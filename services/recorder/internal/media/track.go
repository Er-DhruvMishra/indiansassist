package media

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/samplebuilder"

	"github.com/indiansassist/recorder/internal/metrics"
)

// EventKind is a media condition reported to the session.
type EventKind int

// Media events.
const (
	EventKeyframe        EventKind = iota + 1 // first keyframe of a video track written
	EventKeyframeTimeout                      // no keyframe within KeyframeWait of the track arriving
	EventLimitReached                         // 2 GiB or MAX_DURATION
	EventDiskError                            // write failed
	EventTrackEnded                           // the remote track stopped delivering RTP
)

// Timing knobs (section 11); variables so tests can shorten them.
var (
	KeyframeWait = 10 * time.Second
	PLIInterval  = 3 * time.Second
)

// TrackOptions wires one remote track to a Recorder.
type TrackOptions struct {
	Rec      *Recorder
	SendPLI  func() error // video only
	OnEvent  func(EventKind)
	Log      *slog.Logger
	Ctx      context.Context
	MimeType string // codec mime of the track (video/VP8, video/VP9, audio/opus)
}

// CodecFromMime maps a negotiated mime type to CodecVP8 / CodecVP9 ("" for other codecs).
func CodecFromMime(mime string) string {
	switch strings.ToLower(mime) {
	case strings.ToLower(webrtc.MimeTypeVP8):
		return CodecVP8
	case strings.ToLower(webrtc.MimeTypeVP9):
		return CodecVP9
	}
	return ""
}

// ReadVideo consumes a video track until it ends or ctx is cancelled. It sends PLI on arrival, every
// PLIInterval until the first keyframe, and whenever the sample builder dropped packets.
func ReadVideo(read func() (*rtp.Packet, error), o TrackOptions) {
	codec := CodecFromMime(o.MimeType)
	var dep rtp.Depacketizer = &codecs.VP8Packet{}
	if codec == CodecVP9 {
		dep = &codecs.VP9Packet{}
	}
	if codec == "" {
		o.Log.Warn("unsupported video codec", "mime", o.MimeType)
		return
	}
	o.Rec.BeginVideoEpoch()
	sb := samplebuilder.New(512, dep, 90000, samplebuilder.WithMaxTimeDelay(time.Second))

	var gotKey atomic.Bool
	pli := func() {
		if o.SendPLI == nil {
			return
		}
		if err := o.SendPLI(); err == nil {
			metrics.PLISent.Inc()
		}
	}
	pli()
	go func() {
		tick := time.NewTicker(PLIInterval)
		defer tick.Stop()
		deadline := time.NewTimer(KeyframeWait)
		defer deadline.Stop()
		for {
			select {
			case <-o.Ctx.Done():
				return
			case <-tick.C:
				if gotKey.Load() {
					return
				}
				pli()
			case <-deadline.C:
				if !gotKey.Load() {
					o.OnEvent(EventKeyframeTimeout)
				}
				return
			}
		}
	}()

	for {
		pkt, err := read()
		if err != nil {
			if o.Ctx.Err() == nil {
				o.OnEvent(EventTrackEnded)
			}
			return
		}
		metrics.RTPPackets.WithLabelValues("video").Inc()
		sb.Push(pkt)
		for s := sb.Pop(); s != nil; s = sb.Pop() {
			if s.PrevDroppedPackets > 0 {
				pli()
			}
			wrote, err := o.Rec.WriteVideo(codec, s.Data, s.PacketTimestamp)
			if err != nil {
				reportWriteErr(err, o)
				return
			}
			if wrote && !gotKey.Load() && IsKeyframe(codec, s.Data) {
				gotKey.Store(true)
				o.OnEvent(EventKeyframe)
			}
		}
	}
}

// ReadAudio consumes an Opus track until it ends or ctx is cancelled.
func ReadAudio(read func() (*rtp.Packet, error), o TrackOptions) {
	if !strings.EqualFold(o.MimeType, webrtc.MimeTypeOpus) {
		o.Log.Warn("unsupported audio codec", "mime", o.MimeType)
		return
	}
	o.Rec.BeginAudioEpoch()
	sb := samplebuilder.New(64, &codecs.OpusPacket{}, 48000, samplebuilder.WithMaxTimeDelay(500*time.Millisecond))
	for {
		pkt, err := read()
		if err != nil {
			return // audio ending alone never stops the recording
		}
		metrics.RTPPackets.WithLabelValues("audio").Inc()
		sb.Push(pkt)
		for s := sb.Pop(); s != nil; s = sb.Pop() {
			if _, err := o.Rec.WriteAudio(s.Data, s.PacketTimestamp); err != nil {
				reportWriteErr(err, o)
				return
			}
		}
	}
}

func reportWriteErr(err error, o TrackOptions) {
	switch {
	case errors.Is(err, ErrLimitReached):
		o.OnEvent(EventLimitReached)
	case errors.Is(err, ErrDisk):
		o.Log.Error("recording write failed", "err", err)
		o.OnEvent(EventDiskError)
	}
}
