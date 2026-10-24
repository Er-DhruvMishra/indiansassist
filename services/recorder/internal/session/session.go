// Package session runs one goroutine per recorded session: join, negotiate with the Desk, write
// the media, pause / resume, finalise and hand the file to the uploader
// (docs/specs/phase-a2-recorder.md sections 6, 7, 9, 11).
package session

import (
	"context"
	"log/slog"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/indiansassist/recorder/internal/config"
	"github.com/indiansassist/recorder/internal/media"
	"github.com/indiansassist/recorder/internal/metrics"
	"github.com/indiansassist/recorder/internal/peer"
	"github.com/indiansassist/recorder/internal/signal"
	"github.com/indiansassist/recorder/internal/upload"
)

// ICEProvider returns the ICE servers for a new peer connection.
type ICEProvider interface {
	Get(ctx context.Context) ([]webrtc.ICEServer, error)
}

// Submitter takes finalised recordings.
type Submitter interface {
	Submit(j upload.Job)
}

// Deps are the collaborators shared by every session.
type Deps struct {
	Cfg      *config.Config
	ICE      ICEProvider
	Uploader Submitter
	Peer     peer.Options
	Log      *slog.Logger

	JoinTimeout  time.Duration // recorder.join -> recorder.joined (default 15 s)
	TrackTimeout time.Duration // offer sent -> video track (default 20 s), counts as a failed connection
	MaxRestarts  int           // N4: fresh offers per join (default 3)
}

type state int

const (
	stNew state = iota
	stJoining
	stJoined
	stPaused
	stDone
)

type evKind int

const (
	evAssign evKind = iota + 1
	evJoined
	evJoinError
	evJoinTimeout
	evAnswer
	evICE
	evPCState
	evTrack
	evNoTrack
	evMedia
	evPause
	evEnded
	evLost
	evShutdown
)

type event struct {
	kind    evKind
	resume  bool
	sdp     string
	cand    *signal.ICECandidateInit
	gen     int
	pcState webrtc.PeerConnectionState
	media   media.EventKind
	code    string
}

// Session is one recorded session. All state is owned by its goroutine.
type Session struct {
	id     string
	deps   *Deps
	send   signal.Sender
	log    *slog.Logger
	rec    *media.Recorder
	events chan event
	done   chan struct{}
	onDone func(*Session)
	ctx    context.Context
	cancel context.CancelFunc

	state      state
	pc         *webrtc.PeerConnection
	pcCancel   context.CancelFunc
	pcGen      int
	remoteSet  bool
	pendingICE []webrtc.ICECandidateInit
	restarts   int
	joinGen    int
	joinTimer  *time.Timer
	trackTimer *time.Timer
}

func newSession(id string, d *Deps, send signal.Sender, log *slog.Logger, onDone func(*Session)) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	l := log.With("sessionId", id) // the root logger carries recorderId and the manager logger the signal host
	return &Session{
		id: id, deps: d, send: send, log: l, onDone: onDone, ctx: ctx, cancel: cancel,
		events: make(chan event, 256), done: make(chan struct{}),
		rec: media.NewRecorder(media.Options{
			Dir: d.Cfg.OutDir, SessionID: id, RecorderID: d.Cfg.RecorderID,
			MaxBytes: config.RecordingMaxBytes, MaxDuration: d.Cfg.MaxDuration, Log: l,
		}),
	}
}

// push delivers an event unless the session is finished.
func (s *Session) push(ev event) {
	select {
	case s.events <- ev:
	case <-s.done:
	}
}

// Done is closed when the session has finalised.
func (s *Session) Done() <-chan struct{} { return s.done }

func (s *Session) run() {
	metrics.SessionsActive.Inc()
	defer func() {
		metrics.SessionsActive.Dec()
		s.cancel()
		close(s.done)
		if s.onDone != nil {
			s.onDone(s)
		}
	}()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for s.state != stDone {
		select {
		case ev := <-s.events:
			s.handle(ev)
		case <-tick.C:
			s.rec.Checkpoint()
			if s.rec.Elapsed() >= s.deps.Cfg.MaxDuration {
				s.finish(signal.ReasonLimitReached)
			}
		}
	}
}

func (s *Session) handle(ev event) {
	switch ev.kind {
	case evAssign:
		if s.state == stNew || (s.state == stPaused && ev.resume) {
			s.sendJoin()
		}
	case evJoined:
		if s.state != stJoining {
			return
		}
		stopTimer(s.joinTimer)
		s.state, s.restarts = stJoined, 0
		s.log.Info("recorder joined", "resume", ev.resume)
		s.startPC(ev.resume)
	case evJoinError:
		if s.state == stJoining {
			s.log.Warn("recorder.join refused", "code", ev.code)
			s.finish("")
		}
	case evJoinTimeout:
		if s.state == stJoining && ev.gen == s.joinGen {
			s.log.Warn("recorder.joined not received in time")
			s.finish("")
		}
	case evAnswer:
		s.onAnswer(ev.sdp)
	case evICE:
		s.onICE(ev.cand)
	case evPCState:
		if ev.gen != s.pcGen {
			return
		}
		s.log.Info("peer connection state", "state", ev.pcState.String())
		if ev.pcState == webrtc.PeerConnectionStateFailed {
			s.pcFailed()
		}
	case evTrack:
		if ev.gen == s.pcGen {
			stopTimer(s.trackTimer)
		}
	case evNoTrack:
		if ev.gen == s.pcGen && s.state == stJoined {
			s.log.Warn("no video track from the Desk")
			s.pcFailed()
		}
	case evMedia:
		s.onMedia(ev)
	case evPause:
		if s.state == stJoined {
			s.log.Info("recording paused (consent_pending)")
			s.closePC()
			s.state = stPaused
		}
	case evEnded:
		s.log.Info("session ended")
		s.finish("")
	case evLost:
		s.log.Warn("signaling connection lost; finalising")
		s.finish("")
	case evShutdown:
		s.finish(signal.ReasonShutdown)
	}
}

func (s *Session) onMedia(ev event) {
	if ev.gen != s.pcGen || s.state != stJoined {
		return
	}
	switch ev.media {
	case media.EventKeyframe:
		s.log.Info("first keyframe written")
	case media.EventKeyframeTimeout:
		s.log.Warn("no keyframe within the wait")
		s.finish(signal.ReasonMediaFailed)
	case media.EventLimitReached:
		s.log.Warn("recording limit reached")
		s.finish(signal.ReasonLimitReached)
	case media.EventDiskError:
		s.finish(signal.ReasonDiskError)
	case media.EventTrackEnded:
		if s.pc != nil && s.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			s.finish(signal.ReasonTrackEnded)
		}
	}
}

func (s *Session) sendJoin() {
	msg := signal.RecorderJoin{Envelope: signal.NewEnvelope(signal.TRecorderJoin, joinID(s.id)), SessionID: s.id}
	if err := s.send.Send(msg); err != nil {
		s.log.Warn("sending recorder.join failed", "err", err)
		s.finish("")
		return
	}
	s.state = stJoining
	s.joinGen++
	gen := s.joinGen
	s.joinTimer = time.AfterFunc(s.deps.JoinTimeout, func() { s.push(event{kind: evJoinTimeout, gen: gen}) })
}

// finish stops the session: optional recorder.leave, close the peer connection, finalise the file
// and submit it for upload (an empty file is deleted by the recorder and not uploaded).
func (s *Session) finish(leaveReason string) {
	if s.state == stDone {
		return
	}
	if leaveReason != "" && (s.state == stJoined || s.state == stPaused) {
		msg := signal.RecorderLeave{Envelope: signal.NewEnvelope(signal.TRecorderLeave, ""), SessionID: s.id, Reason: leaveReason}
		if err := s.send.Send(msg); err != nil {
			s.log.Warn("sending recorder.leave failed", "err", err)
		} else {
			s.log.Info("recorder.leave sent", "reason", leaveReason)
		}
	}
	stopTimer(s.joinTimer)
	s.closePC()
	s.state = stDone
	res := s.rec.Close()
	if res.Err != nil {
		s.log.Error("recording had a disk error", "err", res.Err)
	}
	if res.Empty {
		s.log.Info("nothing recorded; no upload")
		return
	}
	s.log.Info("recording finalised", "durationMs", res.DurationMs, "blocks", res.Blocks)
	s.deps.Uploader.Submit(upload.Job{SessionID: s.id, RecorderID: s.deps.Cfg.RecorderID, Mime: res.Mime, DurationMs: res.DurationMs})
}

func stopTimer(t *time.Timer) {
	if t != nil {
		t.Stop()
	}
}

func joinID(sessionID string) string  { return "join:" + sessionID }
func offerID(sessionID string) string { return "offer:" + sessionID }
