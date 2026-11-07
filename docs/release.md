# Signed-release process

How the shippable artifacts of IndiansAssist are built, signed and published: the **Windows portable agent** (`agent/`,
Phase C), the **installed agent MSI** (`packaging/windows/`, Phase D, section 1.6), the **Linux installed agent** (deb
and rpm, section 1.7), the **Linux portable pair** (the X11 agent and its Wayland portal companion, section 1.8), the
**macOS** app and PKG (section 1.9) and the **self-hosted server images** (`apps/api`, `apps/web`, `services/recorder`).
It is the companion to the Phase C contract (`docs/specs/phase-c-contracts.md`, sections 2.2, 2.6, 7, 11.3, 15.5), the
Phase F contract (`docs/specs/phase-f-contracts.md`, sections 8.9, 8.12, 9.6, 17.1) and `infra/HARDENING.md`.

Where each artifact goes on every api node of the region (both directories are read at boot and on `SIGHUP`):

| Directory | Holds |
|---|---|
| `AGENT_DIST_DIR` | the portable agents and `manifest.json`: Windows `.exe`, Android `.apk`, the Linux pair, the macOS `.app.zip` |
| `AGENT_MSI_DIST_DIR` | the Windows MSI and its `manifest.json` at the top |
| `AGENT_MSI_DIST_DIR/linux/` | the deb, the rpm, their `.sha256` files and `manifest.json` (section 1.7) |
| `AGENT_MSI_DIST_DIR/macos/` | the PKG and its `manifest.json` (section 1.9) |

Every release build compiles in the region's keys: set `IA_TOKEN_PUBKEYS` (comma-separated base64url Ed25519 public
keys, the ones `/.well-known/indiansassist.json` lists) and `IA_API_ORIGIN` (the release default origin) before building.
A WSL build started from Windows sees them only through `WSLENV`; `pnpm agent:release:linux` sets that itself, and for
`pnpm linux:pkg` run `$env:WSLENV = 'IA_TOKEN_PUBKEYS/u:IA_API_ORIGIN/u'` first.

Two rules sit over everything below:

- The signed Windows `.exe` is **byte-identical for every download** (section 2.3): the per-download code travels in the
  file name or the signed `.iaconfig` sidecar, never inside the PE, so Authenticode stays valid and the file is cacheable
  and verifiable against `manifest.json`.
- The agent's `sha256` in `manifest.json` is computed by CI **after** signing (section 2.6), so the manifest generator runs
  on the already-signed artifacts, never before.

---

## 1. The agents (Windows in 1.1 to 1.6, Linux in 1.7 and 1.8, macOS in 1.9)

### 1.1 Build targets (Windows portable agent)

| Toolchain         | Target                    | Role                                                                                                                                                                                  |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSVC (CI only)    | `x86_64-pc-windows-msvc`  | the served **x64** build                                                                                                                                                              |
| MSVC (CI only)    | `aarch64-pc-windows-msvc` | the served **arm64** build                                                                                                                                                            |
| GNU (dev / local) | `x86_64-pc-windows-gnu`   | must pass `cargo build`, `cargo test` (incl. the loopback test) and `cargo clippy -D warnings`; **never served** (`+crt-static` and `windows_subsystem` behave differently on `-gnu`) |

Release build command (both MSVC targets):

```
cargo build --release --locked --target <target> -p ia-agent
```

Build settings that the release profile pins (section 11.3): static CRT (`-C target-feature=+crt-static`), no DLL beside the
exe, `strip = true`, `opt-level = "z"` for `ia-ui`, `panic = "abort"`, `lto = "thin"`, `#![windows_subsystem = "windows"]`.
`libvpx` is a prebuilt static library (fetched by `shiguredo_libvpx`; no `nasm` / `make` on the host) and `libopus` is built
from source by `audiopus_sys`; neither is a runtime DLL.

### 1.2 Release gates (CI)

A release build must pass all of these before it is signed and published (section 15.5, agent CI row):

1. **`cargo build --release --locked`** for both `-msvc` targets (the lockfile is authoritative; no network resolution).
2. **Import-table gate (section 11.3).** CI dumps the PE imports (`dumpbin /imports`; `objdump -p` on the gnu dev build) and
   **fails the build if any imported DLL is outside the KnownDLLs set**. KnownDLLs = the registry list
   `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\KnownDLLs` plus the implicit
   `ntdll, kernel32, kernelbase, user32, gdi32, advapi32, ole32, combase, rpcrt4, sechost, shell32, ws2_32, crypt32, bcrypt`.
   Everything else (`dxgi, d3d11, d3dcompiler_47, mfplat, mf, mfreadwrite, dwmapi, uxtheme, version, winmm, wintrust, dcomp,
shcore, propsys, …`) must be reached only through `ia_platform::sys_lib` late binding
   (`libloading` + `LOAD_LIBRARY_SEARCH_SYSTEM32`), so the `windows` crate's static import bindings are not used for those
   libraries. This is the **binding** release requirement on **both** toolchains. Note: the gnu toolchain has no
   `/DELAYLOAD`, which is why late binding (not delay-load) is the mechanism; the gate is identical regardless.
3. **Size gate:** each stripped exe is **`<= 25 MiB`** (section 11.3). libvpx dominates the size; AV1 (`rav1e`) and software
   H.264 (`openh264`) are compiled **off by default** partly for this budget.
4. **No DLL beside the exe:** the published directory for a build contains exactly the one `.exe`.
5. An embedded application manifest declares **no** side-by-side dependency.

### 1.3 Authenticode signing (section 2.6)

Sign each release exe with **Authenticode SHA-256 and an RFC-3161 timestamp**. **Today** this is the interim
self-signed certificate through the signing seam (section 4): `pnpm agent:release:windows` copies, signs and
publishes the exe. The SignPath Foundation certificate replaces it (section 4.7). Earlier plans named these
alternatives:

- **Azure Trusted Signing** via `AzureSignTool` (MIT), or
- an **EV code-signing certificate on an HSM** via `signtool.exe`.

The signing identity's subject (the certificate's CN) is **compiled into the agent** as `IA_EXPECTED_SIGNER`. A self-hoster
compiles their own `IA_EXPECTED_SIGNER` and signs with their own certificate, so the configured signer is always the expected
one for that build.

**As built (checked in the Phase F close-out):** `IA_EXPECTED_SIGNER` is shown on the elevation prompt card as the
publisher to look for in the Windows dialog. The subject *compare* below is not implemented yet: the self-check verdict is
the `WinVerifyTrust` chain only (`ia-platform/src/trust.rs`, `agent/README.md`). The rest of this section describes the
target.

The agent verifies its own signature at startup with `WinVerifyTrust` (`WINTRUST_ACTION_GENERIC_VERIFY_V2`) plus a subject
compare against `IA_EXPECTED_SIGNER`:

- In the **user instance** a mismatch is **not fatal**: the connect, consent and indicator windows carry the yellow line
  "Signed by `<subject>`, not by IndiansAssist".
- In the **elevated child** (hand-over, section 7.3) the check is **fatal**: a signer other than the compiled
  `IA_EXPECTED_SIGNER`, or an image whose `sha256` differs from the one the parent measured while holding the file handle open,
  exits with `elevation.failed { error: 'image_mismatch' }` before the session is touched.
- An **unsigned dev build** (`WinVerifyTrust` returns `TRUST_E_NOSIGNATURE`) carries a persistent "Unsigned development build"
  banner, and `manifest.signed = false` makes the join page print the sha256 and a "verify the file" hint.

Elevation over a user-writable binary has an honest limit stated in the product UI (section 7.4 / 12.4, principle P8): the
handle hold, the signer check on that handle, the child's image-hash check, the fatal signer check in the child, the
import-table rule and the UAC dialog's publisher line are the whole of what a portable binary can guarantee; the Phase D
installed agent (Program Files, a service) removes this class of risk.

### 1.4 Publishing into the download flow (section 2.2)

After signing:

For the Windows exe, steps 1 and 2 are one command: `pnpm agent:release:windows [--exe <IndiansAssist.exe>] [--arch
x64] [--dist <AGENT_DIST_DIR>]`. It copies, signs (section 4), records the file in `manifest.signed.json` and runs
`pnpm agent:manifest`.

1. Lay the signed files out under `AGENT_DIST_DIR` with their canonical names:
   `IndiansAssist-windows-x64-<version>.exe`, `IndiansAssist-windows-arm64-<version>.exe`,
   (from the Android pipeline, section 2) `IndiansAssist-android-universal-<version>.apk`, and (section 1.9)
   `IndiansAssist-macos-arm64-<version>.app.zip`. The Linux pair is written by its own script (section 1.8).
2. Run **`node scripts/agent-manifest.mjs`** (`pnpm agent:manifest`; it keeps the Linux row of section 1.8) to write `AGENT_DIST_DIR/manifest.json`
   (`{ v: 1, builds: AgentBuild[] }`, each build `{ platform, arch, version, size, sha256, signed, minOs }`). Because the
   `sha256` must cover the **signed** bytes, this step runs here, after signing. CI marks the signed builds by listing their
   file names in `AGENT_DIST_DIR/manifest.signed.json` (or by passing `--signed-all`); a dev dist dir leaves `signed: false`.
   `cargo build --release --locked`'s `Cargo.toml` version is `manifest.version` and the agent's `desk.hello.client.version`.
3. Deploy `AGENT_DIST_DIR` to every API node of the region (it is git-ignored; the directory also holds the files it names).
   The API reads it at boot and on `SIGHUP` (`apps/api/src/services/agent-dist.ts`). A node without the directory serves
   `builds: []` on `GET /api/v1/download/manifest` and `503 download_unavailable` on `prepare`, and the join page then shows
   the "not available on this server" text (section 2.7 J1).
4. Set `AGENT_MIN_VERSION` (the API refuses an older `client.version` with `join_unsupported`) and, for Android,
   `AGENT_ANDROID_APP_URL`. See `infra/.env.example`.

The signed exe is then served only through the two-step grant flow (section 2.2): `POST /api/v1/download/prepare` mints a
short-lived single-use-ish grant and a per-download **desk code**; `GET /api/v1/download/<grant>` streams the file
(`Content-Type: application/vnd.microsoft.portable-executable`, `Range`/`HEAD` honoured, use budget 3, same-IP, cross-region
`410`). The bearer token never travels in a URL.

### 1.5 Reproducibility and verification

- Build with `cargo build --release --locked` so the dependency set is exactly `agent/Cargo.lock`.
- `node scripts/license-check.mjs` must pass: every top-level dependency (from `cargo metadata`, falling back to
  `agent/Cargo.lock`) and every Gradle dependency has a row in `docs/LICENSE-REGISTER.md`.
- A downloader can verify a file against the `sha256` in `manifest.json` and against the "Signed by IndiansAssist" / unsigned
  line the join page prints from `manifest.signed`.

### 1.6 Phase D installed agent MSI (contracts `docs/specs/phase-d-contracts.md` sections 11.3, 12)

The installed agent ships as one signed MSI per architecture (`x64`, `arm64`), built with **WiX Toolset v5**. WiX runs as a
.NET global tool (`dotnet tool install --global wix --version 5.0.2`). It is MS-RL and a build tool only, never shipped; see
`docs/LICENSE-REGISTER.md`. The authoring and the scripts live in `packaging/windows/`; `packaging/README.md` covers what
the package does and the GPO, Intune and MST deployment paths.

CI order (the install manifest and the MSI must cover **signed** bytes):

1. `cargo build --release --locked --target <triple>` for `ia-service`, `ia-desktop` (the C agent with the section 4.3
   seams, renamed) and `ia-watchdog`, on both `-msvc` triples. Run the section 1.2 import-table and size gates on each exe.
   C section 10 self-delete is disabled in the P4 build.
2. Authenticode SHA-256 + timestamp on all three exes, with the same identity as section 1.3 (`IA_EXPECTED_SIGNER`
   compiled in). **As built:** `packaging/windows/build.mjs` does this itself through the signing seam (section 4)
   when `IA_SIGN_PFX` is set. It signs the **staged copies** of the three exes and of the custom-action DLL before
   it writes the install manifest and runs WiX, then signs the MSI after ICE validation. Steps 2 to 4 are then one
   command.
3. Build the MSI from the signed exes:
   `node packaging/windows/build.mjs --arch <x64|arm64> --service <ia-service.exe> --desktop <ia-desktop.exe> --watchdog <ia-watchdog.exe>`
   (`pnpm packaging:msi` finds them under `agent/target/<triple>/release/` by default). The script:
   - builds the custom-action DLL (`packaging/windows/ca`, static CRT, `cargo build --release --locked`);
   - writes `manifest.json` (sha256 per signed exe; the watchdog compares against it, section 10.1);
   - runs `wix build` and then **`wix msi validate`** (the full ICE suite; any ICE error fails the build);
   - records `build-info.json`.
4. Authenticode-sign the MSI (`signtool sign /fd SHA256 /tr <rfc3161> /td SHA256 ...`, or `AzureSignTool`), then
   `signtool verify /pa` it. Publish the MSI to `AGENT_MSI_DIST_DIR` on the region's api nodes with a `manifest.json`
   beside it: `{ "v": 1, "builds": [{ "arch": "x64", "version": "<v>", "size": <bytes>, "sha256": "<hex>", "signed": true,
   "minOs": "10.0.17763" }] }` (one row per arch; `platform` and `format` default to `windows` and `msi`). Take the size
   and sha256 of the **signed** MSI. **As built**, the build does this itself: `packaging/windows/out/dist/` holds the
   signed MSI and that `manifest.json`, with one row per arch, merged. Copy the folder to `AGENT_MSI_DIST_DIR`.
   `build-info.json` records the sha256 after signing and `signed`.
   From there the tokens page serves the branded download (section 13.4).
5. The org transform is created per enrollment config: by the api for the tokens page, or by an admin with
   `packaging/windows/tools/New-EnrollTransform.ps1`. It is not signed. It only sets Property rows (`IA_ENROLL`,
   branding) and the ARP icon, and the enroll config it carries is itself region-signed (section 12.3).

**Manual check before a release (Windows Sandbox or a throwaway VM, never a developer machine):**

- `msiexec /i <msi> IA_ENROLL=<dev config> /l*v install.log`. Confirm:
  - both services run as `LocalSystem`;
  - the "IndiansAssist Watchdog" task exists;
  - `enroll.iaconfig` is readable only by `SYSTEM`/`Administrators` (`icacls`) and is gone after the first service
    start;
  - `%ProgramData%\IndiansAssist` has the protected ACL and the system mandatory label;
  - `install.log` never contains the `IA_ENROLL` value.
- Repeat with the MST (`TRANSFORMS=`). The product name and ARP entry show the org.
- Upgrade over the previous MSI. The device identity, keys and `config.json` survive and the device stays online.
- `msiexec /x`. The fleet shows the device "Uninstalled" (`deregistered`). `%ProgramData%\IndiansAssist`, the task and
  `HKLM\SOFTWARE\IndiansAssist\Device` are gone.

Until the `ia-service` crate exists, `pnpm packaging:msi:placeholder` stands the Phase C agent in for the three exes. It
validates the authoring only. The result is named `...-placeholder.msi` and refuses to install (launch condition).

### 1.7 Linux installed agent: deb and rpm (Phase F sections 8.9 and 8.12)

One-time setup in the WSL build distro (user-level, the operator runs these once; no script installs anything): Zig
0.15.2 under `~/.local/zig`, `cargo install cargo-zigbuild --locked` (0.24.0), `cargo install cargo-deb --version 3.8.0
--locked`, `cargo install cargo-generate-rpm --version 0.21.1 --locked`; for the package checks
`sudo apt install --no-install-recommends rpm ansible-core ansible-lint`.

1. On Windows, with the region keys set (see the top of this document), run **`pnpm linux:pkg`**. It builds `ia-service`
   and `ia-desktop` at the **glibc 2.34** floor, gates both with `scripts/elf-check.mjs` (NEEDED within libc, libm and
   ld-linux; `GLIBC_` at most 2.34; at most 25 MiB), builds the packages and runs the read-only package checks. Add
   `--sandbox` to also install and purge the deb in the offline Ubuntu Base 22.04 sandbox (T1).
2. The result is in `packaging/linux/out/dist/`: `IndiansAssist-Agent-<v>-linux-x64.deb` and `.rpm`, a `.sha256` file for
   each, and `manifest.json` (one row per package, `platform: 'linux'`, `signed: false`). `out/build-info.json` records
   the elf-check results.
3. **Signed with the interim OpenPGP key** when `IA_GPG_HOME` is set (section 4; this supersedes W111's "unsigned").
   The rpm carries an embedded signature (`rpm -K`). Each package gets a detached `<package>.asc`. The dist folder
   gets `SHA256SUMS` and `SHA256SUMS.asc`. The rows say `signed: true`. Without a key the packages stay unsigned and
   the rows say `signed: false`. Either way the sha256 is still the check: it is in `manifest.json`, shown by the
   console's enroll dialog, and published in the `.sha256` files (`sha256sum -c`).
4. Copy everything in `packaging/linux/out/dist/` to `AGENT_MSI_DIST_DIR/linux/` on every api node of the region, then
   reload the api (`SIGHUP` or restart). The console's **Linux** tab then offers both packages.
5. Supported: x86-64 with glibc 2.34 or later, so **Ubuntu 22.04 or later, Debian 12, EL 9 (RHEL, Rocky, Alma) and
   Fedora**. The deb depends on `libc6 (>= 2.34)`, the rpm on `glibc >= 2.34`; systemd is recommended, not required.
   The unit runs unconfined: there is no SELinux or AppArmor policy module (section 8.13).
6. Manual checks before a release, on disposable real machines (never a developer machine), section 8.12 "Manual":
   - install on Ubuntu 22.04 or 24.04 with an Xorg session, and on EL 9 or Fedora with an Xorg session;
   - enroll with an enroll config from the console (`sudo install -D -m 0600 enroll.iaconfig
     /etc/indiansassist/enroll.iaconfig`, then install the package);
   - an unattended session with input on a real X server and window manager;
   - a locked session (the console shows "The Desk's screen is locked");
   - a Wayland session (no screen: chat, files and device actions only);
   - a reboot (the device comes back online);
   - the Ansible role (`packaging/linux/ansible/roles/indiansassist_agent/`) against the machine, twice (the second run
     changes nothing);
   - removal and purge (`apt purge` / `dnf remove`): the device shows as uninstalled and `/var/lib/indiansassist`,
     `/etc/indiansassist` and `/run/indiansassist` are gone.

### 1.8 Linux portable pair: the X11 agent and its Wayland portal companion (Phase F sections 9.5 and 9.6)

The Linux download is one archive holding two programs: the X11 agent and, beside it as `.ia-portal`, the portal
companion that shares the screen on Wayland through xdg-desktop-portal and PipeWire (view only, no control). The X11
agent embeds the companion's sha256 and hands over to it only when the hash matches, so **the companion is built
first**.

One-time setup in the WSL build distro: Zig and cargo-zigbuild as in section 1.7, and
`sudo apt install --no-install-recommends clang libclang-dev libpipewire-0.3-dev libspa-0.2-dev`.

1. On Windows, with the region keys set, run **`pnpm agent:release:linux --dist <AGENT_DIST_DIR>`** (without `--dist`
   it uses the `AGENT_DIST_DIR` environment variable, else `./data/agent-dist`). It:
   1. builds the portal companion (`--features portal`, linked against libpipewire with `--allow-shlib-undefined`,
      glibc 2.34 floor) and gates it: NEEDED within libc, libm, ld-linux and `libpipewire-0.3.so.0`; `GLIBC_` at most
      2.34; at most 25 MiB;
   2. builds the X11 agent with the companion's sha256 embedded (`IA_PORTAL_SHA256`) and gates it the same way without
      libpipewire, then checks the hash is really inside it;
   3. copies `IndiansAssist-linux-portal-x64-<v>` and `IndiansAssist-linux-x64-<v>` into the dist directory and
      replaces the Linux row of its `manifest.json` with one row carrying `companion: { sha256, size }`. Rows of other
      platforms are kept; `pnpm agent:manifest` keeps this row too.
   `packaging/linux/out/agent-release-info.json` records both elf-check results.
2. With `IA_GPG_HOME` set, both files get a detached `<file>.asc` (copied into the dist dir beside them), and the stage
   `packaging/linux/out/agent/` gets a signed `SHA256SUMS`. The Linux row then says `signed: true` (section 4).
   Without a key they stay unsigned. The join page prints the X11 agent's sha256 and the companion's on a second
   line either way. `--skip-build` gates, signs and publishes the pair already in the stage.
3. Copy the dist directory to every api node of the region and reload the api. If the companion file is missing or does
   not match its row, the api serves the X11 agent alone and logs why.
4. What a Desk needs: x86-64 with glibc 2.34 or later. On X11 nothing more. On Wayland, for screen sharing:
   **PipeWire 0.3 or later** (`libpipewire-0.3.so.0`) and **xdg-desktop-portal with ScreenCast version 1 or later** plus
   the desktop's portal backend (GNOME, KDE or wlroots). Without PipeWire the agent stays and says "Screen sharing on
   Wayland needs PipeWire, which was not found."; chat and files still work.
5. Manual checks before a release, on disposable real machines:
   - **GNOME on Wayland** (Ubuntu 22.04 or 24.04, or Fedora): download from the join page, extract, run. The agent
     hands over to `.ia-portal`; after the agent's own consent GNOME asks which screen to share, every session. The
     console shows video, Control is greyed with "This Desk cannot take remote control", chat and a file work.
     GNOME's **Stop sharing** makes the console say "The user stopped screen sharing"; cancelling GNOME's dialog
     gives the no-screen state. On exit both files and the archive are removed (or both kept with Keep).
   - **KDE Plasma on Wayland** (Fedora KDE or Kubuntu 24.04): the same, with KDE's portal dialog and its screencast
     indicator.
   - **An X11 session**: no hand-over; video and full control as before.
   - **Wayland without PipeWire** (or with the library removed in a throwaway VM): the honest message, no hand-over.

### 1.9 macOS: the portable app and the unattended PKG (Phase F section 17)

Built on a Mac with Xcode and its command-line tools, Rust (`aarch64-apple-darwin`) and the region keys set.

1. Portable app: `agent/scripts/macos-bundle.sh` writes `agent/target/macos/IndiansAssist.app`; then
   `agent/scripts/macos-zip.sh agent/target/macos/IndiansAssist.app IndiansAssist-macos-arm64-<v>.app.zip`. Copy the
   zip into `AGENT_DIST_DIR` and run `pnpm agent:manifest` (section 1.4), which adds the macOS row.
2. Unattended PKG: `agent/scripts/macos-pkg.sh` writes `agent/target/macos-pkg/IndiansAssist-Agent-<v>-macos-arm64.pkg`
   and `manifest.json`. Copy both into `AGENT_MSI_DIST_DIR/macos/` and reload the api; the console then shows a macOS
   tab. MDM admins also get `packaging/macos/IndiansAssist-PPPC.mobileconfig` (Accessibility pre-granted; Screen
   Recording can only be approved by a person, once per Mac).
3. **Release prerequisites the operator must supply** (section 17.1). Until all exist, every macOS artifact is signed
   ad hoc, its row says `signed: false`, and it must not be presented as signed:
   - an Apple Developer Program membership;
   - a **Developer ID Application** certificate (signs the app, `ia-service` and the worker app);
   - a **Developer ID Installer** certificate (signs the PKG);
   - notarization credentials for `notarytool` (an App Store Connect API key or an app-specific password, saved with
     `xcrun notarytool store-credentials <profile>`).
4. With them, the signing steps are: sign each binary and app with the Developer ID Application identity and the
   hardened runtime (`codesign --force --options runtime --timestamp --sign "Developer ID Application: <name> (<team>)"`)
   in place of the ad hoc `codesign --sign -` in `macos-bundle.sh` and `macos-pkg.sh` (the scripts sign ad hoc today;
   pass the identity there); sign the PKG with `productsign --sign "Developer ID Installer: <name> (<team>)"`; submit
   the zip and the PKG with `xcrun notarytool submit <file> --keychain-profile <profile> --wait`; staple with
   `xcrun stapler staple` (the app before zipping it, and the PKG); check with `spctl --assess -vv` and
   `pkgutil --check-signature`. Then mark the zip signed in `AGENT_DIST_DIR/manifest.signed.json` and set
   `"signed": true` in the macOS PKG row.
5. TCC grants follow the signing identity: after re-signing, grant Screen Recording and Accessibility again, then run
   the manual checks on a Mac that is not a developer machine: a real capture and a click with the grants, chat and a
   file, the PKG installing and enrolling, and its uninstall script (macOS unattended sessions are still an open item,
   section 15.10).

---

## 2. Self-hosted server releases

PRD section 7 requires **signed server releases, a minimal attack surface and documented hardening** (the ScreenConnect
self-hosted CVEs are the cautionary tale). The server ships as container images, not a Windows binary, so "signed" means signed
images and verifiable checksums rather than Authenticode.

### 2.1 Images

`infra/docker-compose.yml` runs `indiansassist/api`, `indiansassist/web` and `indiansassist/recorder`, tagged `${IA_VERSION}`.
Each release:

1. Builds each image reproducibly from a pinned base (`apps/api` and `apps/web` from the Node base; `services/recorder` from the
   `golang:1.27` build image into a distroless `static-debian12` runtime, as recorded in `docs/LICENSE-REGISTER.md`).
2. Produces a **SBOM** per image and a **`SHA256SUMS`** file over the published tarballs / digests.
3. **Signs** each image and its SBOM with [cosign](https://github.com/sigstore/cosign) (keyless or an org key), and publishes
   the signatures alongside the images. Self-hosters verify with `cosign verify` before deploying; the digest pinned in their
   compose `.env` (`IA_VERSION`) is what runs.

### 2.2 What travels with a release

- The pinned `IA_VERSION` digests, the `SHA256SUMS`, the cosign signatures and SBOMs.
- `infra/.env.example` (documents every required variable, including `AGENT_DIST_DIR`, `AGENT_MIN_VERSION`,
  `AGENT_ANDROID_APP_URL`, `TOKEN_SIGNING_KEY`).
- The per-region `assetlinks.json` (Android App Links) and the agent `AGENT_DIST_DIR` payload from section 1.4.
- `infra/HARDENING.md` (the documented hardening baseline) and `pnpm validate:infra` as the pre-deploy check.
- **Phase E upgrade step** (`docs/specs/phase-e-contracts.md` rule 12.2): before upgrading to a Phase E release, set
  `ORG_SECRETS_KEY` (`<keyId>:<64 hex>`) and `ORG_SECRETS_FP_KEY` (64 hex, generated once and never rotated) in `infra/.env`;
  a production node refuses to boot without them, and `AUTH_PROVIDER=oidc` (never functional) now refuses to boot too (W86).
  To rotate `ORG_SECRETS_KEY`, move the old value into `ORG_SECRETS_KEYS_PREVIOUS`, set a new key id, deploy, run
  `pnpm secrets:reseal` (or let values re-seal lazily) and drop the old key only once the re-seal reports none left under it.
- **Fleet data key rotation** (`docs/specs/phase-f-contracts.md` rule 3.1f; `FLEET_DATA_KEY` seals each enrolled device's
  `device.mac_enc` and keys its `mac_hash`):
  1. Generate a new 64-hex key (`openssl rand -hex 32`) and choose a new key id (1-16 characters of `A-Za-z0-9_-`).
  2. In `infra/.env`, move the current value into `FLEET_DATA_KEYS_PREVIOUS` as `<oldKeyId>:<old 64 hex>` (a comma list,
     open-only). A key set without a prefix has the id `k1`, so it moves as `k1:<old 64 hex>`.
  3. Set `FLEET_DATA_KEY=<newKeyId>:<new 64 hex>`. With any previous key the current one must name its id, and no
     previous entry may repeat it; the api refuses to boot otherwise (`config.ts`).
  4. Restart (deploy) every api node of the region. A MAC sealed under the old key still opens and is re-sealed under
     the new one the next time it is read.
  5. Run `pnpm secrets:reseal` with the same environment (`FLEET_DATA_KEY=<new> FLEET_DATA_KEYS_PREVIOUS=<old>`; a PGlite
     directory needs the api stopped first). It re-seals every `device.mac_enc` still under the old key, rewrites its
     `mac_hash`, prints one line per column and exits 1 if any value failed to open.
  6. Only when the `device.mac_enc` line reports `failed 0` and a second run re-seals nothing, remove the old entry
     from `FLEET_DATA_KEYS_PREVIOUS` and restart again. Removing it earlier leaves those devices' MACs unreadable
     (Wake-on-LAN stops for them until they check in again).
- **Token-signing key rotation keeps the retired public key** (`docs/specs/phase-e-contracts.md` rule 6.3d): the region's
  `TOKEN_SIGNING_KEY` also signs the data residency reports, which customers keep and verify offline with
  `node scripts/verify-residency.mjs <report.json> --keys <well-known.json>` (or `--fetch <origin>`). At a rotation, move the
  old key's public half (`TOKEN_SIGNING_KEY=<old> node scripts/signing-pubkey.mjs`) into `TOKEN_SIGNING_KEYS_PREVIOUS`, so
  `/.well-known/indiansassist.json` keeps listing it, and **never remove it from that list** for as long as signed residency
  reports must verify (at least 7 years by default). Removing it makes every report it signed fail with `unknown_kid`.

### 2.3 Server release gates (section 15.5)

Before cutting a server release the full gate set must be green:

- `pnpm --filter @indiansassist/shared typecheck test`, `--filter @indiansassist/db typecheck test` (migration `0005_phase_c`
  applies on PGlite and the new columns round-trip), `--filter @indiansassist/api typecheck test`,
  `--filter @indiansassist/web typecheck test build`.
- `pnpm smoke` (26/26), `pnpm smoke:p2`, `pnpm smoke:recorder` (12/12 + the P3 cases), `pnpm smoke:p3`.
- `services/recorder`: `go vet ./...` and `go test ./...`.
- `node scripts/license-check.mjs` and `pnpm validate:infra` green.

---

## 3. Quick checklist

**Windows agent:** `cargo build --release --locked` (both `-msvc`) → import-table gate → size `<= 25 MiB` → no stray DLL →
Authenticode + timestamp (`IA_EXPECTED_SIGNER`) → `WinVerifyTrust` self-check verified → lay out `AGENT_DIST_DIR` →
`node scripts/agent-manifest.mjs` (mark signed) → deploy to region nodes → set `AGENT_MIN_VERSION`.

**Installed agent MSI (Phase D):** release build of `ia-service`/`ia-desktop`/`ia-watchdog` (both `-msvc`) → gates →
Authenticode on all three → `node packaging/windows/build.mjs` (wix build + ICE validation, manifest of signed hashes) →
sign + verify the MSI → publish to `AGENT_MSI_DIST_DIR` → sandbox install/upgrade/uninstall check (section 1.6).

**Linux installed agent (section 1.7):** region keys in `WSLENV` → `pnpm linux:pkg` (`--sandbox` for T1) → copy
`packaging/linux/out/dist/*` to `AGENT_MSI_DIST_DIR/linux/` → reload the api → the Manual checks.

**Linux portable pair (section 1.8):** region keys set → `pnpm agent:release:linux --dist <AGENT_DIST_DIR>` (companion
first, then X11 with its hash; both elf-checked at 2.34) → deploy the dist dir → reload the api → GNOME, KDE, X11 and
no-PipeWire checks.

**macOS (section 1.9):** `macos-bundle.sh` + `macos-zip.sh` → `AGENT_DIST_DIR` + `pnpm agent:manifest`;
`macos-pkg.sh` → `AGENT_MSI_DIST_DIR/macos/`; Developer ID signing, `notarytool` and `stapler` once the certificates
exist, otherwise `signed: false`.

**Server:** build reproducible images → SBOM + `SHA256SUMS` → `cosign` sign → run the section 2.3 gates →
publish digests + signatures → self-hoster `cosign verify` and pins `IA_VERSION`.

**Signing (section 4):** set `IA_SIGN_PFX` + `IA_SIGN_PFX_PASSWORD_FILE` (Windows) and `IA_GPG_HOME` +
`IA_GPG_PASSPHRASE_FILE` (Linux) before the commands above → each script signs before it hashes → check with
`signtool verify /pa /v`, `Get-AuthenticodeSignature`, `packaging/sign/verify-linux.sh`. In CI: push a `v*` tag →
approve the `release-signing` environment → the GitHub Release has every file, `SHA256SUMS` and `SHA256SUMS.asc`.

---

## 4. Interim signing (self-signed and free keys) and verifiable CI

The project signs every artefact it builds **now** with keys it made itself, until the SignPath Foundation
certificate arrives. The signing is a seam (`packaging/sign/`): one switch moves Windows to SignPath (section 4.7).

### 4.1 What is signed, and how

| Artefact | Signature | Verified with |
|---|---|---|
| Portable Windows agent `IndiansAssist-windows-<arch>-<v>.exe` | Authenticode SHA-256, RFC 3161 timestamp (`http://timestamp.digicert.com`, free) | `signtool verify /pa /v`, `Get-AuthenticodeSignature` |
| MSI payload: `ia-service.exe`, `ia-desktop.exe`, `ia-watchdog.exe`, the custom-action DLL | the same, signed as staged copies **before** the install manifest hashes them and WiX packs them | the same |
| MSI `IndiansAssist-Agent-<v>-windows-<arch>.msi` | the same, after ICE validation | the same |
| deb | detached `<file>.asc` (OpenPGP, armored) | `gpg --verify` |
| rpm | embedded (`rpmsign --addsign`) and detached `<file>.asc` | `rpm -K`, `gpg --verify` |
| Linux portable pair (X11 agent and `.ia-portal`) | detached `<file>.asc` | `gpg --verify` |
| `SHA256SUMS` (Linux dist, the stage of the pair, the GitHub Release) | detached `SHA256SUMS.asc` | `gpg --verify`, `sha256sum -c` |
| Android release APK | APK signature v2 and v3 with the release keystore (section 4.5) | `apksigner verify --print-certs` |

A self-signed Authenticode signature does not chain to a root Windows trusts. `signtool verify /pa` therefore ends
with "terminated in a root certificate which is not trusted", and `Get-AuthenticodeSignature` reports
`UnknownError`. Both are expected. The signature still proves that the file is unchanged, and the thumbprint
identifies the key. **Nothing is ever added to a trusted store**, here or on a user's machine. `site/keys/README.md`
tells downloaders how to check a file without trusting the key.

The manifest rows say `signed: true` only for files that were really signed. The installer rows (deb, rpm, MSI) are
`installerBuildSchema` rows. The portable rows are `agentBuildSchema` rows (through `manifest.signed.json` for
Windows). **Both shared schemas are strict and have no `signature` field**, so none is written. By convention the
detached signature sits beside its file as `<file>.asc`. Adding a field would be a shared-schema change for a
contract revision.

### 4.2 Where the keys live

Everything private is in **`%USERPROFILE%\.indiansassist\signing\`**, made on 7 Nov 2026. Only the current Windows
user can read it (`icacls`, inheritance removed). Its `README.txt` lists every file. **Nothing there is ever
committed.** The root `.gitignore` refuses `*.pfx`, `*.p12`, `*.jks`, `*.keystore`, `*.key`, `*.pem`,
`*-secret.asc`, keyring files, `keystore.properties` and the password files anywhere in the tree.

| Key | Private part (in that folder) | Public part (in the repo) | Fingerprint |
|---|---|---|---|
| Windows: `CN=IndiansAssist (self-signed), O=IndiansAssist Project`, RSA 3072, SHA-256, Code Signing EKU, to 7 Nov 2029 | `indiansassist-windows-selfsigned.pfx` (AES-256), `pfx-password.txt` | `site/keys/indiansassist-windows-selfsigned.cer` | SHA-1 thumbprint `7BE7416FEF06EDA266EB2035987875E4256B09F0`; `.cer` SHA-256 `7871915d20a0a97902543964c1ca00222178df252e603efaa5aee5f313f7ddd5` |
| Linux: `IndiansAssist Release Signing (self-managed)` (no email), ed25519, to 6 Nov 2029 | `gnupg\` (a dedicated GNUPGHOME, never `~/.gnupg`), `gpg-passphrase.txt`, `indiansassist-release-signing-secret.asc`, `indiansassist-release-signing-revocation.asc` | `site/keys/indiansassist-release-signing.asc` | `43848FFFF2479CE0DE28CD4FC6E3E6E839D60661` |
| Android: `CN=IndiansAssist (self-managed), O=IndiansAssist Project`, RSA 3072, alias `indiansassist`, to 1 Nov 2051 | `indiansassist-android-release.p12`, `android-keystore-password.txt` | none (the APK carries the certificate) | certificate SHA-256 `2F:D7:47:C9:…:FB:9E:9B:5E` (in `site/keys/README.md`) |

The Windows certificate was created with `New-SelfSignedCertificate -Type CodeSigningCert` in
`Cert:\CurrentUser\My`. It was exported, then **removed from the store**, together with the copy Windows also placed
in `CurrentUser\CA`. It is in no certificate store on the build machine. `signtool` reads the PFX file directly.

**Back the folder up offline.** The Android keystore matters most: an installed app can only be updated by an APK
signed with the same key.

### 4.3 The signing seam (`packaging/sign/`)

| File | Role |
|---|---|
| `sign-lib.mjs` | the pure rules: the provider switch, the key checks, the `signtool` arguments, the `signed` rows, `SHA256SUMS`, the metadata check (tested in `scripts/test/signing.test.mjs`) |
| `sign-windows.mjs` | `signtool sign /fd SHA256 /f <pfx> /p <pw> /tr <tsa> /td SHA256` on `.exe`, `.dll`, `.msi`, then a `Get-AuthenticodeSignature` check (a signer and a timestamp, status `Valid` or the self-signed `UnknownError`); CLI `pnpm sign:windows [--require] [--verify] <files>` and `--verify-only` |
| `sign-linux.sh` / `sign-linux.mjs` | in WSL (from Windows) or with bash (Linux CI): `rpmsign --addsign` for rpms, then `gpg --armor --detach-sign` for every file, then `SHA256SUMS` and `SHA256SUMS.asc`; exit 3 = no key |
| `verify-linux.sh` | the downloader's check: a temporary GNUPGHOME and a temporary rpm database (`rpmkeys --dbpath … --define _keyringpath …`), `gpg --verify`, `sha256sum -c`, `rpm -K` |
| `rehash.mjs` | re-measures a dist `manifest.json` after an outside signer (SignPath) changed a file |

The release paths that call it: `pnpm agent:release:windows`, `pnpm packaging:msi` (`packaging/windows/build.mjs`),
`pnpm linux:pkg` (`packaging/linux/build.mjs`, which signs **before** it hashes, because the rpm signature changes
its bytes) and `pnpm agent:release:linux` (`packaging/linux/agent-release.mjs`). Each one prints "not signed (why)"
and writes `signed: false` when the keys are absent. It never fails a dev build for that.
`agent:release:windows --require-signed` and `sign:windows --require` make missing keys an error, as CI does.

Environment (the keys are never arguments or files in the repo):

| Variable | Meaning |
|---|---|
| `IA_SIGNING_PROVIDER` | `selfsigned` (default) or `signpath`; `IA_SIGNING_PROVIDER_WINDOWS` / `_LINUX` override it per platform; anything else is an error |
| `IA_SIGN_PFX`, `IA_SIGN_PFX_PASSWORD` or `IA_SIGN_PFX_PASSWORD_FILE` | the Windows PFX and its password |
| `IA_SIGN_TIMESTAMP_URL`, `IA_SIGNTOOL` | another RFC 3161 TSA; an explicit `signtool.exe` (default: the newest Windows Kits 10 x64 one) |
| `IA_GPG_HOME`, `IA_GPG_KEY`, `IA_GPG_PASSPHRASE_FILE` or `IA_GPG_PASSPHRASE` | the GNUPGHOME holding the key (from Windows it is translated into WSL through `WSLENV`), its fingerprint (default: the only secret key there), the passphrase |
| `IA_REQUIRE_VERSIONINFO=1` | a missing version resource fails the build (section 4.4); CI sets it |

A local signed release on the build machine:

```powershell
$s = "$env:USERPROFILE\.indiansassist\signing"
$env:IA_SIGN_PFX = "$s\indiansassist-windows-selfsigned.pfx"; $env:IA_SIGN_PFX_PASSWORD_FILE = "$s\pfx-password.txt"
$env:IA_GPG_HOME = "$s\gnupg"; $env:IA_GPG_PASSPHRASE_FILE = "$s\gpg-passphrase.txt"
pnpm agent:release:windows --dist <AGENT_DIST_DIR>; pnpm packaging:msi; pnpm linux:pkg; pnpm agent:release:linux --dist <AGENT_DIST_DIR>
```

`packaging/linux/check-wsl.sh` queries the rpm with `--nosignature`, because its empty temporary rpm database holds
no key. The signature itself is checked by `verify-linux.sh`.

### 4.4 Windows file metadata

Every release PE carries a VERSIONINFO resource: `ProductName` "IndiansAssist", `CompanyName` "IndiansAssist
Project", `FileVersion` and `ProductVersion` the release version (also `FILEVERSION a.b.c.0`), plus
`FileDescription`, `OriginalFilename` and `LegalCopyright`. Before this change none of the exes had one.
`agent/build-support/versioninfo.rs` is `include!`d by the `build.rs` of `ia-agent`, `ia-desktop`, `ia-service`,
`ia-watchdog` and the custom-action crate. It compiles the resource with the Windows SDK's `rc.exe` on `-msvc`
(`windres` on `-gnu`) and adds no crate dependency. On other targets it does nothing. The version is
`IA_RELEASE_VERSION` when it is set, else the crate version. The MSI build sets it, so the custom-action DLL (crate
0.1.0) carries the MSI's version. A missing `rc.exe` is a warning on a dev build and an error with
`IA_REQUIRE_VERSIONINFO=1`. The MSI build and `agent:release:windows` read the fields back and check them before
they sign.

The MSI has `Manufacturer` "IndiansAssist Project" (it was "IndiansAssist") and `ProductVersion` the release
version. **Its `ProductName` stays "IndiansAssist Agent"**: it is the name in Add/Remove Programs, and
`New-EnrollTransform.ps1` writes "IndiansAssist Agent - <org>" over it. The SignPath artifact configuration
therefore pins the MSI's product name to "IndiansAssist Agent" and the PE files' to "IndiansAssist".

### 4.5 Android

`apps/android/build.gradle.kts` has a `release` signing config. It reads `apps/android/keystore.properties`
(git-ignored; see `keystore.properties.example`) or `IA_ANDROID_KEYSTORE`, `IA_ANDROID_KEYSTORE_PASSWORD`,
`IA_ANDROID_KEY_ALIAS` (default `indiansassist`) and `IA_ANDROID_KEY_PASSWORD`. Without them the release APK is
built unsigned, as before. Debug builds keep the debug key. The release key's certificate SHA-256 above is the value
the per-region `assetlinks.json` needs in `sha256_cert_fingerprints` for App Links to verify.

### 4.6 The agent's self-check with a self-signed build (`IA_EXPECTED_SIGNER`)

Unchanged code, documented here:

- The self-check is `WinVerifyTrust` over the agent's own image (`ia-platform/src/trust.rs`). It verifies the
  **chain**. A self-signed signature therefore gives the verdict `untrusted` (`CERT_E_UNTRUSTEDROOT`,
  `0x800B0109`), not `trusted`.
- The user instance only logs that ("not validly signed (log-only in the user instance)") and **runs normally**, as
  it does unsigned.
- **Elevation of the portable agent** needs a trusted chain. The parent refuses to start the elevated child for any
  verdict other than `trusted` or `unsigned` (`image_mismatch`). The child refuses anything but `trusted` (an
  `unsigned` dev build is the exception). So a self-signed release build cannot elevate, which is the same outcome
  an unsigned release build already had in the child. Elevation works again with the SignPath certificate. **Sign
  only release copies, never `agent/target`:** a signed `dev` build would lose the dev elevation that an unsigned
  one has. The seam always signs copies.
- The installed agent (MSI) does not use `WinVerifyTrust`. Its service and watchdog compare sha256 against the
  install manifest, which hashes the signed bytes. It is unaffected.
- Compile `IA_EXPECTED_SIGNER="IndiansAssist (self-signed)"` into interim release builds; the release workflow
  does. The elevation card then names the right publisher. The subject compare is still not implemented (section 1.3).

### 4.7 Rotation, and the SignPath switch-over

**Rotate an interim key** before it expires (Windows and OpenPGP: November 2029) or at once if it is exposed:

1. Make the new key the way section 4.2 describes, in the same folder, beside the old one.
2. Replace the public file in `site/keys/` and the fingerprints in `site/keys/README.md` and in this section.
3. Update the repository secrets (section 4.8).
4. If the old OpenPGP key was exposed, publish its revocation certificate: remove the `:` in front of
   `-----BEGIN`, then `gpg --homedir <old gnupg> --import` it and publish the revoked public key in `site/keys/`.
   An exposed Windows PFX cannot be revoked (self-signed): publish the new thumbprint and say so in the release
   notes.
5. The Android key is never rotated casually. An app can move to a new key only through APK signature v3 key
   rotation (`apksigner rotate`), and only when you choose to.

**Switch Windows to SignPath** once the Foundation accepts the project:

1. In SignPath: create the project. Link it to this GitHub repository with the GitHub Actions connector (trusted
   build system), and create a signing policy that requires manual approval. Create two artifact configurations.
   `payload` covers the four PE files (`IndiansAssist.exe`, `ia-service.exe`, `ia-desktop.exe`, `ia-watchdog.exe`)
   with product name "IndiansAssist" and the release version. `msi` covers the MSI with product name "IndiansAssist
   Agent".
2. In GitHub: add the secret `SIGNPATH_API_TOKEN` and the variables `SIGNPATH_CONNECTOR_URL`,
   `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`. Then set the variable
   `IA_SIGNING_PROVIDER=signpath` and `IA_EXPECTED_SIGNER` to the new certificate's CN.
3. The stub steps in `.github/workflows/release.yml` then run
   `signpath/github-action-submit-signing-request` (pinned v3.0). First the payload, before WiX packs it. Then the
   MSI, followed by `packaging/sign/rehash.mjs --mark-signed`. **Check the step inputs against the action's README
   on the day**: they are written from v3.0 and have not run yet. Locally, `IA_SIGNING_PROVIDER=signpath` signs
   nothing. A file that already carries a trusted, timestamped signature is accepted as signed.
4. Linux keeps the OpenPGP key (`IA_SIGNING_PROVIDER_LINUX=selfsigned`, set in the workflow).
5. Replace the Windows rows of `site/keys/README.md` with the new certificate, and keep the old thumbprint listed for
   files already shipped.

### 4.8 Verifiable CI (`.github/workflows/`)

- **`ci.yml`** runs on every push and pull request. On ubuntu-24.04: `pnpm install --frozen-lockfile`, `build`,
  `typecheck`, `lint`, `test`, `test:scripts`. Rust on windows-latest: fmt, clippy `--all-features -D warnings`,
  tests, and the custom-action crate's tests. Rust on ubuntu-24.04: fmt, then clippy and tests with
  `agent/scripts/linux-env.sh`'s `FEATS`. The token is read-only.
- **`release.yml`** runs on a `v*` tag. The tag must equal the workspace version. Three jobs run in the
  **`release-signing` environment**. The owner must create that environment with required reviewers (Settings,
  Environments), so every release waits for a person's approval before any key is loaded:
  - `windows` (windows-latest): the x64 release build with `IA_REQUIRE_VERSIONINFO=1`, WiX 5.0.2, then
    `agent:release:windows --require-signed`, the MSI build and the verify step.
  - `linux` (ubuntu-24.04): Zig 0.15.2 (sha256-pinned), cargo-zigbuild 0.24.0, cargo-deb 3.8.0,
    cargo-generate-rpm 0.21.1 and the apt packages. Then `linux:pkg` (with its package checks),
    `agent:release:linux` and `verify-linux.sh`. The build scripts run bash directly on a Linux host.
  - `publish`: `SHA256SUMS` over every file, `SHA256SUMS.asc`, the public keys, and
    `gh release create --verify-tag`. Only this job has `contents: write`.
- Every action is pinned to a full commit SHA with its version in a comment: `actions/checkout` v7.0.1,
  `setup-node` v7.1.0, `cache` v6.1.0, `upload-artifact` v7.0.2, `download-artifact` v8.0.2, and SignPath's own
  action v3.0. pnpm comes through corepack (the `packageManager` pin) and Rust through the runner's rustup, so no
  third-party action runs. arm64 Windows and macOS are not in the release workflow yet.
- **Repository secrets** the owner adds: `IA_SIGN_PFX_BASE64` (`[Convert]::ToBase64String([IO.File]::ReadAllBytes(
  "<folder>\indiansassist-windows-selfsigned.pfx"))`), `IA_SIGN_PFX_PASSWORD` (`pfx-password.txt`),
  `IA_GPG_PRIVATE_KEY` (the whole of `indiansassist-release-signing-secret.asc`), `IA_GPG_PASSPHRASE`
  (`gpg-passphrase.txt`). Add them as environment secrets of `release-signing`, so only approved jobs can read them.
  **Variables:** `IA_TOKEN_PUBKEYS`, `IA_API_ORIGIN`, optionally `IA_EXPECTED_SIGNER` and `IA_SIGNING_PROVIDER`.
- Neither workflow has run yet. Both are checked as parsed YAML by `scripts/test/signing.test.mjs`. The first tag
  push is their first real run.

### 4.9 Verification record (7 Nov 2026, this build machine)

- Portable agent (release build with VERSIONINFO, `agent:release:windows`): signed and timestamped (DigiCert
  "Timestamp Responder 2026 1"). `signtool verify /pa /v` shows the signer `IndiansAssist (self-signed)` and the
  timestamp, then "root … not trusted" (exit 1, expected). `Get-AuthenticodeSignature` reports `UnknownError` with
  signer and timestamper. The manifest row says `signed: true`.
- MSI (`pnpm packaging:msi` with that build's exes): the three exes and the custom-action DLL were signed before
  hashing, ICE validation passed, and the MSI was signed and checked the same way. `out/dist/manifest.json` has
  `signed: true`. The MSI properties read back: ProductName "IndiansAssist Agent", Manufacturer "IndiansAssist
  Project", ProductVersion 0.3.0. Every PE reports ProductName, CompanyName, FileVersion and ProductVersion as
  section 4.4 says.
- `pnpm linux:pkg --skip-build`: the rpm was signed (embedded) and both packages got `.asc` files and a signed
  `SHA256SUMS`. 47 of 47 package checks passed. `verify-linux.sh` with the public key from `site/keys/` passed
  `gpg --verify` (both packages and `SHA256SUMS`), `sha256sum -c` and `rpm -K` against a temporary rpm database
  ("Header OpenPGP V4 EdDSA/SHA512 signature … OK"). One byte changed in each package made all five checks fail.
- `pnpm agent:release:linux --skip-build` on the staged pair of 5 Nov 2026: both elf-checks passed, both files got
  `.asc` files, the Linux row says `signed: true`, and `verify-linux.sh` passed `gpg --verify` and `sha256sum -c`.
- No certificate is left in any CurrentUser or LocalMachine store.
