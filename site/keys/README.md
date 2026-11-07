# IndiansAssist signing keys (public parts)

IndiansAssist releases are signed with **interim keys** that the project made and manages itself, until a
code-signing certificate from the SignPath Foundation replaces the Windows one. These files are the public halves.
Nothing here can sign anything. The private halves never leave the maintainer's machine and the release
workflow's secrets.

**A self-signed signature proves that a file is unchanged since the project signed it. It does not prove who the
project is.** Windows will still say "Unknown publisher" and SmartScreen may still warn. Check the fingerprints
below against a second channel you trust, such as the project's repository or a release announcement, before you
rely on them.

| File | What it is |
|---|---|
| `indiansassist-windows-selfsigned.cer` | the Windows Authenticode certificate (DER), self-signed |
| `indiansassist-release-signing.asc` | the OpenPGP public key that signs the Linux packages, the Linux binaries and `SHA256SUMS` |

## Windows: Authenticode, self-signed

- Subject: `CN=IndiansAssist (self-signed), O=IndiansAssist Project`
- Key: RSA 3072, SHA-256, Code Signing extended key usage
- Valid: 7 Nov 2026 to 7 Nov 2029
- Thumbprint (SHA-1): `7BE7416FEF06EDA266EB2035987875E4256B09F0`
- SHA-256 of `indiansassist-windows-selfsigned.cer`:
  `7871915d20a0a97902543964c1ca00222178df252e603efaa5aee5f313f7ddd5`
- Signed: the portable agent `IndiansAssist-windows-<arch>-<version>.exe`, the installer
  `IndiansAssist-Agent-<version>-windows-<arch>.msi`, and every program inside the installer. Every signature has
  an RFC 3161 timestamp from DigiCert's free public timestamp service, so it stays valid after the certificate
  expires.

Check a file in PowerShell. You do not need to install or trust anything:

```powershell
$sig = Get-AuthenticodeSignature .\IndiansAssist-windows-x64-0.3.0.exe
$sig.SignerCertificate.Thumbprint      # must be 7BE7416FEF06EDA266EB2035987875E4256B09F0
$sig.TimeStamperCertificate.Subject    # the timestamp authority
$sig.Status                            # UnknownError ("root not trusted") is expected for a self-signed file;
                                       # HashMismatch or NotSigned means the file was changed or is not ours
```

`signtool verify /pa /v <file>` prints the same certificate and timestamp, then ends with "terminated in a root
certificate which is not trusted". That is expected for a self-signed certificate.

Do **not** import this certificate into "Trusted Root Certification Authorities" to make the warning go away. A
root you trust can vouch for any program signed with its key. Comparing the thumbprint is enough.

## Linux: OpenPGP

- User id: `IndiansAssist Release Signing (self-managed)`. It has no email address.
- Key: ed25519, sign only, valid 7 Nov 2026 to 6 Nov 2029
- Fingerprint: `4384 8FFF F247 9CE0 DE28  CD4F C6E3 E6E8 39D6 0661`
  (`43848FFFF2479CE0DE28CD4FC6E3E6E839D60661`)
- SHA-256 of `indiansassist-release-signing.asc`:
  `96cb7af00114e229e06ddeeb04f14cf70b5183b6dc7de5df0fdc5d3395c06d53`
- Signed: the `.rpm` (an embedded signature), a detached `<file>.asc` beside the `.deb`, the `.rpm` and both
  Linux portable binaries, and `SHA256SUMS` (`SHA256SUMS.asc`).

Check the files without touching your own keyring, using a temporary one:

```sh
export GNUPGHOME="$(mktemp -d)"
gpg --import indiansassist-release-signing.asc
gpg --fingerprint 43848FFFF2479CE0DE28CD4FC6E3E6E839D60661
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
gpg --verify IndiansAssist-Agent-0.3.0-linux-x64.deb.asc IndiansAssist-Agent-0.3.0-linux-x64.deb
rm -rf "$GNUPGHOME"; unset GNUPGHOME
```

Check the rpm's embedded signature against a temporary rpm database, not the system one:

```sh
db="$(mktemp -d)"
rpmkeys --dbpath "$db" --define "_keyringpath $db/pubkeys" --import indiansassist-release-signing.asc
rpmkeys --dbpath "$db" --define "_keyringpath $db/pubkeys" -K IndiansAssist-Agent-0.3.0-linux-x64.rpm
rm -rf "$db"
```

To let `dnf` check it on a machine where you install the package, import the key once with
`sudo rpm --import indiansassist-release-signing.asc`. That trusts this key for packages on that machine, so do it
only after you have compared the fingerprint.

## Android

The Android app is signed with the project's release key. Its certificate SHA-256 is
`2F:D7:47:C9:8D:D9:1B:A5:21:BA:26:E8:E5:45:C3:59:22:68:0C:08:7C:A6:7B:FB:1E:5B:5D:12:FB:9E:9B:5E`
(`apksigner verify --print-certs <apk>` prints it).

## Revocation and rotation

If a key is lost or exposed, the project publishes the OpenPGP revocation certificate and a new key here, and says so
in the release notes. A new Windows certificate gets a new thumbprint here. The maintainers' procedure is in
`docs/release.md`, section 4.
