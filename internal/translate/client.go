package translate

import (
	"bufio"
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
	"time"
	"unicode/utf8"

	"github.com/Tularity/t-lingual/internal/language"
)

const (
	maxResponseBytes        = 64 << 10
	maxProviderCodeBytes    = 128
	maxProviderMessageBytes = 1024
	maxProviderIDBytes      = 256
	maxRetryAfterSeconds    = 86_400
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
		return nil, errors.New("translation base URL must use http or https")
	}
	if baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("translation base URL must be absolute and cannot contain credentials, query, or fragment")
	}
	if client == nil {
		client = &http.Client{Timeout: 35 * time.Second}
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
	request, err := c.request(ctx, http.MethodGet, "/health/ready", nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return decodeError(response)
	}
	reader := bufio.NewReader(response.Body)
	if _, err := reader.Peek(1); errors.Is(err, io.EOF) {
		// The GPU gateway signals readiness with an exact empty 200 response.
		return nil
	} else if err != nil {
		return fmt.Errorf("read translation health response: %w", err)
	}
	var health struct {
		Status string `json:"status"`
	}
	if err := decodeStrict(reader, &health); err != nil {
		return fmt.Errorf("decode translation health response: %w", err)
	}
	if health.Status != "ready" {
		return ErrUnavailable
	}
	return nil
}

func (c *Client) Translate(ctx context.Context, input Request) (Response, error) {
	if input.SourceLanguage == "" {
		// The gateway treats an omitted source identically to exact lowercase auto.
		// Send the explicit sentinel so this adapter's request/response binding
		// remains unambiguous even when the caller leaves the field empty.
		input.SourceLanguage = "auto"
	}
	if err := validateRequest(input); err != nil {
		return Response{}, err
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return Response{}, err
	}
	request, err := c.request(ctx, http.MethodPost, "/v1/translate", bytes.NewReader(payload))
	if err != nil {
		return Response{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return Response{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Response{}, decodeError(response)
	}
	var result Response
	if err := decodeStrict(response.Body, &result); err != nil {
		return Response{}, fmt.Errorf("decode translation response: %w", err)
	}
	if result.RequestID == "" || result.SourceLanguage == "" || result.TargetLanguage == "" || result.Translation == "" || result.Model == "" {
		return Response{}, errors.New("translation response omitted a required field")
	}
	if err := validateResponse(input, result); err != nil {
		return Response{}, err
	}
	return result, nil
}

func validateRequest(input Request) error {
	_, sourceErr := canonicalSource(input.SourceLanguage)
	target, targetErr := language.Canonicalize(input.TargetLanguage)
	if sourceErr != nil || targetErr != nil || target == "" {
		return errors.New("source and target language tags must be supported languages")
	}
	if !utf8.ValidString(input.Text) || strings.TrimSpace(input.Text) == "" {
		return errors.New("translation text must be non-empty UTF-8")
	}
	if len(input.Text) > 16<<10 {
		return errors.New("translation text exceeds the provider byte limit")
	}
	count := 0
	for _, character := range input.Text {
		if character == 0 || (character < 0x20 && character != '\n' && character != '\t' && character != '\r') || (character >= 0x7f && character <= 0x9f) {
			return errors.New("translation text contains a prohibited control character")
		}
		count++
	}
	if count > 4096 {
		return errors.New("translation text exceeds the provider character limit")
	}
	if err := validateSourceContext(input); err != nil {
		return err
	}
	return nil
}

func validateSourceContext(input Request) error {
	if input.SourceContext == "" {
		return nil
	}
	if input.SourceLanguage != "auto" || utf8.RuneCountInString(input.Text) > 32 ||
		len(input.SourceContext) > 512 || !validProviderText(input.SourceContext) {
		return errors.New("source context requires short auto-detected text and at most 512 valid UTF-8 bytes")
	}
	return nil
}

func validateResponse(input Request, result Response) error {
	expectedSource, _ := canonicalSource(input.SourceLanguage)
	expectedTarget, _ := language.Canonicalize(input.TargetLanguage)
	actualSource, sourceErr := language.Canonicalize(result.SourceLanguage)
	actualTarget, targetErr := language.Canonicalize(result.TargetLanguage)
	if sourceErr != nil || targetErr != nil ||
		(expectedSource != "auto" && actualSource != expectedSource) || actualTarget != expectedTarget {
		return errors.New("translation response language identity did not match the request")
	}
	if expectedSource == "auto" {
		if result.SourceDetection == nil || !validSourceDetection(*result.SourceDetection, input.SourceContext != "") {
			return errors.New("translation response source detection is invalid")
		}
	} else if result.SourceDetection != nil {
		return errors.New("explicit source translation reported auto detection")
	}
	if len(result.RequestID) > 256 || len(result.Model) > 256 || !safeASCII(result.RequestID) || !safeASCII(result.Model) {
		return errors.New("translation response identity is invalid")
	}
	if len(result.Translation) > 64<<10 || !validProviderText(result.Translation) {
		return errors.New("translation response text is invalid")
	}
	if result.Usage.InputTokens == 0 || result.Usage.OutputTokens == 0 {
		return errors.New("translation response usage is invalid")
	}
	return nil
}

func validSourceDetection(value SourceDetection, contextUsed bool) bool {
	return value.Method == "fasttext-lid.176" && !math.IsNaN(value.Confidence) && !math.IsInf(value.Confidence, 0) &&
		value.Confidence >= 0 && value.Confidence <= 1 && value.Rank >= 1 && value.Rank <= 46 &&
		value.ContextUsed == contextUsed && (!contextUsed || value.Uncertain)
}

func canonicalSource(value string) (string, error) {
	if value == "" {
		return "auto", nil
	}
	return language.CanonicalizeSource(value)
}

func validProviderText(value string) bool {
	if !utf8.ValidString(value) || strings.TrimSpace(value) == "" {
		return false
	}
	for _, character := range value {
		if character == 0 || (character < 0x20 && character != '\n' && character != '\t' && character != '\r') || (character >= 0x7f && character <= 0x9f) {
			return false
		}
	}
	return true
}

func safeASCII(value string) bool {
	if value == "" {
		return false
	}
	for index := range len(value) {
		if value[index] < 0x20 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

func (c *Client) request(ctx context.Context, method, suffix string, body io.Reader) (*http.Request, error) {
	endpoint := *c.baseURL
	endpoint.Path = path.Join(c.baseURL.Path, suffix)
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if c.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	return request, nil
}

func decodeStrict(reader io.Reader, target any) error {
	payload, err := io.ReadAll(io.LimitReader(reader, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(payload) > maxResponseBytes {
		return errors.New("response exceeded the byte limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("response contained trailing JSON")
	}
	return nil
}

func decodeError(response *http.Response) error {
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"request_id"`
		} `json:"error"`
	}
	_ = decodeStrict(response.Body, &envelope)
	if len(envelope.Error.Code) > maxProviderCodeBytes || !safeProviderCode(envelope.Error.Code) {
		envelope.Error.Code = ""
	}
	if len(envelope.Error.Message) > maxProviderMessageBytes || !validProviderText(envelope.Error.Message) {
		envelope.Error.Message = ""
	}
	if len(envelope.Error.RequestID) > maxProviderIDBytes || !safeASCII(envelope.Error.RequestID) {
		envelope.Error.RequestID = ""
	}
	retryAfter := time.Duration(0)
	if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 && seconds <= maxRetryAfterSeconds {
		retryAfter = time.Duration(seconds) * time.Second
	}
	return &ProviderError{
		StatusCode: response.StatusCode,
		Code:       envelope.Error.Code,
		Message:    envelope.Error.Message,
		RequestID:  envelope.Error.RequestID,
		RetryAfter: retryAfter,
	}
}

func safeProviderCode(value string) bool {
	if value == "" {
		return false
	}
	for index := range len(value) {
		character := value[index]
		if !((character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '_' || character == '-' || character == '.') {
			return false
		}
	}
	return true
}
