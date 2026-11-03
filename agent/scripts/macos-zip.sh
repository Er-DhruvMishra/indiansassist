#!/bin/sh
# Phase F section 17.2: the downloadable zip of the macOS agent.
#
#   agent/scripts/macos-zip.sh <IndiansAssist.app> <out.zip> [<IndiansAssist.iaconfig>]
#
# Members are STORED, not deflated (`zip -0`), sorted, with fixed timestamps and no extra
# attributes, so the archive is a pure function of its inputs and a byte range of it stays
# meaningful (section 17.2 `Range`). The api builds the per-download zip from the same cached
# members plus the signed sidecar; this script builds the release artefact
# (`IndiansAssist-macos-<arch>-<v>.app.zip`, no sidecar) and, with a sidecar, the local e2e
# stand-in for a download. Nothing outside <out.zip> is written except a temporary directory.
set -eu

[ $# -ge 2 ] && [ $# -le 3 ] || { echo "usage: $0 <IndiansAssist.app> <out.zip> [<sidecar>]" >&2; exit 2; }
app=$1
zipout=$2
sidecar=${3:-}
[ "$(basename "$app")" = IndiansAssist.app ] || { echo "the bundle must be named IndiansAssist.app" >&2; exit 2; }
[ -d "$app/Contents/MacOS" ] || { echo "$app is not an app bundle" >&2; exit 2; }

stage=$(mktemp -d "${TMPDIR:-/tmp}/ia-macos-zip.XXXXXX")
trap 'rm -rf "$stage"' EXIT
ditto --norsrc --noextattr --noqtn "$app" "$stage/IndiansAssist.app"
if [ -n "$sidecar" ]; then
    cp "$sidecar" "$stage/IndiansAssist.iaconfig"
fi
# 2026-01-01T00:00:00Z, so the archive does not depend on when it was built.
find "$stage" -exec touch -h -t 202601010000.00 {} +

case "$zipout" in /*) abs=$zipout ;; *) abs="$PWD/$zipout" ;; esac
rm -f "$abs"
(cd "$stage" && find . -mindepth 1 | sed 's|^\./||' | LC_ALL=C sort | TZ=UTC zip -q -0 -X -y -D "$abs" -@)
unzip -Z1 "$abs" | grep -q '^IndiansAssist.app/Contents/MacOS/IndiansAssist$' || { echo "zip is missing the executable" >&2; exit 1; }
echo "$abs"
