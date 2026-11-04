#!/bin/sh
# Phase F section 17.3: build the unattended macOS agent package. It only builds; nothing is installed
# on this Mac.
#
#   agent/scripts/macos-pkg.sh [--out <dir>]
#
# Writes <out>/IndiansAssist-Agent-<version>-macos-<arch>.pkg (default out: agent/target/macos-pkg), for this
# Mac's architecture, and prints its release-manifest row on the last line:
#   {"platform":"macos","arch":...,"format":"pkg","version":...,"file":...,"size":...,"sha256":...,"signed":false}
#
# Payload (install location /):
#   /Library/IndiansAssist/ia-service                                        the LaunchDaemon (root)
#   /Library/IndiansAssist/IndiansAssist Desktop.app/Contents/MacOS/ia-desktop the LaunchAgent worker
#   /Library/IndiansAssist/manifest.json                                     the integrity list (sha256 of both)
#   /Library/IndiansAssist/uninstall.sh                                      sudo it to remove everything
#   /Library/LaunchDaemons/com.indiansassist.agent.plist
#   /Library/LaunchAgents/com.indiansassist.desktop.plist
# The scripts (packaging/macos/pkg/scripts) stop the old jobs before an upgrade and bootstrap the new ones.
#
# The binaries trust the region keys in IA_TOKEN_PUBKEYS (comma-separated base64url) at build time, as the other
# release builds do. Signing is ad hoc (section 17.1): "not signed for distribution"; a Developer ID Installer
# identity and notarization are release prerequisites (docs/release.md).
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/.." && pwd)
out="$here/target/macos-pkg"
while [ $# -gt 0 ]; do
    case "$1" in
        --out) out="$2"; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

[ "$(uname -s)" = Darwin ] || { echo "macos-pkg.sh runs on macOS only" >&2; exit 1; }
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
command -v cargo >/dev/null 2>&1 || PATH="$HOME/.cargo/bin:$PATH"
[ -n "${IA_TOKEN_PUBKEYS:-}" ] || echo "macos-pkg: IA_TOKEN_PUBKEYS is empty; this package will trust no region key" >&2

version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/Cargo.toml" | head -n 1)
[ -n "$version" ] || { echo "no workspace version in agent/Cargo.toml" >&2; exit 1; }
case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

cargo build --manifest-path "$here/Cargo.toml" --locked --release -p ia-service --features macos-service
cargo build --manifest-path "$here/Cargo.toml" --locked --release -p ia-desktop --no-default-features \
    --features ia-agent/media,ia-agent/macos,ia-agent/gui
bin="${CARGO_TARGET_DIR:-$here/target}/release"

stage="$out/stage"
rm -rf "$stage"
lib="$stage/Library"
inst="$lib/IndiansAssist"
app="$inst/IndiansAssist Desktop.app"
mkdir -p "$app/Contents/MacOS" "$lib/LaunchDaemons" "$lib/LaunchAgents"
cp "$bin/ia-service" "$inst/ia-service"
cp "$bin/ia-desktop" "$app/Contents/MacOS/ia-desktop"
sed "s/@VERSION@/$version/g" "$repo/packaging/macos/pkg/Desktop-Info.plist.in" >"$app/Contents/Info.plist"
cp "$repo/packaging/macos/pkg/uninstall.sh" "$inst/uninstall.sh"
cp "$repo/packaging/macos/launchd/com.indiansassist.agent.plist" "$lib/LaunchDaemons/"
cp "$repo/packaging/macos/launchd/com.indiansassist.desktop.plist" "$lib/LaunchAgents/"
chmod 0755 "$inst/ia-service" "$app/Contents/MacOS/ia-desktop" "$inst/uninstall.sh"
chmod 0644 "$lib/LaunchDaemons/"*.plist "$lib/LaunchAgents/"*.plist

# Ad hoc signatures. The daemon and the worker check each other's signature against their own signer
# (section 17.3), so both are signed the same way, with fixed identifiers.
codesign --force --sign - --timestamp=none --identifier com.indiansassist.service "$inst/ia-service"
codesign --force --sign - --timestamp=none --identifier com.indiansassist.desktop "$app"
codesign --verify --strict "$inst/ia-service"
codesign --verify --strict --deep "$app"

# The integrity list, after signing (signing changes the bytes).
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
size() { stat -f %z "$1"; }
worker_rel="IndiansAssist Desktop.app/Contents/MacOS/ia-desktop"
cat >"$inst/manifest.json" <<JSON
{"v":1,"version":"$version","arch":"$arch","placeholder":false,"files":[{"name":"ia-service","size":$(size "$inst/ia-service"),"sha256":"$(sha "$inst/ia-service")"},{"name":"$worker_rel","size":$(size "$app/Contents/MacOS/ia-desktop"),"sha256":"$(sha "$app/Contents/MacOS/ia-desktop")"}]}
JSON
chmod 0644 "$inst/manifest.json"

pkg="IndiansAssist-Agent-$version-macos-$arch.pkg"
mkdir -p "$out"
rm -f "$out/$pkg"
# No extended attributes in the payload (they would ship as AppleDouble `._` entries, which Installer turns back
# into attributes); the signatures are embedded, so stripping them leaves both valid (checked again below). A
# build run from inside a sandboxed tool keeps `com.apple.provenance`, which the kernel re-applies; that one is
# harmless.
xattr -cr "$stage"
codesign --verify --strict "$inst/ia-service"
codesign --verify --strict --deep "$app"

# The worker bundle must stay where launchd and the daemon expect it: not relocatable (Installer would otherwise
# "update" another copy with the same bundle identifier wherever it found one), never downgraded over.
comp="$out/component.plist"
pkgbuild --analyze --root "$stage" "$comp" >&2
plutil -replace 0.BundleIsRelocatable -bool NO "$comp"
plutil -replace 0.BundleIsVersionChecked -bool NO "$comp"
plutil -replace 0.BundleOverwriteAction -string upgrade "$comp"
pkgbuild --root "$stage" --component-plist "$comp" --scripts "$repo/packaging/macos/pkg/scripts" --identifier com.indiansassist.agent.pkg \
    --version "$version" --install-location / --ownership recommended "$out/$pkg" >&2

printf '{"platform":"macos","arch":"%s","format":"pkg","version":"%s","file":"%s","size":%s,"sha256":"%s","signed":false}\n' \
    "$arch" "$version" "$pkg" "$(size "$out/$pkg")" "$(sha "$out/$pkg")"
