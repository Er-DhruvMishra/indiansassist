# IndiansAssist, Development Plan

Source of truth: [PRD.md](./PRD.md). Vocabulary: **Desk** = the helped computer (employee). **Assist** = the technician console.

## 1. Delivery strategy

The PRD defines five phases (A to E). We build them in order, each phase shipping something usable. Windows and Chromium are first-class in every phase; other platforms follow per PRD section 5.

Local dev constraints (23 Oct 2026): the build machine has Node 22, pnpm 11, git, Python 3.14. It does not have Docker, Postgres, Redis, Go, or Rust. Therefore:

- Phase A is 100% TypeScript. The backend runs locally on embedded Postgres (PGlite) and an in-memory presence store; production and self-host use real Postgres, Redis/Valkey and coturn via Docker Compose. Application code never knows the difference (adapter interfaces).
- The Go/pion media relay (server-side recording) is deferred to Phase A.2; MediaRecorder on the Assist side covers P1 recording first.
- The Rust toolchain is installed at the start of Phase C.

## 2. Repository layout (pnpm monorepo)

```
indiansassist.com/
  apps/
    api/          Fastify + ws. REST API, WS /signal, token issue/verify, sessions, audit chain, recordings
    web/          Vite + React + TS. Assist dashboard + console, Desk web room (P1), download/join page
  packages/
    shared/       Domain types, zod schemas, signaling protocol, signed token format, hash chain, regions
    db/           Drizzle ORM schema + migrations. pg driver in prod, PGlite in dev/test
  infra/
    docker-compose.yml   postgres, valkey, coturn, keycloak (optional), garage (S3), api, web
    coturn/              turnserver.conf
  docs/
    PRD.md, PLAN.md, LICENSE-REGISTER.md, adr/*, specs/*
```

Later phases add `apps/extension` (P2, MV3 + rrweb), `agent/` (P3/P4, Rust workspace), `apps/android`, `apps/ios`, `services/relay` (Go + pion).

## 3. Phase A scope (foundation + Package 1), done

Deliverables, in build order:

1. **Contracts** (`docs/specs/phase-a-contracts.md`): signaling protocol messages, signed token format, REST API, DB schema, audit hash chain rules, region list. Everything else implements this document.
2. **packages/shared**: the contracts as code, with unit tests.
3. **packages/db**: Drizzle schema for org, user, technician_seat, device, token, session, audit_entry, recording, integration. `org.data_region` mandatory and immutable. Migrations. PGlite and pg clients behind one factory.
4. **apps/api**:
   - Auth: local email + password (argon2id) with httpOnly session cookie; OIDC adapter interface with a Keycloak stub for SSO (Phase E completes SAML).
   - Orgs and users, RBAC roles: technician, senior_technician, org_admin, auditor, observer.
   - `POST /tokens`: Ed25519 signed compact token, tier + type (one_time | timed | enrollment), short expiry by default.
   - `GET /download?t=`: join page for P1 (browser share needs no download; later tiers serve a stub). Clipboard copy of the token on click, "copy token again" button.
   - `WS /signal`: token poll (`waiting | matched`), knock + admin confirm (no media before consent on both sides), SDP/ICE relay, chat relay fallback, presence.
   - `GET /ice`: STUN/TURN config with time-limited TURN REST credentials (coturn `use-auth-secret`).
   - Sessions: open/close, consent state, path (p2p | relay), stats snapshots.
   - Audit: append-only table, sha256 hash chain per org, `GET /sessions/:id/audit`, JSONL export, `verify` endpoint that recomputes the chain.
   - Recordings: multipart upload from Assist, sha256 on server, hash written into the audit chain, S3 compatible storage adapter (local filesystem in dev).
   - Region awareness: every org pinned to a region; the API refuses cross-region access; region appears in all audit entries and in a data residency report endpoint.
5. **apps/web**:
   - Assist: signup/login, dashboard, create token (tier, lifetime), token list with copy link, live console: remote view, chat, voice, file transfer, annotation overlay, recording (MediaRecorder then upload), network path transparency (P2P/relay, RTT, codec, bitrate via getStats), audit viewer with chain verification badge, data residency report.
   - Desk web room: consent screen, pre-share checklist ("blur on share" guidance), `getDisplayMedia`, persistent "You are sharing with <technician>" banner, chat, voice, file transfer, annotation overlay, stop sharing at any time, consent receipt at session end.
   - WCAG AA baseline: keyboard reachable, labelled controls, contrast.
6. **infra**: Docker Compose self-host story, coturn config, `.env.example`, hardening notes.
7. **Quality gates**: typecheck, lint, unit tests (shared, api), API integration tests on PGlite, two-browser smoke script.

Out of Phase A: server-side pion recorder (Phase A.2), Keycloak-backed SSO end to end (Phase E), billing (seat counting exists in the data model; invoicing later).

## 4. Phases B to E (summary)

- **B, Package 2** (in review, see section 7): `apps/extension` MV3, rrweb capture over WS to Assist replay, Side Panel chat/voice/files, tab and tab group control, field masking, browser backstage. Reuses the signaling service and console shell.
- **C, Package 3 + Android host**: Rust workspace (`agent/`), Windows first: DXGI capture, SendInput, libsodium E2EE, VP8/VP9/AV1/H.264, QUIC transport, elevation unlock with reason capture, self delete, playbooks, recording hash into the chain. Android host via MediaProjection + Accessibility Service.
- **D, Package 4**: service install, enrollment to device identity, Wake on LAN + LAN waker mesh, AMT cold power on (hardware gated, v1), MSI/GPO, fleet groups and policy, offline action queue, self healing agent.
- **E, Cross platform + enterprise**: macOS/Linux agents, iOS share + controllers, SSO/SAML, PSA integrations, OpenBao credential vault, DPDP residency reporting, local LLM session summaries.

## 5. Settled technical decisions

See `docs/adr/`. Highlights: TypeScript backend (Fastify), Drizzle + Postgres (PGlite in dev), Ed25519 compact tokens, sha256 hash chain over canonical JSON, pluggable auth (local + OIDC), S3 compatible permissive object store (Garage) rather than MinIO, source available licence, pnpm workspaces.

## 6. Working agreements

- The PRD is the contract; amend it, do not drift from it silently.
- Every privileged or state changing action writes an audit entry.
- No AGPL code copied into the repo (RustDesk, MinIO are reference reading only). Keep `docs/LICENSE-REGISTER.md` current.
- Windows + Chromium first, then the rest.

## 7. Status (24 Oct 2026)

**Phase A: done.** Every Phase A deliverable in section 3 is built against `docs/specs/phase-a-contracts.md`, except the items listed as out of Phase A. Gates: `pnpm smoke` passes 26/26 and the P1 Playwright run (`pnpm e2e`) passes. The pion recorder (A.2) and full SSO (Phase E) stay deferred as planned.

**Phase A.2 (server-side recorder): implemented, not yet reviewed or committed.** Contract `docs/specs/phase-a2-recorder.md`. Go service `services/recorder` (pion/webrtc v4, ebml-go WebM, prometheus); api recorder participant, org recording policy, internal upload and ICE; Desk second peer connection and consent text; Assist "Server recording" badge. Gates: `pnpm recorder:test` (26 Go tests), `pnpm smoke:recorder` 12/12. Not yet covered: a browser e2e with real media into the recorder, multi-node recorder bridging (contract Z5) and recorder hand-over (Z6).

**Phase B (Package 2): implemented; the review fix round is integrated.** The contract is `docs/specs/phase-b-contracts.md`. All gates pass on the working tree: build, typecheck, lint, unit tests (shared 195, db 58 + 3 skipped, api 138, web 160, extension 125), `pnpm test:scripts` 24, `pnpm validate:infra`, `pnpm smoke` 26/26, `pnpm smoke:p2` 14/14, `pnpm e2e` (1 test, 16 steps) and `pnpm e2e:ext` (4 specs: bandwidth, control, extension, side panel). In the review round:
- The recorder now re-masks revealed values. It holds lines while a `mask.request` is open (SEC-P2-02, prd-F1).
- Keys follow the frame rule in both input modes (prd-F2, SEC-P2-04).
- The capture registration, the debugger tabs and the consent prompt survive a service-worker restart (correctness-F1, F2, F10, F6).
- Tab scope is applied before the scheme, and unsupported tabs disclose less (SEC-P2-03, SEC-P2-07, prd-F6, prd-F7).
- New extension e2e specs cover the join carrier, the side panel, reveal, pause and bandwidth (prd-F3, F4, F5).

Open before Phase B can be called done:
- **Bandwidth gate.** `bandwidth.spec.ts` covers less than §13.4. It runs a 20 s window on scenario A only (set `E2E_BW_SECONDS` to change the length), not 60 s. It does not run scenario B (`spa.html`) or the voice-on totals. Its last run measured 13.6 kbps for the mirror and a 5.0 KiB snapshot, against a 100 kbps limit. Either extend the spec or amend §13.4.
- **prd-F4 is partial.** The toast and bar texts inside closed shadow roots are not asserted by e2e.
- **Known gap (§5.4).** A frame inside a closed shadow root cannot be seen by the frame rule.
- The review-round changes are not committed yet.

**Phase C (Package 3 + Android host): partly built, not reviewed or committed.** The contract is `docs/specs/phase-c-contracts.md`. Status on 31 Oct 2026:
- **Agent (`agent/`, Rust):** the full workspace now builds on the MSVC host with the default `media`/`winapi`/`gui` features. `ia-core` (the `ia.sec` handshake and frames, ABR, join input, download and sidecar parsing, file names, playbook arguments, the op table, and the Phase C live-session decision modules: `ctl`, `consent`, `stats`, `capture_decision`, `filexfer`, `handover`, `playbook`, `teardown`), the platform traits, scancode/coordinate mapping, BGRA->I420 conversion and the UI model are built and tested, plus the `media` layer: the `/signal` client, the webrtc-rs peer with per-monitor VP8 tracks and the seven data channels, the VP8 encoder over prebuilt libvpx, the `ia.sec` handshake driver and the `ControlServer` serve seam. `cargo fmt`, clippy `-D warnings --all-features` and `cargo test --workspace --all-features` pass (189 tests, incl. `tests/loopback.rs::media_loopback` — two real peers handshake to a matching SAS and a VP8 keyframe arrives). The dev console binary (`--features dev`) parses the full CLI (`--code`, `--api-origin`, `--signal-url`, `--auto-consent`, and new: `--synthetic-capture`, `--no-self-delete`, `--stop-after`), resolves the token source and runs the hello/knock/poll exchange. **Not yet wired:** the live serve loop past `session.created` (offer/answer/ICE with the console, the per-channel decrypt-and-serve loops, the `agent.stats` timer, DXGI capture, SendInput/clipboard calls, the egui event loop, the runas hand-over and self-delete spawn).
- **Android host (`apps/android`):** `assembleDebug` builds and `testDebugUnitTest` passes (72 tests). The emulator smoke needs the api's P3 path.
- **Shared:** all of section 13.1 and the section 16.2 additive changes: native `desk.hello` (`deskClientSchema` native variant, `handover`, `resumeKey` on hand-over), `desk.consent.native`, the new P3 messages (`desk.consent_clipboard` / `_monitors`, `desk.elevation`, `elevation.handover`, `session.handed_over`, `agent.stats`), `agent/download.ts`, `agent/playbook.ts`, `agent/sec-handshake.ts` (the handshake driver the console and `smoke:p3` share), `audit/actions-p3.ts` (incl. the `control.input` `os` branch), REST additions and `agentPolicySchema`. The Phase C enums moved to `enums-p3.ts` (re-exported). New fixtures `playbook-args.json` and `playbook-frames.json`; the two generated name fixtures are unchanged (`pnpm agent:fixtures` passes).
- **db:** migration `0005_phase_c` (`consent_level` += `control`, `elevated`; `playbook_interpreter`, `elevation_level`; tables `playbook`, `playbook_run`, `elevation_handover`; the session P3 columns; `org.require_sas_confirm`) and repositories.
- **api:** download grant flow with desk codes and the dev placeholder build, signed `.iaconfig`, `Presence.consume` / `incr` on both drivers, Origin-less `deskOnly` sockets, the native tier gate and minimum version, the section 7.2 hand-over (mint, binding order of checks, 4411, sweeper), the P3 consent family, `os.*` report gating with `control.refused`, playbook CRUD and the run endpoint, the starter catalogue (seeded at P3 signup), the agent policy, the recorder on P3 sessions with pause / re-assign across the hand-over, stats fold, `sec:` notes and idempotent `session.end`, residency counts.
- **web:** the `/join` p3 branch, `AgentConsole` (monitor picker and mosaic, input modes incl. elevated, security-code gate, clipboard toggle, elevation dialog, playbook panel with live output, agent stats with floor mode), the streaming P3 file sender, `/app/playbooks` and the `.iaconfig` button.
- **Gates (31 Oct 2026):** build, typecheck, lint; tests shared 299, db 62 + 3 skipped, api 192, web 223, extension 129; `pnpm test:scripts` 25; `pnpm validate:infra`; `pnpm agent:fixtures`; against one api started with `SIGNUP_PLAN_TIER=p3_portable` and `RECORDER_TOKEN`: `pnpm smoke` 26/26, `smoke:p2` 14/14, `smoke:recorder` 16/16 (12 + 4 P3 cases), `smoke:p3` 12/12.
- **Open:** the agent's live serve loop (the glue above) so a real agent completes a session — this is what `pnpm e2e:p3` proves. The e2e is scaffolded (`apps/web/e2e/package3.spec.ts`, `agent-harness.ts`, a P3 branch of `playwright.config.ts` using `./data/e2e-p3` + `SIGNUP_PLAN_TIER=p3_portable` + `AGENT_DEV_STUB`, and the `e2e:p3` / `agent:build:dev` scripts); it runs through the knock but the post-accept assertions wait on the serve loop. Also open: P3 console voice and Assist-side recording, the File System Access receive path, nginx `proxy_buffering off` for downloads, Compose mount of `AGENT_DIST_DIR`, the Android emulator smoke against the api.

**Phase D (Package 4), the service stream: built, verified and committed as `450258e` (1 Nov 2026).** The
contract is `docs/specs/phase-d-contracts.md` (revision 5). Everything else in Phase D was
already built; this stream was the installed service, the desktop worker and the Phase C
elevation wiring that `agent/README.md` recorded as stubbed.

- **New crates (D §11.1):** `ia-service` (the SCM binary: identity + DPAPI sealing, enrollment,
  the `/signal/device` socket, interactive reporting, the action gate, worker supervision and the
  §4.2 handoff, the queue drain, waker and AMT execution, receipts, the tamper outbox and the
  §10.3 integrity check), `ia-session0` (the launch blob and pipe protocol, the pipe DACL and
  peer checks, §5.3 desktop selection, §3.4 state derivation, the rule 5.1c gates), `ia-waker`
  (magic packet, rule 8.2a segment hashing, the AMT WS-Man client and HTTP Digest), `ia-vault`
  (rule 9.8 injection only), `ia-watchdog` (the §10.1 decision table and the second service),
  `ia-desktop` (the worker: a thin main over the Phase C serve loop with the §4.3 seams).
  `ia-core` gained the portable half: `devsig`, `seal`, `policy`, `fleet`, `enroll`, `queue`,
  `tamper`, `backoff`, `rnd`; `ia-platform` gained the five Phase D traits.
- **Cross-language parity (the fixture D §15.2 asked for):**
  `packages/shared/test/fixtures/fleet/decisions.json`, generated by
  `scripts/gen-fleet-fixtures.mjs` from the TypeScript and replayed by **both**
  `packages/shared/test/fleet-policy.test.ts` and `agent/crates/ia-core/tests/fleet_vectors.rs`
  (the §6.1 merge, the `allowedHours` arithmetic, all 21 §6.2 session rows and all 23 rule 9.9
  action rows). The same test replays `signatures.json` and `seal.json`, so the eight signature
  domains and every seal purpose are byte-identical across the two implementations.
- **Phase C elevation (C §7.3), wired end to end**, and the contract gap resolved: C §7.2
  (revision 3, W43) now carries `gen` in the hand-over blob, which is what the console needs to
  accept the child's rebuild offer.
- **Gates (1 Nov 2026).** `cargo fmt --all --check`, `cargo clippy --all-targets --all-features
  -- -D warnings` and `cargo test --workspace --all-features` green: **524 Rust tests** across 33
  suites, including the §4.2 handoff loopback over real named pipes. `pnpm -r build`,
  `typecheck`, `lint`; tests shared 377, db 71 + 3 skipped, api 267, web 304, extension 129;
  `pnpm test:scripts` 25; `pnpm license:check`; `pnpm agent:fixtures`; `pnpm fleet:fixtures`;
  `pnpm validate:infra`; `packaging:test` (5 node + 7 cargo). Against one api this stream started
  on **port 4105** with `API_ORIGIN` matched (4000 and 4100 were held by other processes):
  `pnpm smoke` 26/26, `smoke:p2` 14/14, `smoke:p3` 12/12, `smoke:recorder` 17/17, **`smoke:p4`
  15/15**.
- **Not built in this stream, each reporting itself honestly** (D §16.3 lists them with the
  reason): the privacy-screen overlay (so the feature is not advertised and the op answers
  `not_supported`), the `print` action (`unsupported`), AMT serial-over-LAN byte forwarding
  (`unsupported`; power-on and boot redirect are built), the rule 3.7b key swap, and the per-use
  approval card of rule 5.4c (the policy flag and the pill banner are enforced).
- **Open, and only a real machine can close it.** Nothing was installed on the development
  machine (the stream's standing rule), so the MSI install, enrollment against a token, a session
  on a real desktop, the secure desktop through DXGI, a real UAC prompt, `SendSAS`, `BlockInput`,
  a service restart and the uninstall are **built but unverified**. They are the manual checks in
  `docs/release.md` and in the handoff brief, and they need a disposable machine and a person.

**Phase D, the whole package: complete (1 Nov 2026), `450258e` and `ab26e53`.** The contract is
revision 6. The three section 13.5 targets the server stream owed are closed and committed
earlier (`2360a64`, `8392daa`): the seven fleet metric series, `smoke:p4:load`, and the
keyboard-only accessibility spec (`e2e:p4`). The api table of section 15.3 has no open row left.

- **Coordinator verification of the service stream, run independently of the stream's own
  report and agreeing with it line for line.** `cargo fmt --all --check` and `cargo clippy
  --all-targets --all-features -- -D warnings` clean; `cargo test --workspace --all-features`
  **529 passed, 0 failed, 2 ignored** across 19 suites. `pnpm -r build typecheck lint`; tests
  shared 377, db 71 (+3 skipped), api 267, web 304, extension 129 (**1,148**); `test:scripts` 25;
  `license:check`; `agent:fixtures --check`; `fleet:fixtures --check`; `validate:infra`;
  `packaging:test` 5 node + 7 cargo. Against one api on **4105** with `API_ORIGIN` matched (4000
  and 4100 are held by leftover processes): `smoke` 26/26, `smoke:p2` 14/14, `smoke:p3` 12/12,
  `smoke:recorder` 17/17, `smoke:p4` 15/15 — **84 steps, none failing or skipped**. `pnpm e2e:p3`
  passes with `E2E_API_PORT=4105`, which is what proves the worker's reuse of the Phase C serve
  loop did not regress it.
- **A review of the new crates for destructive behaviour found none.** The only file removals are
  the enrollment-material shred, the key-blob shred and one test under a temporary directory.
- **Still open, and each needs something this machine cannot give.** The manual checks on a
  disposable machine (install, enrollment, a real desktop session, the secure desktop, one
  elevation prompt, a service restart, uninstall); a serial-over-LAN close carrying real bytes,
  which needs a proxy that streams data; the full-size `smoke:p4:load` run at 2,000 devices,
  proven so far at 25.
- **Android emulator e2e: closed (1 Nov 2026, `2e6fd50`).** `IA_EMULATOR=1 pnpm android:e2e` passes
  17/17 on Pixel 7 API 35, including "Stop ends the session as `desk_stopped`". The earlier failure
  was the harness, not the app: the logcat step encoding turned underscores into spaces.

**Phase E (cross-platform and enterprise): built and verified (2 Nov 2026).** The contract is
`docs/specs/phase-e-contracts.md` revision 4. A foundation stream (`44a53b9`) landed the shared
names, schemas and empty hooks; five streams then built in parallel: **sso** (OIDC with PKCE, SAML
2.0 SP, verified domains by DNS TXT, JIT provisioning, SSO required with break-glass),
**tickets** (Jira, ServiceNow, Freshdesk, Zoho Desk and a signed webhook, with a retrying push
lifecycle), **ai** (session summaries from a redacted transcript, an in-region `local` provider
and an opt-in `anthropic` provider on `claude-opus-5-5`), **residency** (the signed data residency
report, verifiable offline with `scripts/verify-residency.mjs`) and **linux** (the portable agent
on X11: RandR multi-monitor MIT-SHM capture, XTEST input, `sh` playbooks, honest Wayland refusal,
a glibc 2.35 release build). macOS and iOS are specified in section 8 and not built.

- **Coordinator verification across all streams together.** `pnpm build typecheck lint`; tests
  shared 554, db 81 (+3 skipped), api 566, web 381, extension 129 (**1,711**); `test:scripts` 48;
  `license:check`; `agent:fixtures --check`; `fleet:fixtures --check`; `validate:infra`. Rust on
  Windows: fmt and clippy clean, `cargo test --workspace --all-features` **616 passed, 0 failed,
  2 ignored**. Against one throwaway api on 4125: `smoke:e` **47/47** (sso, tickets, ai,
  residency), and on a fresh api `smoke` 26/26, `smoke:p2` 14/14, `smoke:p3` 12/12, `smoke:p4`
  15/15. `pnpm e2e:e` passes all four keyboard-only enterprise specs; `pnpm e2e:p3` still passes
  on Windows. The linux stream's WSL gates: 515 headless tests (16 X11 tests ignored there), 16/16
  under a harness-owned Xvfb, the release ELF gate, and `pnpm e2e:p3:linux` 3/3 (synthetic, X11,
  Wayland).
- **Integration fixes by the coordinator.** `SSO_DEV_DNS_SERVERS` moved into config (refused in
  production and without loopback egress); a null ticket `externalId` end to end; the default
  Playwright suite's api now carries the Phase E local-fake seams, so `pnpm e2e:e` is one
  command; the console greys Control for a Desk without `input` and explains a missing
  `clipboard` feature; `e2e:p3:linux` added to `package.json` and refuses ports 4000, 4100, 4105.
- **Still open.** The vendor request shapes for ServiceNow, Jira and Freshdesk and the Zoho
  data-centre hosts need checking against vendor documentation (Zoho stays empty until then); the
  residency print has about 7 px of headroom on one A4 page; compose never passes
  `FLEET_DATA_KEY` to the api (a Phase D defect); on Linux the `portal` Wayland capture, a Keep
  control, and a run against a real window manager and session bus are not done, and self-delete
  of the built binary was never executed in automation (section 15.8).

## 8. Phase F plan (2 Nov 2026): the Phase E open points and the deferred features

Decisions taken on 2 Nov 2026: the controller is the **mobile web console** (a touch-first,
installable Assist console that serves Android and iPhone/iPad technicians alike; no native
controller app); **Linux unattended is built in full for X11 sessions** (systemd service, the
Phase D enrollment and fleet protocol, deb and rpm, an Ansible role); **Wayland capture ships as
an opt-in second Linux build** (view, chat and files, no control), beside the single X11 binary.
The four Phase E defaults stand (no fallback under `in_geo`, 7-year key retention, 2 summaries
per region, the AI notice in chat only).

Process as in Phases D and E: a binding contract (`docs/specs/phase-f-contracts.md`) with an
independent review; a foundation stream that owns every shared file; parallel streams; the
coordinator's cross-stream integration before commit.

| Stream | Scope | Verified here by |
|---|---|---|
| F0 foundation | shared names and schemas, migration `0009_phase_f`, route and console hooks, licence rows, env keys | the Phase E foundation gates |
| fixes | compose passes `FLEET_DATA_KEY` to the api; the fleet key gets a previous-keys list (W89); the residency print gets real headroom; the Jira, ServiceNow and Freshdesk request shapes and the Zoho data-centre hosts are checked against vendor documentation (Zoho enabled once verified); the Keep (C D5) control in the console and Desk UI on Windows and Linux | unit tests, `smoke:e`, `e2e:e`, Keep applied only to temporary directories |
| mail | invites by email and password reset over the existing `Mailer` (SMTP or log); single-use hashed tokens, no account enumeration, rate limits; SSO-required orgs offer no reset except break-glass | vitest with an in-process fake SMTP server, a smoke flow, a keyboard-only Playwright spec |
| erasure | org erasure by `audit_pepper` destruction (A §4.2): requested by one org_admin, approved by a second, a cooling-off period, PII rows deleted, the pepper destroyed so chain entries become unlinkable while the chain still verifies; the residency report shows `erasure.available: true` | vitest, a smoke flow that erases a throwaway org and verifies its chain afterwards |
| camera | phone as a support camera (PRD 12.8) in P1, P3 and P4 sessions: a QR code or short link opens the phone browser's rear camera with consent; the Assist sees it live, can freeze and snapshot, and the chain records it | vitest, Playwright with fake media, the Android emulator's Chrome |
| mobile | the touch-first Assist console: installable (manifest and an app-shell service worker), touch mapped to pointer (tap, long-press right click, two-finger scroll, pinch zoom of the view), an on-screen keyboard with special keys, phone and tablet layouts | Playwright mobile projects (Android and iPhone emulation) and the Android emulator's Chrome |
| linux-p4 | Linux unattended: the `ia-service` Linux half as a systemd system service, Phase D enrollment and fleet protocol, attaching to the active user's X11 session (logind), deb and rpm, an Ansible role | WSL unit tests, `systemd-analyze verify`, package-content checks, install tests only in a throwaway environment (never this machine or the main WSL distro) |
| wayland | the `portal` build: xdg-desktop-portal ScreenCast over PipeWire, view only; the join page offers it to Wayland users | WSL tests under a headless compositor (needs a one-time `sudo apt install` by the user, named in the contract) |

Waves: F0, then fixes, mail, erasure, camera and mobile in parallel (TypeScript-heavy); linux-p4
and wayland follow, one at a time, because two Rust builds at once exhaust this machine's memory.

A Mac host joined on 2 Nov 2026 as a separate session, which became the **apple** stream: the
macOS P3 agent (ScreenCaptureKit, `zsh` playbooks), its signed packaging, and the iOS app with a
broadcast extension (view only; Apple allows no remote input on iOS).

Still outside this machine: a run against a real Linux window manager and session bus; the
manual checks on a disposable machine; the full-size 2,000-device load run.

### 8.1 Status (3 Nov 2026): wave 1 and the apple stream integrated

Done: F0; fixes, mail, erasure, camera and mobile; the apple stream's macOS P3 agent, macOS
packaging, iOS app and broadcast extension; the coordinator's integration (contract revision 3).
Every gate is green on this machine: build, typecheck, lint, unit tests, `test:scripts`,
`license:check`, both fixture checks, `validate:infra`, `recorder:test`, Rust fmt, clippy and
tests (646 passed), every smoke (`smoke:e` 47, `smoke:f` 27 in all four flows), `e2e:e`, the F
specs, `e2e:mobile` and `e2e:p3`.

Four defects found by the streams are fixed: an installed worker could delete itself; a missing
or unknown playbook interpreter ran as PowerShell (now refused `not_allowed`); the Android agent
lacked `os.sas`; the hourly audit checkpoints stopped at an erased org.

Open after wave 1:

- The Jira, ServiceNow, Freshdesk and Zoho request shapes were checked against vendor
  documentation only; all four stay `verified: false` until a run against a vendor sandbox.
- A phone camera that reconnects through a different api node cannot resume (§15.10).
- `mobile-emulator.spec.ts` is flaky under load on this machine; touch on a real Android phone
  is unverified.
- Manual: iPhone and iPad Safari, a real iPhone broadcast, macOS capture with the permission
  granted, Keep on a real desktop.
- apple: iOS file receive; macOS unattended waits on linux-p4's `ia-session0` unix half.

Next: linux-p4 (wave 2), then wayland (wave 3), then macOS unattended on the linux-p4 base.
