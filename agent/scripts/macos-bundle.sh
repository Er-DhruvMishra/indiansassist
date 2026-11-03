#!/bin/sh
# Phase F section 17.2: build the portable macOS agent and assemble IndiansAssist.app.
#
#   agent/scripts/macos-bundle.sh [--dev] [--out <dir>]
#
# --dev   adds the `dev` feature (the local-testing switches: --api-origin, --synthetic-capture, ...);
#         a release bundle never has it.
# --out   where IndiansAssist.app is written (default agent/target/macos).
#
# The bundle is signed ad hoc (`codesign -s -`, section 17.1): no paid identity is assumed, so the
# artefact is "not signed for distribution". TCC grants attach to the signing identity, and an ad
# hoc identity changes with every build, so a person re-grants Screen Recording and Accessibility
# after rebuilding. Nothing is installed: the bundle is only written under --out.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/.." && pwd)
features="media,macos,gui"
out="$here/target/macos"
dev=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dev) features="$features,dev"; dev=1 ;;
        --out) out="$2"; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

[ "$(uname -s)" = Darwin ] || { echo "macos-bundle.sh runs on macOS only" >&2; exit 1; }
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
# A user-level rustup install that is not on PATH (the shell profile was not edited).
command -v cargo >/dev/null 2>&1 || PATH="$HOME/.cargo/bin:$PATH"

version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/Cargo.toml" | head -n 1)
[ -n "$version" ] || { echo "no workspace version in agent/Cargo.toml" >&2; exit 1; }

cargo build --manifest-path "$here/Cargo.toml" --locked --release -p ia-agent --bin IndiansAssist \
    --no-default-features --features "$features"

app="$out/IndiansAssist.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$here/target/release/IndiansAssist" "$app/Contents/MacOS/IndiansAssist"
chmod 0755 "$app/Contents/MacOS/IndiansAssist"
sed "s/@VERSION@/$version/g" "$repo/packaging/macos/Info.plist.in" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

plutil -lint "$app/Contents/Info.plist" >/dev/null
# A dev bundle's designated requirement names only the identifier, so the Screen Recording and
# Accessibility grants a developer gave survive a rebuild (an ad hoc default names the code
# hash, which every build changes, and System Settings then shows a switch that is on but does
# nothing). Never for a release bundle: anything signed with that identifier would match.
if [ "$dev" = 1 ]; then
    codesign --force --sign - --timestamp=none --identifier com.indiansassist.agent \
        --requirements '=designated => identifier "com.indiansassist.agent"' "$app"
else
    codesign --force --sign - --timestamp=none --identifier com.indiansassist.agent "$app"
fi
codesign --verify --strict "$app"

echo "$app ($version, features $features, signed ad hoc: not signed for distribution)"
