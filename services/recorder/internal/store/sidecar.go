// Package store manages the per-recording working files in OUT_DIR: `<stem>.webm` and the
// `<stem>.json` sidecar (docs/specs/phase-a2-recorder.md section 9). The stem is the sessionId for a
// Desk recording and the cameraId for a camera recording (Phase F 6.5a).
package store

import (
	"encoding/json"
	"errors"
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

// SourceCamera is the Sidecar.Source of a camera recording; Desk recordings leave Source empty.
const SourceCamera = "camera"

var (
	sessionRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	cameraRe  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// ValidSessionID reports whether id is a uuid (and therefore safe as a file name).
func ValidSessionID(id string) bool { return sessionRe.MatchString(id) }

// ValidCameraID reports whether id is a lower-case uuid (the contract's uuidSchema).
func ValidCameraID(id string) bool { return cameraRe.MatchString(id) }

// Sidecar is the JSON next to each recording. DurationMs and Blocks are recorder-internal progress
// fields (used by restart recovery); the contract fields are the first five. Source and CameraID are
// set (together) only for a camera recording, so a Desk sidecar keeps its pre-Phase F bytes.
type Sidecar struct {
	SessionID  string `json:"sessionId"`
	RecorderID string `json:"recorderId"`
	StartedAt  string `json:"startedAt"`
	Mime       string `json:"mime"`
	State      string `json:"state"`
	DurationMs int64  `json:"durationMs,omitempty"`
	Blocks     int64  `json:"blocks,omitempty"`
	Error      string `json:"error,omitempty"`
	Source     string `json:"source,omitempty"`
	CameraID   string `json:"cameraId,omitempty"`
}

// Stem is the file stem of the recording: the cameraId of a camera recording, else the sessionId.
func (s *Sidecar) Stem() string {
	if s.Source == SourceCamera {
		return s.CameraID
	}
	return s.SessionID
}

// validate checks the ids that end up in file names and the source / cameraId pairing.
func (s *Sidecar) validate() error {
	if !ValidSessionID(s.SessionID) {
		return errors.New("store: invalid sessionId")
	}
	switch s.Source {
	case "":
		if s.CameraID != "" {
			return errors.New("store: cameraId without source camera")
		}
	case SourceCamera:
		if !ValidCameraID(s.CameraID) {
			return errors.New("store: invalid cameraId")
		}
	default:
		return errors.New("store: unknown source")
	}
	return nil
}

// MediaPath is OUT_DIR/<stem>.webm.
func MediaPath(dir, stem string) string { return filepath.Join(dir, stem+".webm") }

// SidecarPath is OUT_DIR/<stem>.json.
func SidecarPath(dir, stem string) string { return filepath.Join(dir, stem+".json") }

// NewSidecar starts a sidecar in state recording.
func NewSidecar(sessionID, recorderID, mime string, started time.Time) *Sidecar {
	return &Sidecar{
		SessionID: sessionID, RecorderID: recorderID, Mime: mime, State: StateRecording,
		StartedAt: started.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
}

// NewCameraSidecar starts the sidecar of a camera recording (stem = cameraId).
func NewCameraSidecar(sessionID, cameraID, recorderID, mime string, started time.Time) *Sidecar {
	s := NewSidecar(sessionID, recorderID, mime, started)
	s.Source, s.CameraID = SourceCamera, cameraID
	return s
}

// Write stores the sidecar atomically (temp file + rename).
func Write(dir string, s *Sidecar) error {
	if err := s.validate(); err != nil {
		return err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	final := SidecarPath(dir, s.Stem())
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

// Read loads OUT_DIR/<stem>.json; the stem must be the sidecar's own (sessionId for a Desk
// recording, cameraId for a camera recording).
func Read(dir, stem string) (*Sidecar, error) {
	b, err := os.ReadFile(SidecarPath(dir, stem))
	if err != nil {
		return nil, err
	}
	var s Sidecar
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	if err := s.validate(); err != nil {
		return nil, err
	}
	if s.Stem() != stem {
		return nil, errors.New("store: sidecar stem mismatch")
	}
	return &s, nil
}

// SetState rewrites the sidecar with a new state (and optional error text).
func SetState(dir, stem, state, errText string) error {
	s, err := Read(dir, stem)
	if err != nil {
		return err
	}
	s.State, s.Error = state, errText
	return Write(dir, s)
}

// Remove deletes the media file and the sidecar; missing files are not an error.
func Remove(dir, stem string) error {
	var errs []error
	for _, p := range []string{MediaPath(dir, stem), SidecarPath(dir, stem)} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// List returns every readable sidecar in dir (Desk and camera recordings).
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
		stem := strings.TrimSuffix(name, ".json")
		if !ValidSessionID(stem) {
			continue
		}
		if s, err := Read(dir, stem); err == nil {
			out = append(out, s)
		}
	}
	return out, nil
}
