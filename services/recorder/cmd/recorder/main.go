// Command recorder is the IndiansAssist server-side session recorder
// (docs/specs/phase-a2-recorder.md): a receive-only WebRTC peer of the Desk that writes WebM and
// uploads it with its sha256 to the api.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/indiansassist/recorder/internal/config"
	"github.com/indiansassist/recorder/internal/httpserver"
	"github.com/indiansassist/recorder/internal/ice"
	"github.com/indiansassist/recorder/internal/peer"
	"github.com/indiansassist/recorder/internal/session"
	sig "github.com/indiansassist/recorder/internal/signal"
	"github.com/indiansassist/recorder/internal/upload"
)

// shutdownGrace bounds the graceful shutdown (leave + finalise + pending uploads).
const shutdownGrace = 2 * time.Minute

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	cfg, err := config.Load()
	if err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("invalid configuration", "err", err.Error())
		os.Exit(2)
	}
	log := newLogger(cfg.LogLevel).With("recorderId", cfg.RecorderID)
	if err := os.MkdirAll(cfg.OutDir, 0o750); err != nil {
		log.Error("cannot create OUT_DIR", "dir", cfg.OutDir, "err", err)
		os.Exit(1)
	}

	// Uploads use their own context so shutdown can let them finish within the grace period.
	uploadCtx, cancelUploads := context.WithCancel(context.Background())
	defer cancelUploads()
	client := upload.NewClient(cfg.APIURL, cfg.Token, cfg.UploadRetries, "indiansassist-recorder/"+config.Version)
	uploader := upload.NewUploader(uploadCtx, client, cfg.OutDir, cfg.KeepFiles, log)
	if n := uploader.Recover(); n > 0 {
		log.Info("restart recovery: uploading leftover recordings", "count", n)
	}

	deps := &session.Deps{
		Cfg: cfg, ICE: ice.New(cfg.APIURL, cfg.Token, cfg.RecorderID), Uploader: uploader, Log: log,
		Peer: peer.Options{UDPPortMin: cfg.UDPPortMin, UDPPortMax: cfg.UDPPortMax, NAT1To1IPs: cfg.NAT1To1IPs},
	}
	hello := sig.Hello{Token: cfg.Token, RecorderID: cfg.RecorderID, Version: config.Version, Region: cfg.Region, MaxSessions: cfg.MaxSessions}

	signalCtx, cancelSignal := context.WithCancel(context.Background())
	defer cancelSignal()
	var clients []*sig.Client
	var managers []*session.Manager
	var wg sync.WaitGroup
	for _, u := range cfg.SignalURLs {
		c := sig.NewClient(u, hello, nil, log)
		m := session.NewManager(deps, c.Log)
		c.Handler = m
		clients, managers = append(clients, c), append(managers, m)
		wg.Add(1)
		go func() { defer wg.Done(); c.Run(signalCtx) }()
	}

	srv := httpserver.New(cfg.HTTPAddr, func() (int, int) {
		connected, sessions := 0, 0
		for i, c := range clients {
			if c.Ready() {
				connected++
			}
			sessions += managers[i].Count()
		}
		return connected, sessions
	})
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server failed", "addr", cfg.HTTPAddr, "err", err)
			os.Exit(1)
		}
	}()
	log.Info("recorder started", "version", config.Version, "region", cfg.Region, "signal", len(cfg.SignalURLs),
		"httpAddr", cfg.HTTPAddr, "outDir", cfg.OutDir, "maxSessions", cfg.MaxSessions)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Info("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	// 1. recorder.leave {shutdown} + finalise on every connection while the sockets are still open.
	var sw sync.WaitGroup
	for _, m := range managers {
		sw.Add(1)
		go func() { defer sw.Done(); m.Shutdown(ctx) }()
	}
	sw.Wait()
	// 2. Close signaling, then the HTTP server, then wait for the uploads.
	cancelSignal()
	wg.Wait()
	_ = srv.Shutdown(ctx)
	if err := uploader.Wait(ctx); err != nil {
		log.Warn("uploads still pending at shutdown; they resume at the next start", "err", err)
	}
	log.Info("stopped")
}

// healthcheck is the container HEALTHCHECK (the distroless image has no curl): GET /healthz on
// HTTP_ADDR, exit 0 on 200.
func healthcheck() int {
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = ":9470"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	c := &http.Client{Timeout: 3 * time.Second}
	res, err := c.Get("http://" + addr + "/healthz")
	if err != nil {
		return 1
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	switch level {
	case "debug":
		l = slog.LevelDebug
	case "warn":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}
