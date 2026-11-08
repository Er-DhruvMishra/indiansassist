# syntax=docker/dockerfile:1.7-labs
# IndiansAssist all-in-one image: one region in one container (infra/allinone/README.md). Build context: the repo root.
#   docker build -f infra/allinone/Dockerfile -t indiansassist .
#
# Same components as infra/docker-compose.yml, and the same scripts and configuration files, copied in below and not
# forked: migrate.mjs, 01-roles.sh, init-env.sh, the seaweedfs and coturn entrypoints, the coturn template, nginx.conf,
# web.conf, proxy-common.conf and security-headers.conf. The build stages mirror apps/api/Dockerfile and
# apps/web/Dockerfile (a Dockerfile cannot include another); scripts/infra/allinone.mjs fails when they drift.
#
# linux/amd64 only for now. No VITE_API_URL or VITE_REGION_ORIGINS is set: a published image holds no domain, and
# apps/web/src/lib/runtimeConfig.ts reads them from /runtime-config.js, written by the container at start.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-bookworm
ARG VALKEY_IMAGE=valkey/valkey:8-bookworm
ARG SEAWEEDFS_IMAGE=chrislusf/seaweedfs:3.80
ARG PNPM_VERSION=11.24.0
ARG PG_MAJOR=16

# Binaries come from the very images Compose runs. `weed` is static; valkey and nginx link only against the libraries
# installed in the runtime stage (checked from the published layers). Every one is executed once at build time below.
FROM ${NGINX_IMAGE} AS nginx-src
FROM ${VALKEY_IMAGE} AS valkey-src
FROM ${SEAWEEDFS_IMAGE} AS seaweedfs-src

# ---------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---------------------------------------------------------------------------------------------------------
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --parents packages/*/package.json apps/*/package.json ./

# ---------------------------------------------------------------------------------------------------------
FROM manifests AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@indiansassist/api..." --filter "@indiansassist/web..."
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
COPY apps/web apps/web
RUN pnpm --filter "@indiansassist/api..." build
RUN test -z "${VITE_API_URL:-}" && test -z "${VITE_REGION_ORIGINS:-}" \
    && pnpm --filter "@indiansassist/web..." build && test -f apps/web/dist/index.html

# ---------------------------------------------------------------------------------------------------------
FROM manifests AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@indiansassist/api..."

# ---------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG PG_MAJOR

# Fixed ids, created before any package can pick its own: the owners of /data must survive an image upgrade. They stay
# in Debian's system range (100-999) because the postgresql and coturn postinst scripts run `adduser --system`, which
# fails on an existing user outside it.
RUN set -eux; \
    for spec in postgres:801 valkey:802 seaweedfs:803 ia-migrate:804 ia-api:805 turnserver:806 nginx:808; do \
      name=${spec%:*}; id=${spec#*:}; \
      groupadd --system --gid "$id" "$name"; \
      useradd --system --uid "$id" --gid "$id" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$name"; \
    done

# Postgres 16 is not in Debian bookworm: PGDG's repository, its signing key checked against the known fingerprint.
# runit, not Debian's supervisor package: runit is BSD-3-Clause, while supervisor's BSD-derived licence is not an
# OSI-approved text (docs/LICENSE-REGISTER.md).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /tmp/pgdg.asc; \
    gpg --show-keys --with-colons /tmp/pgdg.asc | grep -q '^fpr:*B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8:'; \
    gpg --dearmor < /tmp/pgdg.asc > /usr/share/keyrings/pgdg.gpg; \
    rm /tmp/pgdg.asc; \
    echo 'deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
      > /etc/apt/sources.list.d/pgdg.list; \
    mkdir -p /etc/postgresql-common; \
    echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}" coturn runit openssl \
      libpcre2-8-0 libssl3 zlib1g libcrypt1 libsystemd0; \
    apt-get purge -y --auto-remove gnupg; \
    rm -rf /var/lib/apt/lists/*

COPY --from=nginx-src /usr/sbin/nginx /usr/sbin/nginx
COPY --from=nginx-src /etc/nginx/mime.types /etc/nginx/mime.types
COPY --from=valkey-src /usr/local/bin/valkey-server /usr/local/bin/valkey-server
COPY --from=valkey-src /usr/local/bin/valkey-cli /usr/local/bin/valkey-cli
COPY --from=seaweedfs-src /usr/bin/weed /usr/bin/weed

ENV NODE_ENV=production \
    PATH=/usr/lib/postgresql/${PG_MAJOR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# --- the api, root-owned so its own user cannot rewrite it (mirrors apps/api/Dockerfile) -----------------------------
WORKDIR /app
COPY --from=prod-deps /app /app
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/db/dist /app/packages/db/dist
COPY --from=build /app/packages/db/drizzle /app/packages/db/drizzle
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY infra/api/migrate.mjs /app/apps/api/ia-migrate.mjs

# --- the web bundle and nginx ------------------------------------------------------------------------------------------
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY infra/nginx/security-headers.conf /etc/nginx/ia/security-headers.conf
COPY infra/nginx/web.conf /ia/nginx/web.conf.template
COPY infra/nginx/proxy-common.conf /ia/nginx/proxy-common.conf.template
COPY --chmod=755 infra/nginx/10-ia-selfsigned-cert.sh /ia/nginx/10-ia-selfsigned-cert.sh

# --- the other services' own files, unchanged -----------------------------------------------------------------------
COPY infra/coturn/turnserver.conf /etc/coturn/turnserver.conf
COPY --chmod=755 infra/coturn/entrypoint.sh /ia/coturn/entrypoint.sh
COPY --chmod=755 infra/seaweedfs/entrypoint.sh infra/seaweedfs/create-bucket.sh /ia/seaweedfs/
COPY --chmod=755 infra/postgres/init/01-roles.sh /ia/postgres/01-roles.sh
COPY --chmod=755 infra/scripts/init-env.sh /ia/infra/scripts/init-env.sh
COPY infra/.env.example /ia/infra/.env.example

# --- this image -------------------------------------------------------------------------------------------------------
COPY infra/allinone/render.mjs /ia/render.mjs
COPY --chmod=755 infra/allinone/entrypoint.sh infra/allinone/service.sh infra/allinone/finish.sh \
     infra/allinone/pg-init.sh infra/allinone/certs.sh infra/allinone/healthcheck.sh infra/allinone/lib.sh /ia/bin/
COPY LICENSE NOTICE /ia/

RUN set -eux; \
    mkdir -p /var/cache/nginx /var/log/nginx /etc/nginx/conf.d /usr/lib/nginx/modules /var/www; \
    chown nginx:nginx /var/cache/nginx; \
    ln -s /data/certs /etc/nginx/certs; \
    ln -s /data/acme /var/www/acme; \
    ln -s /run/ia/coturn-certs /etc/coturn/certs; \
    ln -sf /run/ia/web/runtime-config.js /usr/share/nginx/html/runtime-config.js; \
    for s in postgres valkey seaweedfs coturn api nginx; do \
      mkdir -p "/ia/sv/$s"; \
      printf '#!/bin/sh\nexec /ia/bin/service.sh %s\n' "$s" > "/ia/sv/$s/run"; \
      printf '#!/bin/sh\nexec /ia/bin/finish.sh %s "$@"\n' "$s" > "/ia/sv/$s/finish"; \
      chmod 755 "/ia/sv/$s/run" "/ia/sv/$s/finish"; \
    done; \
    mkdir -p /ia/sv/postgres/control; \
    printf '#!/bin/sh\nkill -INT "$(cat supervise/pid)"\n' > /ia/sv/postgres/control/t; \
    chmod 755 /ia/sv/postgres/control/t

# Fails the build here, with a clear message, if a copied binary cannot load or a version moved.
RUN set -eux; \
    node --version; \
    weed version; \
    valkey-server --version | grep -q ' v=8\.'; \
    valkey-cli --version; \
    nginx -V 2>&1 | grep -q 'nginx/1\.27\.'; \
    nginx -V 2>&1 | grep -q 'with-http_realip_module'; \
    postgres --version | grep -q " ${PG_MAJOR}\."; \
    dpkg-query -W -f='${Version}' coturn | grep -q '^4\.6\.'; \
    command -v runsvdir; command -v sv; command -v setpriv; \
    id postgres valkey seaweedfs ia-migrate ia-api turnserver nginx

LABEL org.opencontainers.image.title="IndiansAssist all-in-one" \
      org.opencontainers.image.source="https://github.com/Er-DhruvMishra/indiansassist" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

VOLUME /data
EXPOSE 80/tcp 443/tcp 8080/tcp 3478/tcp 3478/udp 5349/tcp 5349/udp
HEALTHCHECK --interval=15s --timeout=12s --start-period=180s --retries=6 CMD ["/ia/bin/healthcheck.sh"]
ENTRYPOINT ["/ia/bin/entrypoint.sh"]
