// Package peer builds the recorder's receive-only pion PeerConnection (docs/specs/phase-a2-recorder.md N1).
package peer

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"

	"github.com/indiansassist/recorder/internal/media"
)

// Options configures every peer connection of the process.
type Options struct {
	UDPPortMin, UDPPortMax uint16
	NAT1To1IPs             []string
	// LoopbackOnly restricts ICE to 127.0.0.1 host candidates (tests).
	LoopbackOnly bool
	// GatherTimeout bounds the wait for ICE gathering before the offer is sent.
	GatherTimeout time.Duration
}

// Payload types used in the offer.
const (
	ptVP8  = 96
	ptVP9  = 98
	ptOpus = 111
)

var videoFeedback = []webrtc.RTCPFeedback{
	{Type: "goog-remb"},
	{Type: webrtc.TypeRTCPFBNACK},
	{Type: webrtc.TypeRTCPFBNACK, Parameter: "pli"},
}

// NewMediaEngine registers VP8 (preferred) and VP9 video and Opus 48 kHz / 2 ch audio. When
// onlyVideo is set ("vp8" or "vp9") only that video codec is offered: a resumed session keeps the
// codec of its open file.
func NewMediaEngine(onlyVideo string) (*webrtc.MediaEngine, error) {
	m := &webrtc.MediaEngine{}
	type vc struct {
		name string
		cap  webrtc.RTPCodecCapability
		pt   webrtc.PayloadType
	}
	videos := []vc{
		{media.CodecVP8, webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: videoFeedback}, ptVP8},
		{media.CodecVP9, webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP9, ClockRate: 90000, SDPFmtpLine: "profile-id=0", RTCPFeedback: videoFeedback}, ptVP9},
	}
	for _, v := range videos {
		if onlyVideo != "" && onlyVideo != v.name {
			continue
		}
		if err := m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: v.cap, PayloadType: v.pt}, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, err
		}
	}
	opus := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: opus, PayloadType: ptOpus}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	return m, nil
}

// NewAPI builds a pion API with the default interceptors (NACK generator / responder, RTCP
// reports, TWCC) and the process ICE settings.
func NewAPI(o Options, onlyVideo string) (*webrtc.API, error) {
	m, err := NewMediaEngine(onlyVideo)
	if err != nil {
		return nil, err
	}
	reg := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, reg); err != nil {
		return nil, err
	}
	se := webrtc.SettingEngine{}
	se.SetICETimeouts(5*time.Second, 15*time.Second, 2*time.Second)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	if o.UDPPortMin != 0 {
		if err := se.SetEphemeralUDPPortRange(o.UDPPortMin, o.UDPPortMax); err != nil {
			return nil, err
		}
	}
	if len(o.NAT1To1IPs) > 0 {
		if err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External: o.NAT1To1IPs, AsCandidateType: webrtc.ICECandidateTypeHost, Mode: webrtc.ICEAddressRewriteReplace,
		}); err != nil {
			return nil, err
		}
	}
	if o.LoopbackOnly {
		se.SetIncludeLoopbackCandidate(true)
		se.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() && ip.To4() != nil })
		se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(reg), webrtc.WithSettingEngine(se)), nil
}

// NewReceiver creates the receive-only peer connection: a video transceiver then an audio
// transceiver, both recvonly, and no data channel (S4).
func NewReceiver(o Options, onlyVideo string, iceServers []webrtc.ICEServer) (*webrtc.PeerConnection, error) {
	api, err := NewAPI(o, onlyVideo)
	if err != nil {
		return nil, err
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: iceServers, BundlePolicy: webrtc.BundlePolicyMaxBundle})
	if err != nil {
		return nil, err
	}
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if _, err := pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			_ = pc.Close()
			return nil, err
		}
	}
	return pc, nil
}

// Offer creates the offer, sets it as the local description and waits for ICE gathering to
// complete (non-trickle, N1). It returns the SDP to send.
func Offer(ctx context.Context, pc *webrtc.PeerConnection, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return "", fmt.Errorf("create offer: %w", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return "", fmt.Errorf("set local description: %w", err)
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case <-gathered:
	case <-t.C: // send what was gathered so far; trickle is not used by the recorder
	case <-ctx.Done():
		return "", ctx.Err()
	}
	ld := pc.LocalDescription()
	if ld == nil {
		return "", errors.New("no local description")
	}
	return ld.SDP, nil
}
