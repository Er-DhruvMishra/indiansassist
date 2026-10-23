# syntax=docker/dockerfile:1.7-labs
# IndiansAssist api image (Fastify 5 + ws, contracts section 6/7). Build context: the repo root.
#   docker build -f apps/api/Dockerfile -t indiansassist/api .
# Owned by the infra step. Assumes @indiansassist/api has `build` and `start` scripts and serves on PORT 4000.
# The image also carries the one-shot migration runner (infra/api/migrate.mjs -> ia-migrate.mjs) used by the
# Compose `migrate` service.
# Debian slim (glibc) rather than Alpine so the argon2 prebuilt binary loads without a toolchain.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=11.24.0

# ---------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---------------------------------------------------------------------------------------------------------
# Manifests only, so the dependency layers are cached until a package.json or the lockfile changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Every workspace manifest (COPY --parents keeps the paths), so the frozen lockfile matches all importers.
COPY --parents packages/*/package.json apps/*/package.json ./

# ---------------------------------------------------------------------------------------------------------
FROM manifests AS build
# Native modules (argon2) fall back to a source build when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@indiansassist/api..."
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter "@indiansassist/api..." build

# ---------------------------------------------------------------------------------------------------------
FROM manifests AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@indiansassist/api..."

# ---------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0
WORKDIR /app
# Production dependency tree (pnpm symlinks are preserved by COPY).
COPY --from=prod-deps --chown=node:node /app /app
# Build outputs and runtime assets of the workspace packages the api depends on.
COPY --from=build --chown=node:node /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build --chown=node:node /app/packages/db/dist /app/packages/db/dist
COPY --from=build --chown=node:node /app/packages/db/drizzle /app/packages/db/drizzle
COPY --from=build --chown=node:node /app/apps/api/dist /app/apps/api/dist
COPY --chown=node:node infra/api/migrate.mjs /app/apps/api/ia-migrate.mjs
# Writable state dir (fs storage driver, PGlite fallback); Compose mounts a named volume here.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/apps/api
EXPOSE 4000 9464
# `npm run` only executes the package script (it never installs); Compose adds `init: true` for signals.
CMD ["npm", "run", "start", "--silent"]
