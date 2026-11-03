package media

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/at-wat/ebml-go/mkvcore"
	"github.com/at-wat/ebml-go/webm"

	"github.com/indiansassist/recorder/internal/metrics"
	"github.com/indiansassist/recorder/internal/store"
)

// Errors returned by the Write methods; the session maps them to recorder.leave reasons.
var (
	ErrLimitReached = errors.New("media: recording limit reached")
	ErrDisk         = errors.New("media: disk error")
	ErrClosed       = errors.New("media: recorder closed")
)

// sizeMargin keeps the final file safely below the 2 GiB upload limit.
const sizeMargin = 4 << 20

// Options configures a Recorder.
type Options struct {
	Dir       string
	SessionID string
	// CameraID makes this a camera recording (Phase F 6.5a): the files are OUT_DIR/<cameraId>.webm
	// and .json, the WebM holds the video track only, and the sidecar carries source "camera".
	CameraID    string
	RecorderID  string
	MaxBytes    int64
	MaxDuration time.Duration
	Log         *slog.Logger
	Now         func() time.Time // test hook
}

// Result describes a finalised recording.
type Result struct {
	Empty      bool // no block written: the files were deleted, nothing to upload
	SessionID  string
	CameraID   string // set for a camera recording
	Path       string
	Mime       string
	DurationMs int64
	Blocks     int64
	Err        error // disk error seen while writing (the prefix written so far is still uploaded)
}

// trackClock maps one track epoch's RTP clock onto file milliseconds.
type trackClock struct {
	set     bool
	baseMs  int64
	baseRTP uint32
	rate    int64 // RTP ticks per millisecond
	lastMs  int64
}

func (c *trackClock) ms(rtpTs uint32, nowMs int64) int64 {
	if !c.set {
		c.set, c.baseMs, c.baseRTP = true, nowMs, rtpTs
		if c.baseMs < c.lastMs {
			c.baseMs = c.lastMs
		}
	}
	ms := c.baseMs + int64(int32(rtpTs-c.baseRTP))/c.rate
	if ms < c.lastMs {
		ms = c.lastMs
	}
	c.lastMs = ms
	return ms
}

// Recorder writes one session's WebM file incrementally. It is safe for concurrent use by the video
// and audio goroutines. The file is opened at the first video keyframe; after BeginVideoEpoch (a new
// peer connection) writing resumes at the next keyframe with timestamps rebased on wall-clock time.
type Recorder struct {
	o Options

	mu         sync.Mutex
	codec      string
	file       *countingFile
	video      webm.BlockWriteCloser
	audio      webm.BlockWriteCloser
	sidecar    *store.Sidecar
	start      time.Time
	waitKey    bool
	vclock     trackClock
	aclock     trackClock
	blocks     int64
	durationMs int64
	closed     bool
	result     *Result
}

// NewRecorder creates a Recorder; nothing touches the disk before the first keyframe.
func NewRecorder(o Options) *Recorder {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.MaxBytes <= 0 {
		o.MaxBytes = 2 << 30
	}
	if o.MaxDuration <= 0 {
		o.MaxDuration = 4 * time.Hour
	}
	return &Recorder{o: o, waitKey: true, vclock: trackClock{rate: 90}, aclock: trackClock{rate: 48}}
}

// stem is the file stem: the cameraId of a camera recording, else the sessionId.
func (r *Recorder) stem() string {
	if r.o.CameraID != "" {
		return r.o.CameraID
	}
	return r.o.SessionID
}

// mime is the recording mime: a camera recording has no audio track.
func (r *Recorder) mime() string {
	if r.o.CameraID != "" {
		return VideoMime(r.codec)
	}
	return Mime(r.codec)
}

// Codec returns the file's video codec ("" before the file is opened).
func (r *Recorder) Codec() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.codec
}

// Elapsed is the wall-clock time since the file was opened (0 before).
func (r *Recorder) Elapsed() time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file == nil {
		return 0
	}
	return r.o.Now().Sub(r.start)
}

// BeginVideoEpoch starts a new video track: frames are dropped until the next keyframe.
func (r *Recorder) BeginVideoEpoch() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.waitKey = true
	r.vclock.set = false
}

// BeginAudioEpoch starts a new audio track.
func (r *Recorder) BeginAudioEpoch() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.aclock.set = false
}

// WriteVideo writes one depacketised video frame. wrote is false when the frame was dropped.
func (r *Recorder) WriteVideo(codec string, frame []byte, rtpTs uint32) (wrote bool, err error) {
	key := IsKeyframe(codec, frame)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return false, ErrClosed
	}
	if r.waitKey && !key {
		return false, nil
	}
	if r.file == nil {
		if err := r.open(codec, frame); err != nil {
			return false, err
		}
	}
	if r.waitKey {
		if codec != r.codec {
			// A resumed connection negotiated another codec: never mix codecs in one file.
			return false, nil
		}
		r.waitKey = false
		r.vclock.set = false
	}
	ms := r.vclock.ms(rtpTs, r.nowMs())
	if err := r.write(r.video, key, ms, frame); err != nil {
		return false, err
	}
	metrics.FramesWritten.WithLabelValues("video").Inc()
	return true, nil
}

// WriteAudio writes one Opus frame; frames are dropped until video is being written.
func (r *Recorder) WriteAudio(frame []byte, rtpTs uint32) (wrote bool, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return false, ErrClosed
	}
	if r.file == nil || r.audio == nil || r.waitKey || len(frame) == 0 {
		return false, nil
	}
	ms := r.aclock.ms(rtpTs, r.nowMs())
	if err := r.write(r.audio, true, ms, frame); err != nil {
		return false, err
	}
	metrics.FramesWritten.WithLabelValues("audio").Inc()
	return true, nil
}

func (r *Recorder) nowMs() int64 { return r.o.Now().Sub(r.start).Milliseconds() }

func (r *Recorder) write(w webm.BlockWriteCloser, key bool, ms int64, frame []byte) error {
	if err := r.file.Err(); err != nil {
		return fmt.Errorf("%w: %v", ErrDisk, err)
	}
	if r.file.Size()+int64(len(frame))+sizeMargin > r.o.MaxBytes || time.Duration(ms)*time.Millisecond >= r.o.MaxDuration {
		return ErrLimitReached
	}
	if _, err := w.Write(key, ms, frame); err != nil {
		return fmt.Errorf("%w: %v", ErrDisk, err)
	}
	r.blocks++
	if ms > r.durationMs {
		r.durationMs = ms
	}
	if r.blocks == 1 {
		r.checkpointLocked()
	}
	return nil
}

func (r *Recorder) open(codec string, keyframe []byte) error {
	if err := os.MkdirAll(r.o.Dir, 0o750); err != nil {
		return fmt.Errorf("%w: %v", ErrDisk, err)
	}
	f, err := os.OpenFile(store.MediaPath(r.o.Dir, r.stem()), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrDisk, err)
	}
	cf := &countingFile{f: f}
	width, height := Dimensions(codec, keyframe)
	codecID := "V_VP8"
	if codec == CodecVP9 {
		codecID = "V_VP9"
	}
	tracks := []webm.TrackEntry{
		{Name: "Video", TrackNumber: 1, TrackUID: 1, CodecID: codecID, TrackType: 1,
			Video: &webm.Video{PixelWidth: width, PixelHeight: height}},
		{Name: "Audio", TrackNumber: 2, TrackUID: 2, CodecID: "A_OPUS", TrackType: 2, CodecPrivate: OpusHead(),
			SeekPreRoll: 80_000_000, Audio: &webm.Audio{SamplingFrequency: 48000, Channels: 2}},
	}
	if r.o.CameraID != "" {
		tracks = tracks[:1] // the phone camera sends video only
	}
	log := r.o.Log
	ws, err := webm.NewSimpleBlockWriter(cf, tracks,
		mkvcore.WithMinMaxClusterDuration(1, 0, 30_000),
		mkvcore.WithSegmentInfo(&webm.Info{TimecodeScale: 1_000_000, MuxingApp: "indiansassist-recorder", WritingApp: "indiansassist-recorder"}),
		mkvcore.WithOnErrorHandler(func(err error) { log.Debug("webm writer", "err", err) }),
		mkvcore.WithOnFatalHandler(func(err error) { log.Error("webm writer fatal", "err", err) }),
	)
	if err != nil {
		_ = f.Close()
		return fmt.Errorf("%w: %v", ErrDisk, err)
	}
	r.file, r.video, r.codec = cf, ws[0], codec
	if len(ws) > 1 {
		r.audio = ws[1]
	}
	r.start = r.o.Now()
	if r.o.CameraID != "" {
		r.sidecar = store.NewCameraSidecar(r.o.SessionID, r.o.CameraID, r.o.RecorderID, r.mime(), r.start)
	} else {
		r.sidecar = store.NewSidecar(r.o.SessionID, r.o.RecorderID, r.mime(), r.start)
	}
	if err := store.Write(r.o.Dir, r.sidecar); err != nil {
		log.Error("sidecar write failed", "err", err)
	}
	log.Info("recording file opened", "codec", codec, "width", width, "height", height)
	return nil
}

// Checkpoint stores progress (duration, block count) in the sidecar for restart recovery.
func (r *Recorder) Checkpoint() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file != nil && !r.closed {
		r.checkpointLocked()
	}
}

func (r *Recorder) checkpointLocked() {
	r.sidecar.DurationMs, r.sidecar.Blocks = r.durationMs, r.blocks
	if err := store.Write(r.o.Dir, r.sidecar); err != nil {
		r.o.Log.Warn("sidecar checkpoint failed", "err", err)
	}
}

// Close finalises the file: flushes the WebM writer, fsyncs and closes the file, and marks the
// sidecar finalised. An empty recording is deleted. Close is idempotent.
func (r *Recorder) Close() Result {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.result != nil {
		return *r.result
	}
	r.closed = true
	res := Result{SessionID: r.o.SessionID, CameraID: r.o.CameraID}
	if r.file == nil {
		res.Empty = true
		r.result = &res
		return res
	}
	_ = r.video.Close()
	if r.audio != nil {
		_ = r.audio.Close() // the last Close blocks until the writer goroutine has closed the file
	}
	res.Path = store.MediaPath(r.o.Dir, r.stem())
	res.Mime, res.DurationMs, res.Blocks, res.Err = r.mime(), r.durationMs, r.blocks, r.file.Err()
	if r.blocks == 0 {
		res.Empty = true
		if err := store.Remove(r.o.Dir, r.stem()); err != nil {
			r.o.Log.Warn("removing empty recording failed", "err", err)
		}
	} else {
		r.sidecar.State, r.sidecar.DurationMs, r.sidecar.Blocks = store.StateFinalised, r.durationMs, r.blocks
		if err := store.Write(r.o.Dir, r.sidecar); err != nil {
			r.o.Log.Error("sidecar finalise failed", "err", err)
		}
	}
	r.result = &res
	return res
}

// countingFile counts bytes and remembers the first I/O error. It reports success to the WebM
// writer even after an error so the writer goroutine never panics or wedges; Err surfaces it.
type countingFile struct {
	f    *os.File
	mu   sync.Mutex
	n    int64
	err  error
	done bool
}

func (c *countingFile) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err == nil && !c.done {
		n, err := c.f.Write(p)
		c.n += int64(n)
		metrics.BytesWritten.Add(float64(n))
		if err != nil {
			c.err = err
		}
	}
	return len(p), nil
}

// Close fsyncs and closes the file (called by the WebM writer when it finishes).
func (c *countingFile) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done {
		return nil
	}
	c.done = true
	if err := c.f.Sync(); err != nil && c.err == nil {
		c.err = err
	}
	if err := c.f.Close(); err != nil && c.err == nil {
		c.err = err
	}
	return c.err
}

func (c *countingFile) Size() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

func (c *countingFile) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}
