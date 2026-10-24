package upload

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/indiansassist/recorder/internal/store"
)

const sid = "6f1c2b9e-1d2a-4c3b-9a8f-0e1d2c3b4a59"

type captured struct {
	method, path, auth, xrw, origin string
	parts                           []string
	meta                            map[string]any
	file                            []byte
	fileName, fileType              string
	contentLength                   int64
}

// recorderAPI fakes the api: statuses are answered in order (the last one repeats).
func recorderAPI(t *testing.T, statuses []int, body string) (*httptest.Server, *[]captured, *sync.Mutex) {
	var mu sync.Mutex
	var got []captured
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := captured{method: r.Method, path: r.URL.Path, auth: r.Header.Get("Authorization"),
			xrw: r.Header.Get("X-Requested-With"), origin: r.Header.Get("Origin"), contentLength: r.ContentLength}
		if _, origin := r.Header["Origin"]; origin {
			c.origin = "present"
		}
		_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil {
			t.Errorf("content type: %v", err)
		}
		mr := multipart.NewReader(r.Body, params["boundary"])
		for {
			p, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Errorf("multipart: %v", err)
				break
			}
			c.parts = append(c.parts, p.FormName())
			b, _ := io.ReadAll(p)
			switch p.FormName() {
			case "meta":
				_ = json.Unmarshal(b, &c.meta)
			case "file":
				c.file, c.fileName, c.fileType = b, p.FileName(), p.Header.Get("Content-Type")
			}
		}
		mu.Lock()
		got = append(got, c)
		status := statuses[min(n, len(statuses)-1)]
		n++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &got, &mu
}

func setup(t *testing.T, url string) (*Uploader, []byte, *[]time.Duration) {
	dir := t.TempDir()
	data := bytes.Repeat([]byte("webm-bytes-"), 5000)
	if err := os.WriteFile(store.MediaPath(dir, sid), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Write(dir, &store.Sidecar{SessionID: sid, RecorderID: "rec-1", Mime: `video/webm;codecs="vp8,opus"`, State: store.StateFinalised}); err != nil {
		t.Fatal(err)
	}
	var sleeps []time.Duration
	c := NewClient(url, "tok-xyz", 5, "test")
	c.Sleep = func(_ context.Context, d time.Duration) error { sleeps = append(sleeps, d); return nil }
	return NewUploader(context.Background(), c, dir, false, slog.New(slog.DiscardHandler)), data, &sleeps
}

func job() Job {
	return Job{SessionID: sid, RecorderID: "rec-1", Mime: `video/webm;codecs="vp8,opus"`, DurationMs: 1234}
}

func TestUploadRequestShape(t *testing.T) {
	srv, got, _ := recorderAPI(t, []int{201}, `{"id":"r1"}`)
	u, data, _ := setup(t, srv.URL)
	if err := u.Run(context.Background(), job()); err != nil {
		t.Fatal(err)
	}
	if len(*got) != 1 {
		t.Fatalf("requests: %d", len(*got))
	}
	c := (*got)[0]
	if c.method != http.MethodPost || c.path != "/api/v1/internal/recordings" || c.auth != "Bearer tok-xyz" || c.xrw != "IndiansAssist" || c.origin != "" {
		t.Fatalf("request: %+v", c)
	}
	if len(c.parts) != 2 || c.parts[0] != "meta" || c.parts[1] != "file" {
		t.Fatalf("parts order: %v", c.parts)
	}
	sum := sha256.Sum256(data)
	want := map[string]any{"sessionId": sid, "recorderId": "rec-1", "mime": `video/webm;codecs="vp8,opus"`,
		"durationMs": float64(1234), "bytes": float64(len(data)), "sha256": hex.EncodeToString(sum[:])}
	for k, v := range want {
		if c.meta[k] != v {
			t.Errorf("meta %s = %v, want %v", k, c.meta[k], v)
		}
	}
	if len(c.meta) != len(want) {
		t.Errorf("meta has extra fields: %v", c.meta)
	}
	if !bytes.Equal(c.file, data) || c.fileName != sid+".webm" || c.fileType != "video/webm" {
		t.Fatalf("file part: name %q type %q equal %v", c.fileName, c.fileType, bytes.Equal(c.file, data))
	}
	if c.contentLength <= int64(len(data)) {
		t.Fatalf("content length %d", c.contentLength)
	}
	if _, err := os.Stat(store.MediaPath(u.Dir, sid)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("file not deleted after success")
	}
}

func TestRetryOn503ThenSuccess(t *testing.T) {
	srv, got, _ := recorderAPI(t, []int{503, 503, 201}, `{}`)
	u, _, sleeps := setup(t, srv.URL)
	u.KeepFiles = true
	if err := u.Run(context.Background(), job()); err != nil {
		t.Fatal(err)
	}
	if len(*got) != 3 || len(*sleeps) != 2 {
		t.Fatalf("requests %d sleeps %v", len(*got), *sleeps)
	}
	if d := (*sleeps)[0]; d < 1600*time.Millisecond || d > 2400*time.Millisecond {
		t.Fatalf("first backoff %v", d)
	}
	if d := (*sleeps)[1]; d < 3200*time.Millisecond || d > 4800*time.Millisecond {
		t.Fatalf("second backoff %v", d)
	}
	if sc, _ := store.Read(u.Dir, sid); sc.State != store.StateUploaded {
		t.Fatalf("KEEP_FILES sidecar state %s", sc.State)
	}
}

func TestNoRetryOn403(t *testing.T) {
	srv, got, _ := recorderAPI(t, []int{403}, `{"error":{"code":"forbidden","message":"no"}}`)
	u, _, sleeps := setup(t, srv.URL)
	err := u.Run(context.Background(), job())
	if !errors.Is(err, ErrFinal) || len(*got) != 1 || len(*sleeps) != 0 {
		t.Fatalf("err %v requests %d sleeps %d", err, len(*got), len(*sleeps))
	}
	sc, _ := store.Read(u.Dir, sid)
	if sc.State != store.StateFailed {
		t.Fatalf("state %s", sc.State)
	}
	if _, err := os.Stat(store.MediaPath(u.Dir, sid)); err != nil {
		t.Fatal("file must be kept on final failure")
	}
}

func TestConflictSameSHAIsSuccess(t *testing.T) {
	dir := t.TempDir()
	data := []byte("abc")
	_ = os.WriteFile(store.MediaPath(dir, sid), data, 0o600)
	_ = store.Write(dir, &store.Sidecar{SessionID: sid, RecorderID: "rec-1", State: store.StateFinalised})
	sum := sha256.Sum256(data)
	srv, _, _ := recorderAPI(t, []int{409}, `{"error":{"code":"recording_exists","message":"x","details":{"recording":{"sha256":"`+hex.EncodeToString(sum[:])+`"}}}}`)
	u := NewUploader(context.Background(), NewClient(srv.URL, "t", 5, ""), dir, false, slog.New(slog.DiscardHandler))
	if err := u.Run(context.Background(), job()); err != nil {
		t.Fatalf("409 same sha: %v", err)
	}
	srv2, _, _ := recorderAPI(t, []int{409}, `{"error":{"code":"recording_exists","message":"x","details":{"sha256":"00"}}}`)
	_ = os.WriteFile(store.MediaPath(dir, sid), data, 0o600)
	_ = store.Write(dir, &store.Sidecar{SessionID: sid, RecorderID: "rec-1", State: store.StateFinalised})
	u2 := NewUploader(context.Background(), NewClient(srv2.URL, "t", 5, ""), dir, false, slog.New(slog.DiscardHandler))
	if err := u2.Run(context.Background(), job()); !errors.Is(err, ErrFinal) {
		t.Fatalf("409 other sha: %v", err)
	}
}

func TestRecoverUploadsLeftovers(t *testing.T) {
	srv, got, mu := recorderAPI(t, []int{201}, `{}`)
	u, _, _ := setup(t, srv.URL)
	other := "7f1c2b9e-1d2a-4c3b-9a8f-0e1d2c3b4a59"
	_ = os.WriteFile(store.MediaPath(u.Dir, other), []byte("hdr"), 0o600)
	_ = store.Write(u.Dir, &store.Sidecar{SessionID: other, RecorderID: "rec-1", State: store.StateRecording}) // 0 blocks
	if n := u.Recover(); n != 1 {
		t.Fatalf("recovered %d", n)
	}
	_ = u.Wait(context.Background())
	mu.Lock()
	defer mu.Unlock()
	if len(*got) != 1 {
		t.Fatalf("uploads %d", len(*got))
	}
	if _, err := os.Stat(store.SidecarPath(u.Dir, other)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("block-less leftover not removed")
	}
}
