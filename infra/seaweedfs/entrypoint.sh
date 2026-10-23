#!/bin/sh
# SeaweedFS (Apache-2.0), the Compose object store default (contracts section 11.3).
# Writes the S3 identity file from the environment (the same S3_ACCESS_KEY / S3_SECRET_KEY the api uses) and
# starts master + volume + filer + S3 gateway in one process. Ports stay inside the Compose network.
set -eu

: "${S3_ACCESS_KEY:?S3_ACCESS_KEY must be set}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY must be set}"

case "$S3_ACCESS_KEY$S3_SECRET_KEY" in
  *[!A-Za-z0-9]*) echo "seaweedfs: S3_ACCESS_KEY / S3_SECRET_KEY must be alphanumeric" >&2; exit 1 ;;
esac

CONF=/tmp/s3.json
umask 077
cat > "$CONF" <<JSON
{
  "identities": [
    {
      "name": "indiansassist-api",
      "credentials": [{ "accessKey": "$S3_ACCESS_KEY", "secretKey": "$S3_SECRET_KEY" }],
      "actions": ["Read", "Write", "List", "Tagging", "Admin"]
    }
  ]
}
JSON

exec weed server \
  -dir=/data \
  -ip.bind=0.0.0.0 \
  -master.volumeSizeLimitMB=1024 \
  -volume.max=0 \
  -s3 \
  -s3.port=8333 \
  -s3.config="$CONF"
