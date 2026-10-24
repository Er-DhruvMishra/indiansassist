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
| Playwright (@playwright/test) and the Chromium build it downloads | Apache-2.0 (Chromium: BSD-3-Clause) | Package 1 two-browser e2e (`apps/web/e2e`) and the Package 2 extension e2e (`apps/extension/test/e2e`, unpacked extension in a persistent Chromium context); dev only, not shipped | in use (dev) |
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
| rrweb 2.1.7 (exact pin) with rrweb-snapshot, rrdom, @rrweb/types, @rrweb/utils, mitt, @xstate/fsm, base64-arraybuffer | MIT (all) | P2 DOM mirroring: replay in the Assist console's replayer frame (`apps/web`); `record()` in the extension capture script (`apps/extension`, bundled into `content.js`) | in use (Phase B, web and extension) |
| @types/chrome 0.3.4 (+ @types/har-format) | MIT | extension API typings (`apps/extension`, dev only, not shipped) | in use (dev, Phase B) |
| eslint-plugin-no-unsanitized 4.1.5 | MPL-2.0 (unmodified dev tool, nothing copied into our code, not shipped) | bans `innerHTML` and friends in `apps/extension` (section 12.1) | in use (dev, Phase B) |
| pion/webrtc v4 (with pion/ice, interceptor, rtcp, rtp, dtls, srtp, sctp, sdp, stun, turn, transport, mdns, logging, randutil, datachannel) | MIT | server-side recorder (`services/recorder`): receive-only peer connection, RTP depacketising, NACK / PLI | in use (Phase A.2) |
| at-wat/ebml-go | Apache-2.0 | server-side recorder: incremental WebM (Matroska) writer | in use (Phase A.2) |
| gorilla/websocket | BSD-2-Clause | server-side recorder: `/signal` client | in use (Phase A.2) |
| prometheus/client_golang (+ client_model, common, procfs; beorn7/perks, cespare/xxhash MIT; munnerz/goautoneg BSD-3-Clause) | Apache-2.0 | server-side recorder `/metrics` | in use (Phase A.2) |
| golang.org/x/{crypto,net,sys,time}, google.golang.org/protobuf, google/uuid, wlynxg/anet | BSD-3-Clause | indirect dependencies of the recorder | in use (Phase A.2) |
| Go toolchain and standard library (golang:1.27 build image) | BSD-3-Clause | builds `services/recorder` | in use (build only) |
| distroless static-debian12 base image | Apache-2.0 (Debian packages under their own permissive licences) | recorder runtime image | self-hosted image |
| RustDesk, MinIO source | AGPL | reference reading only, never copied | forbidden in repo |
