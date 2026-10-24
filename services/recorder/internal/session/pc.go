package session

import (
	"context"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/indiansassist/recorder/internal/media"
	"github.com/indiansassist/recorder/internal/peer"
	"github.com/indiansassist/recorder/internal/signal"
)

// startPC builds a new receive-only peer connection and sends its offer (N1). restart marks an
// offer from a brand-new connection after a failure or a resume (N4, Y23).
func (s *Session) startPC(restart bool) {
	iceCtx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	servers, err := s.deps.ICE.Get(iceCtx)
	cancel()
	if err != nil {
		s.log.Warn("ICE servers unavailable; using cached or host candidates only", "err", err)
	}
	pc, err := peer.NewReceiver(s.deps.Peer, s.rec.Codec(), servers)
	if err != nil {
		s.log.Error("creating peer connection failed", "err", err)
		s.finish(signal.ReasonMediaFailed)
		return
	}
	s.pcGen++
	gen := s.pcGen
	pcCtx, pcCancel := context.WithCancel(s.ctx)
	s.pc, s.pcCancel, s.remoteSet, s.pendingICE = pc, pcCancel, false, nil

	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		s.push(event{kind: evPCState, gen: gen, pcState: st})
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		s.onTrack(pcCtx, gen, pc, track)
	})

	sdp, err := peer.Offer(pcCtx, pc, s.deps.Peer.GatherTimeout)
	if err != nil {
		s.log.Error("creating offer failed", "err", err)
		s.finish(signal.ReasonMediaFailed)
		return
	}
	msg := signal.WebRTCOffer{Envelope: signal.NewEnvelope(signal.TWebRTCOffer, offerID(s.id)), SessionID: s.id, SDP: sdp, Restart: restart}
	if err := s.send.Send(msg); err != nil {
		s.log.Warn("sending webrtc.offer failed", "err", err)
		return // the lost connection finalises the session
	}
	s.log.Info("offer sent", "restart", restart, "attempt", s.restarts)
	s.trackTimer = time.AfterFunc(s.deps.TrackTimeout, func() { s.push(event{kind: evNoTrack, gen: gen}) })
}

// onTrack runs in pion's track goroutine and reads the track until it ends.
func (s *Session) onTrack(ctx context.Context, gen int, pc *webrtc.PeerConnection, track *webrtc.TrackRemote) {
	kind := track.Kind()
	s.push(event{kind: evTrack, gen: gen})
	s.log.Info("track received", "kind", kind.String(), "codec", track.Codec().MimeType)
	o := media.TrackOptions{
		Rec:      s.rec,
		Ctx:      ctx,
		Log:      s.log,
		MimeType: track.Codec().MimeType,
		OnEvent:  func(k media.EventKind) { s.push(event{kind: evMedia, gen: gen, media: k}) },
	}
	read := func() (*rtp.Packet, error) {
		p, _, err := track.ReadRTP()
		return p, err
	}
	if kind == webrtc.RTPCodecTypeVideo {
		ssrc := uint32(track.SSRC())
		o.SendPLI = func() error {
			return pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}})
		}
		media.ReadVideo(read, o)
		return
	}
	media.ReadAudio(read, o)
}

func (s *Session) onAnswer(sdp string) {
	if s.pc == nil || s.state != stJoined || s.remoteSet {
		return
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		s.log.Warn("applying the answer failed", "err", err)
		s.pcFailed()
		return
	}
	s.remoteSet = true
	for _, c := range s.pendingICE {
		if err := s.pc.AddICECandidate(c); err != nil {
			s.log.Debug("adding a buffered candidate failed") // the error text may quote the candidate
		}
	}
	s.pendingICE = nil
}

func (s *Session) onICE(c *signal.ICECandidateInit) {
	if c == nil || c.Candidate == "" || s.pc == nil {
		return // end-of-candidates or no connection
	}
	init := webrtc.ICECandidateInit{Candidate: c.Candidate, SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex, UsernameFragment: c.UsernameFragment}
	if !s.remoteSet {
		s.pendingICE = append(s.pendingICE, init)
		return
	}
	if err := s.pc.AddICECandidate(init); err != nil {
		s.log.Debug("adding a candidate failed") // the error text may quote the candidate
	}
}

// pcFailed rebuilds the connection with a fresh offer at most MaxRestarts times per join, then
// gives up with recorder.leave media_failed (N4).
func (s *Session) pcFailed() {
	if s.state != stJoined {
		return
	}
	if s.restarts >= s.deps.MaxRestarts {
		s.log.Warn("peer connection failed; giving up", "restarts", s.restarts)
		s.finish(signal.ReasonMediaFailed)
		return
	}
	s.restarts++
	s.log.Warn("peer connection failed; sending a fresh offer", "restart", s.restarts)
	s.closePC()
	s.startPC(true)
}

// closePC closes the current peer connection; the file writer stays open.
func (s *Session) closePC() {
	stopTimer(s.trackTimer)
	if s.pc == nil {
		return
	}
	s.pcCancel()
	if err := s.pc.Close(); err != nil {
		s.log.Debug("closing peer connection", "err", err)
	}
	s.pc, s.remoteSet, s.pendingICE = nil, false, nil
	s.pcGen++
}
