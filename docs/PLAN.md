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

## 3. Phase A scope (foundation + Package 1)

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

- **B, Package 2**: `apps/extension` MV3, rrweb capture over WS to Assist replay, Side Panel chat/voice/files, tab and tab group control, field masking, browser backstage. Reuses the signaling service and console shell.
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
