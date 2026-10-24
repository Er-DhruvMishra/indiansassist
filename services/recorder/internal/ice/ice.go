// Package ice fetches the recorder's ICE servers from the api (docs/specs/phase-a2-recorder.md section 10).
package ice

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// Server is one RTCIceServer of the A 6.11 IceResponse; `urls` may be a string or an array.
type Server struct {
	URLs       []string `json:"-"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// UnmarshalJSON accepts `urls` as a string or a string array.
func (s *Server) UnmarshalJSON(b []byte) error {
	var raw struct {
		URLs       json.RawMessage `json:"urls"`
		Username   string          `json:"username"`
		Credential string          `json:"credential"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	s.Username, s.Credential = raw.Username, raw.Credential
	var one string
	if err := json.Unmarshal(raw.URLs, &one); err == nil {
		s.URLs = []string{one}
		return nil
	}
	return json.Unmarshal(raw.URLs, &s.URLs)
}

// Response is the IceResponse body.
type Response struct {
	IceServers   []Server `json:"iceServers"`
	IceTTL       int64    `json:"iceTtl"` // seconds
	IceExpiresAt string   `json:"iceExpiresAt"`
}

// Provider caches the ICE servers until 80 % of iceTtl.
type Provider struct {
	APIURL     string
	Token      string
	RecorderID string
	Client     *http.Client
	Now        func() time.Time

	mu      sync.Mutex
	cached  []webrtc.ICEServer
	refresh time.Time
}

// New returns a Provider for API_URL.
func New(apiURL, token, recorderID string) *Provider {
	return &Provider{APIURL: apiURL, Token: token, RecorderID: recorderID, Client: &http.Client{Timeout: 10 * time.Second}, Now: time.Now}
}

// Get returns cached servers or fetches fresh ones. On a fetch error it returns the last cached
// list (possibly expired) together with the error, so the caller can still try host candidates.
func (p *Provider) Get(ctx context.Context) ([]webrtc.ICEServer, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cached != nil && p.Now().Before(p.refresh) {
		return p.cached, nil
	}
	resp, err := p.fetch(ctx)
	if err != nil {
		return p.cached, err
	}
	servers := make([]webrtc.ICEServer, 0, len(resp.IceServers))
	for _, s := range resp.IceServers {
		is := webrtc.ICEServer{URLs: s.URLs, Username: s.Username}
		if s.Credential != "" {
			is.Credential = s.Credential
		}
		servers = append(servers, is)
	}
	ttl := time.Duration(resp.IceTTL) * time.Second
	if ttl <= 0 {
		ttl = time.Minute
	}
	p.cached, p.refresh = servers, p.Now().Add(ttl*8/10)
	return servers, nil
}

func (p *Provider) fetch(ctx context.Context) (*Response, error) {
	u := p.APIURL + "/api/v1/ice?recorderId=" + url.QueryEscape(p.RecorderID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	req.Header.Set("Accept", "application/json")
	res, err := p.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ice: request failed: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ice: status %d", res.StatusCode)
	}
	var out Response
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("ice: bad body: %w", err)
	}
	return &out, nil
}
