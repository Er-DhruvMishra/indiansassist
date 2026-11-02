#!/usr/bin/env bash
# Phase E contract §7.10 "X11" and "Guard": run the #[ignore]-marked X11 tests against an X server
# this script starts and stops itself. Run in WSL from agent/:
#
#   scripts/xvfb-test.sh                 # display :99, every X11 suite
#   IA_XVFB_DISPLAY=:97 scripts/xvfb-test.sh ia-capture-x11   # another display, one crate
#
# What it guarantees (binding):
# * the tests talk only to a harness-owned `Xvfb :<n> -screen 0 3840x1080x24 -nolisten tcp -noreset`
#   (never :0, which WSLg uses for the user's real desktop), named by IA_TEST_X11_DISPLAY, with
#   IA_TEST_X11_XVFB_PID and IA_TEST_SESSION_DISPLAY so each test's guard
#   (ia_platform::linux::testguard) can check the server is the one started here;
# * WAYLAND_DISPLAY is unset and DISPLAY points at the harness display, so nothing opens on the
#   user's desktop;
# * XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_RUNTIME_DIR and HOME-relative caches
#   point at a temporary root, so no test writes the real ~/.local/share/applications or
#   mimeapps.list; DBUS_SESSION_BUS_ADDRESS is set to a path that does not exist, so no test can
#   open the session bus;
# * Xvfb is killed and the temporary root removed on every exit path.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="$(cd "$here/.." && pwd)"
# shellcheck source=linux-env.sh
. "$here/linux-env.sh"

display="${IA_XVFB_DISPLAY:-:99}"
case "$display" in
  :0 | :0.*) echo "xvfb-test: refusing display :0 (the session's real desktop)" >&2; exit 2 ;;
  :[0-9]*) ;;
  *) echo "xvfb-test: IA_XVFB_DISPLAY must be :<n>" >&2; exit 2 ;;
esac
num="${display#:}"
num="${num%%.*}"
if [ -e "/tmp/.X${num}-lock" ]; then
  echo "xvfb-test: display $display is already in use (/tmp/.X${num}-lock); pick another IA_XVFB_DISPLAY" >&2
  exit 2
fi

session_display="${DISPLAY:-}"
root="$(mktemp -d "${TMPDIR:-/tmp}/ia-xvfb-test.XXXXXX")"
xvfb_pid=""
cleanup() {
  if [ -n "$xvfb_pid" ] && kill -0 "$xvfb_pid" 2>/dev/null; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT INT TERM

mkdir -p "$root/data" "$root/config" "$root/state" "$root/runtime" "$root/downloads"
chmod 0700 "$root/runtime"

# -noreset: without it the server regenerates whenever its last client leaves, so back-to-back
# tests would race a reset (ECONNRESET) and lose server state between tests.
Xvfb "$display" -screen 0 3840x1080x24 -nolisten tcp -noreset >"$root/xvfb.log" 2>&1 &
xvfb_pid=$!
# Wait for the server's lock file (it holds the server's pid) and its socket.
for _ in $(seq 1 100); do
  if [ -e "/tmp/.X${num}-lock" ] && { [ -S "/tmp/.X11-unix/X${num}" ] || [ -e "/tmp/.X11-unix/X${num}" ]; }; then
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "xvfb-test: Xvfb exited:" >&2
    cat "$root/xvfb.log" >&2
    exit 1
  fi
  sleep 0.1
done
lock_pid="$(tr -d ' \n' <"/tmp/.X${num}-lock" 2>/dev/null || true)"
if [ "$lock_pid" != "$xvfb_pid" ]; then
  echo "xvfb-test: $display is not served by the Xvfb started here (lock $lock_pid, ours $xvfb_pid)" >&2
  exit 1
fi

cd "$agent_dir"
if [ "$#" -eq 0 ]; then
  set -- ia-capture-x11 ia-input-x11
fi

echo "xvfb-test: Xvfb $display (pid $xvfb_pid), temporary root $root"
status=0
for crate in "$@"; do
  echo "xvfb-test: $crate"
  env -u WAYLAND_DISPLAY \
    DISPLAY="$display" \
    IA_TEST_X11_DISPLAY="$display" \
    IA_TEST_X11_XVFB_PID="$xvfb_pid" \
    IA_TEST_SESSION_DISPLAY="$session_display" \
    XDG_DATA_HOME="$root/data" \
    XDG_CONFIG_HOME="$root/config" \
    XDG_STATE_HOME="$root/state" \
    XDG_RUNTIME_DIR="$root/runtime" \
    XDG_SESSION_TYPE=x11 \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$root/no-session-bus" \
    cargo test -p "$crate" --features x11 --test xvfb -- --ignored --test-threads=1 || status=$?
done
exit "$status"
