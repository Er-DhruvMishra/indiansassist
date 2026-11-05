#!/usr/bin/env bash
# The WSL half of `pnpm agent:release:linux` (packaging/linux/agent-release.mjs): the release build of the Linux
# portable pair, the X11 agent and its Wayland portal companion (Phase E section 7.9, Phase F section 9.6 and its
# revision 3 corrections). Run from Windows as `wsl.exe -d Ubuntu -- bash <this file> <command> ...`; the Node half
# does the elf-check gate, the sha256 and the AGENT_DIST_DIR files and manifest rows.
#
#   agent-release-wsl.sh tools
#       print the tool versions; exit 1 when cargo-zigbuild, Zig, clang or libpipewire-0.3 (library and headers) is
#       missing (nothing is installed here)
#   agent-release-wsl.sh portal <cargo-target-dir> <out-file>
#       the portal companion, built FIRST: `--features portal`, linked against a directory holding only
#       libpipewire (SYSTEM_DEPS_LIBPIPEWIRE_SEARCH_NATIVE) with `--allow-shlib-undefined`, at the glibc 2.34 floor
#   agent-release-wsl.sh x11 <cargo-target-dir> <out-file> <portal-sha256>
#       the X11 agent with the companion's sha256 embedded (IA_PORTAL_SHA256), at the glibc 2.34 floor
#
# Both artefacts come out of the same cargo path (<target>/x86_64-unknown-linux-gnu/release/IndiansAssist), so each
# is copied to <out-file> as soon as it is linked. IA_TOKEN_PUBKEYS and IA_API_ORIGIN reach the build when the
# caller passes them (WSLENV). It writes only to the cargo target directory and the two out files.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
agent="$repo/agent"
triple="x86_64-unknown-linux-gnu"
# Phase F section 8.9 (revision 3): the floor of the installed agent, and of both portable artefacts.
floor="2.34"
pwlib="/usr/lib/x86_64-linux-gnu/libpipewire-0.3.so.0"

cmd="${1:-}"
shift || true

env_for() {
  export CARGO_TARGET_DIR="$1"
  # shellcheck source=../../agent/scripts/linux-env.sh
  . "$agent/scripts/linux-env.sh"
  case "$CARGO_TARGET_DIR" in
    /mnt/*) echo "agent-release: the cargo target directory must be inside WSL, not $CARGO_TARGET_DIR" >&2; exit 2 ;;
  esac
  # Never build against the session's displays (the build runs no UI, but keep the environment clean).
  unset WAYLAND_DISPLAY DISPLAY
  export LIBVPX_TARGET=ubuntu-22.04_x86_64
}

copy_out() {
  local out="$1" bin="$CARGO_TARGET_DIR/$triple/release/IndiansAssist"
  [ -x "$bin" ] || { echo "agent-release: $bin was not built" >&2; exit 1; }
  mkdir -p "$(dirname "$out")"
  install -m 0755 "$bin" "$out"
  echo "agent-release: $(sha256sum "$out" | cut -d' ' -f1)  $out"
}

case "$cmd" in
  tools)
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    [ -d "$HOME/.local/zig" ] && export PATH="$HOME/.local/zig:$PATH"
    ok=0
    zb="$(cargo zigbuild --help >/dev/null 2>&1 && echo present || echo missing)"
    zig="$(zig version 2>/dev/null || echo missing)"
    clang="$(clang --version 2>/dev/null | head -1 || true)"
    pw="$(pkg-config --modversion libpipewire-0.3 2>/dev/null || true)"
    echo "cargo-zigbuild: $zb"
    echo "zig: $zig"
    echo "clang: ${clang:-missing}"
    echo "libpipewire-0.3 (pkg-config): ${pw:-missing}"
    [ "$zb" = present ] || { echo "agent-release: cargo-zigbuild is required (E section 7.9)" >&2; ok=1; }
    [ "$zig" != missing ] || { echo "agent-release: Zig is required under ~/.local/zig (E section 7.9)" >&2; ok=1; }
    [ -n "$clang" ] || { echo "agent-release: clang and libclang are required (bindgen, F section 9.6)" >&2; ok=1; }
    [ -n "$pw" ] || { echo "agent-release: libpipewire-0.3-dev and libspa-0.2-dev are required (F section 9.6)" >&2; ok=1; }
    [ -e "$pwlib" ] || { echo "agent-release: $pwlib is missing (F section 9.6)" >&2; ok=1; }
    exit "$ok"
    ;;
  portal)
    [ "$#" -eq 2 ] || { echo "usage: agent-release-wsl.sh portal <cargo-target-dir> <out-file>" >&2; exit 2; }
    env_for "$1"
    cd "$agent"
    # Zig links against its own glibc stubs and searches no system directory: give it a directory holding only
    # libpipewire (never /usr/lib itself, whose libc would raise the floor). The host's libpipewire refers to newer
    # GLIBC symbols than the floor; the Desk supplies its own libpipewire at run time (revision 3 "Release link").
    linkdir="$CARGO_TARGET_DIR/ia-portal-link"
    mkdir -p "$linkdir"
    ln -sf "$pwlib" "$linkdir/libpipewire-0.3.so"
    export SYSTEM_DEPS_LIBPIPEWIRE_SEARCH_NATIVE="$linkdir"
    echo "agent-release: the portal companion (release, portal, glibc $floor) into $CARGO_TARGET_DIR"
    cargo-zigbuild rustc --release --locked --target "$triple.$floor" -p ia-agent --bin IndiansAssist \
      --no-default-features --features portal -- -C link-arg=-Wl,--allow-shlib-undefined
    copy_out "$2"
    ;;
  x11)
    [ "$#" -eq 3 ] || { echo "usage: agent-release-wsl.sh x11 <cargo-target-dir> <out-file> <portal-sha256>" >&2; exit 2; }
    [[ "$3" =~ ^[0-9a-f]{64}$ ]] || { echo "agent-release: the portal sha256 must be 64 lower-case hex" >&2; exit 2; }
    env_for "$1"
    cd "$agent"
    # Section 9.5: the X11 binary hands over only to a companion with exactly this sha256.
    export IA_PORTAL_SHA256="$3"
    echo "agent-release: the X11 agent (release, $FEATS_RELEASE, glibc $floor, IA_PORTAL_SHA256=$3)"
    cargo zigbuild --release --locked --target "$triple.$floor" -p ia-agent --no-default-features \
      --features "$FEATS_RELEASE"
    copy_out "$2"
    ;;
  *)
    echo "usage: agent-release-wsl.sh tools | portal <target> <out> | x11 <target> <out> <portal-sha256>" >&2
    exit 2
    ;;
esac
