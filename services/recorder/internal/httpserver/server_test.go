package httpserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/indiansassist/recorder/internal/metrics"
)

func TestHealthz(t *testing.T) {
	connected := 0
	srv := httptest.NewServer(Handler(func() (int, int) { return connected, 2 }))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	var h Health
	_ = json.NewDecoder(res.Body).Decode(&h)
	res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable || h.OK || h.Sessions != 2 {
		t.Fatalf("disconnected: %d %+v", res.StatusCode, h)
	}
	connected = 1
	res, _ = http.Get(srv.URL + "/healthz")
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || strings.TrimSpace(string(b)) != `{"ok":true,"connected":1,"sessions":2}` {
		t.Fatalf("connected: %d %s", res.StatusCode, b)
	}
}

func TestMetrics(t *testing.T) {
	metrics.PLISent.Inc()
	metrics.SignalConnected.WithLabelValues("ws://api:4000/signal").Set(1)
	srv := httptest.NewServer(Handler(func() (int, int) { return 1, 0 }))
	defer srv.Close()
	res, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	for _, name := range []string{
		"ia_recorder_sessions_active", "ia_recorder_signal_connected", "ia_recorder_signal_reconnects_total",
		`ia_recorder_rtp_packets_total{kind="video"}`, `ia_recorder_frames_written_total{kind="audio"}`,
		"ia_recorder_bytes_written_total", "ia_recorder_pli_sent_total", `ia_recorder_uploads_total{result="retry"}`,
		"ia_recorder_upload_seconds_bucket", "go_goroutines",
	} {
		if !strings.Contains(string(b), name) {
			t.Errorf("missing %s", name)
		}
	}
}
