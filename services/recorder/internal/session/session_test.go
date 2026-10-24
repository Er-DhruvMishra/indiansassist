package session

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/indiansassist/recorder/internal/config"
	"github.com/indiansassist/recorder/internal/peer"
	"github.com/indiansassist/recorder/internal/signal"
	"github.com/indiansassist/recorder/internal/upload"
)

const sid = "6f1c2b9e-1d2a-4c3b-9a8f-0e1d2c3b4a59"

// fakeSender records outgoing frames after a JSON round trip (exactly what the server would see).
type fakeSender struct{ out chan signal.Message }

func newFakeSender() *fakeSender { return &fakeSender{out: make(chan signal.Message, 64)} }

func (f *fakeSender) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	m, err := signal.Decode(b)
	if err != nil {
		return err
	}
	f.out <- m
	return nil
}

func (f *fakeSender) next(t *testing.T, typ string) signal.Message {
	t.Helper()
	select {
	case m := <-f.out:
		if m.Type() != typ {
			t.Fatalf("sent %s, want %s", m.Type(), typ)
		}
		return m
	case <-time.After(10 * time.Second):
		t.Fatalf("no %s sent", typ)
	}
	return nil
}

type staticICE struct{}

func (staticICE) Get(context.Context) ([]webrtc.ICEServer, error) { return nil, nil }

type jobSink struct {
	mu   sync.Mutex
	jobs []upload.Job
}

func (j *jobSink) Submit(job upload.Job) { j.mu.Lock(); j.jobs = append(j.jobs, job); j.mu.Unlock() }

func testDeps(t *testing.T, dir string, sub Submitter) *Deps {
	cfg := &config.Config{RecorderID: "rec-test", OutDir: dir, MaxSessions: 8, MaxDuration: time.Hour, UploadRetries: 3, KeepFiles: true}
	return &Deps{
		Cfg: cfg, ICE: staticICE{}, Uploader: sub, Log: slog.New(slog.DiscardHandler),
		Peer: peer.Options{LoopbackOnly: true, GatherTimeout: 5 * time.Second},
	}
}

func assign(resume bool) *signal.RecorderAssign {
	return &signal.RecorderAssign{
		Envelope: signal.Envelope{T: signal.TRecorderAssign}, SessionID: sid, OrgID: "0b6a3e5c-6a7f-4e2d-8c1b-2f3e4d5c6b7a",
		Region: "in-mum", Tier: "p1", RecordingMode: "server", Resume: resume, DeadlineAt: "2026-10-24T10:00:10.000Z",
	}
}

func TestJoinRefusedFinishesWithoutUpload(t *testing.T) {
	sink := &jobSink{}
	m := NewManager(testDeps(t, t.TempDir(), sink), slog.New(slog.DiscardHandler))
	fs := newFakeSender()
	m.OnReady(fs, &signal.RecorderHelloOK{})
	m.OnMessage(assign(false))
	join := fs.next(t, signal.TRecorderJoin).(*signal.RecorderJoin)
	if join.SessionID != sid || join.ID != "join:"+sid {
		t.Fatalf("join %+v", join)
	}
	m.OnMessage(assign(false)) // duplicate assignment: no second join
	m.OnMessage(&signal.Error{Envelope: signal.Envelope{T: signal.TError, Re: join.ID}, Code: "bad_state"})
	deadline := time.Now().Add(5 * time.Second)
	for m.Count() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if m.Count() != 0 {
		t.Fatal("session not removed after the join was refused")
	}
	select {
	case extra := <-fs.out:
		t.Fatalf("unexpected frame %s", extra.Type())
	default:
	}
	if len(sink.jobs) != 0 {
		t.Fatal("upload submitted for an empty session")
	}
}

func TestMaxSessions(t *testing.T) {
	d := testDeps(t, t.TempDir(), &jobSink{})
	d.Cfg.MaxSessions = 1
	m := NewManager(d, slog.New(slog.DiscardHandler))
	fs := newFakeSender()
	m.OnReady(fs, &signal.RecorderHelloOK{})
	m.OnMessage(assign(false))
	fs.next(t, signal.TRecorderJoin)
	second := assign(false)
	second.SessionID = "7f1c2b9e-1d2a-4c3b-9a8f-0e1d2c3b4a59"
	m.OnMessage(second)
	if m.Count() != 1 {
		t.Fatalf("count %d", m.Count())
	}
	m.OnLost(nil)
	if m.Count() != 0 {
		t.Fatal("sessions kept after the connection was lost")
	}
}
