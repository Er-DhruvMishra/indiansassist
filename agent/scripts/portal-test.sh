#!/usr/bin/env bash
# Phase F contract §9.6 "Headless test stack": a private, headless Wayland desktop with a working
# xdg-desktop-portal ScreenCast, started and stopped by this script. Run in WSL from agent/:
#
#   scripts/portal-test.sh                       # the #[ignore] portal tests (ia-capture-portal)
#   scripts/portal-test.sh run -- <cmd> [args]   # <cmd> under the stack (the e2e portal cases)
#   scripts/portal-test.sh run --deny -- <cmd>   # the same with a portal that cancels the dialog
#
# What it guarantees (binding):
# * everything lives under a fresh temporary root: XDG_RUNTIME_DIR (0700), XDG_CONFIG_HOME,
#   XDG_DATA_HOME, XDG_STATE_HOME; DISPLAY and the WSLg WAYLAND_DISPLAY are unset;
# * a private session bus (`dbus-daemon --session --address=unix:path=$T/bus`), never the user's;
#   DBUS_SYSTEM_BUS_ADDRESS names a path that does not exist, so nothing reaches the system bus;
# * sway headless (WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1) with output
#   HEADLESS-1 at 1280x720 on a solid known colour (swaybg), reached as WAYLAND_DISPLAY=ia-wl-<rand>
#   (a name in the temporary runtime dir for sway's own socket); pipewire and wireplumber on that
#   runtime dir; xdg-desktop-portal with xdg-desktop-portal-wlr (`chooser_type=none`,
#   `output_name=HEADLESS-1`, or a chooser that cancels for --deny) and `portals.conf default=wlr`;
# * IA_TEST_PORTAL_BUS (the bus address) and the `ia-wl-` prefix are the tests' guard;
# * on every exit path it stops every process it started (and anything they spawned with this
#   runtime dir in their environment) and deletes the temporary root.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="$(cd "$here/.." && pwd)"
# shellcheck source=linux-env.sh
. "$here/linux-env.sh"

mode="tests"
deny=0
if [ "${1:-}" = "run" ]; then
  mode="run"
  shift
  if [ "${1:-}" = "--deny" ]; then deny=1; shift; fi
  [ "${1:-}" = "--" ] && shift
  if [ "$#" -eq 0 ]; then
    echo "portal-test: run needs a command after --" >&2
    exit 2
  fi
fi

for tool in sway swaybg pipewire wireplumber dbus-daemon dbus-send; do
  command -v "$tool" >/dev/null || { echo "portal-test: $tool is not installed (§9.6 one-time install)" >&2; exit 3; }
done
for exe in /usr/libexec/xdg-desktop-portal /usr/libexec/xdg-desktop-portal-wlr; do
  [ -x "$exe" ] || { echo "portal-test: $exe is not installed (§9.6 one-time install)" >&2; exit 3; }
done

root="$(mktemp -d "${TMPDIR:-/tmp}/ia-portal-test.XXXXXX")"
rt="$root/runtime"
mkdir -p "$rt" "$root/config/sway" "$root/config/xdg-desktop-portal" "$root/data" "$root/state" "$root/logs"
chmod 0700 "$rt"
rand="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
wl_name="ia-wl-$rand"
bus="unix:path=$root/bus"
colour="${IA_PORTAL_TEST_COLOUR:-3366cc}"
pids=()

cleanup() {
  local status=$?
  set +e
  local i
  for ((i = ${#pids[@]} - 1; i >= 0; i--)); do
    kill "${pids[$i]}" 2>/dev/null
  done
  sleep 0.5
  # Anything the stack spawned (D-Bus activation, swaybg) carries this runtime dir: stop it too.
  local p
  for p in /proc/[0-9]*; do
    [ -O "$p" ] || continue
    if tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=$rt"; then
      kill "${p#/proc/}" 2>/dev/null
    fi
  done
  for ((i = ${#pids[@]} - 1; i >= 0; i--)); do
    kill -9 "${pids[$i]}" 2>/dev/null
    wait "${pids[$i]}" 2>/dev/null
  done
  if [ "$status" -ne 0 ] && [ "${IA_PORTAL_TEST_KEEP_LOGS:-}" = "1" ]; then
    echo "portal-test: logs kept in $root/logs" >&2
    find "$root" -mindepth 1 -maxdepth 1 ! -name logs -exec rm -rf {} +
  else
    rm -rf "$root"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# The stack's environment: nothing of the user's session survives.
unset DISPLAY WAYLAND_DISPLAY PULSE_SERVER PIPEWIRE_REMOTE PIPEWIRE_RUNTIME_DIR SWAYSOCK I3SOCK
export XDG_RUNTIME_DIR="$rt"
export XDG_CONFIG_HOME="$root/config"
export XDG_DATA_HOME="$root/data"
export XDG_STATE_HOME="$root/state"
export DBUS_SESSION_BUS_ADDRESS="$bus"
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$root/no-system-bus"
export XDG_CURRENT_DESKTOP=sway
export XDG_SESSION_TYPE=wayland
export XDG_SESSION_DESKTOP=sway

has_name() {
  dbus-send --bus="$bus" --print-reply --dest=org.freedesktop.DBus / \
    org.freedesktop.DBus.NameHasOwner "string:$1" 2>/dev/null | grep -q 'boolean true'
}
wait_for() { # <what> <seconds> <command...>
  local what="$1" secs="$2"
  shift 2
  local n=$((secs * 10))
  while [ "$n" -gt 0 ]; do
    if "$@"; then return 0; fi
    sleep 0.1
    n=$((n - 1))
  done
  echo "portal-test: $what did not come up; logs:" >&2
  tail -n 30 "$root"/logs/*.log >&2 || true
  return 1
}

# 1. The private session bus.
dbus-daemon --session --address="$bus" --nofork --nopidfile >"$root/logs/dbus.log" 2>&1 &
pids+=($!)
wait_for "the private session bus" 10 test -S "$root/bus"

# 2. PipeWire and WirePlumber on the temporary runtime dir.
pipewire >"$root/logs/pipewire.log" 2>&1 &
pids+=($!)
wait_for "pipewire" 10 test -S "$rt/pipewire-0"
wireplumber >"$root/logs/wireplumber.log" 2>&1 &
pids+=($!)

# 3. sway headless on a solid known colour.
cat >"$root/config/sway/config" <<EOF
xwayland disable
swaybg_command swaybg
output HEADLESS-1 resolution 1280x720 position 0 0 bg #$colour solid_color
default_border none
EOF
WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
  sway --config "$root/config/sway/config" >"$root/logs/sway.log" 2>&1 &
sway_pid=$!
pids+=($sway_pid)
sway_socket() {
  local s
  for s in "$rt"/wayland-*; do
    case "$s" in *.lock) continue ;; esac
    [ -S "$s" ] && { basename "$s"; return 0; }
  done
  return 1
}
if ! wait_for "sway (headless)" 15 sway_socket; then
  echo "portal-test: NOT MET: sway could not start headless here" >&2
  exit 4
fi
ln -s "$(sway_socket)" "$rt/$wl_name"
export WAYLAND_DISPLAY="$wl_name"
# Let swaybg paint the background.
sleep 1

# 4. xdg-desktop-portal-wlr, then xdg-desktop-portal (`default=wlr`).
printf '[preferred]\ndefault=wlr\n' >"$root/config/xdg-desktop-portal/portals.conf"
cp "$root/config/xdg-desktop-portal/portals.conf" "$root/config/xdg-desktop-portal/sway-portals.conf"
write_wlr_config() { # <allow|deny>
  if [ "$1" = "deny" ]; then
    # A chooser that returns nothing: the portal answers the request as not granted.
    printf '[screencast]\noutput_name=\nchooser_type=simple\nchooser_cmd=/bin/false\nmax_fps=30\n' >"$root/config/xdpw.conf"
  else
    printf '[screencast]\noutput_name=HEADLESS-1\nchooser_type=none\nmax_fps=30\n' >"$root/config/xdpw.conf"
  fi
}
wlr_pid=""
start_wlr() { # <allow|deny>
  write_wlr_config "$1"
  /usr/libexec/xdg-desktop-portal-wlr -r -c "$root/config/xdpw.conf" -l INFO >>"$root/logs/xdpw.log" 2>&1 &
  wlr_pid=$!
  pids+=($wlr_pid)
  wait_for "xdg-desktop-portal-wlr" 15 has_name org.freedesktop.impl.portal.desktop.wlr
}
stop_wlr() {
  [ -n "$wlr_pid" ] || return 0
  kill "$wlr_pid" 2>/dev/null || true
  wait "$wlr_pid" 2>/dev/null || true
  local n=50
  while has_name org.freedesktop.impl.portal.desktop.wlr && [ "$n" -gt 0 ]; do sleep 0.1; n=$((n - 1)); done
}
if [ "$deny" -eq 1 ]; then start_wlr deny; else start_wlr allow; fi
/usr/libexec/xdg-desktop-portal -r >"$root/logs/portal.log" 2>&1 &
pids+=($!)
wait_for "xdg-desktop-portal" 15 has_name org.freedesktop.portal.Desktop

export IA_TEST_PORTAL_BUS="$bus"
export IA_TEST_PORTAL_RUNTIME="$rt"
export IA_TEST_PORTAL_COLOUR="$colour"
echo "portal-test: stack up (bus $bus, WAYLAND_DISPLAY=$wl_name, sway pid $sway_pid, root $root)"

if [ "$mode" = "run" ]; then
  export IA_TEST_PORTAL_WLR_PID="$wlr_pid"
  # In the background with this script's stdin (a caller's `stop` line reaches it), so a TERM to
  # this script is handled at once (bash defers traps while a foreground child runs) and the
  # cleanup stops the command with the stack.
  "$@" <&0 &
  cmd_pid=$!
  pids+=($cmd_pid)
  status=0
  wait "$cmd_pid" || status=$?
  exit "$status"
fi

cd "$agent_dir"
cargo build -p ia-capture-portal --features portal --tests >"$root/logs/build.log" 2>&1 || {
  cat "$root/logs/build.log" >&2
  exit 1
}
run_tests() { # <filter> [env...]
  local filter="$1"
  shift
  env "$@" cargo test -p ia-capture-portal --features portal --test portal -- \
    --ignored --test-threads=1 --nocapture --exact "$filter"
}
status=0
run_tests a_session_starts_without_a_dialog_and_frames_have_the_known_colour || status=$?
run_tests stopping_the_stream_is_portal_closed IA_TEST_PORTAL_WLR_PID="$wlr_pid" || status=$?
stop_wlr
start_wlr deny
run_tests a_cancelled_dialog_is_portal_denied IA_TEST_PORTAL_MODE=deny || status=$?
exit "$status"
