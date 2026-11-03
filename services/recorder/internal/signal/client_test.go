package signal

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type recHandler struct {
	ready chan *RecorderHelloOK
	msgs  chan Message
	lost  chan error
}

func (h *recHandler) OnReady(_ Sender, ok *RecorderHelloOK) { h.ready <- ok }
func (h *recHandler) OnMessage(m Message)                   { h.msgs <- m }
func (h *recHandler) OnLost(err error)                      { h.lost <- err }

func TestClientHelloPingPong(t *testing.T) {
	type result struct {
		first   map[string]any
		pong    map[string]any
		origin  bool
		connNum int
	}
	results := make(chan result, 4)
	up := websocket.Upgrader{}
	conns := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conns++
		_, hasOrigin := r.Header["Origin"]
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var res result
		res.origin, res.connNum = hasOrigin, conns
		_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		if err := ws.ReadJSON(&res.first); err != nil {
			t.Errorf("read hello: %v", err)
			return
		}
		_ = ws.WriteJSON(map[string]any{"t": "recorder.hello.ok", "connectionId": "c1", "nodeId": "n1", "regions": []string{"in-mum"}})
		_ = ws.WriteJSON(map[string]any{"t": "ping", "id": "p1"})
		if err := ws.ReadJSON(&res.pong); err != nil {
			t.Errorf("read pong: %v", err)
			return
		}
		_ = ws.WriteJSON(map[string]any{"t": "recorder.joined", "sessionId": sid, "resume": false})
		_ = ws.WriteJSON(map[string]any{"t": "chat.message", "text": "ignored"})
		results <- res
		if res.connNum == 1 {
			// Close the first connection to exercise the reconnect path.
			time.Sleep(100 * time.Millisecond)
			return
		}
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()

	h := &recHandler{ready: make(chan *RecorderHelloOK, 4), msgs: make(chan Message, 8), lost: make(chan error, 4)}
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/signal"
	c := NewClient(url, Hello{Token: "tok", RecorderID: "rec-1", Version: "0.1.0", Region: "in-mum", MaxSessions: 8, Features: []string{FeatureCamera}}, h, slog.New(slog.DiscardHandler))
	c.MinBackoff = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	res := <-results
	if res.first["t"] != "recorder.hello" || res.first["token"] != "tok" || res.first["recorderId"] != "rec-1" ||
		res.first["version"] != "0.1.0" || res.first["region"] != "in-mum" || res.first["maxSessions"] != float64(8) ||
		fmt.Sprint(res.first["features"]) != "[camera]" {
		t.Fatalf("first frame: %v", res.first)
	}
	if res.origin {
		t.Fatal("Origin header sent")
	}
	if res.pong["t"] != "pong" || res.pong["re"] != "p1" {
		t.Fatalf("pong: %v", res.pong)
	}
	if ok := <-h.ready; ok.ConnectionID != "c1" || ok.NodeID != "n1" {
		t.Fatalf("ready: %+v", ok)
	}
	if m := <-h.msgs; m.Type() != TRecorderJoined {
		t.Fatalf("dispatched %s", m.Type())
	}
	select {
	case <-h.lost:
	case <-time.After(5 * time.Second):
		t.Fatal("OnLost not called after server close")
	}
	res2 := <-results
	if res2.connNum != 2 || res2.first["t"] != "recorder.hello" {
		t.Fatalf("reconnect: %+v", res2)
	}
	<-h.ready
	if !c.Ready() {
		t.Fatal("not ready after second hello")
	}
}
