#!/bin/bash
# PID 1 of the all-in-one image. Prepares /data on the first boot (secrets, Postgres cluster, certificate), renders
# every per-service file, runs runit under a clean environment, and on `docker stop` brings the services down in order
# so Postgres shuts down cleanly. Exits non-zero when a core service keeps dying.
set -Eeuo pipefail
# shellcheck source=infra/allinone/lib.sh
. /ia/bin/lib.sh

STATE=/run/ia/state
SECRETS=/data/secrets/ia.env
SV=/ia/sv
PG_INIT_MARK=/data/.ia-pg-initializing

STOP_REQUESTED=0
trap 'STOP_REQUESTED=1' TERM INT

die() {
  log "FATAL: $*"
  exit 1
}

checkpoint() {
  if [ "$STOP_REQUESTED" = 1 ]; then
    log "stop requested during setup"
    exit 143
  fi
}

# own_dir <path> <user> <mode>: creates the directory and fixes its owner only when it is wrong (a large volume stays
# fast to boot).
own_dir() {
  mkdir -p "$1"
  if [ "$(stat -c %u "$1")" != "$(id -u "$2")" ]; then chown -R "$2:$(id -gn "$2")" "$1"; fi
  chmod "$3" "$1"
}

# ---- 1. the environment ---------------------------------------------------------------------------------------------
node /ia/render.mjs validate || die "fix the settings above and start the container again"

# ---- 2. directories -------------------------------------------------------------------------------------------------
# /run survives `docker restart`, so nothing from the previous run may be trusted.
rm -rf /run/ia
mkdir -p /run/ia /run/ia/web
chmod 755 /run/ia /run/ia/web
own_dir /run/ia/env root 700
own_dir "$STATE" root 700
own_dir /run/ia/postgres postgres 700
own_dir /run/ia/valkey valkey 700
own_dir /run/ia/seaweedfs seaweedfs 700
mkdir -p /run/ia/coturn-certs
chown root:turnserver /run/ia/coturn-certs
chmod 750 /run/ia/coturn-certs
rm -rf "$SV"/*/supervise

chown root:root /data
chmod 755 /data
own_dir /data/secrets root 700
own_dir /data/postgres postgres 700
own_dir /data/valkey valkey 700
own_dir /data/seaweedfs seaweedfs 700
own_dir /data/api ia-api 700
# Filled by the operator (release builds, ACME webroot) and only read by services.
own_dir /data/agent-dist root 755
own_dir /data/agent-msi root 755
own_dir /data/acme root 755
chmod -R a+rX /data/agent-dist /data/agent-msi
mkdir -p /data/certs
if [ -w /data/certs ]; then chmod 700 /data/certs; fi

# A first boot that died during cluster creation left no user data (the api starts only after this step), so it is
# always safe to start that step over.
if [ -e "$PG_INIT_MARK" ]; then
  log "an earlier first boot did not finish; recreating the empty database cluster"
  find /data/postgres -mindepth 1 -delete
  rm -f "$PG_INIT_MARK"
fi

# ---- 3. secrets: generated once, then only ever reused --------------------------------------------------------------
if [ ! -f "$SECRETS" ]; then
  if [ -s /data/postgres/PG_VERSION ]; then
    die "$SECRETS is missing but /data/postgres holds a database. Refusing to generate new keys: that would break every released agent and make the data unreadable. Restore the file from your backup."
  fi
  log "first boot: generating secrets into $SECRETS"
  ENV_FILE="$SECRETS" sh /ia/infra/scripts/init-env.sh
fi
chmod 600 "$SECRETS"

# A volume belongs to one region for life (residency): its bucket and every org in it are stamped with that region.
stored_region=$(sed -n 's/^DEFAULT_REGION=//p' "$SECRETS")
if [ -n "${IA_REGION:-}" ] && [ "$IA_REGION" != "$stored_region" ]; then
  die "IA_REGION is $IA_REGION but this volume was created for $stored_region. A volume cannot change region."
fi
export IA_REGION="$stored_region"
checkpoint

# ---- 4. TLS ---------------------------------------------------------------------------------------------------------
CERT=/data/certs/fullchain.pem
KEY=/data/certs/privkey.pem
SELF_SIGNED_MARK=/data/certs/.ia-self-signed
domain=$(printf '%s' "$IA_DOMAIN" | tr '[:upper:]' '[:lower:]')

if [ "${IA_PROXY_MODE:-}" != 1 ] && ! printf '%s' "${IA_PROXY_MODE:-}" | grep -Eqi '^(true|yes|on)$'; then
  # Only ever replaces a pair this image generated itself.
  if [ -f "$SELF_SIGNED_MARK" ] && [ -w /data/certs ]; then
    if [ "$(cat "$SELF_SIGNED_MARK")" != "$domain" ] || ! openssl x509 -checkend 604800 -noout -in "$CERT" >/dev/null 2>&1; then
      log "regenerating the self-signed certificate"
      rm -f "$CERT" "$KEY" "$SELF_SIGNED_MARK"
    fi
  fi
  if [ ! -s "$CERT" ] || [ ! -s "$KEY" ]; then
    [ -w /data/certs ] || die "no certificate in /data/certs and it is read-only"
    IA_TLS_SELF_SIGNED_CN="$domain" sh /ia/nginx/10-ia-selfsigned-cert.sh
    printf '%s' "$domain" > "$SELF_SIGNED_MARK"
    chmod 600 "$KEY"
  fi
fi
cert_present=0
if [ -s "$CERT" ] && [ -s "$KEY" ]; then cert_present=1; fi
/ia/bin/certs.sh copy

# ---- 5. per-service files -------------------------------------------------------------------------------------------
node /ia/render.mjs render "$SECRETS" "$cert_present" || die "could not render the configuration"
nginx -t -q || die "the generated nginx configuration is invalid"
checkpoint

# ---- 6. Postgres, first boot only -----------------------------------------------------------------------------------
if [ ! -s /data/postgres/PG_VERSION ]; then
  log "first boot: creating the database cluster"
  : > "$PG_INIT_MARK"
  ( load_env pg-init; as_user postgres bash /ia/bin/pg-init.sh )
  rm -f "$PG_INIT_MARK"
fi
rm -f /run/ia/env/pg-init.env
checkpoint

# ---- 7. run -----------------------------------------------------------------------------------------------------------
mkfifo -m 600 "$STATE/wake"
exec 3<>"$STATE/wake"

# env -i: the container's variables (and anything an operator passed with -e) reach a service only through its own
# file from step 5.
env -i PATH="$PATH" runsvdir -P "$SV" &
RUNSVDIR_PID=$!
log "started for $domain"

exit_code=0
while :; do
  # A builtin with a timeout: the loop starts no process, and a trapped signal is seen within a second.
  IFS= read -r -t 1 -u 3 _ || true
  if [ "$STOP_REQUESTED" = 1 ]; then
    log "stopping"
    break
  fi
  if [ -e "$STATE/fatal" ]; then
    log "core service $(cat "$STATE/fatal") has failed permanently"
    exit_code=1
    break
  fi
  if ! kill -0 "$RUNSVDIR_PID" 2>/dev/null; then
    log "the process supervisor exited unexpectedly"
    exit_code=1
    break
  fi
done

# ---- 8. ordered stop: the public edge first, Postgres last ------------------------------------------------------------
: > "$STATE/stopping"
sv -w 20 force-stop "$SV/nginx" "$SV/coturn" || true
sv -w 25 force-stop "$SV/api" || true
sv -w 15 force-stop "$SV/valkey" "$SV/seaweedfs" || true
sv -w 45 force-stop "$SV/postgres" || true
kill -TERM "$RUNSVDIR_PID" 2>/dev/null || true
wait "$RUNSVDIR_PID" 2>/dev/null || true
log "stopped"
exit "$exit_code"
