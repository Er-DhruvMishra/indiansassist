#!/usr/bin/env bash
# The section 8.12 "Package checks" layer, read-only on the files (Phase F contract): run in WSL by
# `pnpm linux:pkg` after the packages are built, or by hand:
#
#   check-wsl.sh <dist-dir> <deb-file-name> <rpm-file-name>
#
#   * systemd-analyze verify on the unit with the binary path mapped to a temporary copy, and the
#     systemd-analyze security --offline=yes score (recorded, not gated: section 8.8);
#   * dpkg-deb --info / --contents: name, Depends, Recommends, architecture, every file with its
#     mode and owner, the maintainer scripts byte for byte;
#   * rpm -qpl / --scripts / --requires / --recommends and the file modes and owners;
#   * the packaged binaries hash to the packaged manifest.json (the section 8.8 integrity check
#     starts clean on a fresh install);
#   * ansible-playbook --syntax-check and ansible-lint --profile production on the test playbook.
#
# Everything it writes goes to one temporary directory, removed on exit (ansible's home, temp and
# caches included). It installs nothing and never runs a maintainer script.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
[ "$#" -eq 3 ] || { echo "usage: check-wsl.sh <dist-dir> <deb-file-name> <rpm-file-name>" >&2; exit 2; }
dist="$1"
deb="$dist/$2"
rpmf="$dist/$3"

T="$(mktemp -d /tmp/ia-pkg-check.XXXXXX)"
trap 'rm -rf "$T"' EXIT
pass=0
fail=0
check() { # check <description> <command...>
  local what="$1"
  shift
  if "$@" >"$T/last.out" 2>&1; then
    pass=$((pass + 1))
    echo "  ok   $what"
  else
    fail=$((fail + 1))
    echo "  FAIL $what"
    sed 's/^/       /' "$T/last.out" | head -20
  fi
}
has() { grep -qE -- "$1" "$2"; }
lacks() { ! grep -qE -- "$1" "$2"; }

for f in "$deb" "$rpmf"; do
  [ -f "$f" ] || { echo "check-wsl: $f is missing" >&2; exit 1; }
done

echo "== systemd unit (section 8.8)"
mkdir -p "$T/unit" "$T/bin"
cp "$repo/packaging/linux/indiansassist-agent.service" "$T/unit/"
dpkg-deb -x "$deb" "$T/debroot"
install -m 0755 "$T/debroot/usr/lib/indiansassist/ia-service" "$T/bin/ia-service"
sed -i "s#^ExecStart=/usr/lib/indiansassist/ia-service\$#ExecStart=$T/bin/ia-service#" "$T/unit/indiansassist-agent.service"
check "the unit's ExecStart is mapped to a temporary copy" has "^ExecStart=$T/bin/ia-service\$" "$T/unit/indiansassist-agent.service"
check "systemd-analyze verify" systemd-analyze verify --man=no "$T/unit/indiansassist-agent.service"
systemd-analyze security --offline=yes "$T/unit/indiansassist-agent.service" >"$T/security.txt" 2>&1 || true
score="$(grep -Eo 'Overall exposure level for [^:]+: [0-9.]+ [A-Z]+' "$T/security.txt" | sed 's/.*: //')"
echo "  info systemd-analyze security --offline=yes: ${score:-unavailable}"
echo "IA_UNIT_SECURITY=${score:-unavailable}"

echo "== deb: $(basename "$deb")"
dpkg-deb --info "$deb" >"$T/deb-info.txt"
dpkg-deb --contents "$deb" >"$T/deb-contents.txt"
sed 's/^/    /' "$T/deb-info.txt"
sed 's/^/    /' "$T/deb-contents.txt"
check "Package: indiansassist-agent" has '^ Package: indiansassist-agent$' "$T/deb-info.txt"
check "Architecture: amd64" has '^ Architecture: amd64$' "$T/deb-info.txt"
check "Depends: libc6 (>= 2.34), nothing else" has '^ Depends: libc6 \(>= 2\.34\)$' "$T/deb-info.txt"
check "Recommends: systemd" has '^ Recommends: systemd$' "$T/deb-info.txt"
check "no Pre-Depends or Suggests" lacks '^ (Pre-Depends|Suggests):' "$T/deb-info.txt"
check "ia-service 0755 root (uid/gid 0)" has '^-rwxr-xr-x (root/root|0/0) .* \./usr/lib/indiansassist/ia-service$' "$T/deb-contents.txt"
check "ia-desktop 0755 root (uid/gid 0)" has '^-rwxr-xr-x (root/root|0/0) .* \./usr/lib/indiansassist/ia-desktop$' "$T/deb-contents.txt"
check "manifest.json 0644 root (uid/gid 0)" has '^-rw-r--r-- (root/root|0/0) .* \./usr/lib/indiansassist/manifest\.json$' "$T/deb-contents.txt"
check "the unit 0644 root (uid/gid 0)" has '^-rw-r--r-- (root/root|0/0) .* \./usr/lib/systemd/system/indiansassist-agent\.service$' "$T/deb-contents.txt"
check "copyright 0644 root (uid/gid 0)" has '^-rw-r--r-- (root/root|0/0) .* \./usr/share/doc/indiansassist-agent/copyright$' "$T/deb-contents.txt"
files="$(grep -c '^-' "$T/deb-contents.txt")"
check "exactly five files in the deb (found $files)" test "$files" -eq 5
dpkg-deb --ctrl-tarfile "$deb" | tar -x -C "$T" --one-top-level=debctrl
for s in postinst prerm postrm; do
  check "deb $s is packaging/linux/debian/$s byte for byte" cmp "$T/debctrl/$s" "$repo/packaging/linux/debian/$s"
  check "deb $s is executable" test -x "$T/debctrl/$s"
done
check "the packaged unit is the repo's unit" cmp "$T/debroot/usr/lib/systemd/system/indiansassist-agent.service" "$repo/packaging/linux/indiansassist-agent.service"
for b in ia-service ia-desktop; do
  sum="$(sha256sum "$T/debroot/usr/lib/indiansassist/$b" | cut -d' ' -f1)"
  check "deb $b hashes to its manifest.json row" has "\"sha256\": \"$sum\"" "$T/debroot/usr/lib/indiansassist/manifest.json"
done

echo "== rpm: $(basename "$rpmf")"
mkdir -p "$T/rpmdb"
# --nosignature: a signed rpm (packaging/sign) would otherwise print a NOKEY warning into every query output, because
# this empty temporary database holds no key; the signature itself is checked by packaging/sign/verify-linux.sh.
R=(rpm --dbpath "$T/rpmdb" --nosignature)
"${R[@]}" -qpi "$rpmf" >"$T/rpm-info.txt" 2>&1
"${R[@]}" -qpl "$rpmf" >"$T/rpm-list.txt" 2>&1
"${R[@]}" -qp --scripts "$rpmf" >"$T/rpm-scripts.txt" 2>&1
"${R[@]}" -qp --requires "$rpmf" >"$T/rpm-requires.txt" 2>&1
"${R[@]}" -qp --recommends "$rpmf" >"$T/rpm-recommends.txt" 2>&1
"${R[@]}" -qp --qf '[%{FILEMODES:perms} %{FILEUSERNAME}:%{FILEGROUPNAME} %{FILEFLAGS:fflags} %{FILENAMES}\n]' "$rpmf" >"$T/rpm-modes.txt" 2>&1
for f in rpm-info rpm-list rpm-requires rpm-recommends rpm-modes rpm-scripts; do
  echo "  -- $f"
  sed 's/^/    /' "$T/$f.txt"
done
check "Name: indiansassist-agent" has '^Name *: indiansassist-agent$' "$T/rpm-info.txt"
check "Architecture: x86_64" has '^Architecture *: x86_64$' "$T/rpm-info.txt"
check "Requires glibc >= 2.34" has '^glibc >= 2\.34$' "$T/rpm-requires.txt"
check "Requires nothing else but /bin/sh and rpmlib()" \
  test -z "$(grep -vE '^(glibc >= 2\.34|/bin/sh|rpmlib\(.*)$' "$T/rpm-requires.txt")"
check "Recommends: systemd (weak)" has '^systemd$' "$T/rpm-recommends.txt"
check "ia-service 0755 root:root" has '^-rwxr-xr-x root:root +/usr/lib/indiansassist/ia-service$' "$T/rpm-modes.txt"
check "ia-desktop 0755 root:root" has '^-rwxr-xr-x root:root +/usr/lib/indiansassist/ia-desktop$' "$T/rpm-modes.txt"
check "manifest.json 0644 root:root" has '^-rw-r--r-- root:root +/usr/lib/indiansassist/manifest\.json$' "$T/rpm-modes.txt"
check "the unit 0644 root:root" has '^-rw-r--r-- root:root +/usr/lib/systemd/system/indiansassist-agent\.service$' "$T/rpm-modes.txt"
check "copyright 0644 root:root, %doc" has '^-rw-r--r-- root:root d /usr/share/doc/indiansassist-agent/copyright$' "$T/rpm-modes.txt"
rfiles="$(grep -c '^/' "$T/rpm-list.txt")"
check "exactly five files in the rpm (found $rfiles)" test "$rfiles" -eq 5
check "%post enables the unit only under systemd" has 'if \[ -d /run/systemd/system \]; then' "$T/rpm-scripts.txt"
check "%preun deregisters bounded to 10 s, status ignored" has 'timeout -k 2 10 /usr/lib/indiansassist/ia-service --deregister \|\| true' "$T/rpm-scripts.txt"
check "%postun on erase removes state and config" has 'rm -rf /var/lib/indiansassist /etc/indiansassist' "$T/rpm-scripts.txt"
for s in postinstall preuninstall postuninstall; do
  check "rpm has a $s scriptlet run by /bin/sh" has "^$s scriptlet \(using /bin/sh\):" "$T/rpm-scripts.txt"
done
if command -v rpm2cpio >/dev/null && command -v cpio >/dev/null; then
  mkdir -p "$T/rpmroot"
  (cd "$T/rpmroot" && rpm2cpio "$rpmf" | cpio -idm --quiet) 2>/dev/null
  for b in ia-service ia-desktop; do
    check "rpm $b is the deb's $b byte for byte" cmp "$T/rpmroot/usr/lib/indiansassist/$b" "$T/debroot/usr/lib/indiansassist/$b"
  done
  check "rpm manifest.json is the deb's" cmp "$T/rpmroot/usr/lib/indiansassist/manifest.json" "$T/debroot/usr/lib/indiansassist/manifest.json"
else
  echo "  info rpm2cpio or cpio is not installed; the rpm payload comparison is not run"
fi
for s in "$repo"/packaging/linux/debian/* "$repo"/packaging/linux/rpm/*; do
  check "$(basename "$s"): downloads nothing, touches no home" lacks '(curl|wget|https?://|\$HOME|~/|/home/)' "$s"
done

echo "== Ansible role (section 8.10)"
mkdir -p "$T/ansible/home" "$T/ansible/tmp" "$T/ansible/cache"
ansible_env=(env ANSIBLE_HOME="$T/ansible/home" ANSIBLE_LOCAL_TEMP="$T/ansible/tmp"
  ANSIBLE_ROLES_PATH="$repo/packaging/linux/ansible/roles" XDG_CACHE_HOME="$T/ansible/cache"
  ANSIBLE_NOCOLOR=1)
check "ansible-playbook --syntax-check" \
  "${ansible_env[@]}" ansible-playbook --syntax-check -i localhost, "$repo/packaging/linux/ansible/test-playbook.yml"
check "ansible-lint --profile production" \
  bash -c "cd '$repo/packaging/linux/ansible' && $(printf '%q ' "${ansible_env[@]}") ansible-lint --offline --profile production test-playbook.yml roles/indiansassist_agent"

echo "IA_PKG_CHECKS_PASSED=$pass"
echo "IA_PKG_CHECKS_FAILED=$fail"
[ "$fail" -eq 0 ]
