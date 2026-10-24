package signal

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/indiansassist/recorder/internal/metrics"
)

// Sender sends one frame on a live connection. It is safe for concurrent use; after the
// connection is gone Send returns ErrNotConnected.
type Sender interface {
	Send(v any) error
}

// ErrNotConnected is returned by Send on a closed connection.
var ErrNotConnected = errors.New("signal: not connected")

// Handler receives the events of one signaling URL. Calls are made from the client goroutine.
type Handler interface {
	OnReady(s Sender, ok *RecorderHelloOK)
	OnMessage(m Message)
	OnLost(err error)
}

// Hello is the identity sent in recorder.hello.
type Hello struct {
	Token       string
	RecorderID  string
	Version     string
	Region      string
	MaxSessions int
}

// Client keeps one connection to one SIGNAL_URL alive (reconnect 1 s .. 30 s with jitter).
type Client struct {
	URL     string
	Hello   Hello
	Handler Handler
	Log     *slog.Logger

	MinBackoff, MaxBackoff time.Duration
	HelloTimeout           time.Duration // wait for recorder.hello.ok
	ReadTimeout            time.Duration // no frame at all (server pings every 25 s)

	ready atomic.Bool
}

// NewClient returns a client with the contract timings.
func NewClient(rawURL string, h Hello, handler Handler, log *slog.Logger) *Client {
	host := rawURL
	if u, err := url.Parse(rawURL); err == nil {
		host = u.Host
	}
	return &Client{
		URL: rawURL, Hello: h, Handler: handler, Log: log.With("signal", host),
		MinBackoff: time.Second, MaxBackoff: 30 * time.Second, HelloTimeout: 10 * time.Second, ReadTimeout: 90 * time.Second,
	}
}

// Ready reports whether the connection is helloed.
func (c *Client) Ready() bool { return c.ready.Load() }

// Run connects and reconnects until ctx is cancelled.
func (c *Client) Run(ctx context.Context) {
	backoff := c.MinBackoff
	for first := true; ctx.Err() == nil; first = false {
		if !first {
			metrics.SignalReconnects.Inc()
		}
		helloed, err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if helloed {
			backoff = c.MinBackoff
		}
		d := backoff/2 + rand.N(backoff/2+1)
		c.Log.Warn("signaling connection lost; reconnecting", "err", err, "in", d.String())
		select {
		case <-time.After(d):
		case <-ctx.Done():
			return
		}
		if !helloed {
			backoff = min(backoff*2, c.MaxBackoff)
		}
	}
}

// conn is one live WebSocket; it implements Sender.
type conn struct {
	mu     sync.Mutex
	ws     *websocket.Conn
	closed bool
}

func (k *conn) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.closed {
		return ErrNotConnected
	}
	_ = k.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return k.ws.WriteMessage(websocket.TextMessage, b)
}

func (k *conn) close() {
	k.mu.Lock()
	k.closed = true
	k.mu.Unlock()
	_ = k.ws.Close()
}

// session runs one connection; helloed tells whether recorder.hello.ok was received.
func (c *Client) session(ctx context.Context) (helloed bool, err error) {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, Proxy: http.ProxyFromEnvironment}
	ws, _, err := dialer.DialContext(ctx, c.URL, nil) // no Origin header (non-browser client)
	if err != nil {
		return false, err
	}
	ws.SetReadLimit(256 << 10)
	k := &conn{ws: ws}
	stop := context.AfterFunc(ctx, k.close)
	defer stop()
	defer k.close()

	hello := RecorderHello{Envelope: NewEnvelope(TRecorderHello, ""), Token: c.Hello.Token, RecorderID: c.Hello.RecorderID,
		Version: c.Hello.Version, Region: c.Hello.Region, MaxSessions: c.Hello.MaxSessions}
	if err := k.Send(hello); err != nil {
		return false, err
	}
	defer func() {
		if helloed {
			c.ready.Store(false)
			metrics.SignalConnected.WithLabelValues(c.URL).Set(0)
			c.Handler.OnLost(err)
		}
	}()
	_ = ws.SetReadDeadline(time.Now().Add(c.HelloTimeout))
	for {
		_, data, rerr := ws.ReadMessage()
		if rerr != nil {
			return helloed, rerr
		}
		_ = ws.SetReadDeadline(time.Now().Add(c.ReadTimeout))
		m, derr := Decode(data)
		if derr != nil {
			c.Log.Warn("bad signaling frame", "err", derr)
			continue
		}
		switch v := m.(type) {
		case *Ping:
			if err := k.Send(Pong{Envelope: Envelope{T: TPong, Re: v.ID}}); err != nil {
				return helloed, err
			}
		case *Pong:
		case *RecorderHelloOK:
			if helloed {
				continue
			}
			helloed = true
			c.ready.Store(true)
			metrics.SignalConnected.WithLabelValues(c.URL).Set(1)
			c.Log.Info("signaling connected", "connectionId", v.ConnectionID, "nodeId", v.NodeID, "regions", v.Regions)
			c.Handler.OnReady(k, v)
		case *Error:
			if !helloed {
				c.Log.Error("recorder.hello refused", "code", v.Code, "message", v.Message)
				continue
			}
			c.Handler.OnMessage(v)
		case *Unknown:
			c.Log.Debug("ignoring signaling frame", "t", v.T)
		default:
			if helloed {
				c.Handler.OnMessage(m)
			}
		}
	}
}
