# IndiansAssist Android host (`apps/android`)

The Android **Desk** (the phone being helped), Phase C contracts section 12. It joins a `p3_portable` token as a
native Desk (`desk.hello.client = { kind: 'native', os: 'android', ... }`), runs the same `/signal` protocol, the same
`ia.sec` handshake and encrypted channels as the Windows agent, and streams the screen through Google's libwebrtc.

Application id `com.indiansassist.desk`, min SDK 29, target/compile SDK 36, Kotlin, single Gradle module (this
directory is the root project and the app module).

## Build and test

Gradle is not installed globally; use the wrapper (Gradle 9.3.1, AGP 9.0.1 with built-in Kotlin). `ANDROID_HOME`
must point at the SDK (platform 36, build-tools 36+). JDK 17+ (the Android Studio JBR works).

| Command | What |
|---|---|
| `pnpm android:build` (repo root) or `./gradlew assembleDebug` | debug APK, `build/outputs/apk/debug/indiansassist-desk-debug.apk` |
| `pnpm android:test` or `./gradlew testDebugUnitTest` | JVM unit tests (68) |
| `./gradlew connectedDebugAndroidTest` | instrumented tests on a running emulator / device (`adb devices`) |
| `./gradlew assembleRelease` | R8-minified unsigned release APK (sign in CI) |
| `node tools/gen-phase-c-vectors.mjs` (from the repo root) | regenerates `packages/shared/test/fixtures/agent/sec-vectors.json` |

APK sizes (one universal APK: arm64-v8a, armeabi-v7a, x86_64, section 2.6): debug 45.9 MB, release (R8, unsigned)
32.4 MB. Almost all of it is the three libwebrtc native libraries.

Debug builds talk to the dev api at `http://10.0.2.2:4000` (the emulator's view of the host) and allow cleartext;
release builds only know the compiled region origins (`REGION_ORIGINS` in `build.gradle.kts`).

## Tests

JVM (`src/test`), all against `packages/shared/test/fixtures/agent/sec-vectors.json` where a vector exists:

| Suite | Covers |
|---|---|
| `SecVectorsTest` | section 1.3 with Tink: public keys, commit hashes, transcript, HKDF keys, SAS, confirm MACs; the full Desk state machine fed the vector Assist; two live handshakes; negative vectors (`commit`, `fingerprint`, `suite`, `key`, `mac`), ordering rules, 10 s timeout; the IETF XChaCha20-Poly1305 draft vector |
| `SecFrameTest` | every vector frame for all six label ids (nonce, AAD, frame bytes), replay / skip / tamper / wrong label / reserved flags, one SecChannel per label per generation, oversize |
| `HelpersParityTest` | ports checked against the TypeScript build: `canonicalJson`, `sanitiseFileName`, `normaliseTokenInput`, `isValidShortCode`, `fingerprintFromSdp`, `opIdFor`; link and deep-link grammar; `a=max-message-size` munging |
| `DeskMachineTest` | the Desk state machine: hello / knock / held / consent / active, re-sent `session.created`, Stop order (stop.sharing, teardown, then `session.end`), local end while the socket is down, native resume (stays `active`, rebuild on `ice.refresh`), lost `consent.ok`, `sec:<reason>` and `indicator_lost` endings, decline / revoke, view-only, fatal errors and terminal closes |
| `GestureMappingTest` | tap, 600 ms long press, double tap, scroll notch rule (10 % of the shorter side, max 5, inverted), drag continuation at 20 Hz, 55 s lift-and-replace, 2 s dangling stroke |
| `ControlDispatcherTest` | capability flags (section 12.4), `not_supported` for absent features, strict args (`bad_args`), levels and InputGuard, `secure_window` / own-window refusal, text insertion and audit, `busy`, quality, `level.request` |
| `InputRulesTest` | `os.text` insertion splicing (`hel` + `lo` = `hello`), Backspace / Delete by code point, the InputGuard state table, dispatch windows, token bucket |
| `WireAndFilesTest` | kotlinx.serialization round-trip of `desk.hello.client`, re-encoding of `packages/shared/test/fixtures/agent` JSON when present, ICE server parsing, attestation outbox (4/s, burst 15, never drops, re-queue on `rate_limited`), `control.input` / `input.text_burst`, the file receiver (F4 rules, passive-risk `bad_name`, 2 GiB cap, hash mismatch) |
| `BackoffTest` | reconnect backoff and terminal close codes |

Instrumented (`src/androidTest`, last run on the `Pixel7_API35` emulator: 3 passed, 1 skipped):

| Test | Covers |
|---|---|
| `PromptGuardTest` | a tap inside a dispatched-gesture window cannot accept a file; a physical tap can; InputGuard is closed while a prompt is in front |
| `IndicatorTest` | without the indicator notification **Share my screen** is unusable; `indicator_lost` ends the session (revoking `POST_NOTIFICATIONS` kills the process under test, so the unusable state is forced through `Indicator.testOverride`) |
| `EmulatorSmokeTest` | the section 15.3 end-to-end smoke; skipped unless `IA_EMULATOR=1` and `IA_TOKEN` are set |

### Running the emulator smoke

Needs an api with the Phase C P3 support (native `desk.hello`, `desk.consent.native`) and something that accepts the
knock and answers the offer (the web console, or the Node fake Assist of `scripts/smoke-p3.mjs` once it exists):

```sh
emulator -avd Pixel7_API35 -no-window -no-audio &      # boots in about 70 s here
pnpm dev                                                # api on :4000, reachable from the emulator at 10.0.2.2:4000
# create a p3_portable token in the dashboard, start the accepting Assist, then:
IA_EMULATOR=1 IA_TOKEN=<compact token or 12-digit code> ./gradlew connectedDebugAndroidTest
```

The test opens `indiansassist://join?...`, ticks the checklist, grants the system MediaProjection dialog with
UiAutomator, and asserts `active`, captured frames and an established secure channel (6-digit SAS).

## Architecture

| Package | Role |
|---|---|
| `core` (pure Kotlin, JVM-tested) | `SecHandshake`, `SecFrame` / `SecChannel`, `CanonicalJson`, `DeskMachine`, `AgentControl` + `ControlDispatcher`, `GestureMapper` + `StrokeTracker`, `TextEditing`, `InputGuard`, `DispatchWindows`, `AttestOutbox`, `InputAudit`, `FileReceiver`, `JoinInput`, `Fingerprint`, `FileNames`, wire builders |
| `net` | `TokenResolver` (local Ed25519 check of compact tokens, Luhn, `public-lookup`, one `421` follow), `SignalSocket` (OkHttp, no `Origin`, backoff) |
| `rtc` | `RtcEngine` (factory, `ScreenCapturerAndroid`, muted mic), `AssistPeer` (seven channels, offer, `ia.sec`, encrypted channels, lifetime rule), `RecorderPeer` (A.2 N3 answerer) |
| `service` | `SessionService` (foreground service, `mediaProjection` + `microphone`), `DeskController` (machine effects, outbox, timers), `LiveMedia` (everything torn down by hard rule 2), `DeskAccessibilityService`, `Indicator` (notifications), `OverlayBar`, `DownloadsSink` / `FileSender` |
| `ui` | `MainActivity` (entry, waiting, in-session, receipt), `ConsentActivity`, `PromptActivity` |

Token entry: App Link `https://<web host>/join#t=` (verified by `/.well-known/assetlinks.json`, web/integration
stream), `indiansassist://join?t=|c=`, QR scan (zxing-android-embedded), manual paste. The clipboard is read only on
the **Paste** tap.

## Setup checklist and OEM caveats

Shown in the app where they apply; also here because section 12.4 asks for them in writing:

- **Notifications** must be allowed (Android 13+ `POST_NOTIFICATIONS`) and the "Screen sharing indicator" channel
  enabled, otherwise **Share my screen** stays disabled; turning them off mid-session ends it (`indicator_lost`).
- **Remote control** needs Settings > Accessibility > IndiansAssist remote control. Without it the technician can only
  watch. Turn it off after the session (the app posts a reminder; while it is on with no session a low-priority
  notification says so).
- **Display over other apps** is optional (the top bar with Stop and the security code).
- MIUI, EMUI, ColorOS and similar skins may kill foreground services: disable battery optimisation for IndiansAssist.
- Apps that set `FLAG_SECURE` (banking apps, some keyboards) block injected gestures: the console sees
  `secure_window`. They also show black in the capture.
- Android 14+ asks for the MediaProjection permission again for every capture.

## Deviations from the contract text

See the Phase C hand-off report; in short: Tink's nonce-taking XChaCha20-Poly1305 is in
`com.google.crypto.tink.aead.internal`, not `subtle`; consent and prompts are separate activities (the contract asks
for both "single-activity" and "a full activity before capture"); QR-scanned codes report `tokenSource: 'deeplink'`
(`TOKEN_SOURCES` has no `qr`); `a=max-message-size:131072` is set by SDP munging (no libwebrtc Java option); a
cancelled `dispatchGesture` is reported as `secure_window` (Android gives no cause).
