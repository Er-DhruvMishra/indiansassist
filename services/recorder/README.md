# recorder

Server-side session recorder of IndiansAssist (Phase A.2, binding contract: `docs/specs/phase-a2-recorder.md`).

The recorder joins as a second, receive-only WebRTC peer of the **Desk** (the helped computer). It writes the
screen video and microphone audio to `OUT_DIR/<sessionId>.webm`, and when the session ends it uploads the file and
its sha256 to the api. The api writes the hash into the audit chain.

- Signaling: one WebSocket per api node (`SIGNAL_URL`). The first frame is `recorder.hello`. JSON `ping` frames
  are answered with `pong`. Reconnects back off from 1 s to 30 s with jitter.
- Media: pion/webrtc v4, `video` then `audio` recvonly transceivers, VP8 (preferred) / VP9 + Opus. NACK, PLI and
  REMB feedback are declared. pion's default interceptors handle NACK and RTCP reports. The recorder never opens a
  data channel.
- Output: WebM written with `at-wat/ebml-go` (track 1 video, track 2 Opus). The file opens at the first keyframe.
  A JSON sidecar records the state (`recording` → `finalised` → `uploaded` / `failed`).
- Upload: `POST {API_URL}/api/v1/internal/recordings`, multipart `meta` then `file`, streamed from disk. Network
  errors, 429 and 5xx are retried with backoff (2 s to 32 s, ±20 %).
- Restart recovery: at start, sidecars left in `recording` / `finalised` are uploaded.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `API_URL` | `http://localhost:4000` | REST base (internal upload, ICE) |
| `SIGNAL_URL` | `API_URL` with `ws(s)` and `/signal` | comma list, one connection per api node |
| `RECORDER_TOKEN` | required | service token (same value as the api's `RECORDER_TOKEN`) |
| `RECORDER_ID` | host name, lower-cased, other characters → `-` | `^[a-z0-9][a-z0-9._-]{0,63}$` |
| `REGION` | `in-mum` | `in-mum`, `eu-fra` or `us-east`; must be served by the api node |
| `OUT_DIR` | `./data/recorder` (`/data/recorder` in the image) | working files |
| `HTTP_ADDR` | `:9470` | `GET /healthz`, `GET /metrics` (internal only) |
| `MAX_SESSIONS` | `8` | per signaling connection, 1..256 |
| `MAX_DURATION` | `4h` | Go duration; reaching it finalises and sends `recorder.leave limit_reached` |
| `UPLOAD_RETRIES` | `5` | total upload attempts |
| `KEEP_FILES` | `false` | keep files after a successful upload (sidecar `uploaded`) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` (JSON logs on stdout) |
| `UDP_PORT_MIN` / `UDP_PORT_MAX` | unset (any port), `50000`/`50100` in the image | UDP range for ICE host candidates |
| `NAT_1TO1_IPS` | unset | comma list of public IPs advertised in place of host candidates (Docker / NAT) |

The last two rows are extras that the contract does not list. The compose file should map
`RECORDER_UDP_PORT_MIN`/`MAX` onto them and publish the same UDP range.

SDP, ICE candidates, tokens and the `Authorization` header never appear in the logs.

## Run

```sh
cd services/recorder
RECORDER_TOKEN=dev-recorder-token-at-least-32-characters API_URL=http://localhost:4000 go run ./cmd/recorder
curl -s localhost:9470/healthz   # 200 once a signaling connection is helloed, else 503
```

Docker:

```sh
docker build -t indiansassist/recorder services/recorder
docker run --rm -e RECORDER_TOKEN=... -e API_URL=http://api:4000 -p 50000-50100:50000-50100/udp indiansassist/recorder
```

The image is distroless, runs as non-root and has a `HEALTHCHECK` (`/recorder healthcheck`).

## Test

```sh
cd services/recorder
go vet ./...
go test ./...
```

The tests need no network and no Docker. They cover:

- an in-process pion-to-pion loopback: a synthetic VP8 + Opus Desk peer goes through the real session, WebM
  writer and uploader, then the test checks the file parses, has blocks, and that its sha256 matches the upload;
- the upload client against `httptest` (headers, part order, retry on 503, no retry on 403, 409 with the same
  hash);
- config parsing;
- the signaling codec against literal contract frames;
- the WebSocket client (hello first, ping → pong, reconnect);
- `/healthz` and `/metrics`.
