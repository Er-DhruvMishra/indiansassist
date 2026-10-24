// Package store manages the per-session working files in OUT_DIR: `<sessionId>.webm` and the
// `<sessionId>.json` sidecar (docs/specs/phase-a2-recorder.md section 9).
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Sidecar states.
const (
	StateRecording = "recording"
	StateFinalised = "finalised"
	StateUploaded  = "uploaded"
	StateFailed    = "failed"
)

var sessionRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ValidSessionID reports whether id is a uuid (and therefore safe as a file name).
func ValidSessionID(id string) bool { return sessionRe.MatchString(id) }

// Sidecar is the JSON next to each recording. DurationMs and Blocks are recorder-internal progress
// fields (used by restart recovery); the contract fields are the first five.
type Sidecar struct {
	SessionID  string `json:"sessionId"`
	RecorderID string `json:"recorderId"`
	StartedAt  string `json:"startedAt"`
	Mime       string `json:"mime"`
	State      string `json:"state"`
	DurationMs int64  `json:"durationMs,omitempty"`
	Blocks     int64  `json:"blocks,omitempty"`
	Error      string `json:"error,omitempty"`
}

// MediaPath is OUT_DIR/<sessionId>.webm.
func MediaPath(dir, sessionID string) string { return filepath.Join(dir, sessionID+".webm") }

// SidecarPath is OUT_DIR/<sessionId>.json.
func SidecarPath(dir, sessionID string) string { return filepath.Join(dir, sessionID+".json") }

// NewSidecar starts a sidecar in state recording.
func NewSidecar(sessionID, recorderID, mime string, started time.Time) *Sidecar {
	return &Sidecar{
		SessionID: sessionID, RecorderID: recorderID, Mime: mime, State: StateRecording,
		StartedAt: started.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
}

// Write stores the sidecar atomically (temp file + rename).
func Write(dir string, s *Sidecar) error {
	if !ValidSessionID(s.SessionID) {
		return fmt.Errorf("store: invalid sessionId")
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	final := SidecarPath(dir, s.SessionID)
	tmp := final + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, final)
}

// Read loads OUT_DIR/<sessionId>.json.
func Read(dir, sessionID string) (*Sidecar, error) {
	b, err := os.ReadFile(SidecarPath(dir, sessionID))
	if err != nil {
		return nil, err
	}
	var s Sidecar
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	if s.SessionID != sessionID {
		return nil, errors.New("store: sidecar sessionId mismatch")
	}
	return &s, nil
}

// SetState rewrites the sidecar with a new state (and optional error text).
func SetState(dir, sessionID, state, errText string) error {
	s, err := Read(dir, sessionID)
	if err != nil {
		return err
	}
	s.State, s.Error = state, errText
	return Write(dir, s)
}

// Remove deletes the media file and the sidecar; missing files are not an error.
func Remove(dir, sessionID string) error {
	var errs []error
	for _, p := range []string{MediaPath(dir, sessionID), SidecarPath(dir, sessionID)} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// List returns every readable sidecar in dir.
func List(dir string) ([]*Sidecar, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []*Sidecar
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !ValidSessionID(id) {
			continue
		}
		if s, err := Read(dir, id); err == nil {
			out = append(out, s)
		}
	}
	return out, nil
}
