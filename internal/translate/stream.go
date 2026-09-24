package translate

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Tularity/t-lingual/internal/language"
)

const (
	streamDeadline  = 95 * time.Second // upstream deadline is 90 seconds
	streamTextMax   = 8 << 10
	streamFrameMax  = 256 << 10 // allow JSON escaping of a 64 KiB terminal translation
	streamBodyMax   = 16 << 20
	streamOutputMax = 64 << 10
	streamDeltaMax  = 64 << 10
	streamModel     = "xiaomi-research/MiLMMT-46-4B-v1.0"
)

type streamStart struct {
	RequestID       string           `json:"request_id"`
	SourceLanguage  string           `json:"source_language"`
	SourceDetection *SourceDetection `json:"source_detection"`
	TargetLanguage  string           `json:"target_language"`
	Model           string           `json:"model"`
	Provisional     bool             `json:"provisional"`
}

type streamDelta struct {
	RequestID   string `json:"request_id"`
	Index       uint64 `json:"index"`
	Text        string `json:"text"`
	Provisional bool   `json:"provisional"`
}

type streamComplete struct {
	Response
	Validated bool `json:"validated"`
}

type streamFailure struct {
	RequestID string `json:"request_id"`
	Error     struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *Client) TranslateStream(ctx context.Context, input Request, onUpdate func(StreamUpdate) error) (Response, error) {
	if ctx == nil {
		return Response{}, errors.New("translation context is required")
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}
	if input.SourceLanguage == "" {
		input.SourceLanguage = "auto"
	}
	if err := validateStreamRequest(input); err != nil {
		return Response{}, err
	}
	if onUpdate == nil {
		return Response{}, errors.New("streaming translation callback is required")
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return Response{}, err
	}
	if len(payload) > 16<<10 {
		return Response{}, errors.New("streaming translation request exceeds the provider byte limit")
	}
	requestCtx, cancel := context.WithTimeout(ctx, streamDeadline)
	defer cancel()
	request, err := c.request(requestCtx, http.MethodPost, "/v1/translate/stream", bytes.NewReader(payload))
	if err != nil {
		return Response{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	// The JSON client's shorter default timeout must not truncate a valid
	// 90-second generation. The request context still bounds the whole stream.
	httpClient := *c.http
	httpClient.Timeout = 0
	response, err := httpClient.Do(request)
	if err != nil {
		return Response{}, fmt.Errorf("%w: stream translation: %v", ErrUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Response{}, decodeError(response)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/event-stream" {
		return Response{}, errors.New("translation stream content type is invalid")
	}
	headerID := response.Header.Get("X-Request-ID")
	if len(headerID) > maxProviderIDBytes || !safeASCII(headerID) {
		return Response{}, errors.New("translation stream request identity is invalid")
	}
	return consumeTranslationStream(requestCtx, response.Body, input, headerID, onUpdate)
}

func validateStreamRequest(input Request) error {
	if _, err := canonicalSource(input.SourceLanguage); err != nil {
		return errors.New("streaming translation source language is unsupported")
	}
	if _, err := language.Canonicalize(input.TargetLanguage); err != nil {
		return errors.New("streaming translation target language is unsupported")
	}
	if len(input.Text) > streamTextMax {
		return errors.New("streaming translation text exceeds the provider byte limit")
	}
	if !validProviderText(input.Text) {
		return errors.New("streaming translation text is invalid")
	}
	if err := validateSourceContext(input); err != nil {
		return err
	}
	return nil
}

func consumeTranslationStream(ctx context.Context, body io.Reader, input Request, headerID string, onUpdate func(StreamUpdate) error) (Response, error) {
	reader := bufio.NewReaderSize(body, streamFrameMax+2)
	var frame strings.Builder
	var total int
	var started, terminated bool
	var start streamStart
	var provisional strings.Builder
	var lastIndex uint64
	var result Response
	for {
		if err := ctx.Err(); err != nil {
			return Response{}, err
		}
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			return Response{}, errors.New("translation stream frame exceeded the byte limit")
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return Response{}, fmt.Errorf("read translation stream: %w", err)
		}
		total += len(line)
		if total > streamBodyMax {
			return Response{}, errors.New("translation stream exceeded the byte limit")
		}
		if errors.Is(err, io.EOF) {
			if len(line) != 0 || frame.Len() != 0 || !terminated {
				return Response{}, errors.New("translation stream ended before a terminal event")
			}
			return result, nil
		}
		if frame.Len()+len(line) > streamFrameMax {
			return Response{}, errors.New("translation stream frame exceeded the byte limit")
		}
		if _, err := frame.Write(line); err != nil {
			return Response{}, err
		}
		if string(line) != "\n" && string(line) != "\r\n" {
			continue
		}
		frameText := frame.String()
		frame.Reset()
		event, data, comment, parseErr := parseStreamFrame(frameText)
		if parseErr != nil {
			return Response{}, parseErr
		}
		if comment {
			continue
		}
		if terminated {
			return Response{}, errors.New("translation stream sent data after terminal event")
		}
		switch event {
		case "start":
			if started {
				return Response{}, errors.New("translation stream repeated start")
			}
			if err := decodeStreamData(data, &start); err != nil {
				return Response{}, err
			}
			if start.RequestID != headerID || start.Model != streamModel || !start.Provisional ||
				!matchesStreamLanguage(input, start.SourceLanguage, start.TargetLanguage) {
				return Response{}, errors.New("translation stream start identity is invalid")
			}
			if input.SourceLanguage == "auto" {
				if start.SourceDetection == nil || !validSourceDetection(*start.SourceDetection, input.SourceContext != "") {
					return Response{}, errors.New("translation stream start source detection is invalid")
				}
			} else if start.SourceDetection != nil {
				return Response{}, errors.New("explicit source stream reported auto detection")
			}
			started = true
		case "delta":
			if !started {
				return Response{}, errors.New("translation stream delta preceded start")
			}
			var delta streamDelta
			if err := decodeStreamData(data, &delta); err != nil {
				return Response{}, err
			}
			if delta.RequestID != headerID || delta.Index != lastIndex+1 || !delta.Provisional ||
				!utf8.ValidString(delta.Text) || utf8.RuneCountInString(delta.Text) != 1 ||
				provisional.Len()+len(delta.Text) > streamOutputMax || delta.Index > streamDeltaMax {
				return Response{}, errors.New("translation stream delta is invalid")
			}
			lastIndex = delta.Index
			provisional.WriteString(delta.Text)
			if callbackErr := onUpdate(StreamUpdate{RequestID: headerID, Index: lastIndex, Text: provisional.String()}); callbackErr != nil {
				return Response{}, fmt.Errorf("translation stream update rejected: %w", callbackErr)
			}
		case "complete":
			if !started {
				return Response{}, errors.New("translation stream complete preceded start")
			}
			var complete streamComplete
			if err := decodeStreamData(data, &complete); err != nil {
				return Response{}, err
			}
			if !complete.Validated || complete.RequestID != headerID || complete.Model != start.Model ||
				complete.SourceLanguage != start.SourceLanguage || complete.TargetLanguage != start.TargetLanguage ||
				complete.Translation != provisional.String() || !sameSourceDetection(start.SourceDetection, complete.SourceDetection) {
				return Response{}, errors.New("translation stream terminal result did not match provisional data")
			}
			if err := validateResponse(input, complete.Response); err != nil {
				return Response{}, err
			}
			result, terminated = complete.Response, true
		case "error":
			if !started {
				return Response{}, errors.New("translation stream error preceded start")
			}
			var failure streamFailure
			if err := decodeStreamData(data, &failure); err != nil {
				return Response{}, err
			}
			if failure.RequestID != headerID || len(failure.Error.Code) > maxProviderCodeBytes || !safeProviderCode(failure.Error.Code) ||
				len(failure.Error.Message) > maxProviderMessageBytes || !validProviderText(failure.Error.Message) {
				return Response{}, errors.New("translation stream error identity is invalid")
			}
			return Response{}, &ProviderError{StatusCode: http.StatusOK, Code: failure.Error.Code, Message: failure.Error.Message, RequestID: headerID}
		default:
			return Response{}, errors.New("translation stream event type is invalid")
		}
	}
}

func sameSourceDetection(left, right *SourceDetection) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func matchesStreamLanguage(input Request, source, target string) bool {
	expectedSource, sourceErr := canonicalSource(input.SourceLanguage)
	expectedTarget, targetErr := language.Canonicalize(input.TargetLanguage)
	actualSource, resolvedErr := language.Canonicalize(source)
	actualTarget, actualTargetErr := language.Canonicalize(target)
	return sourceErr == nil && targetErr == nil && resolvedErr == nil && actualTargetErr == nil &&
		(expectedSource == "auto" || actualSource == expectedSource) && actualTarget == expectedTarget
}

func decodeStreamData(data string, target any) error {
	if len(data) > streamFrameMax {
		return errors.New("translation stream data exceeded the byte limit")
	}
	decoder := json.NewDecoder(strings.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid translation stream event: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("translation stream event contained trailing JSON")
	}
	return nil
}

func parseStreamFrame(frame string) (event, data string, comment bool, err error) {
	for _, line := range strings.Split(strings.ReplaceAll(frame, "\r\n", "\n"), "\n") {
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, ":") {
			if event != "" || data != "" {
				return "", "", false, errors.New("translation stream mixed keepalive with event")
			}
			comment = true
			continue
		}
		if strings.HasPrefix(line, "event: ") {
			if comment || event != "" {
				return "", "", false, errors.New("translation stream repeated event field")
			}
			event = strings.TrimPrefix(line, "event: ")
			continue
		}
		if strings.HasPrefix(line, "data: ") {
			if comment || data != "" {
				return "", "", false, errors.New("translation stream repeated data field")
			}
			data = strings.TrimPrefix(line, "data: ")
			continue
		}
		return "", "", false, errors.New("translation stream field is invalid")
	}
	if comment {
		return "", "", true, nil
	}
	if event == "" || data == "" {
		return "", "", false, errors.New("translation stream event omitted data")
	}
	return event, data, false, nil
}
