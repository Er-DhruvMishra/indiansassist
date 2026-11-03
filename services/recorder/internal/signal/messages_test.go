package signal

import (
	"encoding/json"
	"reflect"
	"testing"
)

const (
	sid   = "6f1c2b9e-1d2a-4c3b-9a8f-0e1d2c3b4a59"
	camID = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b0a"
)

// Literal frames copied from the shapes of packages/shared/src/schemas/signal-recorder.ts and signal-messages.ts.
var frames = map[string]string{
	TRecorderHello:   `{"t":"recorder.hello","token":"tok-123","recorderId":"rec-1","version":"0.1.0","region":"in-mum","maxSessions":8}`,
	TRecorderHelloOK: `{"t":"recorder.hello.ok","connectionId":"c-1","nodeId":"node-a","regions":["in-mum","eu-fra"]}`,
	TRecorderAssign:  `{"t":"recorder.assign","sessionId":"` + sid + `","orgId":"0b6a3e5c-6a7f-4e2d-8c1b-2f3e4d5c6b7a","region":"in-mum","tier":"p1","recordingMode":"server","resume":false,"deadlineAt":"2026-10-24T10:00:10.000Z"}`,
	TRecorderJoin:    `{"t":"recorder.join","id":"join:` + sid + `","sessionId":"` + sid + `"}`,
	TRecorderJoined:  `{"t":"recorder.joined","sessionId":"` + sid + `","resume":true}`,
	TRecorderPause:   `{"t":"recorder.pause","sessionId":"` + sid + `","reason":"consent_pending"}`,
	TRecorderLeave:   `{"t":"recorder.leave","sessionId":"` + sid + `","reason":"media_failed"}`,
	TRecorderCamera:  `{"t":"recorder.camera","sessionId":"` + sid + `","cameraId":"` + camID + `"}`,
	TWebRTCOffer:     `{"t":"webrtc.offer","sessionId":"` + sid + `","sdp":"v=0\r\n","restart":true,"peer":"recorder"}`,
	TWebRTCAnswer:    `{"t":"webrtc.answer","sessionId":"` + sid + `","sdp":"v=0\r\n","peer":"recorder"}`,
	TWebRTCIce:       `{"t":"webrtc.ice","sessionId":"` + sid + `","candidate":{"candidate":"candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"abcd"},"peer":"recorder"}`,
	TSessionEnded:    `{"t":"session.ended","sessionId":"` + sid + `","endReason":"assist_ended","endedAt":"2026-10-24T10:30:00.000Z","startedAt":"2026-10-24T10:00:00.000Z","durationMs":1800000,"hashChainTail":"ab12","assist":{"id":"0b6a3e5c-6a7f-4e2d-8c1b-2f3e4d5c6b7b","name":"Asha"},"surface":"tab","recordingStarted":false,"reachedActive":true,"serverRecording":true}`,
	TError:           `{"t":"error","re":"join:` + sid + `","code":"bad_state","message":"session is not active","details":{"state":"consent_pending"}}`,
	TPing:            `{"t":"ping"}`,
	TPong:            `{"t":"pong"}`,
}

func TestDecodeTypes(t *testing.T) {
	want := map[string]Message{
		TRecorderHello:   &RecorderHello{},
		TRecorderHelloOK: &RecorderHelloOK{},
		TRecorderAssign:  &RecorderAssign{},
		TRecorderJoin:    &RecorderJoin{},
		TRecorderJoined:  &RecorderJoined{},
		TRecorderPause:   &RecorderPause{},
		TRecorderLeave:   &RecorderLeave{},
		TRecorderCamera:  &RecorderCamera{},
		TWebRTCOffer:     &WebRTCOffer{},
		TWebRTCAnswer:    &WebRTCAnswer{},
		TWebRTCIce:       &WebRTCIce{},
		TSessionEnded:    &SessionEnded{},
		TError:           &Error{},
		TPing:            &Ping{},
		TPong:            &Pong{},
	}
	for typ, raw := range frames {
		m, err := Decode([]byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
		if m.Type() != typ || reflect.TypeOf(m) != reflect.TypeOf(want[typ]) {
			t.Fatalf("%s: decoded %T", typ, m)
		}
		// Round trip: re-marshal and compare as generic JSON (field names and values match the contract).
		out, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		var a, b any
		_ = json.Unmarshal([]byte(raw), &a)
		_ = json.Unmarshal(out, &b)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%s round trip:\n in  %s\n out %s", typ, raw, out)
		}
	}
}

func TestDecodeFields(t *testing.T) {
	m, _ := Decode([]byte(frames[TRecorderAssign]))
	a := m.(*RecorderAssign)
	if a.SessionID != sid || a.Region != "in-mum" || a.Tier != "p1" || a.RecordingMode != "server" || a.Resume ||
		a.DeadlineAt != "2026-10-24T10:00:10.000Z" {
		t.Fatalf("%+v", a)
	}
	m, _ = Decode([]byte(frames[TWebRTCIce]))
	ice := m.(*WebRTCIce)
	if ice.Candidate == nil || *ice.Candidate.SDPMid != "0" || *ice.Candidate.SDPMLineIndex != 0 || ice.Peer != "recorder" {
		t.Fatalf("%+v", ice)
	}
	m, _ = Decode([]byte(frames[TError]))
	e := m.(*Error)
	if e.Code != "bad_state" || e.Re != "join:"+sid || e.Details["state"] != "consent_pending" {
		t.Fatalf("%+v", e)
	}
	m, _ = Decode([]byte(frames[TSessionEnded]))
	if se := m.(*SessionEnded); se.SessionID != sid || se.ServerRecording == nil || !*se.ServerRecording {
		t.Fatalf("%+v", se)
	}
	if SessionOf(m) != sid {
		t.Fatal("SessionOf")
	}
	m, _ = Decode([]byte(frames[TRecorderCamera]))
	if c, ok := m.(*RecorderCamera); !ok || c.SessionID != sid || c.CameraID != camID || SessionOf(m) != sid {
		t.Fatalf("recorder.camera %+v", m)
	}
	m, _ = Decode([]byte(`{"t":"webrtc.answer","sessionId":"` + sid + `","sdp":"x","peer":"camera"}`))
	if a := m.(*WebRTCAnswer); a.Peer != PeerCamera {
		t.Fatalf("camera answer %+v", a)
	}
}

func TestMarshalOutgoing(t *testing.T) {
	cases := []struct {
		v    any
		want string
	}{
		{RecorderHello{Envelope: NewEnvelope(TRecorderHello, ""), Token: "tok-123", RecorderID: "rec-1", Version: "0.1.0", Region: "in-mum", MaxSessions: 8}, frames[TRecorderHello]},
		{RecorderHello{Envelope: NewEnvelope(TRecorderHello, ""), Token: "tok-123", RecorderID: "rec-1", Version: "0.1.0", Region: "in-mum", MaxSessions: 8, Features: []string{FeatureCamera}},
			`{"t":"recorder.hello","token":"tok-123","recorderId":"rec-1","version":"0.1.0","region":"in-mum","maxSessions":8,"features":["camera"]}`},
		{WebRTCOffer{Envelope: NewEnvelope(TWebRTCOffer, "camoffer:"+sid), SessionID: sid, SDP: "x", Peer: PeerCamera},
			`{"t":"webrtc.offer","id":"camoffer:` + sid + `","sessionId":"` + sid + `","sdp":"x","peer":"camera"}`},
		{RecorderJoin{Envelope: NewEnvelope(TRecorderJoin, "join:"+sid), SessionID: sid}, frames[TRecorderJoin]},
		{RecorderLeave{Envelope: NewEnvelope(TRecorderLeave, ""), SessionID: sid, Reason: ReasonMediaFailed}, frames[TRecorderLeave]},
		{WebRTCOffer{Envelope: NewEnvelope(TWebRTCOffer, ""), SessionID: sid, SDP: "v=0\r\n", Restart: true, Peer: PeerRecorder}, frames[TWebRTCOffer]},
		{WebRTCOffer{Envelope: NewEnvelope(TWebRTCOffer, ""), SessionID: sid, SDP: "x"}, `{"t":"webrtc.offer","sessionId":"` + sid + `","sdp":"x"}`},
		{WebRTCIce{Envelope: NewEnvelope(TWebRTCIce, ""), SessionID: sid}, `{"t":"webrtc.ice","sessionId":"` + sid + `","candidate":null}`},
		{Pong{Envelope: NewEnvelope(TPong, "")}, frames[TPong]},
	}
	for _, c := range cases {
		out, err := json.Marshal(c.v)
		if err != nil {
			t.Fatal(err)
		}
		if string(out) != c.want {
			t.Errorf("marshal:\n got  %s\n want %s", out, c.want)
		}
	}
}

func TestDecodeUnknownAndBad(t *testing.T) {
	m, err := Decode([]byte(`{"t":"chat.message","sessionId":"x","text":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	if u, ok := m.(*Unknown); !ok || u.T != "chat.message" || len(u.Raw) == 0 {
		t.Fatalf("got %T", m)
	}
	if _, err := Decode([]byte(`{"sessionId":"x"}`)); err != ErrNoType {
		t.Fatalf("no t: %v", err)
	}
	if _, err := Decode([]byte(`not json`)); err == nil {
		t.Fatal("bad json accepted")
	}
	if _, err := Decode([]byte(`{"t":"recorder.joined","resume":"yes"}`)); err == nil {
		t.Fatal("bad field type accepted")
	}
}
