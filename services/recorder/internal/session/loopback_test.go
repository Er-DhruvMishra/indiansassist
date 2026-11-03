package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/at-wat/ebml-go"
	"github.com/at-wat/ebml-go/webm"
	"github.com/pion/ice/v4"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/indiansassist/recorder/internal/signal"
	"github.com/indiansassist/recorder/internal/store"
	"github.com/indiansassist/recorder/internal/upload"
)

// vp8Frame builds a synthetic VP8 frame (RFC 6386 9.1 frame tag; keyframes carry the start code
// and a 640x480 size). The payload is not decodable, which does not matter to the recorder.
func vp8Frame(key bool, n int) []byte {
	b := make([]byte, n)
	tag := uint32(1<<4) | uint32(10)<<5
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
		b[i] = byte(i * 7)
	}
	return b
}

// deskPeer is the Desk stand-in: a plain pion peer with default codecs on loopback.
func deskPeer(t *testing.T) *webrtc.PeerConnection {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	se.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() && ip.To4() != nil })
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	return pc
}

type uploaded struct {
	meta upload.Meta
	file []byte
}

func uploadServer(t *testing.T) (*httptest.Server, chan uploaded) {
	got := make(chan uploaded, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		mr := multipart.NewReader(r.Body, params["boundary"])
		var u uploaded
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			b, _ := io.ReadAll(p)
			if p.FormName() == "meta" {
				_ = json.Unmarshal(b, &u.meta)
			} else if p.FormName() == "file" {
				u.file = b
			}
		}
		w.WriteHeader(http.StatusCreated)
		got <- u
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

func TestLoopbackRecording(t *testing.T) {
	dir := t.TempDir()
	srv, got := uploadServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.DiscardHandler)
	up := upload.NewUploader(ctx, upload.NewClient(srv.URL, "tok", 3, "test"), dir, true, log)
	m := NewManager(testDeps(t, dir, up), log)
	fs := newFakeSender()
	m.OnReady(fs, &signal.RecorderHelloOK{})

	// recorder.assign -> recorder.join -> recorder.joined -> webrtc.offer
	m.OnMessage(assign(false))
	fs.next(t, signal.TRecorderJoin)
	m.OnMessage(&signal.RecorderJoined{Envelope: signal.Envelope{T: signal.TRecorderJoined}, SessionID: sid})
	offer := fs.next(t, signal.TWebRTCOffer).(*signal.WebRTCOffer)
	if offer.SessionID != sid || offer.Restart || offer.Peer != "" || bytes.Contains([]byte(offer.SDP), []byte("m=application")) {
		t.Fatalf("offer: restart=%v peer=%q", offer.Restart, offer.Peer)
	}

	// Desk side: answer with a VP8 screen track and an Opus microphone track.
	desk := deskPeer(t)
	defer desk.Close()
	connected := make(chan struct{})
	var once atomic.Bool
	desk.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected && once.CompareAndSwap(false, true) {
			close(connected)
		}
	})
	if err := desk.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		t.Fatal(err)
	}
	video, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "screen", "desk")
	audio, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "mic", "desk")
	vs, err := desk.AddTrack(video)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := desk.AddTrack(audio); err != nil {
		t.Fatal(err)
	}
	var plis atomic.Int32
	go func() {
		for {
			pkts, _, err := vs.ReadRTCP()
			if err != nil {
				return
			}
			for _, p := range pkts {
				if _, ok := p.(*rtcp.PictureLossIndication); ok {
					plis.Add(1)
				}
			}
		}
	}()
	answer, err := desk.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(desk)
	if err := desk.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	m.OnMessage(&signal.WebRTCAnswer{Envelope: signal.Envelope{T: signal.TWebRTCAnswer}, SessionID: sid, SDP: desk.LocalDescription().SDP, Peer: "recorder"})
	select {
	case <-connected:
	case <-time.After(15 * time.Second):
		t.Fatal("Desk and recorder did not connect")
	}

	// ~1.5 s of media: 15 fps video with a keyframe every 5 frames, 20 ms Opus frames.
	stop := time.Now().Add(1500 * time.Millisecond)
	go func() {
		for time.Now().Before(stop) {
			_ = audio.WriteSample(media.Sample{Data: []byte{0xfc, 0xff, 0xfe, 0x01, 0x02}, Duration: 20 * time.Millisecond})
			time.Sleep(20 * time.Millisecond)
		}
	}()
	for i := 0; time.Now().Before(stop); i++ {
		if err := video.WriteSample(media.Sample{Data: vp8Frame(i%5 == 0, 3000), Duration: 66 * time.Millisecond}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(66 * time.Millisecond)
	}

	m.OnMessage(&signal.SessionEnded{Envelope: signal.Envelope{T: signal.TSessionEnded}, SessionID: sid, EndReason: "assist_ended"})
	var u uploaded
	select {
	case u = <-got:
	case <-time.After(20 * time.Second):
		t.Fatal("recording was not uploaded")
	}
	_ = up.Wait(context.Background())

	// The file on disk (KEEP_FILES) is the uploaded one and its hash matches the finaliser's meta.
	path := store.MediaPath(dir, sid)
	disk, err := os.ReadFile(path)
	if err != nil || len(disk) == 0 {
		t.Fatalf("webm file: %v (%d bytes)", err, len(disk))
	}
	sum := sha256.Sum256(disk)
	if u.meta.SHA256 != hex.EncodeToString(sum[:]) || u.meta.Bytes != int64(len(disk)) || !bytes.Equal(u.file, disk) {
		t.Fatalf("meta %+v vs disk sha %x (%d bytes)", u.meta, sum, len(disk))
	}
	if u.meta.SessionID != sid || u.meta.RecorderID != "rec-test" || u.meta.Mime != `video/webm;codecs="vp8,opus"` || u.meta.DurationMs <= 0 {
		t.Fatalf("meta %+v", u.meta)
	}
	if sc, err := store.Read(dir, sid); err != nil || sc.State != store.StateUploaded {
		t.Fatalf("sidecar %+v %v", sc, err)
	}

	var doc struct {
		Header  webm.EBMLHeader `ebml:"EBML"`
		Segment webm.Segment    `ebml:"Segment"`
	}
	if err := ebml.Unmarshal(bytes.NewReader(disk), &doc); err != nil {
		t.Fatalf("parse webm: %v", err)
	}
	if doc.Header.DocType != "webm" || len(doc.Segment.Tracks.TrackEntry) != 2 || doc.Segment.Tracks.TrackEntry[0].CodecID != "V_VP8" {
		t.Fatalf("tracks %+v", doc.Segment.Tracks)
	}
	var vblocks, ablocks int
	for _, c := range doc.Segment.Cluster {
		for _, b := range c.SimpleBlock {
			if b.TrackNumber == 1 {
				vblocks++
			} else {
				ablocks++
			}
		}
	}
	if vblocks == 0 || !doc.Segment.Cluster[0].SimpleBlock[0].Keyframe {
		t.Fatalf("video blocks %d audio blocks %d", vblocks, ablocks)
	}
	if plis.Load() == 0 {
		t.Fatal("no PLI sent on the new video track")
	}
	t.Logf("webm %d bytes, %d video / %d audio blocks, %d PLI, durationMs %d", len(disk), vblocks, ablocks, plis.Load(), u.meta.DurationMs)
	select {
	case extra := <-fs.out:
		t.Fatalf("unexpected frame after session.ended: %s", extra.Type())
	default:
	}
}
