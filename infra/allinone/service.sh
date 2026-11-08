#!/bin/bash
# The run script of every runit service: starts as root (runsv), loads only this service's variables, then replaces
# itself with the service, running as that service's own user. `exec` keeps the pid runsv signals.
set -Eeuo pipefail
# shellcheck source=infra/allinone/lib.sh
. /ia/bin/lib.sh

name=${1:?usage: service.sh <name>}

ping_valkey() { [ "$(valkey-cli -h 127.0.0.1 -p "$IA_VALKEY_PORT" ping)" = PONG ]; }

case "$name" in
  postgres)
    load_env postgres
    as_user postgres postgres -D /data/postgres \
      -c listen_addresses=127.0.0.1 \
      -c port="$IA_PG_PORT" \
      -c unix_socket_directories=/run/ia/postgres
    ;;
  valkey)
    as_user valkey valkey-server /run/ia/valkey/valkey.conf
    ;;
  seaweedfs)
    load_env seaweedfs
    as_user seaweedfs sh /ia/seaweedfs/entrypoint.sh
    ;;
  coturn)
    load_env coturn
    as_user turnserver sh /ia/coturn/entrypoint.sh
    ;;
  nginx)
    # The one service that stays root: its master binds 80/443 (Docker's unprivileged-port sysctl does not apply under
    # --network host) and reads the private key. Workers run as `user nginx` from nginx.conf.
    exec nginx -g 'daemon off;'
    ;;
  api)
    # Each step below runs in a subshell, so the owner credential never enters this shell, and with it the api.
    ( load_env health; retry 120 pg_isready -q -h 127.0.0.1 -p "$IA_PG_PORT" ) \
      || { log "postgres did not become ready"; exit 1; }
    # The separate migrate step of the Compose stack: owner role, finishes before the api starts, re-applies the app
    # grants and the append-only revokes (infra/api/migrate.mjs).
    ( load_env migrate; cd /app/apps/api; as_user ia-migrate node ia-migrate.mjs )
    ( load_env seaweedfs-init; as_user seaweedfs sh /ia/seaweedfs/create-bucket.sh )
    ( load_env health; retry 60 ping_valkey ) || { log "valkey did not become ready"; exit 1; }
    load_env api
    cd /app/apps/api
    as_user ia-api node dist/server.js
    ;;
  *)
    log "unknown service: $name"
    exit 2
    ;;
esac
