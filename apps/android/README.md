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
| `pnpm android:test` or `./gradlew testDebugUnitTest` | JVM unit tests (72) |
| `./gradlew lintDebug` | Android lint (0 errors; 33 warnings, all i18n / KTX / dependency-version advice) |
| `./gradlew connectedDebugAndroidTest` | instrumented tests on a running emulator / device (`adb devices`); the live e2e skips here |
| `IA_EMULATOR=1 pnpm android:e2e` (repo root) | the live end-to-end test against a real api and the real web console, below |
| `./gradlew assembleRelease` | R8-minified unsigned release APK (sign in CI) |
| `node tools/gen-phase-c-vectors.mjs` (from the repo root) | regenerates `packages/shared/test/fixtures/agent/sec-vectors.json` |

APK sizes (one universal APK: arm64-v8a, armeabi-v7a, x86_64, section 2.6): debug 45.9 MB, release (R8, unsigned)
32.4 MB. Almost all of it is the three libwebrtc native libraries.

Debug builds talk to the dev api at `http://10.0.2.2:4000` (the emulator's view of the host) and allow cleartext;
`IA_DEV_API=<origin>` (env) or `-PiaDevApi=<origin>` at build time replaces that default and joins the debug origins
(the e2e builds with `http://localhost:4300` behind `adb reverse`; rebuild with `pnpm android:build` afterwards for the
plain dev APK). Release builds only know the compiled region origins (`REGION_ORIGINS` in `build.gradle.kts`). Debug
builds also log every `ia.control` outcome (`IA.ctl`: op, pointer kind, id, ok / error code, never coordinates or text)
and every `dispatchGesture` result (`IA.a11y`) for the e2e (`service/DevLog.kt`); release builds log neither.

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

Instrumented (`src/androidTest`):

| Test | Covers |
|---|---|
| `PromptGuardTest` | a tap inside a dispatched-gesture window cannot accept a file; a physical tap can; InputGuard is closed while a prompt is in front |
| `IndicatorTest` | without the indicator notification **Share my screen** is unusable; `indicator_lost` ends the session (revoking `POST_NOTIFICATIONS` kills the process under test, so the unusable state is forced through `Indicator.testOverride`) |
| `AssistE2ETest` | the device half of the live e2e (section 15.3, replaces the old `EmulatorSmokeTest`); skipped unless the runner gets `IA_EMULATOR=1` and `IA_TOKEN`, so `connectedDebugAndroidTest` reports it as skipped |

`PromptGuardTest` and `IndicatorTest` last passed on `Pixel7_API35` in the Phase C hand-off; the e2e pass of
31 Oct 2026 ran `AssistE2ETest` only (`am instrument -e class`), not those two.

### Live e2e (`pnpm android:e2e`)

`IA_EMULATOR=1 pnpm android:e2e` from the repo root (`tools/android-e2e.mjs`; without `IA_EMULATOR=1` it prints SKIP
and exits 0). Needs the Android SDK, the repo's `node_modules`, a built `packages/shared/dist`, and apps/web's
Playwright Chromium (`pnpm --filter @indiansassist/web e2e:install`). It:

1. starts the api on **4300** (metrics **9480**, a fresh PGlite under `data/e2e-android/run-*/`, `RATE_LIMIT_DISABLED`,
   `SIGNUP_PLAN_TIER=p3_portable`, log `data/android-api.log`) and Vite on **5273** (`VITE_API_URL` -> the api); it
   fails early when a port is busy (`IA_API_PORT`, `IA_METRICS_PORT`, `IA_WEB_PORT` move them);
2. uses the attached emulator / device, or boots `Pixel7_API35` headless (`-no-window -no-audio -gpu
   swiftshader_indirect`) and kills it afterwards (`IA_KEEP_EMULATOR=1` keeps it); builds the debug and androidTest
   APKs with `IA_DEV_API=http://localhost:4300` (`IA_SKIP_BUILD=1` skips), installs them, `pm clear`s the app, grants
   `POST_NOTIFICATIONS`, `RECORD_AUDIO` and `CAMERA`, allows `SYSTEM_ALERT_WINDOW` (appops), enables the Accessibility
   service (`settings put secure enabled_accessibility_services ...` and `accessibility_enabled 1`) and maps the api
   into the device with `adb reverse tcp:4300 tcp:4300` (the api's `signalUrl` is `ws://localhost:4300/signal`);
3. signs up a p3 org over REST, mints a `one_time` p3 token, opens an observing Assist `/signal` socket (plain `ws`)
   and the real technician console in Chromium (`tools/assist-driver.mjs`, which imports the `scripts/smoke/*`
   helpers), with `--disable-features=WebRtcHideLocalIpsWithMdns`: the emulator cannot resolve mDNS host candidates;
   with real host IPs its slirp NAT reaches Chromium and ICE pairs through a peer-reflexive candidate, no TURN needed;
4. runs `AssistE2ETest` with `am instrument` and drives the Assist half against its `IA_E2E` logcat progress lines;
   the driver signals the device by creating files in `/data/local/tmp/ia-e2e` (read through the instrumentation
   shell, because the app cannot read that directory);
5. prints PASS / FAIL / KNOWN per assertion and stops the api, Vite, the logcat reader and (if it booted it) the
   emulator; logcat, instrumentation output, the audit JSON and a console screenshot stay in `data/e2e-android/run-*`.

All assertions passed twice in a row on 31 Oct 2026 (`Pixel7_API35`, API 35, x86_64; about 100 to 120 s per run
with a warm Gradle, about 62 s of it on the device):

| Assertion | How |
|---|---|
| knock from the native Android Desk | the ws observer gets `assist.knock` with `userAgent` `IndiansAssist-Android/0.3.0 (Android 35; x86_64)` |
| Assist accepts | the console's knock toast **Accept** -> `/app/sessions/:id`; the observer sees `knock.closed { by: 'accepted' }` |
| consent screen names technician and org | UiAutomator reads "Asha Tech (Android E2E xxxxxx) wants to see this phone" |
| MediaProjection dialog | UiAutomator picks **Entire screen** in the spinner (default "A single app") and taps **Start** |
| active at `control` with frames | `SessionHub` phase `active`, level `control`, the `ScreenCapturerAndroid` frame counter > 0 |
| foreground notification | in-app `activeNotifications` (id 1, ongoing, "Sharing your screen with ...") and `dumpsys notification --noredact` |
| remote video | the console's `<video>` has `videoWidth > 0` (720 x 1600) |
| security code | the code read from the app screen (UiAutomator) equals the console header and is typed into the console's **Confirm the security code** dialog (`sec.verified`) |
| tap at `control` | after Home (input is refused while an IndiansAssist window is in front), a real mouse click on the console overlay: `IA.ctl` logs `ctl.res ok` for `os.pointer` down and up, `IA.a11y` logs `dispatchGesture` `stroke.begin` and `stroke.end` completed |
| chat both ways | console -> `SessionHub.chat`; a reply typed in the app's chat field -> the console's chat log |
| file Assist -> Android | 40 KiB through the console's file panel, **Save file** tapped in the prompt, `adb shell md5sum /sdcard/Download/IndiansAssist/<name>` equals the sent bytes |
| Stop from the app | **Stop sharing** -> device `ended`, sharing notification gone, console "Session ended", REST `state: ended` |
| audit chain | `GET /sessions/:id/audit` verified client-side with the shared hashing (`scripts/smoke/audit.mjs`), server integrity ok; `consent_granted { level: control, monitors: 1 }`, `sec.verified` for the confirmed code, `a11y.state` at start and end, desk and console `control.input` (mode `os`, `monitorId` 1), desk `file.received` |
| end reason `desk_stopped` | **KNOWN, not an Android defect**, below |

**Known console defect (apps/web; reported, not fixed here).** Contract hard rule 2 (A section 7.4) makes the Desk
close every data channel and its peer connection *before* it sends WS `session.end`. The console's `SecureHub`
(`apps/web/src/lib/secureHub.ts`, the channel `close` listener) treats any encrypted-channel close as `sec.fail
{ reason: 'channel' }`; `AgentControllerCore.onSecFailed` then posts `sec.failed` and sends `session.end { note:
'sec:channel' }`, which reaches the server first. A Desk **Stop** (and a Desk **Revoke consent**) is therefore chained
as `sec.failed` plus `session.ended { endReason: 'error' }` by the user instead of `desk_stopped`, and the console
says "Session ended: error". The `stop.sharing` / `consent.revoked` frame on `ia.ctrl` arrives just before the closes,
but the console only shows a notice for it. The e2e prints KNOWN only when the audit proves exactly that path
(`sec.failed { reason: 'channel' }` by the user after the device reached `ended`); any other end reason fails. The
Windows agent will meet the same race.

### Bugs the live e2e found (fixed)

- **Two consent screens.** `MainActivity` and `SessionService` both started `ConsentActivity`; after the user shared,
  the second instance stayed on top of the live session. Both prompt activities are now `singleTop`, and the consent
  screen finishes itself once the session leaves `consent_pending`.
- **Every injected tap was cancelled (`secure_window`).** A one-point stroke is drawn as a 0.5 px segment, and the
  continuation started at the tap point instead of that segment's end; `MotionEventInjector` cancels a continuation
  that does not start where the previous segment ended. The service now tracks the open stroke's end point and never
  sends a zero-length segment.
- **End-of-session attestations lost.** The outbox (the `control.input` aggregate and the closing `a11y.state`) was
  flushed only after the teardown, which is exactly when the console ends the session; it is now also flushed before
  the teardown (the closing `a11y.state` is queued once), so both `a11y.state` entries are chained.
- **Android 10 crash (lint `NewApi`, an error).** `Ui.scroll` called the API 30 `WindowInsets.getInsets`
  unconditionally under min SDK 29; Android 10 now uses the system-window insets.

Harness notes: `am instrument` force-stops the app, and a force stop removes its Accessibility service from the enabled
list; UiAutomation also suppresses other accessibility services by default. `AssistE2ETest` therefore uses
`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` and re-enables the service from the instrumentation shell until it binds.
The MediaProjection dialog cannot be pre-granted on API 34+ (no adb grant or appop exists for a normal app), so the
test drives it with UiAutomator.

## Architecture

| Package | Role |
|---|---|
| `core` (pure Kotlin, JVM-tested) | `SecHandshake`, `SecFrame` / `SecChannel`, `CanonicalJson`, `DeskMachine`, `AgentControl` + `ControlDispatcher`, `GestureMapper` + `StrokeTracker`, `TextEditing`, `InputGuard`, `DispatchWindows`, `AttestOutbox`, `InputAudit`, `FileReceiver`, `JoinInput`, `Fingerprint`, `FileNames`, wire builders |
| `net` | `TokenResolver` (local Ed25519 check of compact tokens, Luhn, `public-lookup`, one `421` follow), `SignalSocket` (OkHttp, no `Origin`, backoff) |
| `rtc` | `RtcEngine` (factory, `ScreenCapturerAndroid`, muted mic), `AssistPeer` (seven channels, offer, `ia.sec`, encrypted channels, lifetime rule), `RecorderPeer` (A.2 N3 answerer) |
| `service` | `SessionService` (foreground service, `mediaProjection` + `microphone`), `DeskController` (machine effects, outbox, timers), `LiveMedia` (everything torn down by hard rule 2), `DeskAccessibilityService`, `Indicator` (notifications), `OverlayBar`, `DownloadsSink` / `FileSender`, `DevLog` (debug-build diagnostics for the e2e) |
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
