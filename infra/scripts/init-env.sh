#!/bin/sh
# Creates infra/.env from infra/.env.example with fresh random secrets (no default passwords).
#
#   IA_REGION=in-mum IA_DOMAIN=in.example.com IA_PUBLIC_IP=203.0.113.10 sh infra/scripts/init-env.sh
#
# Variables (all optional; the example values are kept when unset):
#   IA_REGION     in-mum | eu-fra | us-east           -> DEFAULT_REGION, SERVED_REGIONS, S3_BUCKET suffix
#   IA_DOMAIN     public host name of this region     -> WEB_ORIGIN / API_ORIGIN / VITE_API_URL = https://IA_DOMAIN
#   IA_TURN_HOST  TURN host name (default IA_DOMAIN)  -> TURN_REALM, TURN_URLS, STUN_URLS
#   IA_PUBLIC_IP  public IPv4 of this host            -> TURN_EXTERNAL_IP
# Refuses to overwrite an existing infra/.env unless FORCE=1.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SRC="$ROOT_DIR/infra/.env.example"
DST="${ENV_FILE:-$ROOT_DIR/infra/.env}"

if [ -f "$DST" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "init-env: $DST already exists (set FORCE=1 to regenerate; this rotates every secret)" >&2
  exit 1
fi

hex() { # hex <bytes>
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; fi
}

REGION="${IA_REGION:-in-mum}"
case "$REGION" in in-mum|eu-fra|us-east) ;; *) echo "init-env: IA_REGION must be in-mum, eu-fra or us-east" >&2; exit 1 ;; esac

tmp="$DST.tmp.$$"
umask 077
cp "$SRC" "$tmp"

setv() { # setv KEY VALUE  (VALUE must not contain '|')
  if grep -q "^$1=" "$tmp"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$tmp" && rm -f "$tmp.bak"
  else
    printf '%s=%s\n' "$1" "$2" >> "$tmp"
  fi
}

setv POSTGRES_OWNER_PASSWORD "$(hex 24)"
setv IA_APP_DB_PASSWORD "$(hex 24)"
setv SESSION_COOKIE_SECRET "$(hex 32)"
setv TOKEN_SIGNING_KEY "$(hex 32)"
setv TURN_SECRET "$(hex 32)"
setv VALKEY_PASSWORD "$(hex 24)"
setv S3_ACCESS_KEY "GK$(hex 12)"
setv S3_SECRET_KEY "$(hex 32)"
setv GARAGE_RPC_SECRET "$(hex 32)"
setv GARAGE_ADMIN_TOKEN "$(hex 32)"
setv KEYCLOAK_DB_PASSWORD "$(hex 24)"
setv KEYCLOAK_ADMIN_PASSWORD "$(hex 24)"
setv FLEET_DATA_KEY "k1:$(hex 32)"
setv ORG_SECRETS_KEY "k1:$(hex 32)"
setv ORG_SECRETS_FP_KEY "$(hex 32)"

setv DEFAULT_REGION "$REGION"
setv SERVED_REGIONS "$REGION"
setv S3_BUCKET "ia-recordings-$REGION"

if [ -n "${IA_DOMAIN:-}" ]; then
  ORIGIN="https://$IA_DOMAIN"
  TURN_HOST="${IA_TURN_HOST:-$IA_DOMAIN}"
  setv WEB_ORIGIN "$ORIGIN"
  setv API_ORIGIN "$ORIGIN"
  setv VITE_API_URL "$ORIGIN"
  setv TURN_REALM "$TURN_HOST"
  setv TURN_URLS "turn:$TURN_HOST:3478?transport=udp,turn:$TURN_HOST:3478?transport=tcp,turns:$TURN_HOST:5349"
  setv STUN_URLS "stun:$TURN_HOST:3478"
  setv ICE_OWN_HOST_SUFFIXES "$IA_DOMAIN"
  setv IA_TLS_SELF_SIGNED_CN "$IA_DOMAIN"
  echo "init-env: set REGION_ORIGINS and VITE_REGION_ORIGINS by hand to list every region you run" >&2
fi
if [ -n "${IA_PUBLIC_IP:-}" ]; then setv TURN_EXTERNAL_IP "$IA_PUBLIC_IP"; fi

mv "$tmp" "$DST"
chmod 600 "$DST"
echo "init-env: wrote $DST (mode 600). Keep it out of git and back it up with your secrets manager."
