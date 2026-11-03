package media

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/at-wat/ebml-go"
	"github.com/at-wat/ebml-go/webm"

	"github.com/indiansassist/recorder/internal/store"
)

const testSID = "6f1c2b9e-1d2a-4c3b-9a8f-0e1d2c3b4a59"

// SyntheticVP8 builds a VP8 frame: keyframes carry the start code and a 640x480 size (RFC 6386 9.1).
func SyntheticVP8(key bool, n int) []byte {
	b := make([]byte, n)
	tag := uint32(1<<4) | uint32(10)<<5 // show_frame, first_part_size 10
	if !key {
		tag |= 1
	}
	b[0], b[1], b[2] = byte(tag), byte(tag>>8), byte(tag>>16)
	if key {
		b[3], b[4], b[5] = 0x9d, 0x01, 0x2a
		binary.LittleEndian.PutUint16(b[6:], 640)
		binary.LittleEndian.PutUint16(b[8:], 480)
	}
	for i := 10; i < n; i++ {
		b[i] = byte(i)
	}
	return b
}

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func parseWebM(t *testing.T, path string) (webm.EBMLHeader, webm.Segment) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var doc struct {
		Header  webm.EBMLHeader `ebml:"EBML"`
		Segment webm.Segment    `ebml:"Segment"`
	}
	if err := ebml.Unmarshal(f, &doc); err != nil {
		t.Fatalf("parse webm: %v", err)
	}
	return doc.Header, doc.Segment
}

func TestKeyframeDetection(t *testing.T) {
	if !IsKeyframe(CodecVP8, SyntheticVP8(true, 40)) || IsKeyframe(CodecVP8, SyntheticVP8(false, 40)) {
		t.Fatal("vp8 keyframe bit")
	}
	if w, h := Dimensions(CodecVP8, SyntheticVP8(true, 40)); w != 640 || h != 480 {
		t.Fatalf("vp8 dims %dx%d", w, h)
	}
	// VP9 profile 0 keyframe: marker 10, profile 00, show_existing 0, frame_type 0, show 1, err_res 0,
	// sync 49 83 42, color_space 000 (BT.601), color_range 0, width-1 = 1279, height-1 = 719.
	vp9 := []byte{0x82, 0x49, 0x83, 0x42, 0x00, 0x4f, 0xf0, 0x2c, 0xf0}
	if !IsKeyframe(CodecVP9, vp9) {
		t.Fatal("vp9 keyframe")
	}
	if w, h := Dimensions(CodecVP9, vp9); w != 1280 || h != 720 {
		t.Fatalf("vp9 dims %dx%d", w, h)
	}
	if IsKeyframe(CodecVP9, []byte{0x86}) { // frame_type 1
		t.Fatal("vp9 inter frame reported as key")
	}
}

func TestRecorderWritesWebM(t *testing.T) {
	dir := t.TempDir()
	clk := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	r := NewRecorder(Options{Dir: dir, SessionID: testSID, RecorderID: "rec-1", MaxDuration: time.Hour, Now: clk.now})

	// Frames before the first keyframe are dropped and nothing is created on disk.
	if wrote, err := r.WriteVideo(CodecVP8, SyntheticVP8(false, 50), 1000); wrote || err != nil {
		t.Fatalf("pre-key frame: %v %v", wrote, err)
	}
	if _, err := os.Stat(store.MediaPath(dir, testSID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("file created before keyframe")
	}
	ts := uint32(1000)
	for i := 0; i < 30; i++ {
		if wrote, err := r.WriteVideo(CodecVP8, SyntheticVP8(i%10 == 0, 200), ts); !wrote || err != nil {
			t.Fatalf("frame %d: %v %v", i, wrote, err)
		}
		if _, err := r.WriteAudio([]byte{0xfc, 1, 2, 3}, uint32(i)*3200); err != nil {
			t.Fatal(err)
		}
		ts += 6000 // 66.7 ms at 90 kHz
		clk.t = clk.t.Add(66 * time.Millisecond)
	}
	sc, err := store.Read(dir, testSID)
	if err != nil || sc.State != store.StateRecording || sc.Mime != `video/webm;codecs="vp8,opus"` || sc.RecorderID != "rec-1" {
		t.Fatalf("sidecar while recording: %+v %v", sc, err)
	}
	res := r.Close()
	if res.Empty || res.Blocks != 60 || res.DurationMs < 1900 || res.Err != nil {
		t.Fatalf("result %+v", res)
	}
	if sc, _ := store.Read(dir, testSID); sc.State != store.StateFinalised {
		t.Fatalf("sidecar state %s", sc.State)
	}
	hdr, seg := parseWebM(t, res.Path)
	if hdr.DocType != "webm" || len(seg.Tracks.TrackEntry) != 2 || seg.Tracks.TrackEntry[0].CodecID != "V_VP8" ||
		seg.Tracks.TrackEntry[1].CodecID != "A_OPUS" || !bytes.HasPrefix(seg.Tracks.TrackEntry[1].CodecPrivate, []byte("OpusHead")) {
		t.Fatalf("tracks %+v", seg.Tracks)
	}
	if v := seg.Tracks.TrackEntry[0].Video; v == nil || v.PixelWidth != 640 || v.PixelHeight != 480 {
		t.Fatalf("video size %+v", v)
	}
	blocks := 0
	for _, c := range seg.Cluster {
		blocks += len(c.SimpleBlock)
	}
	if blocks != 60 || !seg.Cluster[0].SimpleBlock[0].Keyframe || seg.Cluster[0].SimpleBlock[0].TrackNumber != 1 {
		t.Fatalf("blocks %d, first %+v", blocks, seg.Cluster[0].SimpleBlock[0])
	}
	if again := r.Close(); again.Path != res.Path {
		t.Fatal("Close not idempotent")
	}
}

func TestRecorderEmptyAndLimits(t *testing.T) {
	dir := t.TempDir()
	if res := NewRecorder(Options{Dir: dir, SessionID: testSID}).Close(); !res.Empty {
		t.Fatal("never-opened recorder must be empty")
	}
	clk := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	r := NewRecorder(Options{Dir: dir, SessionID: testSID, MaxDuration: time.Second, Now: clk.now})
	if _, err := r.WriteVideo(CodecVP8, SyntheticVP8(true, 100), 0); err != nil {
		t.Fatal(err)
	}
	clk.t = clk.t.Add(1500 * time.Millisecond)
	if _, err := r.WriteVideo(CodecVP8, SyntheticVP8(false, 100), 135000); !errors.Is(err, ErrLimitReached) {
		t.Fatalf("duration limit: %v", err)
	}
	r.Close()

	r2 := NewRecorder(Options{Dir: dir, SessionID: testSID, MaxBytes: sizeMargin + 1000, Now: clk.now})
	if _, err := r2.WriteVideo(CodecVP8, SyntheticVP8(true, 2000), 0); !errors.Is(err, ErrLimitReached) {
		t.Fatalf("size limit: %v", err)
	}
	if res := r2.Close(); !res.Empty {
		t.Fatalf("no block written, file must be removed: %+v", res)
	}
	if _, err := os.Stat(store.MediaPath(dir, testSID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("empty file kept")
	}
}

func TestResumeRebase(t *testing.T) {
	dir := t.TempDir()
	clk := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	r := NewRecorder(Options{Dir: dir, SessionID: testSID, Now: clk.now})
	r.WriteVideo(CodecVP8, SyntheticVP8(true, 100), 5000)
	clk.t = clk.t.Add(time.Second)
	r.WriteVideo(CodecVP8, SyntheticVP8(false, 100), 5000+90000)
	// Pause for 10 s, then a new connection with an unrelated RTP clock.
	r.BeginVideoEpoch()
	clk.t = clk.t.Add(10 * time.Second)
	if wrote, _ := r.WriteVideo(CodecVP8, SyntheticVP8(false, 100), 7); wrote {
		t.Fatal("inter frame accepted before keyframe after resume")
	}
	if wrote, _ := r.WriteVideo(CodecVP8, SyntheticVP8(true, 100), 7); !wrote {
		t.Fatal("keyframe after resume dropped")
	}
	res := r.Close()
	if res.DurationMs != 11000 || res.Blocks != 3 {
		t.Fatalf("rebased duration %d blocks %d", res.DurationMs, res.Blocks)
	}
}

func TestCameraRecorderVideoOnly(t *testing.T) {
	const camID = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b0a"
	dir := t.TempDir()
	clk := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	r := NewRecorder(Options{Dir: dir, SessionID: testSID, CameraID: camID, RecorderID: "rec-1", MaxDuration: time.Hour, Now: clk.now})
	ts := uint32(1000)
	for i := 0; i < 10; i++ {
		if wrote, err := r.WriteVideo(CodecVP8, SyntheticVP8(i%5 == 0, 200), ts); !wrote || err != nil {
			t.Fatalf("frame %d: %v %v", i, wrote, err)
		}
		if wrote, err := r.WriteAudio([]byte{0xfc, 1, 2, 3}, uint32(i)*3200); wrote || err != nil {
			t.Fatalf("audio written into a camera recording: %v %v", wrote, err)
		}
		ts += 6000
		clk.t = clk.t.Add(66 * time.Millisecond)
	}
	if _, err := os.Stat(store.MediaPath(dir, testSID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("camera recording written under the sessionId")
	}
	res := r.Close()
	if res.Empty || res.Blocks != 10 || res.CameraID != camID || res.Path != store.MediaPath(dir, camID) || res.Mime != `video/webm;codecs="vp8"` {
		t.Fatalf("result %+v", res)
	}
	sc, err := store.Read(dir, camID)
	if err != nil || sc.State != store.StateFinalised || sc.Source != store.SourceCamera || sc.CameraID != camID || sc.SessionID != testSID || sc.Mime != res.Mime {
		t.Fatalf("sidecar %+v %v", sc, err)
	}
	_, seg := parseWebM(t, res.Path)
	if len(seg.Tracks.TrackEntry) != 1 || seg.Tracks.TrackEntry[0].CodecID != "V_VP8" {
		t.Fatalf("tracks %+v", seg.Tracks)
	}
}
