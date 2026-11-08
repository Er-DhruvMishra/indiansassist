# IndiansAssist all-in-one image

One image, one data volume, one region: `ghcr.io/er-dhruvmishra/indiansassist` (linux/amd64). It runs the same
components as the [Compose stack](../README.md), which stays fully supported: Postgres 16, Valkey 8, SeaweedFS 3.80,
coturn, the api and its migrate step, and nginx serving the web app. The optional Compose profiles (`garage`, `sso`,
`recorder`) are not included.

The image holds no domain and no secret. Both are decided when the container starts.

## Run it

Production (host networking, because TURN needs a relay port range that Docker cannot publish efficiently):

```sh
docker run -d --name indiansassist --restart unless-stopped --stop-timeout 60 \
  --network host \
  -v indiansassist-data:/data \
  -e IA_DOMAIN=in.example.com \
  -e IA_PUBLIC_IP=203.0.113.10 \
  -e TURN_MIN_PORT=49152 -e TURN_MAX_PORT=65535 \
  ghcr.io/er-dhruvmishra/indiansassist:latest
```

Without host networking, publish the ports and keep the relay range small:

```sh
docker run -d --name indiansassist --restart unless-stopped --stop-timeout 60 \
  -p 80:80 -p 443:443 \
  -p 3478:3478/udp -p 3478:3478/tcp -p 5349:5349/tcp \
  -p 49160-49200:49160-49200/udp \
  -v indiansassist-data:/data \
  -e IA_DOMAIN=in.example.com \
  -e IA_PUBLIC_IP=203.0.113.10 \
  ghcr.io/er-dhruvmishra/indiansassist:latest
```

Point DNS at the host and open the firewall for the ports above. Keep `--stop-timeout 60`: Docker's default of 10 s can
cut a Postgres shutdown short. Under `--network host` the loopback ports below are shared with the host, so anything
running on the host can reach them (Postgres, Valkey and S3 still require their passwords; the api port has no
password of its own).

| Setting                            | Required | Meaning                                                                                                                                                                           |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IA_DOMAIN`                        | yes      | public host name. Becomes the origin, TURN realm and region list                                                                                                                  |
| `IA_PUBLIC_IP`                     | for TURN | public IPv4 for TURN relays (or `public/private` behind 1:1 NAT). Unset, TURN advertises the container's own address, which works only on a host with a public interface          |
| `IA_REGION`                        | no       | `in-mum` (default), `eu-fra` or `us-east`. Fixed for the life of the volume                                                                                                       |
| `IA_TURN_HOST`                     | no       | TURN host name, if not `IA_DOMAIN`                                                                                                                                                |
| `TURN_MIN_PORT`, `TURN_MAX_PORT`   | no       | relay range, default 49160-49200                                                                                                                                                  |
| `IA_PROXY_MODE`, `IA_HTTP_PORT`, `IA_HTTP_BIND`, `IA_TRUSTED_PROXIES` | no | see [Behind a reverse proxy](#behind-a-reverse-proxy)                                                                                                                             |
| any api setting                    | no       | `SIGNUP_PLAN_TIER`, `MAIL_DRIVER`, `SMTP_URL`, `MAIL_FROM`, `EXTENSION_IDS`, `REGION_ORIGINS`, ... (`API_ENV_PASSTHROUGH` and `API_ENV_DEFAULTED` in `render.mjs`; meanings in `infra/.env.example`) |

Database URLs, ports, keys and rate-limit switches are set by the image and ignored if passed.

The container is ready when `docker ps` shows it `healthy` (first boot takes a minute or two). An invalid setting, or a
core service that keeps dying, stops the container with a non-zero exit code; `docker logs` says why.

## The data volume

Everything is under `/data`:

| Path                                | Holds                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| `/data/secrets/ia.env` (mode 600)   | every password and key, generated once on the first boot            |
| `/data/postgres`                    | database                                                            |
| `/data/valkey`                      | presence and rate-limit state                                       |
| `/data/seaweedfs`                   | recordings (object store)                                           |
| `/data/certs`                       | TLS certificate                                                     |
| `/data/acme`                        | ACME http-01 webroot                                                |
| `/data/agent-dist`, `/data/agent-msi` | release builds you add (see below)                                |

> **Warning: losing `/data` loses the token signing key.** `TOKEN_SIGNING_KEY` in `/data/secrets/ia.env` is what every
> released agent trusts. It is generated once and never regenerated. If it is lost, enrolled agents and issued tokens
> stop working and old audit checkpoints can no longer be verified. Back it up separately, in a secrets manager.

A later boot always reuses `/data/secrets/ia.env`. If that file is missing while a database exists, the container
refuses to start rather than generate new keys: restore the file from your backup.

## Backup

Stop the container for a consistent copy (a few seconds of downtime), archive the volume, start it again:

```sh
docker stop -t 60 indiansassist
docker run --rm -v indiansassist-data:/data:ro -v "$PWD:/backup" debian:bookworm-slim \
  tar -czf "/backup/indiansassist-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C / data
docker start indiansassist
```

The archive contains every secret, so encrypt it and keep it in the region it belongs to. Restore into an empty volume
with `tar -xzf ... -C /` in the same throwaway container, then start the image.

## Upgrade

```sh
docker pull ghcr.io/er-dhruvmishra/indiansassist:latest
docker stop -t 60 indiansassist && docker rm indiansassist
# run the same `docker run` command as before
```

Migrations run automatically before the api starts, on every start. Take a backup first. Service accounts have fixed
ids, so the volume keeps working across images. A future Postgres major version will need its own upgrade procedure.

## TLS

By default nginx serves ports 80 and 443. Put your certificate in the volume at `/data/certs/fullchain.pem` and
`/data/certs/privkey.pem`, or mount a directory there read-only (`-v /etc/ssl/ia:/data/certs:ro`). With neither, the
container generates a 30-day self-signed certificate, for a first test only.

After renewing, apply the new pair without a restart:

```sh
docker exec indiansassist /ia/bin/certs.sh reload
```

For Let's Encrypt, port 80 serves `/.well-known/acme-challenge/` from `/data/acme`.

## Behind a reverse proxy

When a proxy such as LiteSpeed, Caddy or a cloud load balancer terminates TLS, nginx serves plain HTTP on one port:

```sh
docker run -d --name indiansassist --restart unless-stopped --stop-timeout 60 \
  --network host \
  -v indiansassist-data:/data \
  -e IA_DOMAIN=in.example.com -e IA_PUBLIC_IP=203.0.113.10 \
  -e TURN_MIN_PORT=49152 -e TURN_MAX_PORT=65535 \
  -e IA_PROXY_MODE=1 -e IA_HTTP_BIND=127.0.0.1 -e IA_HTTP_PORT=8080 \
  ghcr.io/er-dhruvmishra/indiansassist:latest
```

| Setting              | Default                               | Meaning                                                                        |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `IA_PROXY_MODE`      | off                                   | `1` serves plain HTTP; no port 80 redirect, no port 443                        |
| `IA_HTTP_PORT`       | `8080`                                | the plain HTTP port                                                            |
| `IA_HTTP_BIND`       | all interfaces                        | one address to listen on; use `127.0.0.1` when the proxy is on the same host   |
| `IA_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128,172.16.0.0/12`  | comma list of IPs or CIDRs allowed to report the real client                   |

The proxy must:

- send `X-Forwarded-For` and `X-Forwarded-Proto: https`;
- allow WebSocket upgrades on `/signal`, with an idle timeout above 75 s;
- allow request bodies up to 110 MB on the recording upload routes.

Set `IA_TRUSTED_PROXIES` to your proxy's real address if it is not on the same host. **Every per-IP rate limit depends
on this:** a peer outside the range has its `X-Forwarded-For` and `X-Forwarded-Proto` ignored, so if your proxy is not
listed, all clients share the proxy's one address and one rate limit. Do not publish the plain port to the internet.

TURN does not go through the proxy: ports 3478, 5349 and the relay range still go straight to the container. `turns:` is
advertised only when a certificate is present in `/data/certs`, including in proxy mode.

## Release builds

The portable agents and installers are not in the image. Copy the signed builds and their `manifest.json` into the
volume, then tell the api to re-read them (a restart works too):

```sh
docker cp ./agent-dist/. indiansassist:/data/agent-dist/
docker cp ./agent-msi/.  indiansassist:/data/agent-msi/
docker exec indiansassist chmod -R a+rX /data/agent-dist /data/agent-msi
docker exec indiansassist sv hup /ia/sv/api
```

`AGENT_DIST_DIR` and `AGENT_MSI_DIST_DIR` default to those two paths.

## What runs inside

runit supervises each service as its own unprivileged user. The only root processes are PID 1, the supervisor tree and
the nginx master (it binds 80/443 and reads the private key; its workers run as `nginx`).

| Service             | User         | Listens on                                                  |
| ------------------- | ------------ | ----------------------------------------------------------- |
| nginx               | root/`nginx` | **public:** 80, 443 (or the proxy-mode port)                |
| coturn              | `turnserver` | **public:** 3478, 5349, relay range                         |
| api                 | `ia-api`     | 127.0.0.1:14000, metrics 127.0.0.1:19464                    |
| migrate (each start) | `ia-migrate` | none; finishes before the api starts                       |
| Postgres            | `postgres`   | 127.0.0.1:15432                                             |
| Valkey              | `valkey`     | 127.0.0.1:16379                                             |
| SeaweedFS           | `seaweedfs`  | 127.0.0.1 only: S3 18333, master 19333, volume 18080, filer 18888, and their gRPC ports (+10000) |

The security properties of [HARDENING.md](../HARDENING.md) hold here: the api connects as `ia_app` and never receives
the owner credential, the migrate step re-applies the append-only audit grants on every start, coturn uses the same
denied-peer template, and there are no default passwords. The recorder service (a Compose profile) is not included; it
would need its own process and UDP range.

## Build it yourself

```sh
docker build -f infra/allinone/Dockerfile -t indiansassist .
bash infra/allinone/smoke.sh indiansassist     # needs Docker, curl, jq, openssl
```

`pnpm validate:infra` checks these files without Docker.
