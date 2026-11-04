#!/usr/bin/env bash
# Phase F contract section 8.12: the dev Linux service (`ia-service --console`) for the WSL end-to-end
# run (`pnpm e2e:p4:linux`) and by hand. Invoked from Windows as
# `wsl.exe -d Ubuntu -- bash <this script> <mode> ...`:
#
#   service-e2e.sh build
#       the dev binaries into $CARGO_TARGET_DIR/release: ia-service (linux-service, dev) with the
#       logind fake example beside it, and ia-desktop (linux, dev); ia-desktop must sit beside
#       ia-service, because the dev service launches the worker from its own directory
#   service-e2e.sh run [service args...]
#       a fresh /tmp/ia-service-e2e.XXXXXX root; the harness Xvfb :97; the fake logind on a private
#       bus (logind-fake.sh) reporting an X11 session on :97 for the current uid; then
#         ia-service --console --data-dir <root>/data --system-bus <private bus> --display :97
#           --runtime-dir <root>/runtime --session-bus none --home <root>/home [service args...]
#       in the foreground. The service args must include `--worker-arg --no-self-delete` (S2) and
#       may add `--enroll <file>` and `--worker-arg --synthetic-capture`. Environment:
#       IA_E2E_API_FORWARD=<gateway>:<port> forwards 127.0.0.1:<port> to the Windows test api (WSL
#       NAT mode; plain http is allowed only to localhost), IA_LOGIND_FAKE_ARGS (e.g. "--type
#       wayland" or "--nobody") starts the fake in another state, IA_E2E_XVFB_DISPLAY (default 97).
#   service-e2e.sh cleanup <root>
#       stop what a run left behind (only its own pids) and remove the root
#
# While `run` runs, each line on its stdin is a command:
#   logind <command>   passed to the fake logind (type x11|wayland, class user|greeter, locked
#                      true|false, nobody, present, ...: see examples/logind_fake.rs)
#   stop               SIGTERM to the service (a clean stop)
# and it prints, for the harness to match:
#   E2E_ROOT=<root>  E2E_DISPLAY=:97  E2E_SYSTEM_BUS=<address>  E2E_READY (the service sent READY=1
#   over the NOTIFY_SOCKET this script listens on)  E2E_NOTIFY <line>  E2E_SERVICE_EXIT=<status>
#
# Isolation (binding, S2 and S3): the display is the Xvfb started here (never :0, the WSLg desktop),
# WAYLAND_DISPLAY and DISPLAY are unset for the service, the system bus is the private one, there is
# no session bus, XDG_* and the worker's HOME point into the root, and the service is never started
# without --no-self-delete for its worker. Nothing is installed; nothing outside the root is written.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="$(cd "$here/.." && pwd)"
# shellcheck source=linux-env.sh
. "$here/linux-env.sh"
bindir="${IA_SERVICE_BIN_DIR:-$CARGO_TARGET_DIR/release}"
service="$bindir/ia-service"

mode="${1:-}"
shift || true

if [ "$mode" = "build" ]; then
  cd "$agent_dir" || exit 1
  cargo build --release --locked -p ia-service --features linux-service,dev --bin ia-service --example logind_fake \
    && cargo build --release --locked -p ia-desktop --no-default-features --features linux,dev
  exit $?
fi

if [ "$mode" = "cleanup" ]; then
  root="${1:-}"
  case "$root" in
    /tmp/ia-service-e2e.*) ;;
    *) echo "service-e2e: refusing to clean $root" >&2; exit 2 ;;
  esac
  if [ -f "$root/pids" ]; then
    while read -r pid; do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
    done <"$root/pids"
  fi
  rm -rf "$root"
  exit 0
fi

[ "$mode" = "run" ] || { echo "service-e2e: mode must be build, run or cleanup" >&2; exit 2; }

# S2: the worker is never started without --no-self-delete.
case " $* " in
  *" --worker-arg --no-self-delete "*) ;;
  *) echo "service-e2e: refusing to start the service without '--worker-arg --no-self-delete'" >&2; exit 2 ;;
esac
# S3: the isolation flags are this script's, never the caller's.
for a in "$@"; do
  case "$a" in
    --system-bus | --display | --runtime-dir | --session-bus | --data-dir | --home | --console)
      echo "service-e2e: $a is set by this script (S3); do not pass it" >&2
      exit 2
      ;;
  esac
done
for b in "$service" "$bindir/ia-desktop" "$bindir/examples/logind_fake"; do
  [ -x "$b" ] || { echo "service-e2e: $b is missing; run '$0 build' first" >&2; exit 1; }
done
command -v Xvfb >/dev/null || { echo "service-e2e: Xvfb is not installed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "service-e2e: python3 (the NOTIFY_SOCKET listener) is not installed" >&2; exit 1; }

root="$(mktemp -d /tmp/ia-service-e2e.XXXXXX)"
mkdir -p "$root/data" "$root/runtime" "$root/home" "$root/xdg/data" "$root/xdg/config" "$root/xdg/state" \
  "$root/xdg/cache" "$root/logind"
chmod 0700 "$root/runtime" "$root/home"
printf 'XDG_DOWNLOAD_DIR="%s/home/Downloads"\n' "$root" >"$root/xdg/config/user-dirs.dirs"
: >"$root/pids"
echo "E2E_ROOT=$root"

xvfb_pid=""
logind_pid=""
notify_pid=""
service_pid=""
reader_pid=""
finish() {
  [ -n "$service_pid" ] && kill "$service_pid" 2>/dev/null && wait "$service_pid" 2>/dev/null
  [ -n "$reader_pid" ] && kill "$reader_pid" 2>/dev/null
  [ -n "$logind_pid" ] && kill "$logind_pid" 2>/dev/null && wait "$logind_pid" 2>/dev/null
  [ -n "$notify_pid" ] && kill "$notify_pid" 2>/dev/null
  [ -n "${forward_pid:-}" ] && kill "$forward_pid" 2>/dev/null
  if [ -n "$xvfb_pid" ]; then
    kill "$xvfb_pid" 2>/dev/null
    wait "$xvfb_pid" 2>/dev/null
  fi
  # The root is kept until the harness's cleanup call, so a spec can check what the worker wrote.
}
trap finish EXIT
trap 'exit 130' INT TERM HUP

# The harness display (S3): :97 unless IA_E2E_XVFB_DISPLAY names another; never :0.
num="${IA_E2E_XVFB_DISPLAY:-97}"
num="${num#:}"
case "$num" in
  '' | 0 | *[!0-9]*) echo "service-e2e: display :$num is not allowed" >&2; exit 2 ;;
esac
if [ -e "/tmp/.X${num}-lock" ]; then
  echo "service-e2e: display :$num is not free (/tmp/.X${num}-lock)" >&2
  exit 2
fi
Xvfb ":$num" -screen 0 1920x1080x24 -nolisten tcp -noreset >"$root/xvfb.log" 2>&1 &
xvfb_pid=$!
echo "$xvfb_pid" >>"$root/pids"
for _ in $(seq 1 100); do
  [ -e "/tmp/.X${num}-lock" ] && [ -e "/tmp/.X11-unix/X${num}" ] && break
  sleep 0.1
done
lock_pid="$(tr -d ' \n' <"/tmp/.X${num}-lock" 2>/dev/null)"
if [ "$lock_pid" != "$xvfb_pid" ]; then
  echo "service-e2e: :$num is not the Xvfb started here" >&2
  exit 1
fi
echo "E2E_DISPLAY=:$num"

# The fake logind on its private bus (an X11 session on the harness display, the current uid).
IA_LOGIND_FAKE_BIN="$bindir/examples/logind_fake" \
  bash "$here/logind-fake.sh" run "$root/logind" --display ":$num" ${IA_LOGIND_FAKE_ARGS:-} \
  >"$root/logind.log" 2>&1 &
logind_pid=$!
echo "$logind_pid" >>"$root/pids"
for _ in $(seq 1 200); do
  [ -s "$root/logind/bus.address" ] && break
  kill -0 "$logind_pid" 2>/dev/null || { echo "service-e2e: the logind fake exited:" >&2; cat "$root/logind.log" >&2; exit 1; }
  sleep 0.05
done
[ -s "$root/logind/bus.address" ] || { echo "service-e2e: the logind fake did not come up" >&2; exit 1; }
bus="$(cat "$root/logind/bus.address")"
echo "E2E_SYSTEM_BUS=$bus"

# A NOTIFY_SOCKET listener, so READY=1 / STATUS= / WATCHDOG=1 are visible to the harness (the service
# speaks sd_notify exactly as under systemd; nothing here is systemd).
notify="$root/notify.sock"
python3 -I -u -c '
import os, socket, sys
path = sys.argv[1]
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.bind(path)
os.chmod(path, 0o600)
print("E2E_NOTIFY_LISTENING", flush=True)
while True:
    data = s.recv(4096).decode("utf-8", "replace")
    for line in data.splitlines():
        if line == "WATCHDOG=1":
            continue
        print("E2E_NOTIFY " + line, flush=True)
        if line == "READY=1":
            print("E2E_READY", flush=True)
' "$notify" &
notify_pid=$!
echo "$notify_pid" >>"$root/pids"
for _ in $(seq 1 100); do
  [ -S "$notify" ] && break
  sleep 0.05
done

# IA_E2E_API_FORWARD=<host>:<port> (optional): the Windows-hosted test api as seen from WSL (NAT mode:
# the gateway address). config.json allows plain http/ws only to localhost / 127.0.0.1 (C §2.4), so a
# forwarder on 127.0.0.1:<port> carries the service's and the worker's connections to it; the api's
# API_ORIGIN (and the enroll.iaconfig) then say http://127.0.0.1:<port>.
forward_pid=""
if [ -n "${IA_E2E_API_FORWARD:-}" ]; then
  fwd_host="${IA_E2E_API_FORWARD%:*}"
  fwd_port="${IA_E2E_API_FORWARD##*:}"
  case "$fwd_port" in
    4000 | 4100 | 4105 | '' | *[!0-9]*) echo "service-e2e: refusing to forward port '$fwd_port'" >&2; exit 2 ;;
  esac
  python3 -I -u -c '
import asyncio, sys
host, port = sys.argv[1], int(sys.argv[2])
async def pipe(r, w):
    try:
        while (data := await r.read(65536)):
            w.write(data)
            await w.drain()
    except Exception:
        pass
    finally:
        w.close()
async def handle(cr, cw):
    try:
        ur, uw = await asyncio.open_connection(host, port)
    except Exception:
        cw.close()
        return
    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", port)
    print(f"E2E_API_FORWARD 127.0.0.1:{port} -> {host}:{port}", flush=True)
    async with server:
        await server.serve_forever()
asyncio.run(main())
' "$fwd_host" "$fwd_port" &
  forward_pid=$!
  echo "$forward_pid" >>"$root/pids"
  sleep 0.5
  kill -0 "$forward_pid" 2>/dev/null || { echo "service-e2e: the api forwarder did not start (is 127.0.0.1:$fwd_port taken?)" >&2; exit 1; }
fi

env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SYSTEM_BUS_ADDRESS \
  XDG_DATA_HOME="$root/xdg/data" \
  XDG_CONFIG_HOME="$root/xdg/config" \
  XDG_STATE_HOME="$root/xdg/state" \
  XDG_CACHE_HOME="$root/xdg/cache" \
  XDG_RUNTIME_DIR="$root/runtime" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$root/no-session-bus" \
  NOTIFY_SOCKET="$notify" \
  RUST_LOG="${RUST_LOG:-ia_service=info,ia_desktop=info,ia_agent=info,info,dtls=error,webrtc_ice=error,webrtc_sctp=error,webrtc_mdns=error}" \
  "$service" --console --data-dir "$root/data" --system-bus "$bus" --display ":$num" \
  --runtime-dir "$root/runtime" --session-bus none --home "$root/home" "$@" </dev/null &
service_pid=$!
echo "$service_pid" >>"$root/pids"

# Commands on stdin: `logind <cmd>` to the fake, `stop` to the service.
(
  while IFS= read -r line; do
    case "$line" in
      "logind "*) printf '%s\n' "${line#logind }" >"$root/logind/control" ;;
      stop) kill -TERM "$service_pid" 2>/dev/null ;;
      "") ;;
      *) echo "service-e2e: unknown command '$line' (logind <cmd> | stop)" >&2 ;;
    esac
  done
) <&0 &
reader_pid=$!

wait "$service_pid"
status=$?
service_pid=""
echo "E2E_SERVICE_EXIT=$status"
exit "$status"
