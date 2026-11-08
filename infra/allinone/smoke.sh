#!/bin/bash
# End-to-end smoke of a built all-in-one image: infra/allinone/smoke.sh <image>
# Needs Docker, curl, jq and openssl. Runs the image in proxy mode with a test domain and checks the claims of
# infra/allinone/README.md. On failure it prints the container's logs; it never prints a credential.
set -Eeuo pipefail

IMAGE=${1:?usage: smoke.sh <image>}
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
NAME=ia-allinone-smoke
VOLUME=ia-allinone-smoke-data
PORT=18080
DOMAIN=ia-smoke.example.test
ORIGIN="https://$DOMAIN"
BASE="http://127.0.0.1:$PORT"
CLIENT_IP=203.0.113.7
EMAIL="smoke@$DOMAIN"
PASSWORD=$(openssl rand -hex 16)
WORK=$(mktemp -d)

say() { printf '== %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo '--- container state ---'
    docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NAME" 2>/dev/null || true
    echo '--- container logs (last 200 lines) ---'
    docker logs --tail 200 "$NAME" 2>&1 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

start() {
  docker run -d --name "$NAME" --stop-timeout 60 -v "$VOLUME:/data" -p "127.0.0.1:$PORT:8080" \
    -e IA_DOMAIN="$DOMAIN" -e IA_PROXY_MODE=1 "$IMAGE" >/dev/null
}

wait_healthy() {
  local state
  for _ in $(seq 1 150); do
    state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NAME")
    case "$state" in
      'running healthy') return 0 ;;
      exited* | dead*) fail "the container stopped while starting ($state)" ;;
    esac
    sleep 2
  done
  fail "the container did not become healthy within 300 s"
}

# What the trusted proxy would send: the public scheme and host, and the real client.
http() {
  curl -sS --max-time 30 -H "Host: $DOMAIN" -H 'X-Forwarded-Proto: https' -H "X-Forwarded-For: $CLIENT_IP" "$@"
}
in_container() { docker exec "$NAME" bash -c "$1"; }
as_app_role() { in_container ". /run/ia/env/api.env; psql \"\$DATABASE_URL\" -At -c \"$1\""; }

kid_now() { http "$BASE/.well-known/indiansassist.json" | jq -er '.keys[0].kid'; }
secrets_hash() { in_container 'sha256sum /data/secrets/ia.env' | cut -d' ' -f1; }

post_json() { # post_json <path> <json>; writes the body to $WORK/body and prints the status
  http -o "$WORK/body" -w '%{http_code}' -X POST "$BASE$1" -H 'Content-Type: application/json' \
    -H 'X-Requested-With: IndiansAssist' -H "Origin: $ORIGIN" -d "$2"
}

assert_login_and_org() {
  local code body
  body=$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')
  code=$(post_json /api/v1/auth/login "$body")
  [ "$code" = 200 ] || fail "login after restart answered $code"
  [ "$(jq -er '.org.id' "$WORK/body")" = "$ORG_ID" ] || fail "the org did not survive"
}

assert_clean_postgres_stop() {
  if docker logs "$NAME" 2>&1 | grep -Eq 'was not properly shut down|automatic recovery in progress'; then
    fail "Postgres was not shut down cleanly"
  fi
}

say "a missing IA_DOMAIN stops the container with an error"
if docker run --rm "$IMAGE" >"$WORK/no-domain.log" 2>&1; then fail "started without IA_DOMAIN"; fi
grep -q 'IA_DOMAIN is required' "$WORK/no-domain.log" || fail "no clear message for a missing IA_DOMAIN"

say "first boot"
docker volume create "$VOLUME" >/dev/null
start
wait_healthy

say "health and the well-known document carry the runtime domain"
http "$BASE/api/v1/health" | jq -e '.ok == true and .region == "in-mum"' >/dev/null || fail "/api/v1/health"
http "$BASE/.well-known/indiansassist.json" > "$WORK/wk.json"
jq -e --arg o "$ORIGIN" '.api == ($o + "/api/v1") and .join == ($o + "/join")' "$WORK/wk.json" >/dev/null \
  || fail "the well-known document does not name $ORIGIN"
KID=$(jq -er '.keys[0].kid' "$WORK/wk.json")
SECRETS_HASH=$(secrets_hash)

say "the SPA loads and its runtime config names the domain"
http "$BASE/" | grep -q 'id="root"' || fail "/ did not serve the SPA"
http "$BASE/" | grep -q 'src="/runtime-config.js"' || fail "index.html does not load the runtime config"
http "$BASE/runtime-config.js" | grep -qF "\"apiUrl\":\"$ORIGIN\"" || fail "runtime-config.js does not name $ORIGIN"
http -o /dev/null -D "$WORK/headers" "$BASE/"
grep -qi '^content-security-policy:.*connect-src' "$WORK/headers" || fail "the security headers are missing"

say "signup"
BODY=$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{orgName:"Smoke Org",name:"Smoke Admin",email:$e,password:$p}')
CODE=$(post_json /api/v1/auth/signup "$BODY")
if [ "$CODE" != 201 ]; then
  jq -c '.error // .code // "no error field"' "$WORK/body" >&2 || true
  fail "signup answered $CODE"
fi
ORG_ID=$(jq -er '.org.id' "$WORK/body")

say "the real client reached the access log (realip)"
docker logs "$NAME" 2>/dev/null | grep -Eq "^$CLIENT_IP - .*\"POST /api/v1/auth/signup\" 201" \
  || fail "the access log does not show the X-Forwarded-For client"

say "the api works as ia_app and the audit stays append-only"
[ "$(as_app_role 'select current_user')" = ia_app ] || fail "DATABASE_URL is not the ia_app role"
[ "$(as_app_role 'select count(*) > 0 from audit_entry')" = t ] || fail "signup wrote no audit entry as ia_app"
[ "$(as_app_role "select has_table_privilege('audit_entry', 'INSERT')")" = t ] || fail "ia_app cannot insert audit entries"
for privilege in UPDATE DELETE TRUNCATE; do
  [ "$(as_app_role "select has_table_privilege('audit_entry', '$privilege')")" = f ] || fail "ia_app holds $privilege on audit_entry"
done

say "docker restart keeps the signing key, the secrets and the org"
docker restart -t 60 "$NAME" >/dev/null
wait_healthy
[ "$(kid_now)" = "$KID" ] || fail "the signing key changed across a restart"
[ "$(secrets_hash)" = "$SECRETS_HASH" ] || fail "the secrets file changed across a restart"
assert_login_and_org
assert_clean_postgres_stop

say "recreating the container on the same volume keeps them too"
docker stop -t 60 "$NAME" >/dev/null
docker logs "$NAME" 2>&1 | grep -q 'database system is shut down' || fail "Postgres did not report a clean shutdown"
docker rm "$NAME" >/dev/null
start
wait_healthy
[ "$(kid_now)" = "$KID" ] || fail "the signing key changed across a recreate"
[ "$(secrets_hash)" = "$SECRETS_HASH" ] || fail "the secrets file changed across a recreate"
assert_login_and_org
assert_clean_postgres_stop

say "inside: internal ports on loopback, nothing needlessly root, services under their own users"
docker cp "$HERE/smoke-inside.mjs" "$NAME:/tmp/smoke-inside.mjs" >/dev/null
docker exec "$NAME" node /tmp/smoke-inside.mjs

say "a core service that keeps dying stops the container with a non-zero exit"
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Status}}' "$NAME")" != running ]; then break; fi
  docker exec "$NAME" sv kill /ia/sv/api >/dev/null 2>&1 || true
  sleep 3
done
[ "$(docker inspect -f '{{.State.Status}}' "$NAME")" = exited ] || fail "the container is still up after repeated api failures"
EXIT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$EXIT_CODE" != 0 ] || fail "the container exited 0 after a permanent failure"
docker logs "$NAME" 2>&1 | grep -q 'database system is shut down' || fail "Postgres was not stopped cleanly on the way out"

say "all-in-one smoke passed"
