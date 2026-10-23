# syntax=docker/dockerfile:1.7-labs
# IndiansAssist web image: Vite build of @indiansassist/web served by nginx, which also terminates TLS and
# reverse-proxies /api/, /signal and /.well-known/indiansassist.json to api:4000 (contracts section 11.4).
# Build context: the repo root.
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://in.example.com -t indiansassist/web .
# Owned by the infra step. Assumes @indiansassist/web has a `build` script that writes apps/web/dist.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-alpine
ARG PNPM_VERSION=11.24.0

# ---------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Every workspace manifest (COPY --parents keeps the paths), so the frozen lockfile matches all importers.
COPY --parents packages/*/package.json apps/*/package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@indiansassist/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web

# Compiled into the bundle (section 11.2). Production: VITE_API_URL = WEB_ORIGIN (same origin through nginx);
# every VITE_REGION_ORIGINS entry must be https:.
ARG VITE_API_URL
ARG VITE_REGION_ORIGINS
ARG VITE_APP_NAME=IndiansAssist
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_REGION_ORIGINS=${VITE_REGION_ORIGINS} \
    VITE_APP_NAME=${VITE_APP_NAME}
RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL build arg is required" >&2; exit 1)
RUN pnpm --filter "@indiansassist/web..." build && test -f apps/web/dist/index.html

# ---------------------------------------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime
# openssl only for the development self-signed fallback certificate (10-ia-selfsigned-cert.sh).
RUN apk add --no-cache openssl \
    && rm -f /etc/nginx/conf.d/default.conf \
    && mkdir -p /etc/nginx/ia /etc/nginx/certs /var/www/acme
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY infra/nginx/web.conf /etc/nginx/conf.d/web.conf
COPY infra/nginx/security-headers.conf /etc/nginx/ia/security-headers.conf
COPY infra/nginx/proxy-common.conf /etc/nginx/ia/proxy-common.conf
COPY --chmod=755 infra/nginx/10-ia-selfsigned-cert.sh /docker-entrypoint.d/10-ia-selfsigned-cert.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80 443
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -q --no-check-certificate -O /dev/null https://127.0.0.1/index.html || exit 1
