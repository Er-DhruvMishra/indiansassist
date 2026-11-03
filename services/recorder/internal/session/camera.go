package session

import (
	"context"
	"log/slog"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/indiansassist/recorder/internal/config"
	"github.com/indiansassist/recorder/internal/media"
	"github.com/indiansassist/recorder/internal/peer"
	"github.com/indiansassist/recorder/internal/signal"
	"github.com/indiansassist/recorder/internal/store"
	"github.com/indiansassist/recorder/internal/upload"
)

// cameraDisconnectGrace is how long a disconnected camera connection may take to recover before
// the camera recording is finalised. A variable so tests can shorten it.
var cameraDisconnectGrace = 5 * time.Second

// camera is the session's phone-camera sub-recording (Phase F 6.5a): a second receive-only peer
// connection (offered with `peer: "camera"`) and its own WebM, OUT_DIR/<cameraId>.webm. It has no
// restarts and no recorder.leave: when the phone's connection ends, the recording ends. It is owned
// by the session goroutine like the rest of the session state.
type camera struct {
	id         string
	gen        int
	log        *slog.Logger
	rec        *media.Recorder
	pc         *webrtc.PeerConnection
	cancel     context.CancelFunc
	remoteSet  bool
	pendingICE []webrtc.ICECandidateInit
	trackTimer *time.Timer
	discTimer  *time.Timer
}

// onCameraRequest handles recorder.camera.
func (s *Session) onCameraRequest(cameraID string) {
	if s.state != stJoined && s.state != stPaused {
		s.log.Debug("recorder.camera for a session that is not joined; ignored")
		return
	}
	if !store.ValidCameraID(cameraID) {
		s.log.Warn("recorder.camera with an invalid cameraId; ignored")
		return
	}
	if s.cam != nil && s.cam.id == cameraID {
		return // already recording this camera
	}
	if s.camDone[cameraID] {
		// Its file may still be uploading under the same name; a stopped camera is not restarted.
		s.log.Warn("recorder.camera for a camera already recorded in this session; ignored", "cameraId", cameraID)
		return
	}
	if s.cam != nil {
		s.finishCamera("replaced by another camera")
	}
	s.startCamera(cameraID)
}

// startCamera builds the camera's receive-only peer connection and sends its offer.
func (s *Session) startCamera(cameraID string) {
	log := s.log.With("cameraId", cameraID)
	iceCtx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	servers, err := s.deps.ICE.Get(iceCtx)
	cancel()
	if err != nil {
		log.Warn("ICE servers unavailable; using cached or host candidates only", "err", err)
	}
	pc, err := peer.NewReceiver(s.deps.Peer, "", servers)
	if err != nil {
		log.Error("creating the camera peer connection failed", "err", err)
		s.camDone[cameraID] = true
		return
	}
	s.camGen++
	gen := s.camGen
	pcCtx, pcCancel := context.WithCancel(s.ctx)
	c := &camera{
		id: cameraID, gen: gen, log: log, pc: pc, cancel: pcCancel,
		rec: media.NewRecorder(media.Options{
			Dir: s.deps.Cfg.OutDir, SessionID: s.id, CameraID: cameraID, RecorderID: s.deps.Cfg.RecorderID,
			MaxBytes: config.RecordingMaxBytes, MaxDuration: s.deps.Cfg.MaxDuration, Log: log,
		}),
	}
	s.cam = c

	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		s.push(event{kind: evCamPCState, gen: gen, pcState: st})
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		s.push(event{kind: evCamTrack, gen: gen})
		log.Info("camera track received", "kind", track.Kind().String(), "codec", track.Codec().MimeType)
		readTrack(pcCtx, pc, track, c.rec, log, func(k media.EventKind) { s.push(event{kind: evCamMedia, gen: gen, media: k}) })
	})

	sdp, err := peer.Offer(pcCtx, pc, s.deps.Peer.GatherTimeout)
	if err != nil {
		log.Error("creating the camera offer failed", "err", err)
		s.finishCamera("offer failed")
		return
	}
	msg := signal.WebRTCOffer{Envelope: signal.NewEnvelope(signal.TWebRTCOffer, camOfferID(s.id)), SessionID: s.id, SDP: sdp, Peer: signal.PeerCamera}
	if err := s.send.Send(msg); err != nil {
		log.Warn("sending the camera webrtc.offer failed", "err", err)
		return // the lost connection finalises the session and its camera
	}
	log.Info("camera offer sent")
	c.trackTimer = time.AfterFunc(s.deps.TrackTimeout, func() { s.push(event{kind: evCamNoTrack, gen: gen}) })
}

// handleCamera handles the camera events; stale generations are dropped.
func (s *Session) handleCamera(ev event) {
	switch ev.kind {
	case evCamera:
		s.onCameraRequest(ev.cameraID)
		return
	case evCamAnswer:
		s.onCameraAnswer(ev.sdp)
		return
	case evCamICE:
		s.onCameraICE(ev.cand)
		return
	case evCamRefused:
		if s.cam != nil && !s.cam.remoteSet {
			s.finishCamera("offer refused")
		}
		return
	}
	c := s.cam
	if c == nil || ev.gen != c.gen {
		return
	}
	switch ev.kind {
	case evCamPCState:
		c.log.Info("camera peer connection state", "state", ev.pcState.String())
		switch ev.pcState {
		case webrtc.PeerConnectionStateConnected:
			stopTimer(c.discTimer)
		case webrtc.PeerConnectionStateDisconnected:
			stopTimer(c.discTimer)
			gen := c.gen
			c.discTimer = time.AfterFunc(cameraDisconnectGrace, func() { s.push(event{kind: evCamDisconnected, gen: gen}) })
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			s.finishCamera("camera connection " + ev.pcState.String())
		}
	case evCamDisconnected:
		if c.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			s.finishCamera("camera connection did not recover")
		}
	case evCamTrack:
		stopTimer(c.trackTimer)
	case evCamNoTrack:
		c.log.Warn("no video track from the camera")
		s.finishCamera("no track")
	case evCamMedia:
		switch ev.media {
		case media.EventKeyframe:
			c.log.Info("first camera keyframe written")
		case media.EventKeyframeTimeout:
			s.finishCamera("no keyframe")
		case media.EventLimitReached:
			s.finishCamera("limit reached")
		case media.EventDiskError:
			s.finishCamera("disk error")
		case media.EventTrackEnded:
			s.finishCamera("track ended")
		}
	}
}

func (s *Session) onCameraAnswer(sdp string) {
	c := s.cam
	if c == nil || c.remoteSet {
		return
	}
	if err := c.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		c.log.Warn("applying the camera answer failed", "err", err)
		s.finishCamera("bad answer")
		return
	}
	c.remoteSet = true
	for _, cand := range c.pendingICE {
		if err := c.pc.AddICECandidate(cand); err != nil {
			c.log.Debug("adding a buffered camera candidate failed") // the error text may quote the candidate
		}
	}
	c.pendingICE = nil
}

func (s *Session) onCameraICE(cand *signal.ICECandidateInit) {
	c := s.cam
	if cand == nil || cand.Candidate == "" || c == nil {
		return
	}
	init := webrtc.ICECandidateInit{Candidate: cand.Candidate, SDPMid: cand.SDPMid, SDPMLineIndex: cand.SDPMLineIndex, UsernameFragment: cand.UsernameFragment}
	if !c.remoteSet {
		c.pendingICE = append(c.pendingICE, init)
		return
	}
	if err := c.pc.AddICECandidate(init); err != nil {
		c.log.Debug("adding a camera candidate failed") // the error text may quote the candidate
	}
}

// checkpointCamera stores the camera's progress and enforces MAX_DURATION on it (session ticker).
func (s *Session) checkpointCamera() {
	if s.cam == nil {
		return
	}
	s.cam.rec.Checkpoint()
	if s.cam.rec.Elapsed() >= s.deps.Cfg.MaxDuration {
		s.finishCamera("limit reached")
	}
}

// finishCamera closes the camera connection, finalises its file and submits it for upload (an
// empty file is deleted and not uploaded). The session itself keeps running.
func (s *Session) finishCamera(why string) {
	c := s.cam
	if c == nil {
		return
	}
	s.cam = nil
	s.camDone[c.id] = true
	stopTimer(c.trackTimer)
	stopTimer(c.discTimer)
	c.cancel()
	if err := c.pc.Close(); err != nil {
		c.log.Debug("closing the camera peer connection", "err", err)
	}
	res := c.rec.Close()
	if res.Err != nil {
		c.log.Error("camera recording had a disk error", "err", res.Err)
	}
	if res.Empty {
		c.log.Info("camera stopped; nothing recorded, no upload", "why", why)
		return
	}
	c.log.Info("camera recording finalised", "why", why, "durationMs", res.DurationMs, "blocks", res.Blocks)
	s.deps.Uploader.Submit(upload.Job{
		SessionID: s.id, RecorderID: s.deps.Cfg.RecorderID, Mime: res.Mime, DurationMs: res.DurationMs,
		Source: store.SourceCamera, CameraID: c.id,
	})
}

func camOfferID(sessionID string) string { return "camoffer:" + sessionID }
