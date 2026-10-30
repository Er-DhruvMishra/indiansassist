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
- **Agent (`agent/`, Rust):** the pure-Rust crates are built and tested on `x86_64-pc-windows-gnu`: `ia-core` (the `ia.sec` handshake and frames, ABR, join input, download and sidecar parsing, file names, playbook arguments, the op table), the platform traits, the scancode and coordinate mapping, the BGRA to I420 conversion and the UI model. `cargo fmt`, clippy `-D warnings` and 115 tests pass. The runnable session is not built: the WS client, webrtc-rs peer, encoders, capture and egui UI sit behind the `media`/`winapi`/`gui` features and need a C toolchain this machine does not have. The dev binary only resolves the token source.
- **Android host (`apps/android`):** `assembleDebug` builds and `testDebugUnitTest` passes (72 tests). The emulator smoke needs the api's P3 path.
- **Shared:** all of section 13.1 and the section 16.2 additive changes: native `desk.hello` (`deskClientSchema` native variant, `handover`, `resumeKey` on hand-over), `desk.consent.native`, the new P3 messages (`desk.consent_clipboard` / `_monitors`, `desk.elevation`, `elevation.handover`, `session.handed_over`, `agent.stats`), `agent/download.ts`, `agent/playbook.ts`, `agent/sec-handshake.ts` (the handshake driver the console and `smoke:p3` share), `audit/actions-p3.ts` (incl. the `control.input` `os` branch), REST additions and `agentPolicySchema`. The Phase C enums moved to `enums-p3.ts` (re-exported). New fixtures `playbook-args.json` and `playbook-frames.json`; the two generated name fixtures are unchanged (`pnpm agent:fixtures` passes).
- **db:** migration `0005_phase_c` (`consent_level` += `control`, `elevated`; `playbook_interpreter`, `elevation_level`; tables `playbook`, `playbook_run`, `elevation_handover`; the session P3 columns; `org.require_sas_confirm`) and repositories.
- **api:** download grant flow with desk codes and the dev placeholder build, signed `.iaconfig`, `Presence.consume` / `incr` on both drivers, Origin-less `deskOnly` sockets, the native tier gate and minimum version, the section 7.2 hand-over (mint, binding order of checks, 4411, sweeper), the P3 consent family, `os.*` report gating with `control.refused`, playbook CRUD and the run endpoint, the starter catalogue (seeded at P3 signup), the agent policy, the recorder on P3 sessions with pause / re-assign across the hand-over, stats fold, `sec:` notes and idempotent `session.end`, residency counts.
- **web:** the `/join` p3 branch, `AgentConsole` (monitor picker and mosaic, input modes incl. elevated, security-code gate, clipboard toggle, elevation dialog, playbook panel with live output, agent stats with floor mode), the streaming P3 file sender, `/app/playbooks` and the `.iaconfig` button.
- **Gates (31 Oct 2026):** build, typecheck, lint; tests shared 299, db 62 + 3 skipped, api 192, web 223, extension 129; `pnpm test:scripts` 25; `pnpm validate:infra`; `pnpm agent:fixtures`; against one api started with `SIGNUP_PLAN_TIER=p3_portable` and `RECORDER_TOKEN`: `pnpm smoke` 26/26, `smoke:p2` 14/14, `smoke:recorder` 16/16 (12 + 4 P3 cases), `smoke:p3` 12/12.
- **Open:** a real agent session (the `media` build), `e2e:p3` / `agent.spec.ts`, P3 console voice and Assist-side recording, the File System Access receive path, nginx `proxy_buffering off` for downloads, Compose mount of `AGENT_DIST_DIR`, the Android emulator smoke against the api.

