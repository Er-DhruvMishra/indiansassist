# IndiansAssist self-host (infra)

One Docker Compose stack = **one region cluster** (contracts section 1.1 T1): its own Postgres, Valkey,
object-store bucket, coturn, api and web. Nothing is shared or replicated between regions.
Vocabulary: **Desk** = the employee's computer being helped, **Assist** = the technician console.

Binding references: `docs/specs/phase-a-contracts.md` sections 1, 10, 11. Operator detail for each hardening
item is in [HARDENING.md](HARDENING.md).

| File                           | Purpose                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`           | the stack: `postgres`, `valkey`, `seaweedfs` (+ one-shot `storage-init`), `coturn`, `migrate` (one-shot), `api`, `web`; optional profiles `garage` and `sso` (`keycloak`) |
| `docker-compose.turn-host.yml` | production override: coturn on host networking with relay range 49152-65535                                                                                               |
| `.env.example`                 | every variable, documented; secrets empty on purpose                                                                                                                      |
| `scripts/init-env.sh`          | writes `infra/.env` with fresh random secrets (mode 600)                                                                                                                  |
| `scripts/backup.sh`            | Postgres dump + object-store archive for this region                                                                                                                      |
| `coturn/`                      | `turnserver.conf` template (contract 11.5) and the entrypoint that renders it                                                                                             |
| `nginx/`                       | TLS termination, `/api/` + `/signal` + `/.well-known` proxy, security headers (contract 11.4)                                                                             |
| `postgres/init/01-roles.sh`    | creates `ia_owner` (migrations) and `ia_app` (the api, `DB_APP_ROLE`)                                                                                                     |
| `seaweedfs/`                   | default S3 store (Apache-2.0), identity scoped to the region bucket                                                                                                       |
| `garage/`                      | optional S3 store (AGPL-3.0, unmodified network service only, contract X6)                                                                                                |
| `api/migrate.mjs`              | migration runner baked into the api image as `ia-migrate.mjs`                                                                                                             |

## 1. One-command self-host

Requirements: Docker Engine 24+ with Compose v2.24+ (for `!reset` in the TURN override), a DNS name pointing
at the host, and the firewall ports of section 3.

```sh
IA_REGION=in-mum IA_DOMAIN=in.example.com IA_PUBLIC_IP=203.0.113.10 sh infra/scripts/init-env.sh \
  && docker compose -f infra/docker-compose.yml up -d --build
```

`init-env.sh` generates every password and key (`openssl rand -hex`), sets `WEB_ORIGIN = API_ORIGIN =
https://$IA_DOMAIN`, `SERVED_REGIONS = DEFAULT_REGION = $IA_REGION`, the bucket `ia-recordings-$IA_REGION`
and the TURN URLs. It refuses to overwrite an existing `infra/.env` (`FORCE=1` regenerates, which rotates
every secret and makes existing data unreadable to the new credentials: do not do that on a live stack).

Boot order (enforced by `depends_on`): `postgres` (roles created on first start) -> `migrate` (owner role,
then append-only grants) -> `seaweedfs` -> `storage-init` (bucket) -> `valkey` -> `api` (healthy on
`/api/v1/health`) -> `web` (nginx on 80/443). `coturn` starts independently.

Check it:

```sh
docker compose -f infra/docker-compose.yml ps
API_URL=https://in.example.com pnpm smoke          # end-to-end: signup, token, signaling, audit verify
```

The smoke test creates a throwaway org on the target (there is no delete endpoint in Phase A); run it against
staging, or accept one `Smoke Org <hex>` org per run in production. With the development self-signed
certificate use `NODE_EXTRA_CA_CERTS=infra/certs/fullchain.pem`.

Validate the configuration without Docker (CI, review machines): `pnpm validate:infra`. It parses both
Compose files with the `yaml` package and checks service names, images, published ports, the api
environment against contract 11.1, TURN secret wiring, nginx proxying and headers, and the coturn template.

For production add the TURN override (section 3):

```sh
docker compose -f infra/docker-compose.yml -f infra/docker-compose.turn-host.yml up -d
```

### Optional profiles

| Profile  | Enables               | Notes                                                                                                                                                                                                                                                                                     |
| -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `garage` | `garage` object store | set `S3_ENDPOINT=http://garage:3900`, `S3_REGION=garage`, then `sh infra/garage/bootstrap.sh`. AGPL-3.0: run unmodified only. SeaweedFS stays the default.                                                                                                                                |
| `sso`    | `keycloak` (Phase E)  | needs `KEYCLOAK_DB_PASSWORD` set **before the first Postgres start** (the init script creates the `keycloak` database only then) and `KEYCLOAK_ADMIN_PASSWORD`. Port 8080 is internal; for the admin console add a local override publishing `127.0.0.1:8080:8080` and use an SSH tunnel. |

`docker compose -f infra/docker-compose.yml --profile sso up -d`

## 2. Multi-region deployment

Rule: **one stack per region**, each on its own host(s), its own `infra/.env`, its own domain.

| Region    | Example origin           | `infra/.env` (differs per stack)                                         |
| --------- | ------------------------ | ------------------------------------------------------------------------ |
| `in-mum`  | `https://in.example.com` | `DEFAULT_REGION=in-mum`, `S3_BUCKET=ia-recordings-in-mum`, own secrets   |
| `eu-fra`  | `https://eu.example.com` | `DEFAULT_REGION=eu-fra`, `S3_BUCKET=ia-recordings-eu-fra`, own secrets   |
| `us-east` | `https://us.example.com` | `DEFAULT_REGION=us-east`, `S3_BUCKET=ia-recordings-us-east`, own secrets |

Identical on **every** stack (they describe the whole deployment):

```sh
REGION_ORIGINS=in-mum=https://in.example.com,eu-fra=https://eu.example.com,us-east=https://us.example.com
VITE_REGION_ORIGINS=in-mum=https://in.example.com,eu-fra=https://eu.example.com,us-east=https://us.example.com
```

- **Bucket per region.** Each stack writes only to its own bucket (`S3_BUCKET`), in its own SeaweedFS (or a
  managed S3 bucket located in that region). Storage keys start with `<region>/<orgId>/` (section 9).
- **Separate secrets per region.** Never copy `TOKEN_SIGNING_KEY`, `TURN_SECRET` or database passwords between
  regions: a token signed in `in-mum` must not verify in `eu-fra` (R6), and the compromise of one region must
  not extend to another.
- **No shared control plane.** There is no global user directory (T1-T3). A cookie from another region is
  simply `401`, a login for an email living elsewhere is `401 invalid_credentials`, a short code from another
  region is `404`.

### How the web app routes an org to its region (`421 region_mismatch`)

A node answers `421` only when the request itself names the region (T2, R3, R5):

1. **Join links.** The signed token carries `reg`. `POST /api/v1/tokens/public-lookup` and `desk.hello`
   check `reg` against `SERVED_REGIONS` **before any database access** and answer
   `421 { region, origin: REGION_ORIGINS[region] ?? null }`. The join page follows `origin` only when it is
   in the compiled `VITE_REGION_ORIGINS` allow-list and `https:`, otherwise it shows "This organisation is
   hosted in <region>" with the origin as plain text.
2. **Signup.** The region chosen on `/signup` is sent in the body; a node that does not serve it answers `421`
   before creating anything and the page redirects to that region's `/signup` (same allow-list rule).
3. **Login.** No `421` is possible (the email alone does not name a region). `/login` shows a region picker
   when `VITE_REGION_ORIGINS` has more than one distinct origin, navigates to that region's `/login` and
   remembers the choice in `localStorage['ia.region']`.
4. **Short codes** are not routable: the dashboard shows each code with the host it is valid on (T5).

Because `REGION_ORIGINS` (api) and `VITE_REGION_ORIGINS` (compiled into the web bundle) drive this, rebuild the
`web` image (`docker compose build web`) on every stack whenever a region is added.

## 3. TURN and firewall ports

Only these ports are exposed to the internet (contract 11.4 P6). Everything else (5432, 6379, 8333, 9333,
4000, 9464, 8080, 3900-3903) stays on Docker networks; `backend` is `internal: true`.

| Port        | Proto     | Service | Purpose                                                                       |
| ----------- | --------- | ------- | ----------------------------------------------------------------------------- |
| 80          | tcp       | web     | ACME http-01 + redirect to 443                                                |
| 443         | tcp       | web     | SPA, `/api/`, `/signal` (WebSocket), `/.well-known/indiansassist.json`        |
| 3478        | udp + tcp | coturn  | STUN and TURN                                                                 |
| 5349        | tcp       | coturn  | TURN over TLS (`turns:`)                                                      |
| 49160-49200 | udp       | coturn  | relay range, **dev** (published by `docker-compose.yml`)                      |
| 49152-65535 | udp       | coturn  | relay range, **production** (`docker-compose.turn-host.yml`, host networking) |

Production: set `TURN_MIN_PORT=49152` and `TURN_MAX_PORT=65535` in `infra/.env`, start with the override, and
open exactly that range. Docker cannot publish 16k ports efficiently, hence host networking.
`TURN_EXTERNAL_IP` must be the public address (or `public/private` behind 1:1 NAT).

**Secret wiring.** The api signs TURN REST credentials (`username = <expiry>:<principal>`,
`credential = base64(HMAC-SHA1(TURN_SECRET, username))`) and coturn verifies them with
`static-auth-secret`. Both read the **same** `${TURN_SECRET}` from `infra/.env` (>= 32 chars, enforced by the
coturn entrypoint and the api's production config). `TURN_URLS` / `STUN_URLS` must point at this region's own
TURN host; third-party STUN is off by default and, if added, shows up as `thirdPartyHosts` in the residency
report.

## 4. TLS termination

nginx in the `web` container terminates TLS (TLS 1.2 + 1.3, Mozilla intermediate ciphers, HSTS) for
`WEB_ORIGIN` and proxies to `api:4000`, so `WEB_ORIGIN === API_ORIGIN` and the api port is never published.

- Certificates: `infra/certs/fullchain.pem` and `infra/certs/privkey.pem` (git-ignored). The same pair is
  mounted read-only into coturn for `turns:5349`.
- First boot without certificates: the web image generates a 30-day self-signed pair (development only).
- **Let's Encrypt:** port 80 serves `/.well-known/acme-challenge/` from the `acme` volume. Example with certbot
  on the host: `certbot certonly --webroot -w /var/lib/docker/volumes/indiansassist-in-mum_acme/_data -d in.example.com`,
  then copy `fullchain.pem` / `privkey.pem` into `infra/certs/` from a deploy hook and run
  `docker compose -f infra/docker-compose.yml exec web nginx -s reload` and `... restart coturn`.
- coturn runs as `nobody`: the key must be readable by it (`chmod 640` with a group it is in, or a copy with
  mode 644 in a directory only root can list). If it cannot read the pair it disables TLS and logs why.
- **Another proxy in front** (cloud load balancer, Caddy): keep TLS to this nginx, and configure the nginx
  `realip` module (`set_real_ip_from <lb cidr>; real_ip_header X-Forwarded-For;`) because
  `proxy-common.conf` overwrites `X-Forwarded-For` with `$remote_addr` and every per-IP rate limit keys on it.
  WebSockets must be allowed through with an idle timeout above 75 s.

## 5. Backups and restore

```sh
sh infra/scripts/backup.sh /srv/backups          # -> /srv/backups/<region>-<utc>/{postgres.dump,objects.tar.gz,SHA256SUMS}
```

- Postgres: `pg_dump --format=custom` as the owner role. The object store volumes are archived with SeaweedFS
  (or Garage) **stopped** for a consistent copy (a few seconds of failed recording uploads); set
  `IA_BACKUP_HOT=1` to skip the stop and accept a fuzzy copy.
- **Residency:** store each region's backups in that region. Encrypt them at rest (e.g. `age`, restic).
- **Also back up `infra/.env` separately** (secrets manager): without `TOKEN_SIGNING_KEY` the signed audit
  checkpoints in old exports cannot be verified against `/.well-known`, and without the S3 keys the store
  cannot be reattached.
- Restore (empty stack, same `infra/.env`):

```sh
docker compose -f infra/docker-compose.yml up -d postgres
docker compose -f infra/docker-compose.yml exec -T postgres pg_restore -U ia_owner -d indiansassist --clean --if-exists < postgres.dump
docker run --rm -v indiansassist-in-mum_seaweeddata:/dst -v "$PWD:/in" alpine:3.20 sh -c 'cd /dst && tar -xzf /in/objects.tar.gz --strip-components=2 ./indiansassist-in-mum_seaweeddata'
docker compose -f infra/docker-compose.yml up -d
```

`migrate` re-applies the `ia_app` grants and the append-only revokes after a restore. Then run
`POST /api/v1/audit/verify` (Audit page, "Verify chain") to confirm the chain is intact.

## 6. Hardening checklist

Tick every item before production. Details and commands: [HARDENING.md](HARDENING.md).

- [ ] **No default passwords.** `infra/.env` came from `init-env.sh` (or equivalent random values); every
      secret uses `${VAR:?}` so Compose refuses to start with an empty one. `pnpm validate:infra` passes.
- [ ] `infra/.env` is mode 600, not in git, and stored in a secrets manager.
- [ ] **Secret rotation** plan in place: `SESSION_COOKIE_SECRET` (logs everyone out, also rotates presign
      URLs), `TOKEN_SIGNING_KEY` (move the old public key to `TOKEN_SIGNING_KEYS_PREVIOUS`; get it with
      `TOKEN_SIGNING_KEY=<old> node scripts/signing-pubkey.mjs`; drop it once its tokens expired, or at once
      after a compromise), `TURN_SECRET` (api and coturn together, maintenance window), database, Valkey and
      S3 passwords (update `infra/.env` and the role / identity, then restart).
- [ ] **coturn denied peer ranges** unchanged: every private, loopback, link-local, CGNAT, multicast and
      reserved range of contract 11.5 is `denied-peer-ip`; no `allowed-peer-ip`; `no-cli`; quotas set.
- [ ] Firewall exposes only 80, 443, 3478 udp/tcp, 5349 tcp and the relay range.
- [ ] **Rate limits** on: `RATE_LIMIT_DISABLED=false` (Compose forces it), `TRUST_PROXY=true` with nginx
      overwriting `X-Forwarded-For`; nginx `limit_req` / `limit_conn` ceilings in front of the api limits of
      contract 6.12. Alert on the `short_code_budget_exhausted` log line and `ia_rate_limited_total`.
- [ ] **Append-only audit DB role.** The api connects as `DB_APP_ROLE` (`ia_app`), which owns no table and has
      no UPDATE / DELETE / TRUNCATE on `audit_entry` and `audit_checkpoint` (the `migrate` service revokes
      them after every migration and fails if the app role owns a table). Only the one-shot `migrate`
      service holds the owner credential; the api container never receives it.
- [ ] Real TLS certificate installed (not the self-signed fallback); renewal hook reloads nginx and coturn.
- [ ] `/metrics` (9464) reachable only from your Prometheus (it is never proxied by nginx).
- [ ] Backups run daily, stay in-region, are encrypted, and a restore has been tested.
- [ ] One stack per region, separate secrets, `REGION_ORIGINS` / `VITE_REGION_ORIGINS` list only `https:` origins.
- [ ] Docker log rotation (Compose sets 20 MB x 5 per container) matches your retention policy.
