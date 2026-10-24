// Package metrics holds the recorder Prometheus series (docs/specs/phase-a2-recorder.md section 12).
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Registry is the recorder registry served on GET /metrics.
var Registry = prometheus.NewRegistry()

var f = promauto.With(Registry)

var (
	SessionsActive = f.NewGauge(prometheus.GaugeOpts{
		Name: "ia_recorder_sessions_active", Help: "Sessions currently held by this recorder (joined or paused).",
	})
	SignalConnected = f.NewGaugeVec(prometheus.GaugeOpts{
		Name: "ia_recorder_signal_connected", Help: "1 when the signaling connection to the URL is helloed.",
	}, []string{"url"})
	SignalReconnects = f.NewCounter(prometheus.CounterOpts{
		Name: "ia_recorder_signal_reconnects_total", Help: "Signaling reconnect attempts.",
	})
	RTPPackets = f.NewCounterVec(prometheus.CounterOpts{
		Name: "ia_recorder_rtp_packets_total", Help: "RTP packets received.",
	}, []string{"kind"})
	FramesWritten = f.NewCounterVec(prometheus.CounterOpts{
		Name: "ia_recorder_frames_written_total", Help: "Frames written to WebM files.",
	}, []string{"kind"})
	BytesWritten = f.NewCounter(prometheus.CounterOpts{
		Name: "ia_recorder_bytes_written_total", Help: "Bytes written to WebM files.",
	})
	PLISent = f.NewCounter(prometheus.CounterOpts{
		Name: "ia_recorder_pli_sent_total", Help: "RTCP PLI packets sent.",
	})
	Uploads = f.NewCounterVec(prometheus.CounterOpts{
		Name: "ia_recorder_uploads_total", Help: "Upload attempts by result (ok, retry, failed).",
	}, []string{"result"})
	UploadSeconds = f.NewHistogram(prometheus.HistogramOpts{
		Name: "ia_recorder_upload_seconds", Help: "Duration of successful uploads.",
		Buckets: []float64{0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600},
	})
)

func init() {
	Registry.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	for _, k := range []string{"video", "audio"} {
		RTPPackets.WithLabelValues(k)
		FramesWritten.WithLabelValues(k)
	}
	for _, r := range []string{"ok", "retry", "failed"} {
		Uploads.WithLabelValues(r)
	}
}
