#!/usr/bin/env bash
# The WSL half of `pnpm linux:pkg` (packaging/linux/build.mjs; Phase F contract section 8.9). Run from
# Windows as `wsl.exe -d Ubuntu -- bash <this file> <command> ...`; build.mjs does the Windows half
# (the elf-check gate, the installed-file manifest, the sha256 files and the installer manifest).
#
#   build-wsl.sh tools
#       print the packaging tool versions; exit 1 when cargo-deb 3.8.0, cargo-generate-rpm 0.21.1,
#       cargo-zigbuild or Zig is missing (the gates are then "not met"; nothing is installed here)
#   build-wsl.sh build <cargo-target-dir> <stage-dir>
#       the E section 7.9 release build at the glibc 2.34 floor (F section 8.9, revision 3 (g)) for both binaries, then stage them
#   build-wsl.sh stage <cargo-target-dir> <stage-dir>
#       stage the release binaries already built in <cargo-target-dir> (no build)
#   build-wsl.sh package <stage-dir> <dist-dir> <deb-file-name> <rpm-file-name> <source-date-epoch>
#       cargo-deb and cargo-generate-rpm with --no-build over the stage (which must hold
#       ia-service, ia-desktop and manifest.json)
#
# It installs nothing, downloads nothing beyond what cargo needs for the locked dependencies, and
# writes only to the cargo target directory, the stage and the dist directory.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
agent="$repo/agent"
triple="x86_64-unknown-linux-gnu"

cmd="${1:-}"
shift || true

env_for() {
  export CARGO_TARGET_DIR="$1"
  # shellcheck source=../../agent/scripts/linux-env.sh
  . "$agent/scripts/linux-env.sh"
  case "$CARGO_TARGET_DIR" in
    /mnt/*) echo "build-wsl: the cargo target directory must be inside WSL, not $CARGO_TARGET_DIR" >&2; exit 2 ;;
  esac
}

stage_bins() {
  local target="$1" stage="$2" b
  local rel="$target/$triple/release"
  for b in ia-service ia-desktop; do
    if [ ! -x "$rel/$b" ]; then
      echo "build-wsl: $rel/$b is missing; run the build first" >&2
      exit 1
    fi
  done
  rm -rf "$stage"
  mkdir -p "$stage"
  for b in ia-service ia-desktop; do
    install -m 0755 "$rel/$b" "$stage/$b"
  done
  echo "build-wsl: staged ia-service and ia-desktop from $rel into $stage"
}

case "$cmd" in
  tools)
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    [ -d "$HOME/.local/zig" ] && export PATH="$HOME/.local/zig:$PATH"
    ok=0
    deb="$(cargo deb --version 2>/dev/null | head -1 || true)"
    rpm="$(cargo generate-rpm --version 2>/dev/null | head -1 || true)"
    zb="$(cargo zigbuild --help >/dev/null 2>&1 && echo present || echo missing)"
    zig="$(zig version 2>/dev/null || echo missing)"
    echo "cargo-deb: ${deb:-missing}"
    echo "cargo-generate-rpm: ${rpm:-missing}"
    echo "cargo-zigbuild: $zb"
    echo "zig: $zig"
    [ "$deb" = "cargo-deb 3.8.0" ] || { echo "build-wsl: cargo-deb 3.8.0 is required (section 8.9)" >&2; ok=1; }
    [ "$rpm" = "cargo-generate-rpm 0.21.1" ] || { echo "build-wsl: cargo-generate-rpm 0.21.1 is required (section 8.9)" >&2; ok=1; }
    [ "$zb" = present ] || { echo "build-wsl: cargo-zigbuild is required (E section 7.9)" >&2; ok=1; }
    [ "$zig" != missing ] || { echo "build-wsl: Zig is required under ~/.local/zig (E section 7.9)" >&2; ok=1; }
    exit "$ok"
    ;;
  build)
    [ "$#" -eq 2 ] || { echo "usage: build-wsl.sh build <cargo-target-dir> <stage-dir>" >&2; exit 2; }
    env_for "$1"
    cd "$agent"
    # F section 8.9 (revision 3 (g), linux-p4 L3): the glibc 2.34 floor through Zig, so the packages install on EL 9
    # (glibc 2.34); LIBVPX_TARGET picks the prebuilt libvpx, which links at 2.34 too.
    export LIBVPX_TARGET=ubuntu-22.04_x86_64
    echo "build-wsl: ia-service (release, linux-service) into $CARGO_TARGET_DIR"
    cargo zigbuild --release --locked --target "$triple.2.34" -p ia-service --features linux-service
    echo "build-wsl: ia-desktop (release, linux) into $CARGO_TARGET_DIR"
    cargo zigbuild --release --locked --target "$triple.2.34" -p ia-desktop --no-default-features --features linux
    stage_bins "$CARGO_TARGET_DIR" "$2"
    ;;
  stage)
    [ "$#" -eq 2 ] || { echo "usage: build-wsl.sh stage <cargo-target-dir> <stage-dir>" >&2; exit 2; }
    stage_bins "$1" "$2"
    ;;
  package)
    [ "$#" -eq 5 ] || { echo "usage: build-wsl.sh package <stage-dir> <dist-dir> <deb-name> <rpm-name> <source-date-epoch>" >&2; exit 2; }
    stage="$1" dist="$2" debname="$3" rpmname="$4"
    export SOURCE_DATE_EPOCH="$5"
    for f in ia-service ia-desktop manifest.json; do
      [ -f "$stage/$f" ] || { echo "build-wsl: $stage/$f is missing" >&2; exit 1; }
    done
    # The asset paths in ia-service/Cargo.toml name packaging/linux/out/stage; refuse another stage
    # rather than package something other than what was checked.
    [ "$(cd "$stage" && pwd)" = "$repo/packaging/linux/out/stage" ] || {
      echo "build-wsl: the stage must be $repo/packaging/linux/out/stage (the Cargo.toml asset paths)" >&2
      exit 2
    }
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    # cargo-deb's scratch files go to a temporary directory inside WSL, never under /mnt/c.
    scratch="$(mktemp -d /tmp/ia-linux-pkg.XXXXXX)"
    trap 'rm -rf "$scratch"' EXIT
    export CARGO_TARGET_DIR="$scratch"
    mkdir -p "$dist"
    rm -f "$dist/$debname" "$dist/$rpmname"
    cd "$agent"
    echo "build-wsl: cargo deb --no-build --no-strip -> $dist/$debname"
    cargo deb -p ia-service --no-build --no-strip --no-dbgsym --no-separate-debug-symbols --offline \
      --output "$dist/$debname"
    echo "build-wsl: cargo generate-rpm -> $dist/$rpmname"
    # cargo-generate-rpm resolves `-p` as a directory; run it from the crate instead.
    (cd "$agent/crates/ia-service" && cargo generate-rpm --auto-req no -a x86_64 --payload-compress zstd \
      -o "$dist/$rpmname")
    ls -l "$dist/$debname" "$dist/$rpmname"
    ;;
  *)
    echo "usage: build-wsl.sh tools | build <target> <stage> | stage <target> <stage> | package <stage> <dist> <deb> <rpm> <epoch>" >&2
    exit 2
    ;;
esac
