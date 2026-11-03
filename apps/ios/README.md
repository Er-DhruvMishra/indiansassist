# apps/ios

The iOS app (Phase F contract section 17.4): **Get help** shares this iPhone's or iPad's screen, view only, through a
ReplayKit Broadcast Upload Extension; **Give help** opens the mobile Assist console in an in-app Safari view.

```
apps/ios/
  project.yml                 XcodeGen spec; generates IndiansAssist.xcodeproj (committed beside it)
  IndiansAssist/              the app (SwiftUI): Get help, Give help, Server, QR scan
  IndiansAssistBroadcast/     the broadcast extension: /signal + the Desk state machine (WebRTC media: pending)
  IndiansAssistKit/           Swift package, unit-tested on macOS and the simulator
    IASec                     the ia.sec handshake and frames (CryptoKit), checked against the shared vectors
    IASession                 the Desk state machine (view only), the signal frames, join input, the hand-off
```

## Building

```
~/.local/bin/xcodegen generate --spec apps/ios/project.yml    # after editing project.yml
cd apps/ios/IndiansAssistKit && swift test                     # the library tests (macOS)
xcodebuild test -scheme IndiansAssistKit-Package -destination 'platform=iOS Simulator,name=iPhone 16'
xcodebuild build -project apps/ios/IndiansAssist.xcodeproj -scheme IndiansAssist \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=
```

- **Simulator builds are signed ad hoc** (`CODE_SIGN_IDENTITY=-`, no team needed). Do not use `CODE_SIGNING_ALLOWED=NO`:
  it drops the entitlements, so the App Group container is missing and Get help cannot hand the code over (the app
  now says so instead of doing nothing). With ad hoc signing the whole Get help flow runs on the simulator up to the
  system broadcast button: code entry and validation, the consent sentence, the hand-off file, and its deletion on
  "Use another code".

- **XcodeGen 2.46.0** is a build tool, never shipped. It is installed per user under `~/.local/xcodegen` (sha256 of
  `xcodegen.zip` checked against the GitHub release), with `~/.local/bin/xcodegen` a small wrapper: XcodeGen finds its
  setting presets next to its real binary, so a symlink would generate a project with empty product names.
- When `xcode-select` points at the Command Line Tools, prefix the commands with
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- **Signing:** no paid identity is assumed (section 17.1). The simulator needs none; a device build needs a free
  development team set locally (never committed), and the App Group `group.com.indiansassist.ios` must exist for it.
- **Server addresses:** `IAApiOrigin` and `IAWebOrigin` in the app's Info.plist are set per operator build (a short
  code carries no region, and self-hosted origins differ); the app's Server sheet overrides them, for example a dev
  Mac on the same Wi-Fi.

## The join-code hand-off (binding)

The app is suspended while another app is shown, so the extension holds the session itself and starts from a
hand-off the app writes after its consent screen. The code follows the Phase C rule that a token never stays on disk
(the C section 2.4 sidecar is read once, overwritten and deleted):

- it is **one file** in the App Group container (`HandoffStore`, `join-handoff.json`), written atomically with
  `FileProtectionType.complete`, **never in UserDefaults**;
- the extension **reads it once and deletes it before it opens `/signal`**; a hand-off older than 10 minutes, from the
  future, or unreadable is deleted and ignored;
- the app **removes any leftover on launch and when the person picks "Use another code"**.

What flows back to the app is the session summary (`SessionNote`: the state, the technician's display name, chat
lines, received file names; never the code or a key). Chat is end-to-end encrypted in every other client (C section
1.3), so the summary gets the same care (`SessionNoteStore`):

- one file `session-note.json` in the App Group container, written with `FileProtectionType.complete` and
  **excluded from backup**, never in UserDefaults (an unencrypted plist that goes into backups);
- **overwritten at the start of each session**, so nothing of the last session remains;
- **deleted when the person dismisses the summary**, and at the next launch when it is **older than 24 hours**.

`HandoffTests` covers both files: read-once, expiry and launch cleanup of the hand-off; overwrite, dismissal and the
24-hour cleanup of the summary; backup exclusion; and neither ever reaching UserDefaults. UserDefaults holds only the
two server addresses.

## Testing limits

A broadcast cannot be driven end to end on the simulator (A5): the session logic is the unit-tested `IASession`, and a
real broadcast is a manual check on a device. Nothing in the tests touches the network beyond loopback.
