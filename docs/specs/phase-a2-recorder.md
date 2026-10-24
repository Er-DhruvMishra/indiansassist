# Phase A.2 contracts: server-side recorder (binding)

Status: binding for Phase A.2. Revision 1, 24 Oct 2026. Addendum to `docs/specs/phase-a-contracts.md` (called "A" below; "A 7.3" = its section 7.3) and `docs/specs/phase-b-contracts.md` ("B"). It delivers A section 14 row 1 ("Server-side pion recorder") and PRD section 3 Package 1 "server side recording via a headless pion/webrtc (Go) consumer when a durable, signed recording is required", PRD section 7 ("session recordings are hashed and the hash is written into the chain") and PRD section 12 item 1 ("prove your recording was not edited"). Where this file and A / B differ, this file wins for the items it names; everything else in A and B is unchanged. Vocabulary: **Desk** = the helped computer, **Assist** = the technician console, **recorder** = the Go service of this file.

## 1. Why a server recorder, and the design choice

The Phase A recording is made by the Assist's browser (`MediaRecorder`, A 9). A modified console can skip it, edit it before upload or record out of band. The recorder produces the durable copy without trusting the technician's browser: it receives the Desk's media itself, writes it to disk on a server of the org's region, and uploads it with its sha256 into the audit chain.

**Desk-direct (binding).** The recorder is a second WebRTC peer of the **Desk**, not of the Assist. The Desk holds two `RTCPeerConnection`s: the Phase A one to the Assist and a second one to the recorder, carrying the same screen track and microphone track. Rejected alternative: the recorder peering with the Assist (the Assist forwards the remote stream). That would make the recording depend on the console's code, which is exactly what must not be trusted: a modified console could forward a doctored or empty stream, or none. The Desk is the party whose consent the recording records, it already holds the original capture track, and its room code is served by our own origin, not by the technician. The cost is upstream bandwidth on the Desk (one more video send) and one more ICE negotiation; both are acceptable for P1 (15 fps screen video, A 7.7).

## 2. Participants and roles

| Participant | Socket side (`conn.side`) | `session_participant.role` | Authenticated by | Sees media |
|---|---|---|---|---|
| Assist | `assist` | `assist` | cookie (A 7.2) | yes (Desk PC 1) |
| Desk | `desk` | `desk` | token (A 3.5) | sends |
| recorder | `recorder` (new) | `recorder` (new value of `participant_role`) | service token `RECORDER_TOKEN` | yes (Desk PC 2), receive only |

| # | Rule |
|---|---|
| P1 | The recorder is a **service**, not a user: it has no org, no cookie, no seat. One recorder process may serve every org of the regions its api node serves. |
| P2 | Service token: env `RECORDER_TOKEN` on both the api and the recorder. Empty on the api = recorder disabled (`recorder.hello` and every internal route refused). Every compare is `crypto.timingSafeEqual` on equal-length buffers (A conventions); a length mismatch is a failure. **prod: >= 32 chars when set**; the api refuses to boot otherwise. |
| P3 | Audit actor of recorder actions: `{ type: 'system', id: 'recorder:<recorderId>', label: 'recorder' }` (`recorderActor(recorderId)`). This amends A 5.3 "for `system` it is `system`": a system actor may carry an id and the label `recorder`. |
| P4 | `recorderId`: `^[a-z0-9][a-z0-9._-]{0,63}$` (lower case), from env `RECORDER_ID` (default: the host name, lower-cased, other characters replaced by `-`). It names the process, never a person. |
| P5 | A recorder socket is never a cookie principal: the upgrade cookie, if any, is ignored for `recorder.hello`. |

## 3. Org recording policy

`org.recording_mode` (new column, pgEnum `recording_mode`, not null, default `assist_only`). Shared exports `RECORDING_MODES` and `RecordingMode`.

| Mode | Assist `MediaRecorder` (A 9) | Server recorder | Desk consent screen text (section 8) |
|---|---|---|---|
| `off` | refused: `recording.started` event and uploads answer `403 forbidden` | never assigned | no recording sentence |
| `assist_only` (default, Phase A behaviour) | allowed | never assigned | unchanged (the banner dot appears if the Assist records) |
| `server` | refused (`403 forbidden`) | assigned at every `active` transition | server recording sentence |
| `both` | allowed | assigned at every `active` transition | server recording sentence |

| # | Rule |
|---|---|
| M1 | The mode is **snapshotted** into `session.recording_mode` (new nullable column) at `assist.accept`. Live sessions are not re-policed (as B 11.3). A row with `recording_mode` null (created before A.2) behaves as `assist_only`. |
| M2 | `session.created` (both copies) carries `recordingMode` (section 5). The Desk shows the consent text of the table **before** `getDisplayMedia`, so the recording is part of what the Desk consents to (PRD principle 5). |
| M3 | `GET /api/v1/orgs/current/policy/recording`: any authenticated role, `200 { recordingMode }`. `PATCH` same path: `org_admin` only (`403 forbidden` otherwise), body `{ recordingMode }` (`recordingPolicySchema`, strict), `200 { recordingMode }`, audit `org.policy_updated { fields: ['recordingMode'] }` (no entry when unchanged), 10 / minute per user (the B policy limit, `429 rate_limited`). |
| M5 | The server recorder captures P1 video only: it is assigned only to `p1_browser` sessions. For other tiers (P2 mirror recordings) `server` and `both` behave as `assist_only`, and only `off` refuses the Assist's recording. |
| M4 | `Session` (A 6.3) gains `recordingMode: RecordingMode \| null`, `serverRecording: boolean` (true once `recording.server_started` was written) and `serverRecordingId: uuid \| null`; `Recording` gains `recordedBy: 'assist' \| 'server'`. `Session.recordingId` stays the Assist recording. |

## 4. Recorder connection on `/signal`

Same WS endpoint, envelope, frame limits and heartbeat as A 7.1 / 7.2 (the recorder **must** answer `{ t: 'ping' }` with `{ t: 'pong' }`; 60 s idle closes `4408`). No `Origin` header is required (non-browser client); if one is sent the A 7.2 rule applies.

| Step | Rule |
|---|---|
| H1 | First frame within 5 s: `recorder.hello { token, recorderId, version, region }`. Wrong token, recorder disabled, or `region` not served by this node: `error forbidden` then close `4403`. Failed hellos count against `recorder-hello:<ip>` (10 / minute, then `error rate_limited` + close `4429`). |
| H2 | Reply `recorder.hello.ok { connectionId, nodeId, regions }` (`regions` = `SERVED_REGIONS`, or every region when empty). Right after it the server assigns every session that needs a recorder (section 6 A1) to this socket, subject to `maxSessions`. |
| H3 | Frame bucket for a recorder socket: 200 frames / s, burst 400 (it multiplexes many sessions). |
| H4 | A recorder socket may send only `recorder.join`, `recorder.leave`, `webrtc.offer`, `webrtc.answer`, `webrtc.ice`, `ping`, `pong` (else `error forbidden`, frame dropped). Session authorisation as A 7.2 with the registry slot `live.recorderConnId`. |
| H5 | Multi-node (`PRESENCE_DRIVER=redis`): recorder sockets are never bridged. A session is assigned only to a recorder socket on its **owner node**; the recorder service therefore keeps one signaling connection **per api node** (`SIGNAL_URL` is a comma list). A session whose owner node has no recorder socket is not recorded by the server (warn log, `ia_recorder_assign_failures_total`). |

## 5. Message catalogue (additions)

Direction `R->S` recorder to server, `S->R`, `D<->S<->R` relayed between the Desk and the recorder. Shared exports a zod schema per message (`packages/shared/src/schemas/signal-recorder.ts`) in the A 7.1 unions (`signalMessageSchema`, `clientSignalMessageSchema`, `serverSignalMessageSchema`) and `RECORDER_CLIENT_TYPES`.

| `t` | Dir | Payload | Notes |
|---|---|---|---|
| `recorder.hello` | R->S | `{ token: string (1..256), recorderId, version: string (1..32), region: Region, maxSessions?: int 1..256 }` | H1; `maxSessions` default 8 |
| `recorder.hello.ok` | S->R | `{ connectionId, nodeId: string, regions: Region[] }` | H2 |
| `recorder.assign` | S->R | `{ sessionId, orgId, region, tier, recordingMode: 'server' \| 'both', resume: boolean, deadlineAt: ISO }` | section 6; `resume: true` after a Desk re-consent (same recorder, same file) |
| `recorder.join` | R->S | `{ sessionId }` | accepted only for an open assignment of this socket and a session in `active` (else `error bad_state` / `consent_required`); reply `recorder.joined` |
| `recorder.joined` | S->R | `{ sessionId, resume: boolean }` | after it the recorder sends `webrtc.offer` |
| `recorder.pause` | S->R | `{ sessionId, reason: 'consent_pending' }` | Desk resume took the session out of `active` (A 7.5): close the peer connection, **keep the file open**, wait for a new `recorder.assign { resume: true }` |
| `recorder.leave` | R->S | `{ sessionId, reason: RecorderStopReason }` | the recorder stopped on its own (`track_ended`, `media_failed`, `limit_reached`, `disk_error`, `shutdown`); no reply |
| `session.ended` | S->R | A 7.3 shape | also pushed to the joined (or paused) recorder of the session: finalise and upload |
| `webrtc.offer` / `webrtc.answer` / `webrtc.ice` | D<->S<->R | A 7.3 shape plus `peer?: 'assist' \| 'recorder'` | section 7 |
| `session.recording` | S->D, S->A | `{ sessionId, recording: boolean, source?: 'assist' \| 'server' }` | `source` absent = `assist` (A shape unchanged); see section 6 S1 / S3 |
| `session.created` | S->A, S->D | A shape plus `recordingMode?: RecordingMode` | M2 (optional only so pre-A.2 fixtures parse; always sent) |
| `session.ended` | S->A, S->D | A shape plus `serverRecording?: boolean` | the Desk receipt states it (A 12.1 D6) |

`RecorderStopReason` = `session_ended`, `recorder_left`, `track_ended`, `media_failed`, `limit_reached`, `disk_error`, `shutdown`. New `error` code: none (existing codes are used).

## 6. State machine additions (A 7.4)

| From | Event | Server does | Audit |
|---|---|---|---|
| `consent_pending` -> `active` (`desk.consent granted`), mode `server` / `both` | A1 assign | picks a recorder socket on this node (fewest joined + assigned sessions below its `maxSessions`, ties: oldest socket) and sends `recorder.assign { resume: false }`; no recorder => warn + metric, the session continues unrecorded by the server | none |
| `active`, assignment open | `recorder.join` | registers `live.recorderConnId`, inserts a `session_participant { role: 'recorder', label: 'recorder', connection_id }` row, sets `session.server_recording = true`, replies `recorder.joined`, pushes `session.recording { recording: true, source: 'server' }` to Desk and Assist (S1) | `recording.server_started { recorderId, recordingMode }` (first join only) |
| assignment not joined within 10 s (`RECORDER_JOIN_TIMEOUT_MS`) | A2 timeout | withdraws it; tries the next recorder socket (at most 3 sockets per activation) | none |
| `active` | Desk resume (A 7.5 `active -> consent_pending`) | `recorder.pause` to the recorder; the Desk tears down **both** peer connections | none (A's `session.resumed` covers it) |
| `consent_pending` -> `active` again, recorder still joined / paused | A3 re-assign | `recorder.assign { resume: true }` to the **same** socket only; its `recorder.join` replies `recorder.joined { resume: true }` and re-pushes S1 | none |
| any non-ended, recorder joined | `recorder.leave` | clears `live.recorderConnId`, closes the participant row, pushes `session.recording { recording: false, source: 'server' }` (S3) | `recording.server_stopped { recorderId, reason }` |
| any non-ended, recorder joined | recorder socket closed | as `recorder.leave` with `reason: 'recorder_left'`; **no** re-assignment (one server recording per session) | `recording.server_stopped { reason: 'recorder_left' }` |
| any -> `ended`, recorder joined or paused | session end | in the end transaction, **before** `chat.relayed` / `session.ended`: closes the participant row; after commit pushes `session.ended` to the recorder | `recording.server_stopped { recorderId, reason: 'session_ended' }` |

| # | Rule |
|---|---|
| S1 | **Consent visible before media**: the Desk receives `session.recording { source: 'server', recording: true }` before the recorder's first `webrtc.offer` (both go through the same ordered socket). The Desk banner red dot (A 12.1 D3) is on while any source says true; each source only sets its own flag. |
| S2 | **Media gate identical to A hard rule 1**: no recorder `webrtc.*` is relayed unless the session is `active` and the recorder is joined (`error consent_required` otherwise; never buffered). |
| S3 | The Desk closes its recorder peer connection on `session.recording { recording: false, source: 'server' }`, on any hard-rule-2 teardown (A 7.4), on Desk resume and on `assist.reconnected`. |
| S4 | A recorder never sees chat, data channels, files or annotations: its offer has no data channel (`m=application` lines are rejected by the Desk). |
| S5 | `recording.server_started` / `recording.server_stopped` are written at most once each per session, in that order; `server_stopped` is written only after a `server_started`. |

New audit actions (A 5.3 table; shared `audit/actions-a2.ts`, strict schemas):

| Action | Actor | `data` |
|---|---|---|
| `recording.server_started` | recorder (P3) | `{ recorderId, recordingMode: 'server' \| 'both' }` |
| `recording.server_stopped` | recorder (P3) | `{ recorderId, reason: RecorderStopReason }` |
| `recording.stored` | user (Assist) / recorder | A shape plus `source?: 'server'` (present **only** for server recordings, so Phase A entries are unchanged) |
| `recording.failed` | user / system / recorder | A shape plus `source?: 'server'` |
| `org.policy_updated` | user | B shape, `fields: ['recordingMode']` |

## 7. Negotiation between the Desk and the recorder

| # | Rule |
|---|---|
| N1 | The **recorder offers**. Its `RTCPeerConnection` (pion) has two transceivers, `video` then `audio`, both `recvonly`; codecs: VP8 (preferred) and VP9 for video, Opus (48 kHz, 2 ch) for audio; RTCP feedback `nack`, `nack pli`, `goog-remb`. No data channel. Non-trickle offer is allowed (the recorder may wait for ICE gathering to complete); trickled `webrtc.ice` is accepted in both directions. |
| N2 | Server relay: a frame **from the recorder** is re-serialised with `peer: 'recorder'` and sent to the Desk. A frame **from the Desk** with `peer: 'recorder'` goes to the recorder; without `peer` (or `peer: 'assist'`) to the Assist as in A. A frame **from the Assist** is sent to the Desk with any `peer` key removed (an Assist cannot impersonate the recorder). |
| N3 | Desk on a recorder offer: accepted only while sharing (`active`), when `session.created.recordingMode` is `server` or `both`, and when the SDP has no `m=application` line (else ignored, logged locally). Any recorder offer **replaces** an existing recorder peer connection (close the old one first). It creates `RTCPeerConnection({ iceServers: <the Desk's current ICE servers from consent.ok / ice.refresh>, bundlePolicy: 'max-bundle' })`, `setRemoteDescription(offer)`, then `addTrack(screenTrack, stream)` (and `addTrack(micTrack, stream)` when the microphone is live; otherwise sets the audio transceiver's `direction = 'sendonly'` so a microphone enabled later is attached with `sender.replaceTrack(mic)` and no renegotiation), `createAnswer`, `setLocalDescription`, sends `webrtc.answer { peer: 'recorder' }` and trickles `webrtc.ice { peer: 'recorder' }`. |
| N4 | The Desk never offers to the recorder and never restarts its ICE; on `ice.refresh` it applies `setConfiguration` to both peer connections. The recorder recovers a `failed` connection by sending a fresh `webrtc.offer { restart: true }` from a new peer connection (at most 3 times per join), then `recorder.leave { reason: 'media_failed' }`. |
| N5 | The recorder sends RTCP PLI on every new video track, every 3 s until the first keyframe, and whenever the sample builder drops a frame; NACK responses are generated by pion's interceptors. |

## 8. Desk consent text and Assist badge

| # | Rule |
|---|---|
| U1 | Consent screen (A 12.1 D1), `recordingMode` `server` or `both`: an extra paragraph, before the buttons, inside the checklist box: **"This session will be recorded by <org display name>'s server. The recording contains your shared screen and, if you turn it on, your microphone. It is stored in <REGION_LABELS[region]> and its fingerprint is written to a tamper-evident audit log."** `region` comes from `desk.hello.ok.region`. Mode `both` appends **"Your technician may also record the session from their console."** |
| U2 | Banner (D3): the red dot plus "Recording" while any source is true; the label is "Recording (server)" when only the server source is true. |
| U3 | Receipt (D6): "Server recording: yes / no" from `session.ended.serverRecording`. |
| U4 | Assist console: a badge in the console header from the session state: mode `server` / `both` and not yet joined: **"Server recording: waiting"**; joined (`session.recording { source: 'server', recording: true }` or `Session.serverRecording`): **"Server recording"** with a red dot; stopped: **"Server recording stopped"**. The console's **Record** button is disabled with the text "Console recording is disabled by your organisation" when the mode is `off` or `server`. |

## 9. Recording output and upload

| Step | Contract |
|---|---|
| Container | WebM (Matroska subset) via `github.com/at-wat/ebml-go/webm` (Apache-2.0): track 1 video (`V_VP8` or `V_VP9`), track 2 audio (`A_OPUS`, `CodecPrivate` = OpusHead), SimpleBlocks with millisecond timestamps relative to the file start. Mime `video/webm;codecs="vp8,opus"` (or `vp9,opus`). |
| Incremental write | One file per session `OUT_DIR/<sessionId>.webm`, opened at the first video keyframe, written block by block (no in-memory buffering beyond the jitter buffer), plus a sidecar `OUT_DIR/<sessionId>.json` `{ sessionId, recorderId, startedAt, mime, state: 'recording' \| 'finalised' \| 'uploaded' \| 'failed' }`. Frames before the first keyframe are dropped. After a pause the new peer connection's timestamps are rebased onto wall-clock elapsed time and writing resumes at the next keyframe. |
| Finalise | on `session.ended`, `recorder.leave` (own reasons) or a lost signaling connection: close the writer, `fsync`, compute sha256 and byte count over the file. An empty file (0 blocks) is deleted and not uploaded. |
| Upload | `POST /api/v1/internal/recordings`, headers `Authorization: Bearer <RECORDER_TOKEN>`, `X-Requested-With: IndiansAssist` (A 6.1 CSRF rule unchanged; no `Origin`, no cookie), multipart: field `meta` = JSON `{ sessionId, recorderId, mime, durationMs, bytes, sha256 }` (`internalRecordingMetaSchema`), then field `file`. |
| Server checks | token (P2; wrong or missing => `401 unauthenticated`, recorder disabled => `404 not_found`); session exists and its region is served (`404 not_found`); `started_at` set (`403 forbidden`); `recording_mode` is `server` or `both` (`403 forbidden`); within `RECORDING_UPLOAD_WINDOW_SEC` of `ended_at` (`409 already_ended`); org byte quota (A 6.10, `413`); body <= 2 GiB (`413 payload_too_large`); one server recording per session: a `stored` row with `recorded_by = 'server'` => `409 recording_exists` with `details: { recordingId, status, sha256 }`, a `failed` or stale `uploading` one is reused (A 6.10 rule). |
| Server store | streams through sha256 into `ObjectStorage.put` (key A 9 `<region>/<orgId>/<sessionId>/<recordingId>.webm`); the computed sha256 and byte count must equal `meta.sha256` / `meta.bytes`, else the object is deleted, the row `failed`, audit `recording.failed { recordingId, error: 'sha256_mismatch', source: 'server' }` and `400 validation_failed`. Success: row `stored`, audit `recording.stored { recordingId, sha256, bytes, mime, storageKey, source: 'server' }` with the recorder actor, `chained_into` set; `201 Recording` (`recordedBy: 'server'`). |
| Retries | recorder side: up to `UPLOAD_RETRIES` (5) attempts, backoff 2 s, 4 s, 8 s, 16 s, 32 s (+-20 % jitter, cap 60 s), only on network errors, `429` and `5xx`; `409 recording_exists` with the same sha256 is success; any other `4xx` is final (`state: 'failed'`, file kept). Success deletes the file unless `KEEP_FILES=true`. |
| Restart recovery | at start the recorder scans `OUT_DIR` for sidecars in `recording` / `finalised` state, finalises and uploads them (the WebM written so far is a valid prefix: unknown-size segment and clusters). |
| Verify | unchanged (A 6.10 `POST /recordings/:id/verify`); it works for both sources. |

Database changes (migration `0004_recorder`): pgEnums `recording_mode` (`off`, `assist_only`, `server`, `both`) and `recording_source` (`assist`, `server`); `participant_role` gains `recorder`; `org.recording_mode recording_mode not null default 'assist_only'`; `session.recording_mode recording_mode null`; `session.server_recording boolean not null default false`; `recording.recorded_by recording_source not null default 'assist'`; `recording.uploaded_by` becomes nullable with check `recording_uploader_present`: `recorded_by = 'server' or uploaded_by is not null`; the unique `recording_session_id_unique (session_id)` is replaced by `recording_session_source_unique (session_id, recorded_by)` (one recording per session **per source**).

## 10. Internal ICE

`GET /api/v1/ice?recorderId=<id>` with `Authorization: Bearer <RECORDER_TOKEN>` (no cookie) answers the A 6.11 `IceResponse` built for principal `recorder:<recorderId>` (TURN username `<expiry>:recorder:<recorderId>`), 60 / minute per `recorderId`. A wrong token is `401 unauthenticated`; without the header the A 6.11 cookie route applies unchanged. The recorder caches the answer until 80 % of `iceTtl`.

## 11. Limits and timeouts

| Item | Value |
|---|---|
| `recorder.hello` deadline | 5 s (A hello timeout) |
| Assignment join timeout | 10 s, at most 3 recorder sockets per activation |
| `maxSessions` per recorder socket | default 8, max 256 (`MAX_SESSIONS` env on the recorder) |
| Max recording size | 2 GiB (`LIMITS.recordingMaxBytes`); at the limit the recorder finalises and sends `recorder.leave { reason: 'limit_reached' }` |
| Max recording duration | `MAX_DURATION` (default 4 h), then as above |
| First keyframe wait | 10 s after a track arrives, PLI every 3 s meanwhile; no keyframe => `recorder.leave { reason: 'media_failed' }` |
| Signaling reconnect (recorder) | exponential 1 s .. 30 s with jitter; joined sessions of a lost connection are finalised and uploaded (no mid-session re-join in A.2) |
| Upload | 5 attempts, 2 s .. 60 s backoff, 10 min per attempt timeout |

## 12. Metrics

| Where | Series |
|---|---|
| api (`METRICS_PORT`) | `ia_recorder_connections` gauge (helloed recorder sockets), `ia_recorder_sessions` gauge (joined), `ia_recorder_assign_failures_total` counter |
| recorder (`HTTP_ADDR`, `GET /metrics`, prometheus `client_golang`) | `ia_recorder_sessions_active` gauge, `ia_recorder_signal_connected` gauge per URL, `ia_recorder_signal_reconnects_total`, `ia_recorder_rtp_packets_total{kind}`, `ia_recorder_frames_written_total{kind}`, `ia_recorder_bytes_written_total`, `ia_recorder_pli_sent_total`, `ia_recorder_uploads_total{result="ok\|retry\|failed"}`, `ia_recorder_upload_seconds` histogram, Go runtime defaults |
| recorder health | `GET /healthz` -> `200 {"ok":true,"connected":<n>,"sessions":<n>}` when at least one signaling connection is helloed, else `503` with the same body |

Logs (both sides): structured JSON; SDP, ICE candidates, tokens and the `Authorization` header are never logged (A 6 logging contract). Recorder log lines carry `sessionId`, `recorderId` and `signal` (the URL host) when known.

## 13. Environment

**api** (A 11.1 additions; `infra/.env.example` and `apps/api/.env.example`):

| Var | Default | Meaning |
|---|---|---|
| `RECORDER_TOKEN` | `` (disabled) | service token of section 2 P2; prod: >= 32 chars when set |

**recorder** (`services/recorder`):

| Var | Default | Meaning |
|---|---|---|
| `API_URL` | `http://localhost:4000` | REST base (internal upload, ICE) |
| `SIGNAL_URL` | `API_URL` with `ws(s)` and `/signal` | comma list, one connection per api node (H5) |
| `RECORDER_TOKEN` | required | P2 |
| `RECORDER_ID` | host name | P4 |
| `REGION` | `in-mum` | sent in `recorder.hello`; must be served by the node |
| `OUT_DIR` | `./data/recorder` | working files (section 9) |
| `HTTP_ADDR` | `:9470` | `/healthz` and `/metrics` (never proxied by nginx) |
| `MAX_SESSIONS` | `8` | per signaling connection |
| `MAX_DURATION` | `4h` | Go duration |
| `UPLOAD_RETRIES` | `5` | section 9 |
| `KEEP_FILES` | `false` | keep uploaded files |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Compose: service `recorder` (built from `services/recorder`), internal only, `network_mode` default, UDP media ports `RECORDER_UDP_PORT_MIN`..`MAX` (default 50000-50100) published for ICE host candidates, `depends_on: api`.

## 14. Deviations and amendments

| # | Text | A.2 position | Why |
|---|---|---|---|
| Z1 | A 4.2 `recording.session_id` unique, `uploaded_by` not null | unique per `(session_id, recorded_by)`; `uploaded_by` null for server rows | mode `both` stores two recordings per session; the recorder is not a user |
| Z2 | A 5.3 system actor label `system` | the recorder actor is `system` with id `recorder:<id>` and label `recorder` | distinguishes the service from timers and the sweeper in the chain |
| Z3 | A 7.3 "every `t` has exactly one shape" | `webrtc.*` gains optional `peer`; `session.recording` optional `source`; `session.created` optional `recordingMode`; `session.ended` optional `serverRecording` | additive, Phase A clients unaffected |
| Z4 | A 9 "one recording per session in Phase A" | one per source | Z1 |
| Z5 | Multi-node bridging of participant sockets (A 7.6 N1) | recorder sockets are not bridged; one recorder connection per node (H5) | keeps the bridge unchanged in A.2 |
| Z6 | No mid-session recorder re-join or hand-over | a lost recorder ends server recording for that session (`recorder_left`) | one server recording per session; hand-over needs file stitching (A.3) |
