package asr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const (
	maxProviderBody       = 64 << 10
	maxProviderEventBytes = 128 << 10
	providerEventBuffer   = 16
	maxSessionIDBytes     = 128
	maxLanguageBytes      = 64
	maxErrorCodeBytes     = 128
	maxErrorMessageBytes  = 1024
	maxChunkMS            = 10_000
	maxRetryAfterSeconds  = 86_400
	deleteAttemptTimeout  = 500 * time.Millisecond
	deleteRetryDelay      = 50 * time.Millisecond
	deleteCleanupTimeout  = 2 * time.Second
	deleteCleanupAttempts = 3
	sessionCloseTimeout   = 3 * time.Second
)

type Client struct {
	baseURL *url.URL
	apiKey  string
	http    *http.Client
}

func NewClient(baseURL *url.URL, apiKey string, client *http.Client) (*Client, error) {
	if baseURL == nil {
		return nil, ErrDisabled
	}
	if baseURL.Scheme != "http" && baseURL.Scheme != "https" {
		return nil, errors.New("ASR base URL must use http or https")
	}
	if baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("ASR base URL must be absolute and cannot contain credentials, query, or fragment")
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	copyURL := *baseURL
	copyURL.Path = strings.TrimRight(copyURL.Path, "/")
	return &Client{baseURL: &copyURL, apiKey: strings.TrimSpace(apiKey), http: &clientCopy}, nil
}

func (c *Client) Ready(ctx context.Context) error {
	request, err := c.request(ctx, http.MethodGet, "/healthz", nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return decodeProviderError(response)
	}
	var health struct {
		Ready bool `json:"ready"`
	}
	if err := decodeLimited(response.Body, &health); err != nil {
		return fmt.Errorf("decode ASR health response: %w", err)
	}
	if !health.Ready {
		return ErrUnavailable
	}
	return nil
}

func (c *Client) Capabilities(ctx context.Context) (Capabilities, error) {
	request, err := c.request(ctx, http.MethodGet, "/v1/capabilities", nil)
	if err != nil {
		return Capabilities{}, err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return Capabilities{}, fmt.Errorf("%w: query ASR capabilities: %v", ErrUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Capabilities{}, decodeProviderError(response)
	}
	var capabilities Capabilities
	if err := decodeLimited(response.Body, &capabilities); err != nil {
		return Capabilities{}, fmt.Errorf("decode ASR capabilities: %w", err)
	}
	if err := validateCapabilities(capabilities); err != nil {
		return Capabilities{}, fmt.Errorf("invalid ASR capabilities: %w", err)
	}
	return capabilities, nil
}

func validateCapabilities(value Capabilities) error {
	if value.Backend == "" || len(value.Backend) > 64 || len(value.SupportedLanguages) == 0 || len(value.SupportedLanguages) > 128 ||
		value.LanguageRegions.Clock != "source_pcm_16khz_ms" ||
		(value.LanguageRegions.Mode != "boundary_reset_no_prompt" && value.LanguageRegions.Mode != "prompt_switch") {
		return errors.New("unsupported capability metadata")
	}
	seen := make(map[string]bool, len(value.SupportedLanguages))
	for _, language := range value.SupportedLanguages {
		if !validLanguage(language) || seen[language] {
			return errors.New("invalid or duplicate supported language")
		}
		seen[language] = true
	}
	return nil
}

func (c *Client) Start(ctx context.Context, input StartRequest) (Stream, error) {
	if err := validateStart(input); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	request, err := c.request(ctx, http.MethodPost, "/v1/sessions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: create session: %v", ErrUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return nil, decodeProviderError(response)
	}
	var info StartResponse
	if err := decodeLimited(response.Body, &info); err != nil {
		return nil, fmt.Errorf("decode ASR session response: %w", err)
	}
	if err := validateStartResponse(input, info); err != nil {
		// A syntactically safe ID is sufficient to release an upstream slot. Do
		// not interpolate an untrusted malformed ID into a cleanup request.
		if validSessionID(info.SessionID) {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deleteCleanupTimeout)
			defer cancel()
			_ = c.deleteWithRetry(cleanupCtx, info.SessionID)
		}
		return nil, fmt.Errorf("invalid ASR session response: %w", err)
	}

	wsURL := c.endpoint("/v1/sessions/" + url.PathEscape(info.SessionID) + "/audio")
	if wsURL.Scheme == "https" {
		wsURL.Scheme = "wss"
	} else {
		wsURL.Scheme = "ws"
	}
	headers := http.Header{}
	if c.apiKey != "" {
		headers.Set("Authorization", "Bearer "+c.apiKey)
	}
	conn, handshake, err := websocket.Dial(ctx, wsURL.String(), &websocket.DialOptions{HTTPClient: c.http, HTTPHeader: headers})
	if err != nil {
		if handshake != nil {
			_ = handshake.Body.Close()
		}
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deleteCleanupTimeout)
		defer cancel()
		_ = c.deleteWithRetry(cleanupCtx, info.SessionID)
		return nil, fmt.Errorf("%w: connect audio websocket: %v", ErrUnavailable, err)
	}
	conn.SetReadLimit(maxProviderEventBytes)

	streamCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	stream := &session{
		client:     c,
		info:       info,
		conn:       conn,
		ctx:        streamCtx,
		cancel:     cancel,
		events:     make(chan Event, providerEventBuffer),
		readDone:   make(chan struct{}),
		closeDone:  make(chan struct{}),
		deleteDone: make(chan struct{}),
	}
	go stream.readLoop()
	return stream, nil
}

func validateStart(input StartRequest) error {
	if !validLanguage(input.Language) {
		return errors.New("ASR language must be a short ASCII language tag")
	}
	switch input.Audio.Encoding {
	case "pcm8", "pcm16", "pcm24", "pcm32", "pcm32f":
	default:
		return fmt.Errorf("unsupported ASR audio encoding %q", input.Audio.Encoding)
	}
	if input.Audio.SampleRate < 8000 || input.Audio.SampleRate > 192000 {
		return errors.New("ASR sample rate is outside the supported range")
	}
	if input.Audio.Channels != 1 {
		return errors.New("ASR audio must be mono")
	}
	// asr-factory currently constructs deque(maxlen=cache_lines) after claiming
	// an inference slot. Reject unsafe values here so this proxy cannot trigger
	// that upstream slot leak.
	if input.CacheLines < 0 || input.CacheLines > 100_000 {
		return errors.New("ASR cache lines must be omitted or between 1 and 100000")
	}
	if input.SpeakerEmbedding != "" && input.SpeakerEmbedding != "off" && input.SpeakerEmbedding != "profile" && input.SpeakerEmbedding != "segment" {
		return errors.New("invalid ASR speaker embedding mode")
	}
	if err := validateLanguageRegions(input.LanguageRegions); err != nil {
		return err
	}
	return nil
}

func validateLanguageRegions(regions []LanguageRegion) error {
	if len(regions) > 1000 {
		return errors.New("too many ASR language regions")
	}
	var previousEnd int64
	for index, region := range regions {
		if !validLanguage(region.Language) || region.StartMS < previousEnd || region.StartMS < 0 || region.StartMS > math.MaxInt64/16 {
			return errors.New("invalid ASR language region")
		}
		if region.EndMS == nil {
			if index != len(regions)-1 {
				return errors.New("only the last ASR language region may remain open")
			}
			continue
		}
		if *region.EndMS <= region.StartMS || *region.EndMS > math.MaxInt64/16 {
			return errors.New("invalid ASR language region end")
		}
		previousEnd = *region.EndMS
	}
	return nil
}

func validateStartResponse(input StartRequest, info StartResponse) error {
	if !validSessionID(info.SessionID) {
		return errors.New("session_id is invalid")
	}
	if info.ChunkMS <= 0 || info.ChunkMS > maxChunkMS {
		return errors.New("chunk_ms is outside the supported range")
	}
	if info.Audio != input.Audio {
		return errors.New("audio specification did not match the request")
	}
	if math.IsNaN(info.CreatedAt) || math.IsInf(info.CreatedAt, 0) || info.CreatedAt <= 0 {
		return errors.New("ASR session creation timestamp is invalid")
	}
	if input.AudioSense && !info.AudioSense {
		return errors.New("requested ASR audio sense was not activated")
	}
	if input.Diarize && !info.Diarize {
		return errors.New("requested ASR diarization was not activated")
	}
	if info.Language != "" && !validLanguage(info.Language) {
		return errors.New("language is invalid")
	}
	if err := validateLanguageRegions(info.LanguageRegions); err != nil {
		return fmt.Errorf("language regions in ASR response: %w", err)
	}
	if !sameLanguageRegions(input.LanguageRegions, info.LanguageRegions) {
		return errors.New("language regions did not match the ASR request")
	}
	if info.LanguageRegionMode != "" && info.LanguageRegionMode != "prompt_switch" && info.LanguageRegionMode != "boundary_reset_no_prompt" {
		return errors.New("language region mode is invalid")
	}
	if info.DiarLatencyMS != nil && *info.DiarLatencyMS < 0 || info.MaxSpeakers != nil && (*info.MaxSpeakers < 0 || *info.MaxSpeakers > 32) {
		return errors.New("diarization metadata is invalid")
	}
	if info.CacheLines < 0 || info.CacheLines > 100_000 {
		return errors.New("cache_lines is outside the supported range")
	}
	if len(info.WebSocketURL) > 2048 || (info.WebSocketURL != "" && !safePrintableASCII(info.WebSocketURL)) {
		return errors.New("ws_url is invalid")
	}
	return nil
}

func sameLanguageRegions(requested, returned []LanguageRegion) bool {
	if len(requested) != len(returned) {
		return false
	}
	for index, region := range requested {
		actual := returned[index]
		if region.StartMS != actual.StartMS || region.Language != actual.Language || (region.EndMS == nil) != (actual.EndMS == nil) {
			return false
		}
		if region.EndMS != nil && *region.EndMS != *actual.EndMS {
			return false
		}
	}
	return true
}

func validLanguage(value string) bool {
	if value == "" || len(value) > maxLanguageBytes {
		return false
	}
	for index := range len(value) {
		character := value[index]
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '-' {
			continue
		}
		return false
	}
	return true
}

func validSessionID(value string) bool {
	if value == "" || len(value) > maxSessionIDBytes {
		return false
	}
	for index := range len(value) {
		character := value[index]
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func safePrintableASCII(value string) bool {
	for index := range len(value) {
		if value[index] < 0x20 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

func (c *Client) request(ctx context.Context, method, suffix string, body io.Reader) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, c.endpoint(suffix).String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if c.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	return request, nil
}

func (c *Client) endpoint(suffix string) *url.URL {
	result := *c.baseURL
	result.Path = path.Join(c.baseURL.Path, suffix)
	return &result
}

func (c *Client) delete(ctx context.Context, sessionID string) error {
	request, err := c.request(ctx, http.MethodDelete, "/v1/sessions/"+url.PathEscape(sessionID), nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusNotFound {
		return decodeProviderError(response)
	}
	return nil
}

func (c *Client) deleteWithRetry(ctx context.Context, sessionID string) error {
	var lastErr error
	for attempt := 0; attempt < deleteCleanupAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, deleteAttemptTimeout)
		err := c.delete(attemptCtx, sessionID)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		if !retryableDeleteError(err) || attempt+1 == deleteCleanupAttempts {
			break
		}
		timer := time.NewTimer(deleteRetryDelay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return lastErr
		}
	}
	return lastErr
}

func retryableDeleteError(err error) bool {
	var providerErr *ProviderError
	if errors.As(err, &providerErr) {
		return providerErr.Temporary()
	}
	return true
}

type session struct {
	client *Client
	info   StartResponse
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	events chan Event

	writeMu  sync.Mutex
	endMu    sync.Mutex
	endSent  bool
	errMu    sync.Mutex
	readErr  error
	readDone chan struct{}

	closeOnce  sync.Once
	closeDone  chan struct{}
	deleteOnce sync.Once
	deleteDone chan struct{}
	deleteErr  error
}

func (s *session) Info() StartResponse  { return s.info }
func (s *session) Events() <-chan Event { return s.events }

func (s *session) SendAudio(ctx context.Context, audio []byte) error {
	if len(audio) == 0 {
		return nil
	}
	return s.write(ctx, websocket.MessageBinary, audio)
}

func (s *session) ForceEndOfUtterance(ctx context.Context) error {
	return s.command(ctx, "force_eou")
}

func (s *session) Reset(ctx context.Context) error { return s.command(ctx, "reset_stream") }
func (s *session) Ping(ctx context.Context) error  { return s.command(ctx, "ping") }

func (s *session) End(ctx context.Context) error {
	// asr-factory finishes an explicit end by closing the TCP/WebSocket stream
	// without a WebSocket close frame. Keep the write and state transition
	// ordered with readLoop so an EOF can only be normalized after the end frame
	// was successfully handed to the connection.
	s.endMu.Lock()
	defer s.endMu.Unlock()
	if err := s.command(ctx, "end"); err != nil {
		return err
	}
	s.endSent = true
	return nil
}

func (s *session) command(ctx context.Context, command string) error {
	payload, err := json.Marshal(map[string]string{"type": command})
	if err != nil {
		return err
	}
	return s.write(ctx, websocket.MessageText, payload)
}

func (s *session) write(ctx context.Context, typ websocket.MessageType, payload []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.conn.Write(ctx, typ, payload); err != nil {
		return fmt.Errorf("write ASR websocket: %w", err)
	}
	return nil
}

func (s *session) readLoop() {
	defer close(s.readDone)
	defer close(s.events)
	for {
		typ, payload, err := s.conn.Read(s.ctx)
		if err != nil {
			status := websocket.CloseStatus(err)
			if !errors.Is(err, context.Canceled) && status != websocket.StatusNormalClosure && status != websocket.StatusGoingAway &&
				!(errors.Is(err, io.EOF) && s.endedSuccessfully()) {
				s.setReadErr(fmt.Errorf("read ASR websocket: %w", err))
			}
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var event Event
		if err := json.Unmarshal(payload, &event); err != nil {
			s.setReadErr(fmt.Errorf("decode ASR websocket event: %w", err))
			return
		}
		if event.Type == "" {
			s.setReadErr(errors.New("ASR websocket event omitted type"))
			return
		}
		if err := validateEvent(&event); err != nil {
			s.setReadErr(fmt.Errorf("invalid ASR websocket event: %w", err))
			return
		}
		select {
		case s.events <- event:
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *session) endedSuccessfully() bool {
	s.endMu.Lock()
	defer s.endMu.Unlock()
	return s.endSent
}

func validateEvent(event *Event) error {
	if event == nil {
		return errors.New("event is missing")
	}
	if len(event.Type) > 32 {
		return errors.New("type is too large")
	}
	switch event.Type {
	case "partial", "final", "error", "pong", "audio_state", "speaker", "speaker_profile", "info":
	default:
		return fmt.Errorf("unsupported type %q", event.Type)
	}
	if len(event.Text) > 64<<10 {
		return errors.New("text is too large")
	}
	if len(event.Code) > 128 || len(event.Language) > 64 || len(event.Message) > 1024 {
		return errors.New("provider metadata is too large")
	}
	event.Code = normalizeProviderCode(event.Code)
	event.Message = normalizeProviderMessage(event.Message)
	if event.Language != "" && !validLanguage(event.Language) {
		return errors.New("language is invalid")
	}
	if event.Sequence < 0 || event.Line < 0 || event.StartMS < 0 || event.EndMS < 0 || event.AudioPositionMS < 0 ||
		event.WallMS < 0 || event.Wall0MS < 0 || event.Wall1MS < 0 || event.AudioClockMS < 0 || event.PongTS < 0 {
		return errors.New("numeric field is negative")
	}
	if event.Type == "final" && event.EndMS < event.StartMS {
		return errors.New("final time range is inverted")
	}
	if (event.Type == "speaker" && (event.Speaker == nil || *event.Speaker < 0 || *event.Speaker > 3 || event.Wall1MS < event.Wall0MS)) ||
		(event.Type == "final" && event.Wall1MS != 0 && event.Wall1MS < event.Wall0MS) {
		return errors.New("speaker or wall-clock range is invalid")
	}
	if len(event.InfoEvent) > 64 || len(event.State) > 64 || len(event.LanguageRegions) > 1000 {
		return errors.New("ASR event metadata is too large")
	}
	if err := validateLanguageRegions(event.LanguageRegions); err != nil {
		return err
	}
	return nil
}

func (s *session) setReadErr(err error) {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	s.readErr = err
}

func (s *session) Wait() error {
	<-s.readDone
	s.errMu.Lock()
	defer s.errMu.Unlock()
	return s.readErr
}

func (s *session) Close(ctx context.Context) error {
	s.closeOnce.Do(func() {
		s.cancel()
		s.startDelete()
		go func() {
			defer close(s.closeDone)
			_ = s.conn.CloseNow()
		}()
	})
	if ctx == nil {
		return errors.New("close ASR session: context is required")
	}
	waitCtx, cancel := context.WithTimeout(ctx, sessionCloseTimeout)
	defer cancel()
	select {
	case <-s.readDone:
	case <-waitCtx.Done():
		return context.Cause(waitCtx)
	}
	select {
	case <-s.closeDone:
	case <-waitCtx.Done():
		return context.Cause(waitCtx)
	}
	select {
	case <-s.deleteDone:
		return s.deleteErr
	case <-waitCtx.Done():
		return context.Cause(waitCtx)
	}
}

func (s *session) startDelete() {
	s.deleteOnce.Do(func() {
		go func() {
			defer close(s.deleteDone)
			ctx, cancel := context.WithTimeout(context.Background(), deleteCleanupTimeout)
			defer cancel()
			s.deleteErr = s.client.deleteWithRetry(ctx, s.info.SessionID)
		}()
	})
}

func decodeProviderError(response *http.Response) error {
	var envelope struct {
		Detail struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		} `json:"detail"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	_ = decodeLimited(response.Body, &envelope)
	code := envelope.Error
	message := envelope.Message
	if envelope.Detail.Error != "" {
		code = envelope.Detail.Error
	}
	if envelope.Detail.Message != "" {
		message = envelope.Detail.Message
	}
	code = normalizeProviderCode(code)
	message = normalizeProviderMessage(message)
	retryAfter := time.Duration(0)
	if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 && seconds <= maxRetryAfterSeconds {
		retryAfter = time.Duration(seconds) * time.Second
	}
	return &ProviderError{StatusCode: response.StatusCode, Code: code, Message: message, RetryAfter: retryAfter}
}

func decodeLimited(reader io.Reader, target any) error {
	payload, err := io.ReadAll(io.LimitReader(reader, maxProviderBody+1))
	if err != nil {
		return err
	}
	if len(payload) > maxProviderBody {
		return errors.New("response exceeded the byte limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("response contained trailing JSON")
	}
	return nil
}

func normalizeProviderCode(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxErrorCodeBytes {
		return ""
	}
	for index := range len(value) {
		character := value[index]
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '_' || character == '-' ||
			character == '.' || character == ':' {
			continue
		}
		return ""
	}
	return value
}

func normalizeProviderMessage(value string) string {
	value = strings.ToValidUTF8(value, "")
	var result strings.Builder
	result.Grow(min(len(value), maxErrorMessageBytes))
	spacePending := false
	for _, character := range value {
		if unicode.IsSpace(character) || unicode.Is(unicode.C, character) {
			spacePending = result.Len() > 0
			continue
		}
		if spacePending {
			if result.Len()+1 > maxErrorMessageBytes {
				break
			}
			result.WriteByte(' ')
			spacePending = false
		}
		width := utf8.RuneLen(character)
		if width < 0 || result.Len()+width > maxErrorMessageBytes {
			break
		}
		result.WriteRune(character)
	}
	return result.String()
}
