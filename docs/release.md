# Signed-release process

How the shippable artifacts of IndiansAssist are built, signed and published: the **Windows portable agent** (`agent/`,
Phase C), the **installed agent MSI** (`packaging/windows/`, Phase D, section 1.6) and the **self-hosted server images** (`apps/api`, `apps/web`, `services/recorder`). This document describes the
CI steps; it does not implement them. It is the companion to the Phase C contract
(`docs/specs/phase-c-contracts.md`, sections 2.2, 2.6, 7, 11.3, 15.5) and to `infra/HARDENING.md`.

Two rules sit over everything below:

- The signed Windows `.exe` is **byte-identical for every download** (section 2.3): the per-download code travels in the
  file name or the signed `.iaconfig` sidecar, never inside the PE, so Authenticode stays valid and the file is cacheable
  and verifiable against `manifest.json`.
- The agent's `sha256` in `manifest.json` is computed by CI **after** signing (section 2.6), so the manifest generator runs
  on the already-signed artifacts, never before.

---

## 1. Windows portable agent

### 1.1 Build targets

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

Sign each release exe with **Authenticode SHA-256 and an RFC-3161 timestamp**, using one of:

- **Azure Trusted Signing** via `AzureSignTool` (MIT), or
- an **EV code-signing certificate on an HSM** via `signtool.exe`.

The signing identity's subject (the certificate's CN) is **compiled into the agent** as `IA_EXPECTED_SIGNER`. A self-hoster
compiles their own `IA_EXPECTED_SIGNER` and signs with their own certificate, so the configured signer is always the expected
one for that build.

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

1. Lay the signed files out under `AGENT_DIST_DIR` with their canonical names:
   `IndiansAssist-windows-x64-<version>.exe`, `IndiansAssist-windows-arm64-<version>.exe`,
   and (from the Android pipeline, section 2) `IndiansAssist-android-universal-<version>.apk`.
2. Run **`node scripts/agent-manifest.mjs`** to write `AGENT_DIST_DIR/manifest.json`
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
   compiled in).
3. Build the MSI from the signed exes:
   `node packaging/windows/build.mjs --arch <x64|arm64> --service <ia-service.exe> --desktop <ia-desktop.exe> --watchdog <ia-watchdog.exe>`
   (`pnpm packaging:msi` finds them under `agent/target/<triple>/release/` by default). The script:
   - builds the custom-action DLL (`packaging/windows/ca`, static CRT, `cargo build --release --locked`);
   - writes `manifest.json` (sha256 per signed exe; the watchdog compares against it, section 10.1);
   - runs `wix build` and then **`wix msi validate`** (the full ICE suite; any ICE error fails the build);
   - records `build-info.json`.
4. Authenticode-sign the MSI (`signtool sign /fd SHA256 /tr <rfc3161> /td SHA256 ...`, or `AzureSignTool`), then
   `signtool verify /pa` it. Publish the MSI and its sha256 to `AGENT_MSI_DIST_DIR` on the region's api nodes. From there
   the tokens page serves the branded download (section 13.4).
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

**Server:** build reproducible images → SBOM + `SHA256SUMS` → `cosign` sign → run the section 2.3 gates →
publish digests + signatures → self-hoster `cosign verify` and pins `IA_VERSION`.
