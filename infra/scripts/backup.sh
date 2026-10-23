#!/bin/sh
# Backs up ONE region cluster: a Postgres logical dump and an object-store snapshot.
# Backups stay in the region (data residency, PRD 15.4): write them to storage located in the same region.
#
#   sh infra/scripts/backup.sh [/path/to/backup/dir]
#
# Produces:
#   <dir>/<region>-<utc>/postgres.dump        pg_dump custom format (restore with pg_restore)
#   <dir>/<region>-<utc>/objects.tar.gz       SeaweedFS (default) or Garage volume archive
#   <dir>/<region>-<utc>/SHA256SUMS
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE="${ENV_FILE:-$ROOT_DIR/infra/.env}"
getenv() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'; }
REGION=$(getenv DEFAULT_REGION); REGION="${REGION:-in-mum}"
DB=$(getenv POSTGRES_DB); DB="${DB:-indiansassist}"
OWNER=$(getenv POSTGRES_OWNER_USER); OWNER="${OWNER:-ia_owner}"
COMPOSE="docker compose -f $ROOT_DIR/infra/docker-compose.yml --env-file $ENV_FILE"
PROJECT="indiansassist-$REGION"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${1:-$ROOT_DIR/backups}/$REGION-$STAMP"
mkdir -p "$OUT"
umask 077

echo "backup: postgres -> $OUT/postgres.dump"
$COMPOSE exec -T postgres pg_dump -U "$OWNER" -d "$DB" --format=custom --no-owner > "$OUT/postgres.dump"

if docker volume inspect "${PROJECT}_garagedata" >/dev/null 2>&1 && [ "${IA_OBJECT_STORE:-seaweedfs}" = "garage" ]; then
  VOLS="${PROJECT}_garagemeta ${PROJECT}_garagedata"
else
  VOLS="${PROJECT}_seaweeddata"
fi
echo "backup: object store volumes ($VOLS) -> $OUT/objects.tar.gz"
MOUNTS=""
for v in $VOLS; do MOUNTS="$MOUNTS -v $v:/src/$v:ro"; done
# Consistent snapshot: SeaweedFS / Garage are stopped for the copy unless IA_BACKUP_HOT=1.
if [ "${IA_BACKUP_HOT:-0}" != "1" ]; then $COMPOSE stop seaweedfs garage >/dev/null 2>&1 || true; fi
# shellcheck disable=SC2086
docker run --rm $MOUNTS -v "$OUT:/out" alpine:3.20 tar -C /src -czf /out/objects.tar.gz .
if [ "${IA_BACKUP_HOT:-0}" != "1" ]; then
  $COMPOSE start seaweedfs >/dev/null 2>&1 || true
  $COMPOSE --profile garage start garage >/dev/null 2>&1 || true
fi

(cd "$OUT" && sha256sum postgres.dump objects.tar.gz > SHA256SUMS)
echo "backup: done -> $OUT"
