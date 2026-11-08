#!/bin/bash
# First boot only, as the postgres user: creates the cluster, the database and the two roles (the same
# infra/postgres/init/01-roles.sh Compose runs), then locks authentication down. Local trust exists only while this
# script runs, on a socket directory only postgres can enter, with the server listening on no TCP address.
set -Eeuo pipefail

PGDATA=/data/postgres
SOCKET_DIR=/run/ia/postgres
PWFILE="$SOCKET_DIR/.pwfile"

umask 077
printf '%s\n' "$POSTGRES_PASSWORD" > "$PWFILE"
initdb -D "$PGDATA" --username="$POSTGRES_USER" --pwfile="$PWFILE" \
  --auth-local=trust --auth-host=scram-sha-256 --data-checksums \
  --encoding=UTF8 --locale-provider=libc --locale=C.UTF-8
rm -f "$PWFILE"
unset POSTGRES_PASSWORD

export PGHOST="$SOCKET_DIR" PGPORT="$IA_PG_PORT"
pg_ctl -D "$PGDATA" -w -t 60 \
  -o "-c listen_addresses='' -c unix_socket_directories=$SOCKET_DIR -c port=$IA_PG_PORT" start

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v db="$POSTGRES_DB" <<'SQL'
CREATE DATABASE :"db";
SQL
sh /ia/postgres/01-roles.sh

pg_ctl -D "$PGDATA" -w -t 60 -m fast stop

# No trust left: every later connection authenticates with its password, including on the socket.
cat > "$PGDATA/pg_hba.conf" <<'HBA'
local all all               scram-sha-256
host  all all 127.0.0.1/32  scram-sha-256
host  all all ::1/128       scram-sha-256
HBA
