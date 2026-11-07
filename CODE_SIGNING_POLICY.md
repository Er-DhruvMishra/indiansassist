# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

**Current status (7 November 2026): the SignPath Foundation certificate has not been granted yet.** Until it is,
releases are signed with the project's own keys:

- **Windows** (the portable agent `.exe` and the installer `.msi`): Authenticode SHA-256 with an RFC 3161 timestamp,
  using the project's **self-signed** certificate. Windows does not trust a self-signed certificate, so SmartScreen and
  the UAC prompt show an unknown publisher; check the file as described under "Verifying a download".
- **Linux** (the `.deb`, the `.rpm` and the portable X11 and Wayland pair): signed with the project's **GPG** release key.
  The `.rpm` carries an embedded signature, every file has a detached `.asc` signature, and `SHA256SUMS` lists every
  file's SHA-256 with its own signature `SHA256SUMS.asc`.

The public keys are published on the website, <https://indiansassist.com/keys/indiansassist-windows-selfsigned.cer> and <https://indiansassist.com/keys/indiansassist-release-signing.asc>, and in the repository under `site/keys/`. Once
SignPath Foundation approves the project, the Windows files are signed with the SignPath Foundation certificate under
this policy, and this page will say so. macOS, iOS and Android builds are outside SignPath's scope; their status is on the
[download page](https://indiansassist.com/download.html).

## What is signed

- Only files built from this repository's public source by the project's GitHub Actions release workflow. A signing
  request is never made for a file built on a developer's machine.
- Only the project's own programs and installers (the IndiansAssist agents, service and installer, and the installer's
  custom-action library). Third-party programs are never signed with the project's certificate; third-party libraries
  are only ever included as source-built parts of our own binaries, as listed in
  [docs/LICENSE-REGISTER.md](docs/LICENSE-REGISTER.md).
- Each signed release is tagged in the repository, so its exact source can be inspected and rebuilt.

## Team roles

| Role | Responsibility | Members |
|---|---|---|
| Committers and reviewers | Trusted to change the source code without further review. Every change from anyone else is reviewed by a committer before it is merged. | Dhruv Mishra ([Er-DhruvMishra](https://github.com/Er-DhruvMishra)) |
| Approvers | Approve each signing request by hand, after checking that it comes from the release workflow on a tagged commit of this repository. | Dhruv Mishra ([Er-DhruvMishra](https://github.com/Er-DhruvMishra)) |

All team members use multi-factor authentication on GitHub and on SignPath.

## Release approval

1. A release is cut from a tag on `master`.
2. The release workflow builds every file from that tag on GitHub-hosted runners, runs the tests, and submits the
   Windows files to SignPath.
3. An approver reviews the request (the tag, the commit, the workflow run) and approves it by hand. Nothing is signed
   without that approval.
4. The signed files, their SHA-256 checksums and the Linux signatures are published on
   [GitHub Releases](https://github.com/Er-DhruvMishra/indiansassist/releases).

## Verifying a download

On **Windows** (PowerShell), compare the file's signer with the published certificate:

```powershell
$file = Get-AuthenticodeSignature .\IndiansAssist-Agent-<version>-windows-x64.msi
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 .\indiansassist-windows-selfsigned.cer
$file.SignerCertificate.Thumbprint -eq $cert.Thumbprint   # True
$file.TimeStamperCertificate -ne $null                    # True: the signature is timestamped
(Get-FileHash .\IndiansAssist-Agent-<version>-windows-x64.msi -Algorithm SHA256).Hash   # compare with SHA256SUMS
```

While the certificate is self-signed, `Get-AuthenticodeSignature` reports the status `UnknownError` (untrusted root);
that is expected. There is no need to add the certificate to a trusted store. After the switch to SignPath, the status is
`Valid` and the signer is SignPath Foundation.

On **Linux**:

```sh
gpg --import indiansassist-release-signing.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
gpg --verify IndiansAssist-Agent-<version>-linux-x64.deb.asc IndiansAssist-Agent-<version>-linux-x64.deb
sudo rpm --import indiansassist-release-signing.asc && rpm -K IndiansAssist-Agent-<version>-linux-x64.rpm
```

Get the public keys from both the website (`/keys/`) and the repository's `site/keys/`, and check that they
match.

## Reporting a problem

If you find a file signed with the project's key or certificate that was not published on GitHub Releases, or anything
else wrong with a signature, report it privately as described in [SECURITY.md](SECURITY.md).
