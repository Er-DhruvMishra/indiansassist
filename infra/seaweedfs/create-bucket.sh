#!/bin/sh
# One-shot (Compose service `storage-init`): creates this region's bucket in SeaweedFS if it is missing.
# Idempotent; safe to run on every `docker compose up`.
set -eu
: "${S3_BUCKET:?S3_BUCKET must be set}"
MASTER="${SEAWEED_MASTER:-seaweedfs:9333}"

i=0
until echo "cluster.check" | weed shell -master="$MASTER" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then echo "storage-init: seaweedfs master not reachable" >&2; exit 1; fi
  sleep 2
done

if echo "s3.bucket.list" | weed shell -master="$MASTER" 2>/dev/null | grep -qw "$S3_BUCKET"; then
  echo "storage-init: bucket $S3_BUCKET already exists"
  exit 0
fi
echo "s3.bucket.create -name $S3_BUCKET" | weed shell -master="$MASTER"
echo "storage-init: bucket $S3_BUCKET created"
