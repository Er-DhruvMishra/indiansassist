// Package httpserver serves GET /healthz and GET /metrics on HTTP_ADDR (docs/specs/phase-a2-recorder.md section 12).
package httpserver

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/indiansassist/recorder/internal/metrics"
)

// Status reports the helloed signaling connections and the sessions held.
type Status func() (connected, sessions int)

// Health is the /healthz body.
type Health struct {
	OK        bool `json:"ok"`
	Connected int  `json:"connected"`
	Sessions  int  `json:"sessions"`
}

// Handler returns the mux.
func Handler(status Status) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		c, s := status()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if c == 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(Health{OK: c > 0, Connected: c, Sessions: s})
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(metrics.Registry, promhttp.HandlerOpts{}))
	return mux
}

// New returns the HTTP server for addr.
func New(addr string, status Status) *http.Server {
	return &http.Server{Addr: addr, Handler: Handler(status), ReadHeaderTimeout: 5 * time.Second}
}
