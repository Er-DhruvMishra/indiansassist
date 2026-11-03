package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/at-wat/ebml-go"
	"github.com/at-wat/ebml-go/webm"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/indiansassist/recorder/internal/signal"
	"github.com/indiansassist/recorder/internal/store"
	"github.com/indiansassist/recorder/internal/upload"
)

const (
	camID  = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b0a"
	camID2 = "4d3c2b1a-9f8e-4e7d-8c6b-5a4f3e2d1c0b"
)

func cameraMsg(id string) *signal.RecorderCamera {
	return &signal.RecorderCamera{Envelope: signal.Envelope{T: signal.TRecorderCamera}, SessionID: sid, CameraID: id}
}

func joined() *signal.RecorderJoined {
	return &signal.RecorderJoined{Envelope: signal.Envelope{T: signal.TRecorderJoined}, SessionID: sid}
}

// answerWithVideo answers offer from pc with one VP8 track (non-trickle) and returns the track and a
// channel closed once pc is connected.
func answerWithVideo(t *testing.T, pc *webrtc.PeerConnection, offer, streamID string) (*webrtc.TrackLocalStaticSample, string, <-chan struct{}) {
	t.Helper()
	connected := make(chan struct{})
	var once atomic.Bool
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected && once.CompareAndSwap(false, true) {
			close(connected)
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		t.Fatal(err)
	}
	video, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", streamID)
	if _, err := pc.AddTrack(video); err != nil {
		t.Fatal(err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	return video, pc.LocalDescription().SDP, connected
}

func waitClosed(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(15 * time.Second):
		t.Fatalf("%s did not connect", what)
	}
}

// streamVP8 writes ~d of 15 fps VP8 with a keyframe every 5 frames to every track.
func streamVP8(t *testing.T, d time.Duration, tracks ...*webrtc.TrackLocalStaticSample) {
	t.Helper()
	stop := time.Now().Add(d)
	for i := 0; time.Now().Before(stop); i++ {
		for _, tr := range tracks {
			if err := tr.WriteSample(media.Sample{Data: vp8Frame(i%5 == 0, 2000), Duration: 66 * time.Millisecond}); err != nil {
				t.Fatal(err)
			}
		}
		time.Sleep(66 * time.Millisecond)
	}
}

func nextUpload(t *testing.T, got <-chan uploaded) uploaded {
	t.Helper()
	select {
	case u := <-got:
		return u
	case <-time.After(20 * time.Second):
		t.Fatal("recording was not uploaded")
	}
	return uploaded{}
}

func parseTracks(t *testing.T, b []byte) []webm.TrackEntry {
	t.Helper()
	var doc struct {
		Header  webm.EBMLHeader `ebml:"EBML"`
		Segment webm.Segment    `ebml:"Segment"`
	}
	if err := ebml.Unmarshal(bytes.NewReader(b), &doc); err != nil {
		t.Fatalf("parse webm: %v", err)
	}
	if doc.Header.DocType != "webm" || len(doc.Segment.Cluster) == 0 || len(doc.Segment.Cluster[0].SimpleBlock) == 0 {
		t.Fatalf("webm without blocks")
	}
	return doc.Segment.Tracks.TrackEntry
}

// checkOnDisk asserts that OUT_DIR/<stem>.webm (KEEP_FILES) is the uploaded file and hashes to the meta.
func checkOnDisk(t *testing.T, dir, stem string, u uploaded) []byte {
	t.Helper()
	disk, err := os.ReadFile(store.MediaPath(dir, stem))
	if err != nil || len(disk) == 0 {
		t.Fatalf("%s.webm: %v (%d bytes)", stem, err, len(disk))
	}
	sum := sha256.Sum256(disk)
	if u.meta.SHA256 != hex.EncodeToString(sum[:]) || u.meta.Bytes != int64(len(disk)) || !bytes.Equal(u.file, disk) {
		t.Fatalf("meta %+v vs disk sha %x (%d bytes)", u.meta, sum, len(disk))
	}
	return disk
}

func TestLoopbackCameraRecording(t *testing.T) {
	dir := t.TempDir()
	srv, got := uploadServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.DiscardHandler)
	up := upload.NewUploader(ctx, upload.NewClient(srv.URL, "tok", 3, "test"), dir, true, log)
	m := NewManager(testDeps(t, dir, up), log)
	fs := newFakeSender()
	m.OnReady(fs, &signal.RecorderHelloOK{})

	m.OnMessage(assign(false))
	fs.next(t, signal.TRecorderJoin)
	m.OnMessage(joined())
	deskOffer := fs.next(t, signal.TWebRTCOffer).(*signal.WebRTCOffer)
	if deskOffer.Peer != "" || deskOffer.ID != "offer:"+sid {
		t.Fatalf("desk offer id %q peer %q", deskOffer.ID, deskOffer.Peer)
	}

	// recorder.camera -> a second offer with peer "camera".
	m.OnMessage(cameraMsg(camID))
	camOffer := fs.next(t, signal.TWebRTCOffer).(*signal.WebRTCOffer)
	if camOffer.Peer != signal.PeerCamera || camOffer.ID != "camoffer:"+sid || camOffer.SessionID != sid || camOffer.Restart ||
		strings.Contains(camOffer.SDP, "m=application") {
		t.Fatalf("camera offer id %q peer %q restart %v", camOffer.ID, camOffer.Peer, camOffer.Restart)
	}
	m.OnMessage(cameraMsg(camID)) // repeated while it runs: ignored

	phone := deskPeer(t)
	defer phone.Close()
	camTrack, camAnswer, camUp := answerWithVideo(t, phone, camOffer.SDP, "phone")
	desk := deskPeer(t)
	defer desk.Close()
	deskTrack, deskAnswer, deskUp := answerWithVideo(t, desk, deskOffer.SDP, "desk")

	// The camera answer carries peer "camera"; the Desk answer has no peer and must reach the Desk PC.
	m.OnMessage(&signal.WebRTCAnswer{Envelope: signal.Envelope{T: signal.TWebRTCAnswer}, SessionID: sid, SDP: camAnswer, Peer: signal.PeerCamera})
	m.OnMessage(&signal.WebRTCAnswer{Envelope: signal.Envelope{T: signal.TWebRTCAnswer}, SessionID: sid, SDP: deskAnswer})
	waitClosed(t, camUp, "phone and recorder")
	waitClosed(t, deskUp, "Desk and recorder")

	streamVP8(t, 1500*time.Millisecond, camTrack, deskTrack)
	m.OnMessage(&signal.SessionEnded{Envelope: signal.Envelope{T: signal.TSessionEnded}, SessionID: sid, EndReason: "assist_ended"})

	byStem := map[string]uploaded{}
	for range 2 {
		u := nextUpload(t, got)
		if u.meta.Source == store.SourceCamera {
			byStem[u.meta.CameraID] = u
		} else {
			byStem[u.meta.SessionID] = u
		}
	}
	_ = up.Wait(context.Background())

	cu, ok := byStem[camID]
	if !ok {
		t.Fatalf("no camera upload: %v", byStem)
	}
	if cu.meta.SessionID != sid || cu.meta.RecorderID != "rec-test" || cu.meta.Mime != `video/webm;codecs="vp8"` || cu.meta.DurationMs <= 0 {
		t.Fatalf("camera meta %+v", cu.meta)
	}
	tracks := parseTracks(t, checkOnDisk(t, dir, camID, cu))
	if len(tracks) != 1 || tracks[0].CodecID != "V_VP8" {
		t.Fatalf("camera tracks %+v", tracks)
	}
	if sc, err := store.Read(dir, camID); err != nil || sc.State != store.StateUploaded || sc.Source != store.SourceCamera || sc.SessionID != sid {
		t.Fatalf("camera sidecar %+v %v", sc, err)
	}

	du, ok := byStem[sid]
	if !ok {
		t.Fatalf("no Desk upload: %v", byStem)
	}
	if du.meta.Source != "" || du.meta.CameraID != "" || du.meta.Mime != `video/webm;codecs="vp8,opus"` {
		t.Fatalf("desk meta %+v", du.meta)
	}
	if tracks := parseTracks(t, checkOnDisk(t, dir, sid, du)); len(tracks) != 2 {
		t.Fatalf("desk tracks %+v", tracks)
	}
	select {
	case extra := <-fs.out:
		t.Fatalf("unexpected frame: %s", extra.Type())
	default:
	}
}

func TestCameraEndsDeskContinues(t *testing.T) {
	old := cameraDisconnectGrace
	cameraDisconnectGrace = time.Second
	defer func() { cameraDisconnectGrace = old }()

	dir := t.TempDir()
	srv, got := uploadServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.DiscardHandler)
	up := upload.NewUploader(ctx, upload.NewClient(srv.URL, "tok", 3, "test"), dir, true, log)
	d := testDeps(t, dir, up)
	d.TrackTimeout = time.Minute // the Desk is never answered here; keep its PC waiting
	m := NewManager(d, log)
	fs := newFakeSender()
	m.OnReady(fs, &signal.RecorderHelloOK{})

	m.OnMessage(assign(false))
	fs.next(t, signal.TRecorderJoin)
	m.OnMessage(joined())
	fs.next(t, signal.TWebRTCOffer) // Desk
	m.OnMessage(cameraMsg(camID))
	camOffer := fs.next(t, signal.TWebRTCOffer).(*signal.WebRTCOffer)

	phone := deskPeer(t)
	camTrack, camAnswer, camUp := answerWithVideo(t, phone, camOffer.SDP, "phone")
	m.OnMessage(&signal.WebRTCAnswer{Envelope: signal.Envelope{T: signal.TWebRTCAnswer}, SessionID: sid, SDP: camAnswer, Peer: signal.PeerCamera})
	waitClosed(t, camUp, "phone and recorder")
	streamVP8(t, time.Second, camTrack)
	_ = phone.Close() // the phone leaves

	u := nextUpload(t, got)
	_ = up.Wait(context.Background())
	if u.meta.Source != store.SourceCamera || u.meta.CameraID != camID || u.meta.SessionID != sid {
		t.Fatalf("meta %+v", u.meta)
	}
	checkOnDisk(t, dir, camID, u)

	// The session keeps running: no recorder.leave, and the stopped camera is not restarted.
	if m.Count() != 1 {
		t.Fatalf("sessions %d after the camera ended", m.Count())
	}
	m.OnMessage(cameraMsg(camID))
	time.Sleep(200 * time.Millisecond)
	select {
	case extra := <-fs.out:
		t.Fatalf("unexpected frame after the camera ended: %s", extra.Type())
	default:
	}

	m.OnMessage(&signal.SessionEnded{Envelope: signal.Envelope{T: signal.TSessionEnded}, SessionID: sid, EndReason: "assist_ended"})
	deadline := time.Now().Add(5 * time.Second)
	for m.Count() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if m.Count() != 0 {
		t.Fatal("session not removed after session.ended")
	}
	select {
	case extra := <-got:
		t.Fatalf("unexpected second upload %+v", extra.meta)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestCameraRequestRules(t *testing.T) {
	sink := &jobSink{}
	m := NewManager(testDeps(t, t.TempDir(), sink), slog.New(slog.DiscardHandler))
	fs := newFakeSender()
	m.OnReady(fs, &signal.RecorderHelloOK{})
	noFrame := func(what string) {
		t.Helper()
		time.Sleep(150 * time.Millisecond)
		select {
		case extra := <-fs.out:
			t.Fatalf("%s: unexpected frame %s", what, extra.Type())
		default:
		}
	}

	m.OnMessage(cameraMsg(camID)) // unknown session
	noFrame("unknown session")
	m.OnMessage(assign(false))
	fs.next(t, signal.TRecorderJoin)
	m.OnMessage(cameraMsg(camID)) // not joined yet
	noFrame("before joined")
	m.OnMessage(joined())
	fs.next(t, signal.TWebRTCOffer) // Desk
	m.OnMessage(cameraMsg(strings.ToUpper(camID)))
	noFrame("upper-case cameraId")

	m.OnMessage(cameraMsg(camID))
	if o := fs.next(t, signal.TWebRTCOffer).(*signal.WebRTCOffer); o.Peer != signal.PeerCamera {
		t.Fatalf("peer %q", o.Peer)
	}
	m.OnMessage(cameraMsg(camID))
	noFrame("same cameraId while running")
	// A different camera replaces the first (finalised; empty, so no upload) with a fresh offer.
	m.OnMessage(cameraMsg(camID2))
	if o := fs.next(t, signal.TWebRTCOffer).(*signal.WebRTCOffer); o.Peer != signal.PeerCamera || o.ID != "camoffer:"+sid {
		t.Fatalf("second camera offer %+v", o)
	}
	// A refused camera offer stops that camera; the Desk is untouched.
	m.OnMessage(&signal.Error{Envelope: signal.Envelope{T: signal.TError, Re: "camoffer:" + sid}, Code: "forbidden"})
	m.OnMessage(&signal.RecorderPause{Envelope: signal.Envelope{T: signal.TRecorderPause}, SessionID: sid, Reason: "consent_pending"})
	m.OnMessage(cameraMsg(camID2))
	noFrame("refused camera")
	if m.Count() != 1 {
		t.Fatalf("sessions %d", m.Count())
	}
	m.OnLost(nil)
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.jobs) != 0 {
		t.Fatalf("uploads for empty recordings: %+v", sink.jobs)
	}
}
