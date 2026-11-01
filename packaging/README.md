# packaging

Install packages for the Phase D installed agent (contracts `docs/specs/phase-d-contracts.md`, section 12).
Only Windows ships in Phase D. `linux/` (deb/rpm + Ansible) and `macos/` (PKG + MDM) are left empty for Phase E.

```
packaging/
  windows/
    IndiansAssist.wxs         the MSI (WiX v5): two services, scheduled task, custom actions
    watchdog-task.xml         the "IndiansAssist Watchdog" task (section 10.1)
    build.mjs                 builds and ICE-validates the MSI (never installs it)
    ca/                       ia-msi-ca: the custom-action DLL (Rust), embedded in the MSI
    tools/enroll-config.mjs   check, encode and decode the signed enroll.iaconfig / IA_ENROLL
    tools/New-EnrollTransform.ps1   writes the org's MST transform
```

## Building

```
dotnet tool install --global wix --version 5.0.2   # once; WiX is a build tool, never shipped
pnpm packaging:msi                # real build: needs ia-service.exe, ia-desktop.exe, ia-watchdog.exe
pnpm packaging:msi:placeholder    # until the service crate exists (see below)
pnpm packaging:test               # enroll-config tests (node) + custom-action tests (cargo)
```

The build writes `windows/out/<arch>/IndiansAssist-Agent-<version>-windows-<arch>.msi`, a `build-info.json` and
the staging folder. It runs `wix build`, then `wix msi validate` (the full ICE suite). Signing comes afterwards, in CI
(see `docs/release.md` section 3).

**Placeholder builds.** The `ia-service` crate (section 11.1) does not exist yet. `--placeholder` puts the Phase C agent
(`agent/target/release/IndiansAssist.exe`, from `pnpm agent:release`) in place of each missing exe. This exercises the
whole WiX authoring and the ICE validation. The package is named `...-placeholder.msi`, its product name says
"placeholder payload, not for deployment", and a launch condition stops it from installing.

## What the MSI does

| Step                           | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install                        | Per-machine install into `%ProgramFiles%\IndiansAssist\` (`ia-service.exe`, `ia-desktop.exe`, `ia-watchdog.exe`, `watchdog-task.xml`). The path is fixed and cannot be changed from the command line. Writes `%ProgramData%\IndiansAssist\manifest.json` (sha256 of the three signed exes).                                                                                                                                                                                         |
| Services                       | Installs `IndiansAssistAgent` and `IndiansAssistWatchdog` as `LocalSystem` auto-start services (not delayed) and starts them at the end of the install.                                                                                                                                                                                                                                                                                                                             |
| Custom action `IaApplyInstall` | Runs deferred as `LocalSystem`. Locks `%ProgramData%\IndiansAssist\` and `HKLM\SOFTWARE\IndiansAssist\Device` to `SYSTEM` + `Administrators` and sets the system mandatory label (sections 3.3 and 10.4). When `IA_ENROLL` is set, it writes `enroll.iaconfig` beside `ia-service.exe`, created with that restricted ACL. It also writes `config.json` (`apiOrigin`, `signalUrl`, `wakerOptOut`, `amtProxyOptOut`). A malformed `IA_ENROLL` fails the install with a logged reason. |
| Scheduled task                 | `schtasks /Create /XML` registers "IndiansAssist Watchdog" (LocalSystem, at startup and every 5 minutes).                                                                                                                                                                                                                                                                                                                                                                           |
| Enrollment                     | Never done by the installer. The service enrolls on first start, then shreds `enroll.iaconfig` (section 3.1).                                                                                                                                                                                                                                                                                                                                                                       |
| Upgrade                        | `MajorUpgrade` with `afterInstallExecute`. The device identity, keys and config under `%ProgramData%` stay; only the binaries and the manifest are replaced.                                                                                                                                                                                                                                                                                                                        |
| Uninstall                      | Stops both services. Runs `ia-service.exe --msi-uninstall` (signed deregister, best effort) and deletes the task. `IaWipeData` then overwrites and deletes the key blobs and the enroll config, and removes `%ProgramData%\IndiansAssist\` and the `Device` registry key. None of this runs when the old version is removed during an upgrade.                                                                                                                                      |

The installer never contacts a server.

## The enrollment carrier: signed `enroll.iaconfig` and `IA_ENROLL`

The signed `enroll.iaconfig` is the only thing that can enroll a device (sections 3.1 and 12.3). An org_admin gets it from
the tokens page, or from `GET /api/v1/devices/enroll-config?tokenId=&groupId=`:

```json
{ "v": 1, "apiOrigin": "https://in.example", "signalUrl": "wss://in.example/signal/device", "region": "in-mum",
  "token": "<enrollment compact token>", "groupId": "<uuid>" | null, "kid": "<16 hex>", "sig": "<base64url Ed25519>" }
```

The file is UTF-8 and at most 16384 bytes, and unknown keys are an error. `sig` is made with the region's token-signing key
over `canonicalJson(file minus sig)`. That signature binds the token, the region and the target group. `IA_ENROLL` is the
**base64url (no padding) of the file's bytes**:

```
node packaging/windows/tools/enroll-config.mjs check  enroll.iaconfig --pubkey <region key, base64url>
node packaging/windows/tools/enroll-config.mjs encode enroll.iaconfig      # prints the IA_ENROLL value
```

The custom action checks only the file's shape. It cannot check the signature, because the region public keys are compiled
into `ia-service`. The service verifies the signature before it enrolls, and the server verifies it again.

**Treat the config, the transform and any command line that carries `IA_ENROLL` as secrets.** Whoever holds one can
enroll devices into your org, up to the token's `maxDevices` and until it expires (7 days by default). The MSI marks
`IA_ENROLL` hidden, so the value never appears in an MSI log. The value is not saved in the registry. Two copies can stay on
a device:

- Windows Installer caches every applied transform under `%WINDIR%\Installer`. That cache is readable by administrators
  only.
- A GPO share holds the MST.

Both stop working once the token is used up, revoked or expired. For later waves, issue a new token and a new transform.

## Deployment paths (section 12.1)

One signed base MSI per architecture (`x64`, `arm64`) serves every org. The org-specific part is `IA_ENROLL`, either in a
transform or as a property.

### 1. Group Policy (MSI + MST)

1. Create the org transform from the base MSI and the signed config:
   ```powershell
   .\packaging\windows\tools\New-EnrollTransform.ps1 -Msi IndiansAssist-Agent-0.3.0-windows-x64.msi `
       -EnrollConfig .\enroll.iaconfig -OrgName "Acme Ltd" -LogoIco .\acme.ico -Out .\acme.mst
   ```
   The transform sets `IA_ENROLL`. It also sets the product name shown in the install UI and in Add/Remove Programs
   ("IndiansAssist Agent - Acme Ltd"), `ARPCONTACT` and, optionally, `ARPHELPLINK` and the ARP logo. With
   `-WakerOptOut` or `-AmtProxyOptOut` it sets the device opt-outs. It is validated against the package's UpgradeCode, so
   the same MST keeps working with later builds of the base MSI.
2. Copy the MSI and the MST to a share that **Domain Computers** can read. Restrict who else can read it, because the MST
   carries the token.
3. Open Group Policy Management, then Computer Configuration > Policies > Software Settings > Software installation,
   and choose New > Package. Pick the MSI by its UNC path and select **Advanced**. On the **Modifications** tab, add the
   MST. Use computer assignment, not user assignment.
4. The machines install at their next restart. One transform serves the whole rollout, because the token's `maxDevices`
   allows that many devices. The tokens page warns when `devicesEnrolled` nears `maxDevices` or the token nears expiry.

Startup-script alternative (no Software Installation):
`msiexec /i \\server\share\IndiansAssist-Agent-0.3.0-windows-x64.msi TRANSFORMS=\\server\share\acme.mst /qn /norestart`

### 2. Intune

1. Either upload the MSI directly as a **Line-of-business app**, or wrap it as a Win32 app with
   `IntuneWinAppUtil.exe -c <folder> -s IndiansAssist-Agent-0.3.0-windows-x64.msi -o <out>`.
2. Install command (Win32 app):
   `msiexec /i IndiansAssist-Agent-0.3.0-windows-x64.msi IA_ENROLL=<base64url signed enroll.iaconfig> /qn /norestart`
   For a line-of-business MSI, put `IA_ENROLL=<value>` in the app's command-line arguments.
   Uninstall command: `msiexec /x {ProductCode} /qn`.
   Detection: the MSI product code, or the `IndiansAssistAgent` service.
3. Install context **Device**. Assign the app to a device group.

The Intune portal shows the install command line to anyone who can read the app. Scope that role accordingly, and use a
token sized to the group.

### 3. Manual (pilots)

The org_admin downloads the branded MSI from the tokens or fleet page, which delivers it with the transform, and runs it
as an administrator. Command-line equivalent:
`msiexec /i IndiansAssist-Agent-0.3.0-windows-x64.msi TRANSFORMS=acme.mst`

### MSI properties

| Property               | Meaning                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `IA_ENROLL`            | base64url of the signed `enroll.iaconfig`. Hidden and secure. Required for a new device to enroll. On a repair or upgrade it is not needed. |
| `IA_WAKER_OPT_OUT`     | `1` or `0`: this device never acts as a LAN waker (rule 8.2d). Written into `config.json`.                                                  |
| `IA_AMT_PROXY_OPT_OUT` | `1` or `0`: this device never proxies AMT commands (rule 8.4b).                                                                             |

## What the service side provides (built)

The MSI expected these behaviours from `ia-service` / `ia-watchdog`. The service stream implemented them, and each one
is now a real entry point rather than a proposal:

| What the MSI does                                  | What the service provides                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| registers two SCM services                         | `ia-service.exe` and `ia-watchdog.exe` are SCM-aware (`windows-service`): `ia-service` handles `STOP`, `SHUTDOWN` and `SESSIONCHANGE`, `ia-watchdog` handles `STOP` and `SHUTDOWN`.                                                                                                                                                                       |
| runs `ia-service.exe --msi-uninstall` on uninstall | performs the signed deregister (`ia-dereg-v1`, section 7.2) with a 10 s timeout, then overwrites and deletes both key blobs. A server it cannot reach is logged, not retried: section 10.2's silent-past-grace rule still surfaces the device.                                                                                                            |
| registers the scheduled task                       | `ia-watchdog.exe --task` is the one-shot check (`ia_watchdog::decide`), and the watchdog re-registers the task itself if it disappears.                                                                                                                                                                                                                   |
| does **not** set the failure actions               | `ia-service` applies them to both services at start-up (`restart after 5 s / 10 s / 60 s`, section 4.1) through `ChangeServiceConfig2`, and also sets "restart on a non-zero exit".                                                                                                                                                                       |
| writes `%ProgramData%\IndiansAssist\manifest.json` | read by `ia_service::config::InstallManifest` in exactly the proposed shape, `{ v: 1, version, arch, placeholder, files: [{ name, size, sha256 }] }`, and compared against the installed binaries on every start and every hour (section 10.3). A mismatch records `binary_changed` and the service **refuses to spawn the worker** until it is repaired. |
| writes `config.json` without a `deviceId`          | `ia_service::config::ServiceConfig` treats that as un-enrolled and enrols on first start; it then writes `deviceId`, `keyId`, `region` and `orgId` back. It also re-checks the section 12.3 origin rules on load, so a config edited to point at another host is refused.                                                                                 |
| writes `enroll.iaconfig` beside the binary         | read, verified against the region keys compiled into `ia-service` (`IA_TOKEN_PUBKEYS`), sent verbatim, and **shredded only after a `201`** (section 3.1 step 5).                                                                                                                                                                                          |

Two notes for whoever builds the MSI next:

- **`watchdog-task.xml` must be installed beside the binaries.** The watchdog re-registers the task from
  `<install dir>\watchdog-task.xml` with `schtasks /Create /XML`, the same path the MSI uses.
- **The manifest should list the three exes.** Anything else it lists is integrity-checked too, which is fine, but a
  file that the installer legitimately rewrites would make every hourly check record `binary_changed`.
