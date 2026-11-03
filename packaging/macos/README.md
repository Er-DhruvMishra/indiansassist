# packaging/macos

The macOS agent (Phase F contract section 17). Everything here is built on a Mac; nothing is installed on it.

```
packaging/macos/
  Info.plist.in                      the portable app's Info.plist (bundle id, the indiansassist:// URL type)
  launchd/com.indiansassist.agent.plist     unattended: the root LaunchDaemon (section 17.3)
  launchd/com.indiansassist.desktop.plist   unattended: the per-login LaunchAgent worker (Aqua only)
  IndiansAssist-PPPC.mobileconfig    MDM privacy-profile TEMPLATE (fill @TEAM_ID@ and two UUIDs)
agent/scripts/
  macos-bundle.sh [--dev] [--out d]  builds the agent and assembles IndiansAssist.app, signed ad hoc
  macos-zip.sh app out.zip [sidecar] the stored, deterministic zip (with a sidecar: a download stand-in)
```

## Building

```
agent/scripts/macos-bundle.sh                       # release bundle -> agent/target/macos/IndiansAssist.app
agent/scripts/macos-zip.sh agent/target/macos/IndiansAssist.app IndiansAssist-macos-arm64-0.3.0.app.zip
```

Requirements: Xcode (the scripts use `/Applications/Xcode.app` when `xcode-select` points at the Command Line
Tools; no `sudo xcode-select` is needed) and Rust for `aarch64-apple-darwin` (a user-level `rustup`; the scripts find
`~/.cargo/bin` when it is not on `PATH`). Intel Macs are a release item, not a gate (section 17.1).

## Signing

No paid Apple identity is assumed (section 17.1). Builds are signed ad hoc (`codesign -s -`) and are **not signed
for distribution**: Gatekeeper blocks them on another Mac unless the person right-clicks Open. A Developer ID
Application and Installer certificate, `notarytool` and stapling are release prerequisites (`docs/release.md`).

## Things a developer on a Mac will meet

- **Screen Recording and Accessibility (TCC).** Grants attach to the code-signing identity. An ad hoc identity
  changes with every build, so after rebuilding, the person grants both again in System Settings → Privacy &
  Security. The consent window shows the two steps with "Ask macOS", "Open System Settings" and "Check again".
  Automated runs never touch TCC (A1, A2): they use `--synthetic-capture --no-self-delete`.
- **The application firewall.** With the macOS firewall on, a freshly built unsigned binary that receives
  network traffic triggers "Do you want the application to accept incoming network connections?", and again after
  each rebuild. Dev and test runs set `IA_ICE_LOOPBACK=1` (dev builds only), which keeps WebRTC on 127.0.0.1, where
  the firewall does not filter, so no prompt is needed.
- **The deep link** arrives as a `GetURL` Apple Event, not as an argument; it works only for a bundle that Launch
  Services knows (opened once from Finder or with `open`).
- **Keep** copies the bundle to `~/Applications/IndiansAssist.app` (no administrator needed).
