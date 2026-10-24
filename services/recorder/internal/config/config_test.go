package config

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func host(h string) func() (string, error) { return func() (string, error) { return h, nil } }

func TestDefaults(t *testing.T) {
	c, err := Parse(env(map[string]string{"RECORDER_TOKEN": "secret"}), host("Rec-Box_01.local"))
	if err != nil {
		t.Fatal(err)
	}
	if c.APIURL != "http://localhost:4000" || len(c.SignalURLs) != 1 || c.SignalURLs[0] != "ws://localhost:4000/signal" {
		t.Fatalf("urls: %q %q", c.APIURL, c.SignalURLs)
	}
	if c.RecorderID != "rec-box_01.local" || c.Region != "in-mum" || c.OutDir != "./data/recorder" || c.HTTPAddr != ":9470" {
		t.Fatalf("defaults: %+v", c)
	}
	if c.MaxSessions != 8 || c.MaxDuration != 4*time.Hour || c.UploadRetries != 5 || c.KeepFiles || c.LogLevel != "info" {
		t.Fatalf("defaults: %+v", c)
	}
}

func TestSignalDerivation(t *testing.T) {
	cases := map[string]string{
		"http://api:4000":           "ws://api:4000/signal",
		"https://ia.example.com":    "wss://ia.example.com/signal",
		"https://ia.example.com/":   "wss://ia.example.com/signal",
		"https://ia.example.com/x/": "wss://ia.example.com/x/signal",
	}
	for api, want := range cases {
		c, err := Parse(env(map[string]string{"RECORDER_TOKEN": "t", "API_URL": api}), host("h"))
		if err != nil {
			t.Fatal(err)
		}
		if c.SignalURLs[0] != want {
			t.Errorf("%s: got %s want %s", api, c.SignalURLs[0], want)
		}
	}
}

func TestSignalList(t *testing.T) {
	c, err := Parse(env(map[string]string{
		"RECORDER_TOKEN": "t",
		"SIGNAL_URL":     " ws://node-a:4000/signal, wss://node-b/signal ,,https://node-c/signal",
	}), host("h"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ws://node-a:4000/signal", "wss://node-b/signal", "wss://node-c/signal"}
	if strings.Join(c.SignalURLs, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q", c.SignalURLs)
	}
}

func TestOverrides(t *testing.T) {
	c, err := Parse(env(map[string]string{
		"RECORDER_TOKEN": "t", "RECORDER_ID": "rec-1", "REGION": "eu-fra", "MAX_SESSIONS": "256",
		"MAX_DURATION": "90m", "UPLOAD_RETRIES": "3", "KEEP_FILES": "true", "LOG_LEVEL": "DEBUG",
		"UDP_PORT_MIN": "50000", "UDP_PORT_MAX": "50100", "NAT_1TO1_IPS": "203.0.113.7",
	}), host("h"))
	if err != nil {
		t.Fatal(err)
	}
	if c.RecorderID != "rec-1" || c.Region != "eu-fra" || c.MaxSessions != 256 || c.MaxDuration != 90*time.Minute ||
		c.UploadRetries != 3 || !c.KeepFiles || c.LogLevel != "debug" || c.UDPPortMin != 50000 || c.NAT1To1IPs[0] != "203.0.113.7" {
		t.Fatalf("%+v", c)
	}
}

func TestErrors(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"missing token", map[string]string{}, "RECORDER_TOKEN is required"},
		{"bad region", map[string]string{"RECORDER_TOKEN": "t", "REGION": "ap-south"}, "REGION"},
		{"bad id upper", map[string]string{"RECORDER_TOKEN": "t", "RECORDER_ID": "Rec1"}, "RECORDER_ID"},
		{"bad id start", map[string]string{"RECORDER_TOKEN": "t", "RECORDER_ID": "-rec"}, "RECORDER_ID"},
		{"bad id long", map[string]string{"RECORDER_TOKEN": "t", "RECORDER_ID": strings.Repeat("a", 65)}, "RECORDER_ID"},
		{"sessions 0", map[string]string{"RECORDER_TOKEN": "t", "MAX_SESSIONS": "0"}, "MAX_SESSIONS"},
		{"sessions 257", map[string]string{"RECORDER_TOKEN": "t", "MAX_SESSIONS": "257"}, "MAX_SESSIONS"},
		{"duration", map[string]string{"RECORDER_TOKEN": "t", "MAX_DURATION": "4 hours"}, "MAX_DURATION"},
		{"api scheme", map[string]string{"RECORDER_TOKEN": "t", "API_URL": "ftp://x"}, "API_URL"},
		{"signal scheme", map[string]string{"RECORDER_TOKEN": "t", "SIGNAL_URL": "ftp://x"}, "SIGNAL_URL"},
		{"log level", map[string]string{"RECORDER_TOKEN": "t", "LOG_LEVEL": "trace"}, "LOG_LEVEL"},
		{"keep files", map[string]string{"RECORDER_TOKEN": "t", "KEEP_FILES": "maybe"}, "KEEP_FILES"},
	}
	for _, tc := range cases {
		_, err := Parse(env(tc.env), host("h"))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want containing %q", tc.name, err, tc.want)
		}
	}
}

func TestSanitiseID(t *testing.T) {
	cases := map[string]string{
		"DESKTOP-ABC123":        "desktop-abc123",
		"my host!":              "my-host-",
		"__x":                   "x",
		"":                      "recorder",
		strings.Repeat("b", 80): strings.Repeat("b", 64),
	}
	for in, want := range cases {
		if got := SanitiseID(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
	c, err := Parse(env(map[string]string{"RECORDER_TOKEN": "t"}), func() (string, error) { return "", errors.New("x") })
	if err != nil || c.RecorderID != "recorder" {
		t.Fatalf("hostname error fallback: %v %v", c, err)
	}
}
