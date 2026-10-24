// Package signal implements the recorder side of the `/signal` WebSocket protocol
// (docs/specs/phase-a-contracts.md 7.1-7.2, docs/specs/phase-a2-recorder.md sections 4 and 5).
package signal

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Message type names (`t`).
const (
	TRecorderHello   = "recorder.hello"
	TRecorderHelloOK = "recorder.hello.ok"
	TRecorderAssign  = "recorder.assign"
	TRecorderJoin    = "recorder.join"
	TRecorderJoined  = "recorder.joined"
	TRecorderPause   = "recorder.pause"
	TRecorderLeave   = "recorder.leave"
	TWebRTCOffer     = "webrtc.offer"
	TWebRTCAnswer    = "webrtc.answer"
	TWebRTCIce       = "webrtc.ice"
	TSessionEnded    = "session.ended"
	TError           = "error"
	TPing            = "ping"
	TPong            = "pong"
)

// PeerRecorder is the `peer` value of relayed webrtc.* frames to / from the recorder (N2).
const PeerRecorder = "recorder"

// RecorderStopReason values (RECORDER_STOP_REASONS).
const (
	ReasonTrackEnded   = "track_ended"
	ReasonMediaFailed  = "media_failed"
	ReasonLimitReached = "limit_reached"
	ReasonDiskError    = "disk_error"
	ReasonShutdown     = "shutdown"
)

// Envelope holds the A 7.1 common fields. Every message embeds it.
type Envelope struct {
	T  string `json:"t"`
	ID string `json:"id,omitempty"`
	Re string `json:"re,omitempty"`
	Ts *int64 `json:"ts,omitempty"`
}

// Type returns `t`.
func (e Envelope) Type() string { return e.T }

// RecorderHello is R->S, the first frame (H1).
type RecorderHello struct {
	Envelope
	Token       string `json:"token"`
	RecorderID  string `json:"recorderId"`
	Version     string `json:"version"`
	Region      string `json:"region"`
	MaxSessions int    `json:"maxSessions,omitempty"`
}

// RecorderHelloOK is S->R (H2).
type RecorderHelloOK struct {
	Envelope
	ConnectionID string   `json:"connectionId"`
	NodeID       string   `json:"nodeId"`
	Regions      []string `json:"regions"`
}

// RecorderAssign is S->R (section 6 A1 / A3).
type RecorderAssign struct {
	Envelope
	SessionID     string `json:"sessionId"`
	OrgID         string `json:"orgId"`
	Region        string `json:"region"`
	Tier          string `json:"tier"`
	RecordingMode string `json:"recordingMode"`
	Resume        bool   `json:"resume"`
	DeadlineAt    string `json:"deadlineAt"`
}

// RecorderJoin is R->S.
type RecorderJoin struct {
	Envelope
	SessionID string `json:"sessionId"`
}

// RecorderJoined is S->R.
type RecorderJoined struct {
	Envelope
	SessionID string `json:"sessionId"`
	Resume    bool   `json:"resume"`
}

// RecorderPause is S->R; Reason is always `consent_pending`.
type RecorderPause struct {
	Envelope
	SessionID string `json:"sessionId"`
	Reason    string `json:"reason"`
}

// RecorderLeave is R->S; no reply.
type RecorderLeave struct {
	Envelope
	SessionID string `json:"sessionId"`
	Reason    string `json:"reason"`
}

// WebRTCOffer is the A 7.3 offer plus optional `peer`.
type WebRTCOffer struct {
	Envelope
	SessionID string `json:"sessionId"`
	SDP       string `json:"sdp"`
	Restart   bool   `json:"restart,omitempty"`
	Peer      string `json:"peer,omitempty"`
}

// WebRTCAnswer is the A 7.3 answer plus optional `peer`.
type WebRTCAnswer struct {
	Envelope
	SessionID string `json:"sessionId"`
	SDP       string `json:"sdp"`
	Peer      string `json:"peer,omitempty"`
}

// ICECandidateInit is RTCIceCandidateInit (iceCandidateInitSchema).
type ICECandidateInit struct {
	Candidate        string  `json:"candidate,omitempty"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// WebRTCIce carries one trickled candidate; Candidate nil = end of candidates (JSON null).
type WebRTCIce struct {
	Envelope
	SessionID string            `json:"sessionId"`
	Candidate *ICECandidateInit `json:"candidate"`
	Peer      string            `json:"peer,omitempty"`
}

// UserRef is `{ id, name }`.
type UserRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SessionEnded is the A 7.3 shape plus optional serverRecording. Only SessionID is acted on.
type SessionEnded struct {
	Envelope
	SessionID        string          `json:"sessionId"`
	EndReason        string          `json:"endReason"`
	EndedAt          string          `json:"endedAt"`
	StartedAt        *string         `json:"startedAt"`
	DurationMs       *int64          `json:"durationMs"`
	HashChainTail    *string         `json:"hashChainTail"`
	Assist           *UserRef        `json:"assist,omitempty"`
	Surface          json.RawMessage `json:"surface,omitempty"`
	RecordingStarted bool            `json:"recordingStarted"`
	ReachedActive    bool            `json:"reachedActive"`
	ServerRecording  *bool           `json:"serverRecording,omitempty"`
}

// Error is the `error` frame.
type Error struct {
	Envelope
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// Ping is the JSON heartbeat; the recorder must answer it with Pong.
type Ping struct{ Envelope }

// Pong answers Ping.
type Pong struct{ Envelope }

// Unknown is any other `t`; it is ignored by the recorder.
type Unknown struct {
	Envelope
	Raw json.RawMessage `json:"-"`
}

// Message is any decoded frame.
type Message interface{ Type() string }

// ErrNoType is returned for frames without a string `t`.
var ErrNoType = errors.New("signal: frame has no t")

// Decode parses one text frame. Unknown `t` values return *Unknown and no error.
func Decode(data []byte) (Message, error) {
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("signal: bad frame: %w", err)
	}
	if env.T == "" {
		return nil, ErrNoType
	}
	var m Message
	switch env.T {
	case TRecorderHello:
		m = &RecorderHello{}
	case TRecorderHelloOK:
		m = &RecorderHelloOK{}
	case TRecorderAssign:
		m = &RecorderAssign{}
	case TRecorderJoin:
		m = &RecorderJoin{}
	case TRecorderJoined:
		m = &RecorderJoined{}
	case TRecorderPause:
		m = &RecorderPause{}
	case TRecorderLeave:
		m = &RecorderLeave{}
	case TWebRTCOffer:
		m = &WebRTCOffer{}
	case TWebRTCAnswer:
		m = &WebRTCAnswer{}
	case TWebRTCIce:
		m = &WebRTCIce{}
	case TSessionEnded:
		m = &SessionEnded{}
	case TError:
		m = &Error{}
	case TPing:
		m = &Ping{}
	case TPong:
		m = &Pong{}
	default:
		return &Unknown{Envelope: env, Raw: append(json.RawMessage(nil), data...)}, nil
	}
	if err := json.Unmarshal(data, m); err != nil {
		return nil, fmt.Errorf("signal: bad %s: %w", env.T, err)
	}
	return m, nil
}

// SessionOf returns the sessionId a message refers to, or "".
func SessionOf(m Message) string {
	switch v := m.(type) {
	case *RecorderAssign:
		return v.SessionID
	case *RecorderJoined:
		return v.SessionID
	case *RecorderPause:
		return v.SessionID
	case *WebRTCAnswer:
		return v.SessionID
	case *WebRTCOffer:
		return v.SessionID
	case *WebRTCIce:
		return v.SessionID
	case *SessionEnded:
		return v.SessionID
	}
	return ""
}

// NewEnvelope builds the envelope of an outgoing message.
func NewEnvelope(t, id string) Envelope { return Envelope{T: t, ID: id} }
