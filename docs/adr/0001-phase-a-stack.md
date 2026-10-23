# ADR 0001: Phase A stack

Status: accepted, 23 Oct 2026. Amended 23 Oct 2026 (revision 2 of `docs/specs/phase-a-contracts.md`): where this ADR and the contracts differ, the contracts win; the amended bullets are marked below.

- Backend: TypeScript, Node 22, Fastify 5, `ws` for `/signal`. (PRD 15.1 chose TS for API, signaling, console.)
- Media relay / server-side recorder: Go + pion, deferred to Phase A.2 (no Go toolchain on the build box yet). Assist-side MediaRecorder covers P1 recording first.
- Database: PostgreSQL via Drizzle ORM. Local dev and tests run on PGlite (embedded Postgres) so the schema is identical everywhere.
- Presence / token polling: adapter interface. In-memory implementation for single-node dev; Redis/Valkey implementation for multi-node, carrying the signaling bridge between api replicas (contracts 7.6 N1) and the cluster-wide rate limiter.
- Auth: pluggable. Local email+password (argon2id) with httpOnly cookie sessions for Phase A; OIDC adapter (Keycloak) for SSO in Phase E. Rationale: Keycloak is not runnable locally without Docker, and the token/console flow must not block on it.
- Token format (amended): `ia1.<kid>.<base64url(payload)>.<base64url(ed25519 sig)>`, payload is canonical JSON of exactly ten fields {v, tid, org, by, tier, typ, reg, iat, exp, nonce}; `kid` selects the verifying key, `nonce` binds the compact string to one row (contracts section 3). Server keeps the private key; clients verify with the published public key (base64url).
- Audit (amended): Postgres append-only table (no UPDATE/DELETE/TRUNCATE grants), per-org sha256 chain over canonical JSON of (prev_hash, seq, org_id, session_id, actor, action, reason, region, ts, data), plus Ed25519-signed checkpoints (`audit_checkpoint`, `audit.anchored` entries) so a rewritten chain is detectable (contracts section 5.6).
- Object storage (amended): S3 API via an adapter; local filesystem in dev, SeaweedFS (Apache-2.0) or managed S3 per region in production. Garage is AGPL-3.0 and is therefore not the default (usable only as an unmodified network service); MinIO excluded (AGPL friction, PRD 15.5).
- Frontend: Vite + React 18 + TypeScript + Tailwind, single app with Assist and Desk routes.
- Monorepo: pnpm workspaces, shared tsconfig, vitest, eslint.
