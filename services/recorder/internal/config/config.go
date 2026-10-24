// Package config parses the recorder environment (docs/specs/phase-a2-recorder.md section 13).
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Version is the recorder build version sent in recorder.hello (overridable with -ldflags -X).
var Version = "0.1.0"

// RecordingMaxBytes is LIMITS.recordingMaxBytes (2 GiB).
const RecordingMaxBytes int64 = 2 * 1024 * 1024 * 1024

// RecorderIDRe is RECORDER_ID_RE of packages/shared.
var RecorderIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// Regions mirrors REGIONS of packages/shared.
var Regions = []string{"in-mum", "eu-fra", "us-east"}

// Config is the parsed environment.
type Config struct {
	APIURL        string
	SignalURLs    []string
	Token         string
	RecorderID    string
	Region        string
	OutDir        string
	HTTPAddr      string
	MaxSessions   int
	MaxDuration   time.Duration
	UploadRetries int
	KeepFiles     bool
	LogLevel      string
	// Optional extras (not in the contract table): UDP media port range and 1:1 NAT IPs for ICE host candidates.
	UDPPortMin uint16
	UDPPortMax uint16
	NAT1To1IPs []string
}

// Load reads the process environment.
func Load() (*Config, error) {
	return Parse(os.Getenv, os.Hostname)
}

// Parse builds a Config from getenv; hostname supplies the RECORDER_ID default.
func Parse(getenv func(string) string, hostname func() (string, error)) (*Config, error) {
	get := func(k, def string) string {
		if v := strings.TrimSpace(getenv(k)); v != "" {
			return v
		}
		return def
	}
	c := &Config{}
	var errs []error

	api, err := normaliseHTTP(get("API_URL", "http://localhost:4000"))
	if err != nil {
		errs = append(errs, fmt.Errorf("API_URL: %w", err))
	}
	c.APIURL = api

	if raw := get("SIGNAL_URL", ""); raw != "" {
		bad := false
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			u, err := normaliseWS(part)
			if err != nil {
				bad = true
				errs = append(errs, fmt.Errorf("SIGNAL_URL %q: %w", part, err))
				continue
			}
			c.SignalURLs = append(c.SignalURLs, u)
		}
		if len(c.SignalURLs) == 0 && !bad {
			errs = append(errs, errors.New("SIGNAL_URL: empty list"))
		}
	} else if api != "" {
		c.SignalURLs = []string{SignalFromAPI(api)}
	}

	c.Token = getenv("RECORDER_TOKEN")
	if c.Token == "" {
		errs = append(errs, errors.New("RECORDER_TOKEN is required"))
	} else if len(c.Token) > 256 {
		errs = append(errs, errors.New("RECORDER_TOKEN must be at most 256 characters"))
	}

	if id := get("RECORDER_ID", ""); id != "" {
		if !RecorderIDRe.MatchString(id) {
			errs = append(errs, fmt.Errorf("RECORDER_ID %q must match %s", id, RecorderIDRe))
		}
		c.RecorderID = id
	} else {
		h, _ := hostname()
		c.RecorderID = SanitiseID(h)
	}

	c.Region = get("REGION", "in-mum")
	if !contains(Regions, c.Region) {
		errs = append(errs, fmt.Errorf("REGION %q must be one of %s", c.Region, strings.Join(Regions, ", ")))
	}

	c.OutDir = get("OUT_DIR", "./data/recorder")
	c.HTTPAddr = get("HTTP_ADDR", ":9470")

	c.MaxSessions, err = intRange(get("MAX_SESSIONS", "8"), 1, 256)
	if err != nil {
		errs = append(errs, fmt.Errorf("MAX_SESSIONS: %w", err))
	}
	c.UploadRetries, err = intRange(get("UPLOAD_RETRIES", "5"), 1, 20)
	if err != nil {
		errs = append(errs, fmt.Errorf("UPLOAD_RETRIES: %w", err))
	}
	c.MaxDuration, err = time.ParseDuration(get("MAX_DURATION", "4h"))
	if err != nil || c.MaxDuration <= 0 {
		errs = append(errs, fmt.Errorf("MAX_DURATION: must be a positive Go duration"))
	}
	c.KeepFiles, err = strconv.ParseBool(get("KEEP_FILES", "false"))
	if err != nil {
		errs = append(errs, fmt.Errorf("KEEP_FILES: must be a boolean"))
	}
	c.LogLevel = strings.ToLower(get("LOG_LEVEL", "info"))
	if !contains([]string{"debug", "info", "warn", "error"}, c.LogLevel) {
		errs = append(errs, fmt.Errorf("LOG_LEVEL %q must be debug, info, warn or error", c.LogLevel))
	}

	minP, err1 := intRange(get("UDP_PORT_MIN", "0"), 0, 65535)
	maxP, err2 := intRange(get("UDP_PORT_MAX", "0"), 0, 65535)
	if err1 != nil || err2 != nil || (minP == 0) != (maxP == 0) || minP > maxP {
		errs = append(errs, errors.New("UDP_PORT_MIN / UDP_PORT_MAX: both set, 1..65535, min <= max"))
	}
	c.UDPPortMin, c.UDPPortMax = uint16(minP), uint16(maxP)
	for _, ip := range strings.Split(get("NAT_1TO1_IPS", ""), ",") {
		if ip = strings.TrimSpace(ip); ip == "" {
			continue
		}
		if net.ParseIP(ip) == nil {
			errs = append(errs, fmt.Errorf("NAT_1TO1_IPS: %q is not an IP", ip))
			continue
		}
		c.NAT1To1IPs = append(c.NAT1To1IPs, ip)
	}

	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return c, nil
}

// SignalFromAPI derives the default SIGNAL_URL: http -> ws, https -> wss, path + "/signal".
func SignalFromAPI(api string) string {
	u, err := url.Parse(api)
	if err != nil {
		return ""
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/signal"
	u.RawQuery, u.Fragment = "", ""
	return u.String()
}

// SanitiseID turns a host name into a valid recorderId (P4).
func SanitiseID(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	var b strings.Builder
	for _, r := range h {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	s := strings.TrimLeft(b.String(), "._-")
	if len(s) > 64 {
		s = s[:64]
	}
	if !RecorderIDRe.MatchString(s) {
		return "recorder"
	}
	return s
}

func normaliseHTTP(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("must be an absolute http(s) URL")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawQuery, u.Fragment = "", ""
	return u.String(), nil
}

func normaliseWS(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", errors.New("must be an absolute ws(s) URL")
	}
	switch u.Scheme {
	case "ws", "wss":
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return "", errors.New("must be an absolute ws(s) URL")
	}
	return u.String(), nil
}

func intRange(s string, lo, hi int) (int, error) {
	n, err := strconv.Atoi(s)
	if err != nil || n < lo || n > hi {
		return 0, fmt.Errorf("must be an integer %d..%d", lo, hi)
	}
	return n, nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
