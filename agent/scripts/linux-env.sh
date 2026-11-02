# shellcheck shell=bash
# Phase E contract §7.1 / §7.9: the Linux build environment, sourced by every Linux gate command
# (in WSL Ubuntu, from agent/):
#
#   source scripts/linux-env.sh
#
# * the cargo target directory lives inside the WSL filesystem, never agent/target on /mnt/c (the
#   sources are read across the WSL boundary, but build artefacts there are slow and would mix
#   Linux and Windows outputs). An existing CARGO_TARGET_DIR that is not under /mnt/ is kept;
# * RUSTUP_TOOLCHAIN is unset, because rust-toolchain.toml now says `stable` and rustup resolves
#   it to this host's default triple (x86_64-unknown-linux-gnu);
# * FEATS is the Linux feature set, in `package/feature` syntax so `--no-default-features` drops
#   `winapi` and `voice` everywhere (§15.6).

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

case "${CARGO_TARGET_DIR:-}" in
  "" | /mnt/*) export CARGO_TARGET_DIR="$HOME/.cache/ia-agent-target" ;;
  *) export CARGO_TARGET_DIR ;;
esac
unset RUSTUP_TOOLCHAIN

export FEATS="ia-agent/media,ia-agent/x11,ia-agent/gui,ia-agent/linux-os,ia-agent/dev"
# The release feature set (§7.9): no `dev`, so the local-testing switches do not exist.
export FEATS_RELEASE="media,x11,gui,linux-os"

# Zig and cargo-zigbuild for the glibc 2.35 release build (§7.9), installed user-level.
if [ -d "$HOME/.local/zig" ]; then
  export PATH="$HOME/.local/zig:$PATH"
fi
