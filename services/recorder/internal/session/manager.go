package session

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/indiansassist/recorder/internal/signal"
	"github.com/indiansassist/recorder/internal/store"
)

// Manager owns the sessions of one signaling connection (one api node, H5). It implements
// signal.Handler.
type Manager struct {
	deps *Deps
	log  *slog.Logger

	mu       sync.Mutex
	sender   signal.Sender
	sessions map[string]*Session
}

// NewManager creates a Manager; log should already carry the `signal` host.
func NewManager(d *Deps, log *slog.Logger) *Manager {
	if d.JoinTimeout <= 0 {
		d.JoinTimeout = 15 * time.Second
	}
	if d.TrackTimeout <= 0 {
		d.TrackTimeout = 20 * time.Second
	}
	if d.MaxRestarts <= 0 {
		d.MaxRestarts = 3
	}
	return &Manager{deps: d, log: log, sessions: map[string]*Session{}}
}

// OnReady stores the live connection.
func (m *Manager) OnReady(s signal.Sender, _ *signal.RecorderHelloOK) {
	m.mu.Lock()
	m.sender = s
	m.mu.Unlock()
}

// OnLost finalises and uploads every session of the lost connection (no mid-session re-join).
func (m *Manager) OnLost(error) {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.sessions = map[string]*Session{}
	m.sender = nil
	m.mu.Unlock()
	for _, s := range list {
		s.push(event{kind: evLost})
	}
}

// OnMessage routes a server frame to its session.
func (m *Manager) OnMessage(msg signal.Message) {
	switch v := msg.(type) {
	case *signal.RecorderAssign:
		m.assign(v)
	case *signal.RecorderJoined:
		m.route(v.SessionID, event{kind: evJoined, resume: v.Resume})
	case *signal.RecorderPause:
		m.route(v.SessionID, event{kind: evPause})
	case *signal.WebRTCAnswer:
		m.route(v.SessionID, event{kind: evAnswer, sdp: v.SDP})
	case *signal.WebRTCIce:
		m.route(v.SessionID, event{kind: evICE, cand: v.Candidate})
	case *signal.SessionEnded:
		m.route(v.SessionID, event{kind: evEnded})
	case *signal.Error:
		switch {
		case strings.HasPrefix(v.Re, "join:"):
			m.log.Warn("server refused recorder.join", "sessionId", strings.TrimPrefix(v.Re, "join:"), "code", v.Code)
			m.route(strings.TrimPrefix(v.Re, "join:"), event{kind: evJoinError, code: v.Code})
		case strings.HasPrefix(v.Re, "offer:"):
			m.log.Warn("server refused webrtc.offer", "sessionId", strings.TrimPrefix(v.Re, "offer:"), "code", v.Code)
		default:
			m.log.Warn("signaling error", "code", v.Code, "message", v.Message, "re", v.Re)
		}
	default:
		m.log.Debug("ignoring message", "t", msg.Type())
	}
}

func (m *Manager) assign(a *signal.RecorderAssign) {
	if !store.ValidSessionID(a.SessionID) {
		m.log.Warn("recorder.assign with an invalid sessionId")
		return
	}
	m.mu.Lock()
	if s, ok := m.sessions[a.SessionID]; ok {
		m.mu.Unlock()
		s.push(event{kind: evAssign, resume: a.Resume})
		return
	}
	if m.sender == nil {
		m.mu.Unlock()
		return
	}
	if len(m.sessions) >= m.deps.Cfg.MaxSessions {
		m.mu.Unlock()
		m.log.Warn("recorder.assign over MAX_SESSIONS; ignored", "sessionId", a.SessionID, "max", m.deps.Cfg.MaxSessions)
		return
	}
	s := newSession(a.SessionID, m.deps, m.sender, m.log, m.remove)
	m.sessions[a.SessionID] = s
	m.mu.Unlock()
	s.log.Info("recorder.assign received", "region", a.Region, "tier", a.Tier, "recordingMode", a.RecordingMode, "resume", a.Resume)
	go s.run()
	s.push(event{kind: evAssign, resume: a.Resume})
}

func (m *Manager) route(sessionID string, ev event) {
	m.mu.Lock()
	s := m.sessions[sessionID]
	m.mu.Unlock()
	if s == nil {
		m.log.Debug("message for an unknown session", "sessionId", sessionID)
		return
	}
	s.push(ev)
}

func (m *Manager) remove(s *Session) {
	m.mu.Lock()
	if m.sessions[s.id] == s {
		delete(m.sessions, s.id)
	}
	m.mu.Unlock()
}

// Count is the number of sessions held on this connection.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// Shutdown sends recorder.leave {shutdown} for every session, finalises them and waits (bounded by
// ctx) until each has handed its file to the uploader.
func (m *Manager) Shutdown(ctx context.Context) {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	for _, s := range list {
		s.push(event{kind: evShutdown})
	}
	for _, s := range list {
		select {
		case <-s.Done():
		case <-ctx.Done():
			return
		}
	}
}
