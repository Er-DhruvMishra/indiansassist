#!/bin/sh
# Renders infra/coturn/turnserver.conf (template) with the environment and starts coturn
# (contracts section 11.5: "environment substitution of ${TURN_SECRET}, ${TURN_REALM} and ${TURN_EXTERNAL_IP}").
set -eu

: "${TURN_SECRET:?TURN_SECRET must be set (same value as the api)}"
: "${TURN_REALM:?TURN_REALM must be set, e.g. turn.in-mum.example.com}"
: "${TURN_EXTERNAL_IP:?TURN_EXTERNAL_IP must be the public IP of this host}"
TURN_MIN_PORT="${TURN_MIN_PORT:-49160}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"

if [ "${#TURN_SECRET}" -lt 32 ]; then
  echo "coturn: TURN_SECRET must be at least 32 characters" >&2
  exit 1
fi

TEMPLATE=/etc/coturn/turnserver.conf
OUT=/tmp/turnserver.conf
export TURN_SECRET TURN_REALM TURN_EXTERNAL_IP TURN_MIN_PORT TURN_MAX_PORT

# Literal (non-regex) substitution via awk + ENVIRON, so no character in a secret needs escaping.
awk '
function rep(s, k, v,    out, i) {
  out = ""
  while ((i = index(s, k)) > 0) { out = out substr(s, 1, i - 1) v; s = substr(s, i + length(k)) }
  return out s
}
{
  line = $0
  line = rep(line, "${TURN_SECRET}", ENVIRON["TURN_SECRET"])
  line = rep(line, "${TURN_REALM}", ENVIRON["TURN_REALM"])
  line = rep(line, "${TURN_EXTERNAL_IP}", ENVIRON["TURN_EXTERNAL_IP"])
  line = rep(line, "${TURN_MIN_PORT}", ENVIRON["TURN_MIN_PORT"])
  line = rep(line, "${TURN_MAX_PORT}", ENVIRON["TURN_MAX_PORT"])
  print line
}' "$TEMPLATE" > "$OUT"

if [ ! -r /etc/coturn/certs/fullchain.pem ] || [ ! -r /etc/coturn/certs/privkey.pem ]; then
  echo "coturn: no readable certificate in /etc/coturn/certs, turns:5349 disabled (TLS is optional)" >&2
  sed -i -e '/^cert=/d' -e '/^pkey=/d' "$OUT"
  echo "no-tls" >> "$OUT"
  echo "no-dtls" >> "$OUT"
fi

chmod 600 "$OUT"
exec turnserver -c "$OUT"
