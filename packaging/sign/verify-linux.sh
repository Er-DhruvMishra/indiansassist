#!/usr/bin/env bash
# Checks the signatures sign-linux.sh wrote, the way a downloader does, with nothing taken from the machine's own
# keyrings: the public key is imported into a temporary GNUPGHOME and a temporary rpm database, both removed on exit.
#
#   verify-linux.sh <dir> <public-key.asc> <file>...
#
#   * gpg --verify <file>.asc <file> for each file, and SHA256SUMS.asc over SHA256SUMS when it is there;
#   * sha256sum -c SHA256SUMS (only the named files' lines must pass; other lines are ignored);
#   * rpm -K (rpmkeys --checksig) on each *.rpm against the temporary rpm database.
# Exit 0 when everything verifies, 1 otherwise.
set -uo pipefail

[ "$#" -ge 3 ] || { echo "usage: verify-linux.sh <dir> <public-key.asc> <file>..." >&2; exit 2; }
dir="$1"
key="$2"
shift 2
T="$(mktemp -d /tmp/ia-verify.XXXXXX)"
export GNUPGHOME="$T/gnupg"
mkdir -m 700 "$GNUPGHOME"
cleanup() {
  gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fail=1; }

gpg --batch --quiet --import "$key" 2>/dev/null || { echo "verify-linux: cannot import $key" >&2; exit 1; }
fpr="$(gpg --batch --with-colons --list-keys | awk -F: '/^fpr:/ {print $10; exit}')"
echo "verify-linux: public key $fpr (temporary GNUPGHOME)"

for f in "$@"; do
  if gpg --batch --status-fd 1 --verify "$dir/$f.asc" "$dir/$f" 2>/dev/null | grep -q "^\[GNUPG:\] VALIDSIG $fpr "; then
    ok "gpg --verify $f.asc"
  else
    bad "gpg --verify $f.asc"
  fi
done

if [ -f "$dir/SHA256SUMS" ]; then
  if gpg --batch --status-fd 1 --verify "$dir/SHA256SUMS.asc" "$dir/SHA256SUMS" 2>/dev/null | grep -q "^\[GNUPG:\] VALIDSIG $fpr "; then
    ok "gpg --verify SHA256SUMS.asc"
  else
    bad "gpg --verify SHA256SUMS.asc"
  fi
  for f in "$@"; do
    line="$(awk -v f="$f" '$2 == f' "$dir/SHA256SUMS")"
    if [ -n "$line" ] && (cd "$dir" && printf '%s\n' "$line" | sha256sum -c --strict - >/dev/null 2>&1); then
      ok "sha256sum -c SHA256SUMS: $f"
    else
      bad "sha256sum -c SHA256SUMS: $f"
    fi
  done
fi

for f in "$@"; do
  case "$f" in
    *.rpm)
      if ! command -v rpmkeys >/dev/null; then
        bad "rpm -K $f (rpmkeys is not installed)"
        continue
      fi
      db="$T/rpmdb"
      mkdir -p "$db/pubkeys"
      R=(rpmkeys --dbpath "$db" --define "_keyringpath $db/pubkeys")
      "${R[@]}" --import "$key" >/dev/null 2>&1 || true
      out="$("${R[@]}" --checksig -v "$dir/$f" 2>&1)"
      echo "$out" | sed 's/^/       /'
      if echo "$out" | grep -qiE 'signature.*OK' && ! echo "$out" | grep -qiE 'NOKEY|NOT OK|BAD'; then
        ok "rpm -K $f (temporary rpm database)"
      else
        bad "rpm -K $f"
      fi
      ;;
  esac
done
[ "$fail" -eq 0 ] && echo "verify-linux: all checks passed" || echo "verify-linux: FAILED"
exit "$fail"
