package upload

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/indiansassist/recorder/internal/metrics"
	"github.com/indiansassist/recorder/internal/store"
)

// Job is one finalised recording to upload.
type Job struct {
	SessionID  string
	RecorderID string
	Mime       string
	DurationMs int64
}

// Uploader runs uploads in the background and updates the sidecars.
type Uploader struct {
	Client    *Client
	Dir       string
	KeepFiles bool
	Log       *slog.Logger

	ctx context.Context
	wg  sync.WaitGroup
}

// NewUploader creates an Uploader whose uploads stop when ctx is cancelled.
func NewUploader(ctx context.Context, c *Client, dir string, keep bool, log *slog.Logger) *Uploader {
	return &Uploader{Client: c, Dir: dir, KeepFiles: keep, Log: log, ctx: ctx}
}

// Submit starts the upload of a finalised recording.
func (u *Uploader) Submit(j Job) {
	u.wg.Add(1)
	go func() {
		defer u.wg.Done()
		_ = u.Run(u.ctx, j)
	}()
}

// Wait blocks until every submitted upload finished or ctx is done.
func (u *Uploader) Wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() { u.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Run hashes and uploads one recording synchronously.
func (u *Uploader) Run(ctx context.Context, j Job) error {
	log := u.Log.With("sessionId", j.SessionID)
	path := store.MediaPath(u.Dir, j.SessionID)
	n, sum, err := HashFile(path)
	if err != nil {
		log.Error("hashing recording failed", "err", err)
		_ = store.SetState(u.Dir, j.SessionID, store.StateFailed, "hash: "+err.Error())
		metrics.Uploads.WithLabelValues("failed").Inc()
		return err
	}
	if n == 0 {
		log.Info("empty recording removed")
		return store.Remove(u.Dir, j.SessionID)
	}
	meta := Meta{SessionID: j.SessionID, RecorderID: j.RecorderID, Mime: j.Mime, DurationMs: j.DurationMs, Bytes: n, SHA256: sum}
	client := *u.Client
	client.OnRetry = func(attempt int, err error) {
		metrics.Uploads.WithLabelValues("retry").Inc()
		log.Warn("upload attempt failed, retrying", "attempt", attempt, "err", err)
	}
	started := time.Now()
	err = client.Upload(ctx, meta, path)
	switch {
	case err == nil:
		metrics.Uploads.WithLabelValues("ok").Inc()
		metrics.UploadSeconds.Observe(time.Since(started).Seconds())
		log.Info("recording uploaded", "bytes", n, "sha256", sum, "durationMs", j.DurationMs)
		if u.KeepFiles {
			return store.SetState(u.Dir, j.SessionID, store.StateUploaded, "")
		}
		return store.Remove(u.Dir, j.SessionID)
	case errors.Is(err, ErrFinal):
		metrics.Uploads.WithLabelValues("failed").Inc()
		log.Error("recording upload rejected", "err", err)
		_ = store.SetState(u.Dir, j.SessionID, store.StateFailed, err.Error())
		return err
	default:
		// Retries exhausted (network / 429 / 5xx) or shutdown: the sidecar stays `finalised`, so the
		// next start retries it (restart recovery).
		metrics.Uploads.WithLabelValues("failed").Inc()
		log.Error("recording upload failed; kept for restart recovery", "err", err)
		return err
	}
}

// Recover finalises and uploads the leftovers of a previous process: every sidecar in state
// recording or finalised. It runs the uploads in the background.
func (u *Uploader) Recover() int {
	list, err := store.List(u.Dir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			u.Log.Warn("recovery scan failed", "err", err)
		}
		return 0
	}
	count := 0
	for _, sc := range list {
		if sc.State != store.StateRecording && sc.State != store.StateFinalised {
			continue
		}
		log := u.Log.With("sessionId", sc.SessionID)
		if sc.State == store.StateRecording {
			if sc.Blocks == 0 {
				log.Info("recovered recording has no blocks; removed")
				_ = store.Remove(u.Dir, sc.SessionID)
				continue
			}
			if f, err := os.OpenFile(store.MediaPath(u.Dir, sc.SessionID), os.O_RDWR, 0); err == nil {
				_ = f.Sync()
				_ = f.Close()
			}
			sc.State = store.StateFinalised
			if err := store.Write(u.Dir, sc); err != nil {
				log.Warn("recovery sidecar update failed", "err", err)
			}
		}
		log.Info("recovering recording for upload", "durationMs", sc.DurationMs)
		u.Submit(Job{SessionID: sc.SessionID, RecorderID: sc.RecorderID, Mime: sc.Mime, DurationMs: sc.DurationMs})
		count++
	}
	return count
}
