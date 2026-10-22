# ADR 0001: Phase A stack

Status: accepted, 23 Oct 2026

- Backend: TypeScript, Node 22, Fastify 5, `ws` for `/signal`. (PRD 15.1 chose TS for API, signaling, console.)
- Media relay / server-side recorder: Go + pion, deferred to Phase A.2 (no Go toolchain on the build box yet). Assist-side MediaRecorder covers P1 recording first.
- Database: PostgreSQL via Drizzle ORM. Local dev and tests run on PGlite (embedded Postgres) so the schema is identical everywhere.
- Presence / token polling: adapter interface. In-memory implementation for single-node dev; Redis/Valkey implementation for multi-node.
- Auth: pluggable. Local email+password (argon2id) with httpOnly cookie sessions for Phase A; OIDC adapter (Keycloak) for SSO in Phase E. Rationale: Keycloak is not runnable locally without Docker, and the token/console flow must not block on it.
- Token format: `ia1.<base64url(payload)>.<base64url(ed25519 sig)>`, payload is canonical JSON {tid, org, by, tier, typ, reg, exp, iat}. Server keeps the private key; clients verify with the published public key.
- Audit: Postgres append-only table (no UPDATE/DELETE grants), per-org sha256 chain over canonical JSON of (prev_hash, org_id, session_id, actor, action, reason, region, ts, data).
- Object storage: S3 API via an adapter; local filesystem in dev, Garage or managed S3 per region in production. MinIO excluded (AGPL friction, PRD 15.5).
- Frontend: Vite + React 18 + TypeScript + Tailwind, single app with Assist and Desk routes.
- Monorepo: pnpm workspaces, shared tsconfig, vitest, eslint.
