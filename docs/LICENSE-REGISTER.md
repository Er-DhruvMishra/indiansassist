# Licence register

Our code: source available (PRD section 15.5). Third party components we build on or run beside. Working agreement (contracts section 15): every new runtime dependency or Compose image is added here with its licence in the same change, and the register is reviewed at the end of every phase.

| Component | Licence | Use | Status |
|---|---|---|---|
| Fastify, @fastify/* | MIT | API server | in use (Phase A) |
| ws | MIT | WebSocket signaling | in use |
| Drizzle ORM | Apache-2.0 | DB access, migrations | in use |
| PGlite (@electric-sql/pglite) | Apache-2.0 | embedded Postgres for dev/test | in use |
| node-postgres (pg) | MIT | Postgres driver | in use |
| zod | MIT | validation | in use |
| @noble/ed25519, @noble/hashes | MIT | token signing, hashing | in use |
| argon2 | MIT | password hashing | in use |
| React, Vite, Tailwind CSS | MIT | Assist console, Desk web room | in use |
| coturn | BSD-3-Clause | STUN/TURN | self-hosted service |
| PostgreSQL | PostgreSQL Licence | database | self-hosted service |
| Valkey | BSD-3-Clause | presence / pub-sub (Redis compatible) | self-hosted service |
| Keycloak | Apache-2.0 | SSO / OIDC (optional) | planned, Phase E |
| SeaweedFS | Apache-2.0 | object storage (Compose default, S3 gateway) | self-hosted service |
| Garage | AGPL-3.0 (run only as an unmodified separate process over its S3 API, nothing linked or copied) | object storage, optional alternative | self-hosted service, not the default |
| prom-client | Apache-2.0 | `/metrics` | in use (Phase A) |
| nginx | BSD-2-Clause | TLS termination, reverse proxy, static web | self-hosted service |
| ioredis | MIT | Valkey client (redis presence driver) | in use (Phase A, multi-node) |
| @aws-sdk/client-s3, @aws-sdk/s3-request-presigner | Apache-2.0 | s3 storage driver | in use (Phase A) |
| rrweb | MIT | P2 DOM mirroring | Phase B |
| pion/webrtc | MIT | server-side recorder | Phase A.2 |
| RustDesk, MinIO source | AGPL | reference reading only, never copied | forbidden in repo |
