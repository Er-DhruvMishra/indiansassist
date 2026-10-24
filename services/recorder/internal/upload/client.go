// Package upload hashes finalised recordings and posts them to the api
// (docs/specs/phase-a2-recorder.md section 9 "Finalise", "Upload", "Retries").
package upload

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"time"
)

// Meta is the multipart field `meta` (internalRecordingMetaSchema).
type Meta struct {
	SessionID  string `json:"sessionId"`
	RecorderID string `json:"recorderId"`
	Mime       string `json:"mime"`
	DurationMs int64  `json:"durationMs"`
	Bytes      int64  `json:"bytes"`
	SHA256     string `json:"sha256"`
}

// HashFile returns the byte count and lower-case hex sha256 of a file.
func HashFile(path string) (int64, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(h.Sum(nil)), nil
}

// Client posts recordings to POST {API_URL}/api/v1/internal/recordings.
type Client struct {
	APIURL    string
	Token     string
	Attempts  int           // UPLOAD_RETRIES: total attempts
	Timeout   time.Duration // per attempt (10 min)
	HTTP      *http.Client
	Sleep     func(context.Context, time.Duration) error // test hook
	OnRetry   func(attempt int, err error)
	UserAgent string
	BaseDelay time.Duration // 2 s
	MaxDelay  time.Duration // 60 s
}

// ErrFinal is wrapped by errors that must not be retried (4xx other than 429).
var ErrFinal = errors.New("upload: rejected")

// StatusError is a non-2xx answer.
type StatusError struct {
	Status int
	Code   string
}

func (e *StatusError) Error() string { return fmt.Sprintf("upload: status %d %s", e.Status, e.Code) }

// NewClient returns a Client with the contract defaults.
func NewClient(apiURL, token string, attempts int, userAgent string) *Client {
	return &Client{
		APIURL: apiURL, Token: token, Attempts: attempts, Timeout: 10 * time.Minute, UserAgent: userAgent,
		HTTP: &http.Client{}, BaseDelay: 2 * time.Second, MaxDelay: 60 * time.Second, Sleep: sleepCtx,
	}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Backoff is attempt n's delay (n = 1 after the first failure): 2, 4, 8, 16, 32 s +-20 %, cap 60 s.
func (c *Client) Backoff(n int) time.Duration {
	d := c.BaseDelay << (n - 1)
	if d > c.MaxDelay || d <= 0 {
		d = c.MaxDelay
	}
	j := 0.8 + 0.4*rand.Float64()
	d = time.Duration(float64(d) * j)
	if d > c.MaxDelay {
		d = c.MaxDelay
	}
	return d
}

// Upload posts the file with retries. A nil error means stored (201) or already stored with the
// same sha256 (409). errors.Is(err, ErrFinal) means the api refused it for good.
func (c *Client) Upload(ctx context.Context, meta Meta, path string) error {
	var err error
	for attempt := 1; attempt <= c.Attempts; attempt++ {
		var retryAfter time.Duration
		retryAfter, err = c.once(ctx, meta, path)
		if err == nil || errors.Is(err, ErrFinal) || ctx.Err() != nil {
			return err
		}
		if attempt == c.Attempts {
			break
		}
		if c.OnRetry != nil {
			c.OnRetry(attempt, err)
		}
		d := c.Backoff(attempt)
		if retryAfter > d {
			d = min(retryAfter, c.MaxDelay)
		}
		if serr := c.Sleep(ctx, d); serr != nil {
			return serr
		}
	}
	return err
}

// once performs one attempt; it returns the Retry-After hint of a 429.
func (c *Client) once(ctx context.Context, meta Meta, path string) (time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()
	f, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("%w: open: %v", ErrFinal, err)
	}
	defer f.Close()

	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrFinal, err)
	}
	// Build the multipart framing around the file so the body streams from disk with a known length.
	var head bytes.Buffer
	mw := multipart.NewWriter(&head)
	if err := mw.WriteField("meta", string(metaJSON)); err != nil {
		return 0, err
	}
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s.webm"`, meta.SessionID))
	h.Set("Content-Type", "video/webm")
	if _, err := mw.CreatePart(h); err != nil {
		return 0, err
	}
	prefix := append([]byte(nil), head.Bytes()...)
	head.Reset()
	if err := mw.Close(); err != nil {
		return 0, err
	}
	suffix := head.Bytes()

	body := io.MultiReader(bytes.NewReader(prefix), io.LimitReader(f, meta.Bytes), bytes.NewReader(suffix))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.APIURL+"/api/v1/internal/recordings", body)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrFinal, err)
	}
	req.ContentLength = int64(len(prefix)) + meta.Bytes + int64(len(suffix))
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("X-Requested-With", "IndiansAssist")
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, fmt.Errorf("upload: request failed: %w", err)
	}
	defer res.Body.Close()
	resBody, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return 0, nil
	case res.StatusCode == http.StatusConflict && containsSHA(resBody, meta.SHA256):
		return 0, nil
	case res.StatusCode == http.StatusTooManyRequests:
		ra, _ := strconv.Atoi(res.Header.Get("Retry-After"))
		return time.Duration(ra) * time.Second, &StatusError{Status: res.StatusCode, Code: errorCode(resBody)}
	case res.StatusCode >= 500:
		return 0, &StatusError{Status: res.StatusCode, Code: errorCode(resBody)}
	default:
		return 0, fmt.Errorf("%w: %w", ErrFinal, &StatusError{Status: res.StatusCode, Code: errorCode(resBody)})
	}
}

// errorCode extracts `error.code` of the A 6 error envelope.
func errorCode(b []byte) string {
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(b, &env)
	return env.Error.Code
}

// containsSHA reports whether any `sha256` field anywhere in the JSON body equals want. The 409
// body shape is not pinned by the contract (error.details.sha256, details.recording.sha256, ...).
func containsSHA(b []byte, want string) bool {
	var v any
	if json.Unmarshal(b, &v) != nil {
		return false
	}
	var walk func(any) bool
	walk = func(x any) bool {
		switch t := x.(type) {
		case map[string]any:
			for k, val := range t {
				if s, ok := val.(string); ok && k == "sha256" && strings.EqualFold(s, want) {
					return true
				}
				if walk(val) {
					return true
				}
			}
		case []any:
			for _, val := range t {
				if walk(val) {
					return true
				}
			}
		}
		return false
	}
	return walk(v)
}
