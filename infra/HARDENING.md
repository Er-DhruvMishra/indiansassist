# IndiansAssist hardening notes

Deliverable of contracts section 11.4 P6. Read [README.md](README.md) first; its section 6 is the short
checklist, this file holds the reasons and the commands. Everything here is per region stack.

## 1. Secrets: generation, storage, rotation

Generate with `sh infra/scripts/init-env.sh` (uses `openssl rand -hex`). Compose interpolates each secret
with `${VAR:?}`, so an empty value stops `docker compose up`; nothing has a default password.

| Secret                            | Format                                      | Rotation                                                                                      | Effect of rotating                                                                                                                                                              |
| --------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_OWNER_PASSWORD`         | hex                                         | `ALTER ROLE ia_owner PASSWORD '...'`, update `.env`, `up -d migrate`                          | none for users                                                                                                                                                                  |
| `IA_APP_DB_PASSWORD`              | hex                                         | `ALTER ROLE ia_app PASSWORD '...'`, update `.env`, `up -d api`                                | api restart                                                                                                                                                                     |
| `SESSION_COOKIE_SECRET`           | >= 32 chars                                 | update `.env`, `up -d api`                                                                    | every Assist is logged out; outstanding recording download links (600 s) stop working (the presign key is HKDF-derived from it)                                                 |
| `TOKEN_SIGNING_KEY`               | 64 hex (Ed25519 seed)                       | see below                                                                                     | new tokens and checkpoints use the new `kid`                                                                                                                                    |
| `TURN_SECRET`                     | >= 32 chars                                 | update `.env`, `up -d api coturn` together, in a maintenance window                           | outstanding TURN credentials fail; running relayed sessions drop at their next allocation refresh. For zero downtime run a second coturn with the new secret during the overlap |
| `VALKEY_PASSWORD`                 | hex                                         | update `.env`, `up -d valkey api`                                                             | presence is rebuilt; live sockets reconnect                                                                                                                                     |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | alphanumeric (Garage: `GK`+24 hex / 64 hex) | update `.env`, `up -d seaweedfs api` (Garage: import the new key, grant, then remove the old) | none                                                                                                                                                                            |

**Signing key rotation** (contract 3.4): print the current public key with
`TOKEN_SIGNING_KEY=<current seed> node scripts/signing-pubkey.mjs`, append that `pub` to
`TOKEN_SIGNING_KEYS_PREVIOUS` (comma list), set a new `TOKEN_SIGNING_KEY`, restart the api. Old tokens keep
verifying and old checkpoints stay verifiable through `/.well-known/indiansassist.json`. Remove the old key
after its longest-lived token expired (`enrollment`: 30 days); after a **compromise** remove it immediately,
which makes every token with that `kid` fail verification. Keep every retired seed in the secrets manager:
exported JSONL files embed the public keys, but you may need to prove which key signed a checkpoint.

`infra/.env` is written with mode 600, is git-ignored and excluded from the Docker build context. Store it in a
secrets manager, never in a ticket, chat or image.

## 2. Postgres roles and the append-only audit

| Role                         | Used by                | Rights                                                                                                          |
| ---------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ia_owner` (`POSTGRES_USER`) | `migrate` service only | owns the schema                                                                                                 |
| `ia_app` (`DB_APP_ROLE`)     | api (`DATABASE_URL`)   | DML on application tables; **no** UPDATE / DELETE / TRUNCATE on `audit_entry`, `audit_checkpoint`; owns nothing |

- `postgres/init/01-roles.sh` creates `ia_app` (NOSUPERUSER, NOCREATEDB, NOCREATEROLE), revokes `CREATE` on
  `public` from everyone and sets default privileges for tables the owner creates later.
- `migrate` (`api/migrate.mjs`) applies migrations as the owner, grants DML, then revokes UPDATE / DELETE /
  TRUNCATE on the two audit tables and fails if `ia_app` owns any table. It runs on every `up`.
- The api container does not receive the owner credential (`MIGRATE_DATABASE_URL` is empty there).
- `NODE_ENV=production` makes `DB_APP_ROLE` mandatory in the api config.
- Triggers `audit_entry_immutable` / `audit_entry_no_truncate` block changes even for the owner, but not for a
  superuser. The tamper evidence against a superuser is the signed checkpoints (`audit.anchored`, contract
  5.6): keep the structured log (`audit_checkpoint` lines) in an external sink so an independent copy exists.
- Check: `docker compose exec postgres psql -U ia_owner -d indiansassist -c "\dp audit_entry"` must show
  `ia_app=ar` (INSERT, SELECT) only.

## 3. Network exposure and coturn

- Exposed: 80, 443 tcp (web), 3478 udp/tcp, 5349 tcp, relay range udp (coturn). Nothing else is published;
  `backend` (postgres, valkey, seaweedfs, migrate) is an internal network without egress; coturn sits only on
  `edge` and the api never joins it.
- Production relay: `docker-compose.turn-host.yml` (host networking) with `TURN_MIN_PORT=49152`,
  `TURN_MAX_PORT=65535`. On host networking coturn can reach the host's own services, so the
  `denied-peer-ip` list matters even more: it blocks 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
  192.0.0/24, 192.168/16, 198.18/15, 224.0.0.0-255.255.255.255 (multicast and reserved), `::1`, `fc00::/7`, `fe80::/10` and IPv4-mapped IPv6.
  This prevents a TURN client from relaying into Postgres, Valkey, SeaweedFS, Keycloak or your LAN. Add an
  `allowed-peer-ip` only for a documented need, and re-run `pnpm validate:infra`.
- coturn also runs with `no-cli`, `no-multicast-peers`, `no-loopback-peers`, `secure-stun`,
  `no-software-attribute`, TLS 1.2+ only, `user-quota=12` and `total-quota=1200`.
- Host firewall example (ufw): `ufw default deny incoming; ufw allow 80,443/tcp; ufw allow 3478; ufw allow 5349/tcp; ufw allow 49152:65535/udp`.
  Docker publishes ports through iptables and bypasses ufw for published ports; rely on the fact that only the
  ports above are published, and use a cloud security group as the outer wall.

## 4. TLS material and renewal

See README section 4. Rules: never run production on the self-signed fallback; renew at least 30 days before
expiry and reload nginx (`nginx -s reload`) and restart coturn from the renewal hook; keep `privkey.pem`
readable only by root and the coturn user. TLS 1.2 is enabled only for older Desk browsers: once your users
allow it, set `ssl_protocols TLSv1.3;` in `nginx/nginx.conf` and add `no-tlsv1_2` to the coturn template.

## 5. Rate limits

- The api enforces contract 6.12 (per-IP auth, public-lookup and `desk.hello` limits, the per-node short-code
  failure budget, WS upgrade and frame limits). Compose forces `RATE_LIMIT_DISABLED=false`.
- `TRUST_PROXY=true` is safe only because nginx overwrites `X-Forwarded-For` with the peer address. A further
  proxy in front needs the `realip` configuration of README section 4, otherwise every client shares one key.
- nginx adds coarse flood ceilings (`limit_req` 20 r/s per IP on `/api/`, 1 r/s with burst 20 on auth
  endpoints, 200 concurrent connections per IP) that absorb floods before Node.
- Alert on `short_code_budget_exhausted` (warn log) and on `ia_rate_limited_total`,
  `ia_short_code_misses_total` from `/metrics` (port 9464, internal only, never proxied).

## 6. Logs: retention and redaction

- nginx logs `$uri` only (no query string, no `$request`), and bearer tokens travel in the URL fragment which
  browsers never send. The api's pino redaction covers cookies, authorization, SDP, chat text, tokens, resume
  keys, invites, passwords, signatures and TURN credentials at every level.
- Container logs rotate at 20 MB x 5 files (Compose `x-logging`). Ship them to a sink in the **same region**
  and set retention there to your policy (suggested: 30 days for access logs, 1 year for `audit_checkpoint`).
- coturn logs to stdout in `simple-log` mode; `verbose` stays off (it logs far more session detail than an audit needs).

## 7. Object storage

- SeaweedFS is the default (Apache-2.0); its S3 identity for the api is limited to `Read`, `Write`, `List`,
  `Tagging` on the region bucket only, and the S3 port is internal.
- Garage (AGPL-3.0) is an opt-in profile, run unmodified as a network service only (contract X6).
- Managed S3 instead: set `S3_ENDPOINT`, `S3_REGION` (a bucket physically in the stack's region),
  `S3_FORCE_PATH_STYLE=false` if required, use a key restricted to that one bucket, enable default
  encryption and block public access.

## 8. Backups

`sh infra/scripts/backup.sh <dir>` per region (README section 5). Encrypt, keep in-region, test restores
quarterly, and back up `infra/.env` (and retired signing seeds) separately in the secrets manager.

## 9. Residency checklist (one Compose stack per region)

- [ ] Each region has its own host(s), `infra/.env`, secrets, Postgres volume, bucket and coturn.
- [ ] `SERVED_REGIONS` equals `DEFAULT_REGION` on every stack (Compose sets it).
- [ ] `TURN_URLS` / `STUN_URLS` name only this region's TURN host; the residency report shows no
      `thirdPartyHosts` (or you documented why).
- [ ] Backups and log sinks are located in the same region.
- [ ] `REGION_ORIGINS` and `VITE_REGION_ORIGINS` are identical on every stack, `https:` only, and the web image
      was rebuilt after the last change.
- [ ] `GET /api/v1/orgs/current/residency` for a test org reports the expected region, bucket and prefix.

## 10. Scaling the api (replicas need the redis presence driver)

More than one `api` replica per region stack is supported **only with `PRESENCE_DRIVER=redis`** (Valkey, contract
10.2), which Compose sets. With it, token waiting state, the token -> session pointer, the online-Assist registry,
node heartbeats (`ia:node:<NODE_ID>`, TTL 90 s) and the `sweeper` lease live in Valkey; the N4 sweep runs on one
node at a time and only ends sessions of a node whose heartbeat really expired; the signaling bridge (contract 7.6
N1) pipes a Desk and an Assist on different replicas to the session's owner node over `node:<id>` and fans knocks,
revocations and sign-outs out over `cluster`; and the HTTP and WS rate limits are counted in Valkey, so they hold
across replicas (the `signal.forbidden` budget and the per-socket frame bucket stay per replica).

- Give every replica a distinct, stable `NODE_ID` (default `<hostname>:<pid>`; set it explicitly in orchestrators
  that reuse hostnames), the same `DATABASE_URL`, `REDIS_URL`, `SESSION_COOKIE_SECRET` and `TOKEN_SIGNING_KEY`.
- Valkey carries signaling frames between replicas: keep it on the private network only (no published port),
  with `requirepass` / ACLs, exactly like the database.
- Any load balancer policy works for `/signal` (no sticky sessions needed); keep the WebSocket idle timeout above
  the 25 s ping interval.
- With `PRESENCE_DRIVER=memory` run exactly **one** replica: the memory driver cannot see other nodes, so the
  bridge and the lost-node sweep are off and a Desk and an Assist on different replicas would never meet. The api
  logs `presence driver is single-node: run one api replica` at boot in that mode.
- A replica that dies takes its own sockets with it; sessions it owned end `error` within ~100 s (heartbeat TTL +
  sweep) unless a participant resumes on another replica first (the resume adopts the session).
