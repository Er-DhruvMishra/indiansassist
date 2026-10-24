package ice

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestProviderFetchAndCache(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/v1/ice" || r.URL.Query().Get("recorderId") != "rec-1" || r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"iceServers":[{"urls":"stun:stun.example:3478"},{"urls":["turn:turn.example:3478?transport=udp","turns:turn.example:5349"],"username":"1:recorder:rec-1","credential":"c"}],"iceTtl":100,"iceExpiresAt":"2026-10-24T11:00:00.000Z"}`))
	}))
	defer srv.Close()

	now := time.Unix(1_800_000_000, 0)
	p := New(srv.URL, "tok", "rec-1")
	p.Now = func() time.Time { return now }
	got, err := p.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].URLs[0] != "stun:stun.example:3478" || len(got[1].URLs) != 2 || got[1].Username != "1:recorder:rec-1" || got[1].Credential != "c" {
		t.Fatalf("%+v", got)
	}
	now = now.Add(79 * time.Second)
	if _, err := p.Get(context.Background()); err != nil || calls.Load() != 1 {
		t.Fatalf("cache before 80%%: calls=%d err=%v", calls.Load(), err)
	}
	now = now.Add(2 * time.Second)
	if _, err := p.Get(context.Background()); err != nil || calls.Load() != 2 {
		t.Fatalf("refresh after 80%%: calls=%d err=%v", calls.Load(), err)
	}

	bad := New(srv.URL, "wrong", "rec-1")
	if _, err := bad.Get(context.Background()); err == nil {
		t.Fatal("401 accepted")
	}
}
