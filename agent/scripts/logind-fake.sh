#!/usr/bin/env bash
# Phase F contract section 8.12 "Linux, no root": a fake logind on a PRIVATE system-bus stand-in.
# Run in WSL from agent/ (or through wsl.exe with the absolute path):
#
#   logind-fake.sh build                 # build the fake (the ia-service example `logind_fake`)
#   logind-fake.sh run <dir> [fake args] # foreground: dbus-daemon + the fake, until TERM/INT/EOF
#
# `run` starts
#   dbus-daemon --config-file=<dir>/bus.conf --address=unix:path=<dir>/system_bus --nofork --nopidfile
# and the zbus-served `org.freedesktop.login1` test object (seat0 and one session; see
# crates/ia-service/examples/logind_fake.rs for the fake args: --type, --class, --locked, --nobody,
# --uid, --display) on it. It writes <dir>/bus.address once the fake owns its name and
# <dir>/pids (its own children only), and makes <dir>/control a FIFO: each line written to it
# (`type wayland`, `locked true`, `nobody`, `present`, `quit`, ...) changes the fake's state and
# emits PropertiesChanged. On any exit it stops both processes; the caller owns <dir>.
#
# Isolation (binding, S3): <dir> must be an empty directory the caller created with mktemp under
# /tmp; the bus is a socket in it, never /run/dbus/system_bus_socket and never the session bus.
# The service under test is pointed at it with --system-bus "$(cat <dir>/bus.address)".
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="$(cd "$here/.." && pwd)"
# shellcheck source=linux-env.sh
. "$here/linux-env.sh"
fake="${IA_LOGIND_FAKE_BIN:-$CARGO_TARGET_DIR/release/examples/logind_fake}"

mode="${1:-}"
shift || true

case "$mode" in
  build)
    cd "$agent_dir" || exit 1
    exec cargo build --release --locked -p ia-service --features linux-service --example logind_fake
    ;;
  run) ;;
  *)
    echo "usage: logind-fake.sh build | run <dir> [fake args]" >&2
    exit 2
    ;;
esac

dir="${1:-}"
shift || true
case "$dir" in
  /tmp/?*) ;;
  *) echo "logind-fake: <dir> must be a temporary directory under /tmp, got '$dir'" >&2; exit 2 ;;
esac
if [ ! -d "$dir" ] || [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
  echo "logind-fake: $dir must be an existing, empty directory" >&2
  exit 2
fi
command -v dbus-daemon >/dev/null || { echo "logind-fake: dbus-daemon is not installed" >&2; exit 1; }
[ -x "$fake" ] || { echo "logind-fake: no fake at $fake; run '$0 build' first" >&2; exit 1; }

socket="$dir/system_bus"
address="unix:path=$socket"
cat >"$dir/bus.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <!-- The private system-bus stand-in of contract section 8.12: same-uid clients only (the dbus
       default for a unix socket), anyone may own a name and send anything. It listens only on a
       socket in the harness's temporary directory (the same address is also given on the command line). -->
  <listen>$address</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
mkfifo -m 0600 "$dir/control"
: >"$dir/pids"

bus_pid=""
fake_pid=""
finish() {
  [ -n "$fake_pid" ] && kill "$fake_pid" 2>/dev/null
  [ -n "$bus_pid" ] && kill "$bus_pid" 2>/dev/null
  [ -n "$fake_pid" ] && wait "$fake_pid" 2>/dev/null
  [ -n "$bus_pid" ] && wait "$bus_pid" 2>/dev/null
  rm -f "$dir/bus.address"
}
trap finish EXIT
trap 'exit 130' INT TERM HUP

dbus-daemon --config-file="$dir/bus.conf" --address="$address" --nofork --nopidfile \
  </dev/null >"$dir/dbus.log" 2>&1 &
bus_pid=$!
echo "$bus_pid" >>"$dir/pids"
for _ in $(seq 1 100); do
  [ -S "$socket" ] && break
  kill -0 "$bus_pid" 2>/dev/null || { echo "logind-fake: dbus-daemon exited:" >&2; cat "$dir/dbus.log" >&2; exit 1; }
  sleep 0.05
done
[ -S "$socket" ] || { echo "logind-fake: the private bus did not come up" >&2; exit 1; }

# The fake reads its commands from the FIFO; its stdout says when it owns org.freedesktop.login1.
env -u DBUS_SESSION_BUS_ADDRESS -u DBUS_SYSTEM_BUS_ADDRESS \
  "$fake" --bus "$address" --control "$dir/control" "$@" </dev/null >"$dir/fake.log" 2>&1 &
fake_pid=$!
echo "$fake_pid" >>"$dir/pids"
for _ in $(seq 1 200); do
  grep -q '^logind-fake: ready' "$dir/fake.log" 2>/dev/null && break
  kill -0 "$fake_pid" 2>/dev/null || { echo "logind-fake: the fake exited:" >&2; cat "$dir/fake.log" >&2; exit 1; }
  sleep 0.05
done
grep -q '^logind-fake: ready' "$dir/fake.log" || { echo "logind-fake: the fake did not come up" >&2; exit 1; }
printf '%s\n' "$address" >"$dir/bus.address"
echo "LOGIND_FAKE_BUS=$address"
echo "LOGIND_FAKE_CONTROL=$dir/control"

# Follow the fake's state lines until it or the bus exits.
tail -n +1 -f "$dir/fake.log" --pid="$fake_pid" &
tail_pid=$!
wait "$fake_pid"
status=$?
fake_pid=""
kill "$tail_pid" 2>/dev/null
exit "$status"
