#!/bin/sh
# One-time Garage bootstrap (optional object store, Compose profile `garage`).
#
# Run from the repo root on the Docker host AFTER `docker compose --profile garage up -d garage`:
#
#   sh infra/garage/bootstrap.sh
#
# What it does (idempotent, safe to re-run):
#   1. assigns the single node a zone and capacity and applies layout version 1 (first run only);
#   2. creates the region bucket S3_BUCKET;
#   3. imports the api's key pair S3_ACCESS_KEY / S3_SECRET_KEY from infra/.env (Garage key ids look like
#      GK + 24 hex chars and secrets are 64 hex chars; infra/scripts/init-env.sh generates them in that form);
#   4. grants that key read + write on the bucket.
# Then set in infra/.env: S3_ENDPOINT=http://garage:3900, S3_REGION=garage, S3_FORCE_PATH_STYLE=true.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE="${ENV_FILE:-$ROOT_DIR/infra/.env}"
COMPOSE="docker compose -f $ROOT_DIR/infra/docker-compose.yml --env-file $ENV_FILE --profile garage"
CAPACITY="${GARAGE_CAPACITY:-100G}"
ZONE="${GARAGE_ZONE:-dc1}"

if [ ! -f "$ENV_FILE" ]; then
  echo "bootstrap: $ENV_FILE not found (run infra/scripts/init-env.sh first)" >&2
  exit 1
fi

# Read only the variables we need from the env file (no `source`, so the file is never executed).
getenv() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'; }
S3_BUCKET=$(getenv S3_BUCKET)
S3_ACCESS_KEY=$(getenv S3_ACCESS_KEY)
S3_SECRET_KEY=$(getenv S3_SECRET_KEY)
: "${S3_BUCKET:?S3_BUCKET is empty in $ENV_FILE}"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is empty in $ENV_FILE}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is empty in $ENV_FILE}"

if ! printf '%s' "$S3_ACCESS_KEY" | grep -Eq '^GK[0-9a-f]{24}$'; then
  echo "bootstrap: S3_ACCESS_KEY must match GK + 24 lower-case hex chars for Garage" >&2
  exit 1
fi
if ! printf '%s' "$S3_SECRET_KEY" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "bootstrap: S3_SECRET_KEY must be 64 lower-case hex chars for Garage" >&2
  exit 1
fi

garage() { $COMPOSE exec -T garage /garage "$@"; }

echo "bootstrap: waiting for garage"
i=0
until garage status >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then echo "bootstrap: garage is not answering" >&2; exit 1; fi
  sleep 2
done

if garage status | grep -q "NO ROLE ASSIGNED"; then
  NODE_ID=$(garage node id -q | cut -d@ -f1 | tr -d '\r')
  echo "bootstrap: assigning node $(printf '%.16s' "$NODE_ID")... zone=$ZONE capacity=$CAPACITY"
  garage layout assign -z "$ZONE" -c "$CAPACITY" "$NODE_ID"
  garage layout apply --version 1
else
  echo "bootstrap: layout already applied"
fi

if garage bucket info "$S3_BUCKET" >/dev/null 2>&1; then
  echo "bootstrap: bucket $S3_BUCKET exists"
else
  garage bucket create "$S3_BUCKET"
fi

if garage key info "$S3_ACCESS_KEY" >/dev/null 2>&1; then
  echo "bootstrap: key $S3_ACCESS_KEY exists"
else
  garage key import --yes -n indiansassist-api "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
fi

garage bucket allow --read --write "$S3_BUCKET" --key "$S3_ACCESS_KEY"
echo "bootstrap: done. Bucket $S3_BUCKET is writable by key $S3_ACCESS_KEY."
