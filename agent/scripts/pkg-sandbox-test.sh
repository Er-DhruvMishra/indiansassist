#!/usr/bin/env bash
# Phase F contract section 8.12 "T1 sandbox install" (the default package gate). Run in WSL:
#
#   agent/scripts/pkg-sandbox-test.sh <path to IndiansAssist-Agent-<v>-linux-x64.deb>
#
# * The Ubuntu Base 22.04 root file system, pinned below by file name and sha256 (the official
#   SHA256SUMS at cdimage.ubuntu.com lists exactly this pair; the first download checks that too), is
#   downloaded once into ~/.cache/ia-throwaway/ and verified against the pin on every run.
# * A fresh temporary directory gets the extracted root, which is entered with bubblewrap as a fake
#   root, with no network:
#     bwrap --unshare-all --uid 0 --gid 0 --bind <rootfs> / --proc /proc --dev /dev --tmpfs /tmp
#           --die-with-parent
# * Inside it: `dpkg -i` the deb (it depends only on libc6, which Ubuntu Base has: no
#   --force-depends), assert the files, their modes and owners, the unit and that postinst skipped
#   systemd, run `ia-service --version` and `ia-desktop --version` (the glibc 2.35 floor), give the
#   service a device identity and an enrolled config.json pointing at an unreachable api, then
#   `dpkg --purge` (the prerm's offline deregister must not stop it) and assert that nothing remains:
#   the file tree after the purge is the tree before the install, apart from dpkg's own logs.
# * The temporary directory is deleted on every exit path. Nothing outside it and the download cache
#   changes; nothing is installed on this distro (S4).
set -euo pipefail

UBUNTU_BASE_FILE="ubuntu-base-22.04.5-base-amd64.tar.gz"
UBUNTU_BASE_SHA256="242cd8898b33ea806ef5f13b1076ed7c76f9f989d18384452f7166692438ff1a"
UBUNTU_BASE_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/22.04/release"

deb="${1:-}"
[ -n "$deb" ] && [ -f "$deb" ] || { echo "usage: pkg-sandbox-test.sh <package.deb>" >&2; exit 2; }
deb="$(cd "$(dirname "$deb")" && pwd)/$(basename "$deb")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unit_src="$(cd "$here/../.." && pwd)/packaging/linux/indiansassist-agent.service"
for t in bwrap tar sha256sum; do
  command -v "$t" >/dev/null || { echo "pkg-sandbox-test: $t is required (not met)" >&2; exit 1; }
done

# --- the pinned root file system, downloaded once
cache="$HOME/.cache/ia-throwaway"
tarball="$cache/$UBUNTU_BASE_FILE"
mkdir -p "$cache"
if [ ! -f "$tarball" ]; then
  command -v curl >/dev/null || { echo "pkg-sandbox-test: curl is needed for the one-time download" >&2; exit 1; }
  echo "pkg-sandbox-test: downloading $UBUNTU_BASE_FILE once into $cache"
  part="$(mktemp "$cache/.download.XXXXXX")"
  sums="$(mktemp "$cache/.sums.XXXXXX")"
  trap 'rm -f "$part" "$sums"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 -o "$sums" "$UBUNTU_BASE_URL/SHA256SUMS"
  if ! grep -qx "$UBUNTU_BASE_SHA256 \*$UBUNTU_BASE_FILE" "$sums"; then
    echo "pkg-sandbox-test: the published SHA256SUMS does not list the pinned $UBUNTU_BASE_FILE $UBUNTU_BASE_SHA256" >&2
    exit 1
  fi
  curl -fSL --proto '=https' --tlsv1.2 -o "$part" "$UBUNTU_BASE_URL/$UBUNTU_BASE_FILE"
  got="$(sha256sum "$part" | cut -d' ' -f1)"
  [ "$got" = "$UBUNTU_BASE_SHA256" ] || { echo "pkg-sandbox-test: download sha256 $got != pinned $UBUNTU_BASE_SHA256" >&2; exit 1; }
  mv "$part" "$tarball"
  rm -f "$sums"
  trap - EXIT
fi
got="$(sha256sum "$tarball" | cut -d' ' -f1)"
[ "$got" = "$UBUNTU_BASE_SHA256" ] || { echo "pkg-sandbox-test: $tarball sha256 $got != pinned $UBUNTU_BASE_SHA256" >&2; exit 1; }
echo "pkg-sandbox-test: $UBUNTU_BASE_FILE sha256 $got (pinned, matches)"

# --- a fresh temporary root
T="$(mktemp -d /tmp/ia-pkg-sandbox.XXXXXX)"
cleanup() {
  chmod -R u+rwX "$T" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT
rootfs="$T/rootfs"
mkdir -p "$rootfs" "$T/pkg"
# Device nodes cannot be made without privilege, and --dev provides /dev anyway.
tar -xzpf "$tarball" -C "$rootfs" --no-same-owner --exclude='./dev/*' 2>"$T/tar.err" || {
  cat "$T/tar.err" >&2
  exit 1
}
cp "$deb" "$T/pkg/pkg.deb"
cp "$unit_src" "$T/pkg/unit"
mkdir -p "$rootfs/mnt/pkg"

sandbox() { # sandbox <sh -c script>: as fake root in the Ubuntu Base root, no network
  bwrap --unshare-all --uid 0 --gid 0 \
    --bind "$rootfs" / --proc /proc --dev /dev --tmpfs /tmp \
    --ro-bind "$T/pkg" /mnt/pkg \
    --die-with-parent --clearenv \
    --setenv PATH /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --setenv HOME /root --setenv LANG C.UTF-8 --setenv DEBIAN_FRONTEND noninteractive \
    --chdir / /bin/sh -c "$1"
}

pass=0
fail=0
check() { # check <description> <sandbox script>
  if sandbox "$2" >"$T/last.out" 2>&1; then
    pass=$((pass + 1))
    echo "  ok   $1"
  else
    fail=$((fail + 1))
    echo "  FAIL $1"
    sed 's/^/       /' "$T/last.out" | head -20
  fi
}
# The tree, minus the bind mounts and dpkg's own bookkeeping that every install changes.
TREE='find / -xdev \( -path /proc -o -path /dev -o -path /tmp -o -path /mnt/pkg \) -prune -o -print | grep -vE "^/var/(log/(dpkg\.log|apt/.*|alternatives\.log)|lib/dpkg/(status|status-old|available|lock.*|triggers/.*|info/format|diversions.*|statoverride.*))$" | sort'

echo "pkg-sandbox-test: Ubuntu Base 22.04 in $T (bubblewrap, fake root, no network)"
check "the sandbox is uid 0 with no network (only lo)" \
  'test "$(id -u)" = 0 && test "$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " " | sort | tr "\n" " ")" = "lo "'
check "the root has libc6 >= 2.35 and no systemd running" \
  'dpkg-query -W -f="\${Version}\n" libc6 | grep -q "^2\.35" && ! test -d /run/systemd/system'
sandbox "$TREE" >"$T/before.txt"

echo "== dpkg -i"
if sandbox 'dpkg -i /mnt/pkg/pkg.deb' >"$T/install.log" 2>&1; then
  pass=$((pass + 1))
  echo "  ok   dpkg -i (no --force-depends)"
else
  fail=$((fail + 1))
  echo "  FAIL dpkg -i"
fi
sed 's/^/       /' "$T/install.log"
if grep -q 'systemd is not running here; the service was installed but not started' "$T/install.log"; then
  pass=$((pass + 1))
  echo "  ok   postinst skipped systemd (no /run/systemd/system)"
else
  fail=$((fail + 1))
  echo "  FAIL postinst did not report skipping systemd"
fi
check "installed: ok installed" 'dpkg-query -W -f="\${Status}\n" indiansassist-agent | grep -qx "install ok installed"'
check "Depends is exactly libc6 (>= 2.35)" 'dpkg-query -W -f="\${Depends}\n" indiansassist-agent | grep -qx "libc6 (>= 2.35)"'
for line in \
  "755 root root /usr/lib/indiansassist/ia-service" \
  "755 root root /usr/lib/indiansassist/ia-desktop" \
  "644 root root /usr/lib/indiansassist/manifest.json" \
  "644 root root /usr/lib/systemd/system/indiansassist-agent.service" \
  "644 root root /usr/share/doc/indiansassist-agent/copyright"; do
  f="${line##* }"
  check "$f is $line" "test \"\$(stat -c '%a %U %G %n' $f)\" = '$line'"
done
check "the installed unit is packaging/linux/indiansassist-agent.service" \
  'cmp /usr/lib/systemd/system/indiansassist-agent.service /mnt/pkg/unit'
check "the unit was not enabled (no systemd)" \
  '! test -e /etc/systemd/system/multi-user.target.wants/indiansassist-agent.service'
check "the binaries hash to the installed manifest.json" \
  'cd /usr/lib/indiansassist && for b in ia-service ia-desktop; do grep -q "\"sha256\": \"$(sha256sum $b | cut -d" " -f1)\"" manifest.json || exit 1; done'
check "ia-service --version runs on glibc 2.35" '/usr/lib/indiansassist/ia-service --version | grep -Eq "^ia-service [0-9]+\.[0-9]+\.[0-9]+"'
check "ia-desktop --version runs on glibc 2.35" '/usr/lib/indiansassist/ia-desktop --version | grep -Eq "^ia-desktop [0-9]+\.[0-9]+\.[0-9]+"'
sandbox '/usr/lib/indiansassist/ia-service --version'

echo "== an enrolled device on an offline host"
# The service as root generates the device identity (0600) and waits for an enrollment file; then
# config.json says it is enrolled against an api this sandbox cannot reach, so the prerm deregister
# really tries the network and fails, which must not stop the purge.
sandbox 'timeout -s TERM 3 /usr/lib/indiansassist/ia-service >/tmp/svc.log 2>&1; cat /tmp/svc.log' >"$T/svc.log" 2>&1 || true
sed 's/^/       /' "$T/svc.log" | head -8
check "the service created its device keys 0600 root" \
  'test "$(stat -c "%a %U" /var/lib/indiansassist/device.key)" = "600 root" && test "$(stat -c "%a %U" /var/lib/indiansassist/device.kex)" = "600 root" && test "$(stat -c "%a" /var/lib/indiansassist)" = 700'
check "an enrolled config.json pointing at an unreachable api" \
  'printf "%s\n" "{\"v\":1,\"apiOrigin\":\"https://api.example.test\",\"signalUrl\":\"wss://api.example.test/signal/device\",\"deviceId\":\"00000000-0000-4000-8000-000000000001\",\"keyId\":\"t1-sandbox\",\"region\":\"in\",\"orgId\":\"00000000-0000-4000-8000-000000000002\"}" >/var/lib/indiansassist/config.json && mkdir -p /etc/indiansassist && : >/etc/indiansassist/enroll.iaconfig'

echo "== dpkg --purge"
if sandbox 'dpkg --purge indiansassist-agent' >"$T/purge.log" 2>&1; then
  pass=$((pass + 1))
  echo "  ok   dpkg --purge (the offline deregister did not stop it)"
else
  fail=$((fail + 1))
  echo "  FAIL dpkg --purge"
fi
sed 's/^/       /' "$T/purge.log"
if grep -qE 'deregister call did not land|the device keys have been shredded' "$T/purge.log"; then
  pass=$((pass + 1))
  echo "  ok   prerm ran the deregister, which failed offline and was ignored"
else
  fail=$((fail + 1))
  echo "  FAIL prerm did not run the deregister"
fi
check "the package is gone" '! dpkg-query -W indiansassist-agent >/dev/null 2>&1 || dpkg-query -W -f="\${Status}\n" indiansassist-agent | grep -qx "unknown ok not-installed"'
check "no state, config, runtime or install directory remains" \
  '! test -e /var/lib/indiansassist && ! test -e /etc/indiansassist && ! test -e /run/indiansassist && ! test -e /usr/lib/indiansassist && ! test -e /usr/lib/systemd/system/indiansassist-agent.service && ! test -e /usr/share/doc/indiansassist-agent'
sandbox "$TREE" >"$T/after.txt"
if diff -u "$T/before.txt" "$T/after.txt" >"$T/tree.diff"; then
  pass=$((pass + 1))
  echo "  ok   nothing remains: the tree after the purge is the tree before the install ($(wc -l <"$T/before.txt") paths)"
else
  fail=$((fail + 1))
  echo "  FAIL the tree changed:"
  sed 's/^/       /' "$T/tree.diff" | head -30
fi

echo "IA_T1_CHECKS_PASSED=$pass"
echo "IA_T1_CHECKS_FAILED=$fail"
[ "$fail" -eq 0 ]
