#!/usr/bin/env bash
# Phase E contract §7.10 "End to end": run the Linux dev agent for `pnpm e2e:p3:linux` under the
# WSLg isolation rule. Invoked from Windows by apps/web/e2e/linux-agent-harness.ts through
# `wsl.exe -d Ubuntu -- bash <this script> <mode> <agent args...>`:
#
#   e2e-agent.sh build                     # build the dev agent (release profile) and exit
#   e2e-agent.sh synthetic --code ... --api-origin http://<gw>:<port> --synthetic-capture ...
#   e2e-agent.sh x11       --code ... --api-origin ...   # real X11 capture/input on a harness Xvfb
#   e2e-agent.sh wayland   --code ... --api-origin ...   # a Wayland session (no screen shared)
#   e2e-agent.sh portal    --code ... --api-origin ...   # Phase F §9.6: the X11 binary with .ia-portal beside it
#                                                       # under the headless portal stack (scripts/portal-test.sh)
#   e2e-agent.sh portal-nopw ...                         # the same pair with IA_TEST_NO_PIPEWIRE=1 (dev builds)
#   e2e-agent.sh cleanup <root>            # stop what a run left behind (only its own pids)
#
# Isolation (binding): WAYLAND_DISPLAY is unset (wayland mode sets a name that names no real
# compositor), DISPLAY is a harness-owned Xvfb (x11) or unset, XDG_DATA_HOME / XDG_CONFIG_HOME /
# XDG_STATE_HOME / XDG_RUNTIME_DIR and the download folder point at a temporary root, the session
# bus address names nothing, and the agent is always started with --no-self-delete (the caller's
# arguments include it; this script refuses to run without it). Nothing touches :0 or the real
# ~/.local/share/applications, mimeapps.list or ~/Downloads.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="$(cd "$here/.." && pwd)"
# shellcheck source=linux-env.sh
. "$here/linux-env.sh"
bin="${IA_AGENT_BIN:-$CARGO_TARGET_DIR/release/IndiansAssist}"

mode="${1:-}"
shift || true

# Phase F §9.6: the pair of the single Linux download, side by side as the archive extracts it:
# the X11 dev binary and the portal dev binary as `.ia-portal`. Hard links into the build's own
# target dir (nothing is copied, nothing outside it is written).
pair_dir="$CARGO_TARGET_DIR/ia-pair"

if [ "$mode" = "build" ]; then
  cd "$agent_dir" || exit 1
  # The portal build first (same name, so it is linked aside before the X11 build replaces it).
  cargo build --release -p ia-agent --no-default-features --features "ia-agent/portal,ia-agent/dev" || exit $?
  mkdir -p "$pair_dir"
  ln -f "$CARGO_TARGET_DIR/release/IndiansAssist" "$pair_dir/.ia-portal" || exit $?
  cargo build --release -p ia-agent --no-default-features --features "$FEATS" \
    && cargo build --release -p ia-capture-x11 --features x11 --example xvfb_monitors \
    && ln -f "$CARGO_TARGET_DIR/release/IndiansAssist" "$pair_dir/IndiansAssist"
  exit $?
fi

if [ "$mode" = "cleanup" ]; then
  root="${1:-}"
  case "$root" in
    /tmp/ia-e2e-agent.*) ;;
    *) echo "e2e-agent: refusing to clean $root" >&2; exit 2 ;;
  esac
  if [ -f "$root/pids" ]; then
    while read -r pid; do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
    done <"$root/pids"
  fi
  rm -rf "$root"
  exit 0
fi

case "$mode" in
  synthetic | x11 | wayland | portal | portal-nopw) ;;
  *) echo "e2e-agent: mode must be build, synthetic, x11, wayland, portal, portal-nopw or cleanup" >&2; exit 2 ;;
esac
case "$mode" in
  portal | portal-nopw)
    bin="$pair_dir/IndiansAssist"
    if [ ! -f "$pair_dir/.ia-portal" ]; then
      echo "e2e-agent: no .ia-portal beside $bin; run '$0 build' first" >&2
      exit 1
    fi
    ;;
esac
case " $* " in
  *" --no-self-delete "*) ;;
  *) echo "e2e-agent: refusing to start the agent without --no-self-delete" >&2; exit 2 ;;
esac
if [ ! -x "$bin" ]; then
  echo "e2e-agent: no agent binary at $bin; run '$0 build' first" >&2
  exit 1
fi

root="$(mktemp -d /tmp/ia-e2e-agent.XXXXXX)"
mkdir -p "$root/data" "$root/config" "$root/state" "$root/runtime" "$root/downloads"
chmod 0700 "$root/runtime"
printf 'XDG_DOWNLOAD_DIR="%s/downloads"\n' "$root" >"$root/config/user-dirs.dirs"
: >"$root/pids"
echo "E2E_ROOT=$root"

xvfb_pid=""
agent_pid=""
finish() {
  [ -n "$agent_pid" ] && kill "$agent_pid" 2>/dev/null
  if [ -n "$xvfb_pid" ]; then
    kill "$xvfb_pid" 2>/dev/null
    wait "$xvfb_pid" 2>/dev/null
  fi
  # The root is kept until the harness's cleanup call, so the spec can check received files.
}
trap finish EXIT
trap 'exit 130' INT TERM HUP

display_env=(-u DISPLAY)
if [ "$mode" = "x11" ]; then
  num="${IA_E2E_XVFB_DISPLAY:-97}"
  num="${num#:}"
  if [ "$num" = "0" ] || [ -e "/tmp/.X${num}-lock" ]; then
    echo "e2e-agent: display :$num is not free" >&2
    exit 2
  fi
  Xvfb ":$num" -screen 0 3840x1080x24 -nolisten tcp -noreset >"$root/xvfb.log" 2>&1 &
  xvfb_pid=$!
  echo "$xvfb_pid" >>"$root/pids"
  for _ in $(seq 1 100); do
    [ -e "/tmp/.X${num}-lock" ] && [ -e "/tmp/.X11-unix/X${num}" ] && break
    sleep 0.1
  done
  lock_pid="$(tr -d ' \n' <"/tmp/.X${num}-lock" 2>/dev/null)"
  if [ "$lock_pid" != "$xvfb_pid" ]; then
    echo "e2e-agent: :$num is not the Xvfb started here" >&2
    exit 1
  fi
  monitors="$(dirname "$bin")/examples/xvfb_monitors"
  env -u WAYLAND_DISPLAY IA_TEST_X11_DISPLAY=":$num" IA_TEST_X11_XVFB_PID="$xvfb_pid" \
    IA_TEST_SESSION_DISPLAY="${DISPLAY:-}" "$monitors" || exit 1
  echo "E2E_DISPLAY=:$num"
  display_env=(DISPLAY=":$num" XDG_SESSION_TYPE=x11)
fi
# `env` takes its -u options before any assignment.
if [ "$mode" = "x11" ]; then
  env_args=(-u WAYLAND_DISPLAY "${display_env[@]}")
elif [ "$mode" = "wayland" ]; then
  # A Wayland session as the agent sees it (§7.4): the name points at no compositor; the agent
  # never connects to it (it shares no screen and, headless, opens no window). No DISPLAY.
  env_args=(-u DISPLAY WAYLAND_DISPLAY=ia-e2e-no-such-compositor XDG_SESSION_TYPE=wayland)
else
  env_args=(-u WAYLAND_DISPLAY -u DISPLAY)
fi

if [ "$mode" = "portal" ] || [ "$mode" = "portal-nopw" ]; then
  # Phase F §9.6: the pair runs under the headless portal stack, which owns the session bus, the
  # runtime dir, WAYLAND_DISPLAY=ia-wl-<rand>, PipeWire and the portal; this run's own temporary
  # root holds the agent's data, config (the download folder) and state.
  nopw=()
  [ "$mode" = "portal-nopw" ] && nopw=(IA_TEST_NO_PIPEWIRE=1)
  bash "$here/portal-test.sh" run -- env -u DISPLAY "${nopw[@]}" \
    XDG_DATA_HOME="$root/data" \
    XDG_CONFIG_HOME="$root/config" \
    XDG_STATE_HOME="$root/state" \
    RUST_LOG="${RUST_LOG:-ia_agent=info,ia_capture_portal=info,info,dtls=error,webrtc_ice=error,webrtc_sctp=error,webrtc_mdns=error,zbus=error}" \
    "$bin" "$@" <&0 &
  agent_pid=$!
  echo "$agent_pid" >>"$root/pids"
  wait "$agent_pid"
  status=$?
  agent_pid=""
  echo "E2E_AGENT_EXIT=$status"
  exit "$status"
fi

env "${env_args[@]}" \
  XDG_DATA_HOME="$root/data" \
  XDG_CONFIG_HOME="$root/config" \
  XDG_STATE_HOME="$root/state" \
  XDG_RUNTIME_DIR="$root/runtime" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$root/no-session-bus" \
  RUST_LOG="${RUST_LOG:-ia_agent=info,info,dtls=error,webrtc_ice=error,webrtc_sctp=error,webrtc_mdns=error}" \
  "$bin" "$@" <&0 &
# (`<&0`: a background job would otherwise read /dev/null; the agent must see the harness's
# stdin, where the dev `stop` line arrives.)
agent_pid=$!
echo "$agent_pid" >>"$root/pids"
wait "$agent_pid"
status=$?
agent_pid=""
echo "E2E_AGENT_EXIT=$status"
exit "$status"
