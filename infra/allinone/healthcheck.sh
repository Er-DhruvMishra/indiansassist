#!/bin/bash
# Docker HEALTHCHECK: healthy only when the api, its two stores and the public nginx listener all answer.
set -Eeuo pipefail

# shellcheck disable=SC1091
. /run/ia/env/health.env

curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$IA_API_PORT/api/v1/health"
pg_isready -q -h 127.0.0.1 -p "$IA_PG_PORT"
[ "$(valkey-cli -h 127.0.0.1 -p "$IA_VALKEY_PORT" ping)" = PONG ]
if [ "$IA_PROXY_MODE" = 1 ]; then
  curl -fsS --max-time 5 -o /dev/null "http://$IA_HEALTH_HOST:$IA_HTTP_PORT/index.html"
else
  curl -kfsS --max-time 5 -o /dev/null https://127.0.0.1/index.html
fi
