package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	sid   = "6f1c2b9e-1d2a-4c3b-9a8f-0e1d2c3b4a59"
	camID = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b0a"
)

var started = time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)

func TestDeskSidecarBytesUnchanged(t *testing.T) {
	dir := t.TempDir()
	if err := Write(dir, NewSidecar(sid, "rec-1", `video/webm;codecs="vp8,opus"`, started)); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(SidecarPath(dir, sid))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"sessionId":"` + sid + `","recorderId":"rec-1","startedAt":"2026-11-02T10:00:00.000Z","mime":"video/webm;codecs=\"vp8,opus\"","state":"recording"}`
	if string(b) != want {
		t.Fatalf("desk sidecar:\n got  %s\n want %s", b, want)
	}
}

func TestCameraSidecarRoundTrip(t *testing.T) {
	dir := t.TempDir()
	sc := NewCameraSidecar(sid, camID, "rec-1", `video/webm;codecs="vp8"`, started)
	if sc.Stem() != camID {
		t.Fatalf("stem %s", sc.Stem())
	}
	if err := Write(dir, sc); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, camID+".json")); err != nil {
		t.Fatalf("camera sidecar not stored under the cameraId: %v", err)
	}
	if _, err := os.Stat(SidecarPath(dir, sid)); err == nil {
		t.Fatal("camera sidecar stored under the sessionId")
	}
	b, _ := os.ReadFile(SidecarPath(dir, camID))
	if !strings.Contains(string(b), `"source":"camera"`) || !strings.Contains(string(b), `"cameraId":"`+camID+`"`) {
		t.Fatalf("camera sidecar %s", b)
	}
	got, err := Read(dir, camID)
	if err != nil || got.SessionID != sid || got.CameraID != camID || got.Source != SourceCamera || got.State != StateRecording {
		t.Fatalf("read %+v %v", got, err)
	}
	if err := SetState(dir, camID, StateFinalised, ""); err != nil {
		t.Fatal(err)
	}
	if got, _ := Read(dir, camID); got.State != StateFinalised {
		t.Fatalf("state %s", got.State)
	}
	// A camera sidecar copied under the sessionId's name is refused (the stem must be the cameraId).
	if err := os.WriteFile(SidecarPath(dir, sid), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(dir, sid); err == nil {
		t.Fatal("camera sidecar accepted under the sessionId stem")
	}
	_ = os.Remove(SidecarPath(dir, sid))
	if err := Remove(dir, camID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(SidecarPath(dir, camID)); err == nil {
		t.Fatal("camera sidecar not removed")
	}
}

func TestSidecarValidation(t *testing.T) {
	dir := t.TempDir()
	bad := []*Sidecar{
		{SessionID: sid, CameraID: camID},                                        // cameraId without source
		{SessionID: sid, Source: SourceCamera},                                   // source without cameraId
		{SessionID: sid, Source: SourceCamera, CameraID: strings.ToUpper(camID)}, // not lower-case
		{SessionID: sid, Source: "screen"},                                       // unknown source
		{SessionID: "../x", Source: SourceCamera, CameraID: camID},               // bad sessionId
	}
	for i, sc := range bad {
		if err := Write(dir, sc); err == nil {
			t.Errorf("case %d accepted: %+v", i, sc)
		}
	}
}

func TestListDeskAndCamera(t *testing.T) {
	dir := t.TempDir()
	if err := Write(dir, NewSidecar(sid, "rec-1", "m", started)); err != nil {
		t.Fatal(err)
	}
	if err := Write(dir, NewCameraSidecar(sid, camID, "rec-1", "m", started)); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "notes.json"), []byte("{}"), 0o600)
	list, err := List(dir)
	if err != nil || len(list) != 2 {
		t.Fatalf("list %d %v", len(list), err)
	}
	var desk, cam int
	for _, sc := range list {
		switch {
		case sc.Source == "" && sc.Stem() == sid:
			desk++
		case sc.Source == SourceCamera && sc.Stem() == camID && sc.SessionID == sid:
			cam++
		}
	}
	if desk != 1 || cam != 1 {
		t.Fatalf("desk %d camera %d", desk, cam)
	}
}
