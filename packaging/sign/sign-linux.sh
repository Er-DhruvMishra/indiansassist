#!/usr/bin/env bash
# The Linux half of the release signing seam (docs/release.md section 4), run in WSL by the Windows release scripts
# (packaging/sign/sign-linux.mjs) or directly on a Linux CI runner:
#
#   sign-linux.sh <dir> <file>...
#
# For the named files in <dir>:
#   1. every *.rpm gets an embedded signature (rpmsign --addsign), so `rpm -K` and dnf check it;
#   2. every file gets a detached ASCII-armored signature <file>.asc (gpg --detach-sign --armor);
#   3. <dir>/$IA_SIGN_SUMS (default SHA256SUMS; "none" skips it) lists the sha256 of the files as signed, and
#      <dir>/$IA_SIGN_SUMS.asc is its detached signature.
#
# Environment (never the user's ~/.gnupg: a GNUPGHOME must be named):
#   IA_GPG_HOME              the GNUPGHOME holding the secret key (required)
#   IA_GPG_KEY               its fingerprint (optional: the only secret key in IA_GPG_HOME)
#   IA_GPG_PASSPHRASE_FILE   a file holding the passphrase, or IA_GPG_PASSPHRASE the value (optional)
#   IA_SIGNING_PROVIDER(_LINUX)  selfsigned (default) or signpath (signs nothing here; exit 3)
#
# Exit: 0 signed; 3 not signed (no key configured, or another provider); 1 a failure (nothing is half-signed on
# purpose: an rpm that cannot be signed because rpmsign is missing fails the run).
set -euo pipefail

usage() { echo "usage: sign-linux.sh <dir> <file>..." >&2; exit 2; }
[ "$#" -ge 2 ] || usage
dir="$1"
shift
[ -d "$dir" ] || { echo "sign-linux: $dir is not a directory" >&2; exit 1; }

provider="${IA_SIGNING_PROVIDER_LINUX:-${IA_SIGNING_PROVIDER:-selfsigned}}"
case "$provider" in
  selfsigned | "") ;;
  signpath)
    echo "sign-linux: not signed (IA_SIGNING_PROVIDER=signpath: SignPath signs in CI only, docs/release.md section 4.7)"
    exit 3
    ;;
  *) echo "sign-linux: IA_SIGNING_PROVIDER must be selfsigned or signpath, got $provider" >&2; exit 1 ;;
esac

home="${IA_GPG_HOME:-}"
if [ -z "$home" ]; then
  echo "sign-linux: not signed (IA_GPG_HOME is not set)"
  exit 3
fi
[ -d "$home" ] || { echo "sign-linux: not signed (IA_GPG_HOME $home does not exist)"; exit 3; }
command -v gpg >/dev/null || { echo "sign-linux: gpg is not installed" >&2; exit 1; }
export GNUPGHOME="$home"

tmp="$(mktemp -d /tmp/ia-sign.XXXXXX)"
cleanup() {
  gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

pf="${IA_GPG_PASSPHRASE_FILE:-}"
if [ -z "$pf" ] && [ -n "${IA_GPG_PASSPHRASE:-}" ]; then
  pf="$tmp/pass"
  (umask 077 && printf '%s' "$IA_GPG_PASSPHRASE" > "$pf")
fi
gpg_args=(--batch --yes --no-tty)
if [ -n "$pf" ]; then
  [ -f "$pf" ] || { echo "sign-linux: IA_GPG_PASSPHRASE_FILE $pf does not exist" >&2; exit 1; }
  gpg_args+=(--pinentry-mode loopback --passphrase-file "$pf")
fi

key="${IA_GPG_KEY:-}"
if [ -z "$key" ]; then
  mapfile -t fprs < <(gpg --batch --with-colons --list-secret-keys 2>/dev/null | awk -F: '/^sec:/ {s=1; next} s && /^fpr:/ {print $10; s=0}')
  [ "${#fprs[@]}" -eq 1 ] || { echo "sign-linux: IA_GPG_HOME holds ${#fprs[@]} secret keys; set IA_GPG_KEY" >&2; exit 1; }
  key="${fprs[0]}"
fi
gpg --batch --with-colons --list-secret-keys "$key" >/dev/null 2>&1 \
  || { echo "sign-linux: no secret key $key in IA_GPG_HOME" >&2; exit 1; }
echo "sign-linux: signing with OpenPGP key $key"

files=()
for f in "$@"; do
  case "$f" in */* | "" | .*) echo "sign-linux: $f is not a bare file name" >&2; exit 1 ;; esac
  [ -f "$dir/$f" ] || { echo "sign-linux: $dir/$f is missing" >&2; exit 1; }
  files+=("$f")
done

# 1. the embedded rpm signature first: it changes the rpm's bytes, so the .asc and SHA256SUMS come after it.
for f in "${files[@]}"; do
  case "$f" in
    *.rpm)
      command -v rpmsign >/dev/null || {
        echo "sign-linux: rpmsign is not installed (Debian/Ubuntu: the rpm package); $f cannot be signed" >&2
        exit 1
      }
      extra="${gpg_args[*]}"
      echo "sign-linux: rpmsign --addsign $f"
      rpmsign --addsign \
        --define "_gpg_path $GNUPGHOME" \
        --define "_gpg_name $key" \
        --define "_openpgp_sign_id $key" \
        --define "_gpg_sign_cmd_extra_args $extra" \
        "$dir/$f"
      ;;
  esac
done

# 2. detached armored signatures.
for f in "${files[@]}"; do
  gpg "${gpg_args[@]}" --local-user "$key" --armor --detach-sign --output "$dir/$f.asc" "$dir/$f"
  echo "sign-linux: $f.asc"
done

# 3. the checksum list and its signature.
sums="${IA_SIGN_SUMS:-SHA256SUMS}"
if [ "$sums" != none ]; then
  case "$sums" in */* | .*) echo "sign-linux: IA_SIGN_SUMS must be a bare file name" >&2; exit 1 ;; esac
  (cd "$dir" && sha256sum -- "${files[@]}") > "$dir/$sums"
  gpg "${gpg_args[@]}" --local-user "$key" --armor --detach-sign --output "$dir/$sums.asc" "$dir/$sums"
  echo "sign-linux: $sums and $sums.asc"
fi
echo "IA_SIGNED_WITH=$key"
