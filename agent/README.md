# IndiansAssist portable agent (`agent/`)

The Windows portable support client (Phase C, `docs/specs/phase-c-contracts.md`). A Rust
Cargo workspace that joins a `p3_portable` session as a native WebRTC Desk peer, shows the
consent window and the always-on-top indicator, captures monitors, injects OS-level input,
runs pinned playbooks, hands over to an elevated instance on request, and self-deletes on
exit.

## Workspace layout (contract §11.1)

| Crate | Owns | Default build |
|---|---|---|
| `ia-core` | protocol types, the `ia.sec` handshake + frame crypto, the session state machine, the ABR controller, token/sidecar/filename parsing, file sanitisation, playbook arg validation. **No platform or webrtc calls.** | pure Rust, fully built + tested |
| `ia-platform` | the platform traits (`Capturer`, `InputSink`, `ClipboardBridge`, `Elevation`, `SelfDelete`, `ProtocolHandler`, `KnownFolders`) + the `sys_lib` loader; self-delete stub safety, the HKCU protocol-handler value set and the pipe/mutex name derivation are pure and tested | traits + pure logic (Win32 behind `winapi`) |
| `ia-input-win` | the W3C-code→PS/2 scancode table and the virtual-desktop pointer mapping (pure, tested); `SendInput`/clipboard injection behind `winapi` | pure math (SendInput behind `winapi`) |
| `ia-capture-win` | recorder canvas / ladder letterbox math and the BGRA→I420 converter (pure, tested); DXGI/GDI capture + monitor enumeration behind `winapi` | pure math + converter (capture behind `winapi`) |
| `ia-ui` | the consent / pill / panel / self-defence view-model and the serve-loop bridge (pure, tested); the eframe app (consent window, pill, panel, ended view), tray, input hooks and Win32 window treatment behind `gui` | view-model + bridge (UI behind `gui`) |
| `ia-agent` | the binary: token-source precedence, the elevation hand-over flow, the self-delete decision, the SDP codec spec (all pure, tested); the webrtc-rs peer, encoders, signaling and UI behind `media` | orchestration logic (peer behind `media`) |

## Build environment — important

The build host now has **Visual Studio 2022 Build Tools (MSVC 14.44 + Windows SDK)** and
rustup's `stable-x86_64-pc-windows-msvc` is the default toolchain (`rust-toolchain.toml`).
The **whole workspace builds and links here**, including the `media` / `winapi` / `gui`
features — no separate CI machine is needed to compile the runnable agent.

* `nasm` and GNU `make` are **not** installed and are **not** needed: libvpx is taken as a
  **prebuilt** static library (see the libvpx note below), and libopus is built from source
  by `audiopus_sys` through the `cc` crate (MSVC discovers its own compiler).
* The library crates still build pure-Rust with **no features** on the gnu toolchain, so the
  security-critical core (`ia-core`: the `ia.sec` X25519 + HKDF + XChaCha20-Poly1305
  handshake and frames, the token/sidecar/filename grammars, file sanitisation, playbook
  argument validation, the ABR controller, the state machine) keeps a second-toolchain
  cross-check: `cargo +stable-x86_64-pc-windows-gnu test -p ia-core`.
* The **full `ia-agent` binary requires MSVC** — the prebuilt libvpx is MSVC-ABI only, so it
  cannot link under gnu. `ia-agent`'s default features are `media` + `winapi` + `gui`.

Features:
* `media` (on `ia-agent`): the `webrtc` crate (pinned `=0.17.1`, → `ring`), libvpx (VP8/VP9),
  libopus, rustls, cpal, the `/signal` client and the session orchestration.
* `winapi` (on `ia-platform` / `ia-input-win` / `ia-capture-win`): the `windows` crate — the
  real `SendInput`, DXGI/GDI capture, monitor enumeration, registry, known folders and
  `sys_lib` late-binding.
* `gui` (on `ia-ui`): egui/eframe (glow) + tray-icon + the Win32 window treatment and input hooks.
* `dev` (on `ia-agent`): the local-testing switches `--api-origin` / `--signal-url` /
  `--auto-consent` and `IA_CODEC_PREF`. A release build omits `dev`, so those switches do not
  exist in it (the §2.1 compile-time guarantee), and the exe is a GUI-subsystem app with no
  console. Build with `--features dev` for a console build you can drive from a terminal.

### libvpx (prebuilt) — §11.2 deviation

The contract named `env-libvpx-sys`/`vpx` with a vendored libvpx built by `nasm` + `make`.
This host has neither tool, so the workspace uses **`shiguredo_libvpx`** (Apache-2.0 wrapper;
libvpx v1.17.0, BSD-3-Clause), whose build script downloads a **prebuilt static** libvpx for
`x86_64-pc-windows-msvc` and links it — no nasm/make, no vendored source compile. It exposes
a safe VP8/VP9 encoder (`Encoder` / `EncoderConfig`), used by `ia_agent::vp8`. One libvpx
tuning the contract names, `VP8E_SET_SCREEN_CONTENT_MODE`, is not exposed by this wrapper;
the other screen-content settings (CBR, error-resilient, no look-ahead, high `cpu_used`,
bounded keyframe interval) are applied. Network is needed at **build** time to fetch the
prebuilt archive.

### `getrandom`

The earlier gnu-only `getrandom = "=0.2.11"` pin is **lifted** (it existed only for the gnu
`raw-dylib` linker gap). `getrandom` 0.2.17 builds on both the msvc host and the gnu
cross-check here.

## Gates (run from `agent/`)

```sh
export PATH="$USERPROFILE/.cargo/bin:$PATH"
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo build --release -p ia-agent        # default features; GUI-subsystem exe
```

The ia-core gnu cross-check (optional, second toolchain):

```sh
cargo +stable-x86_64-pc-windows-gnu test -p ia-core
```

### CI (release, msvc)

CI builds the signed release for both msvc targets:

```sh
cargo build --release --locked --target x86_64-pc-windows-msvc -p ia-agent
cargo build --release --locked --target aarch64-pc-windows-msvc -p ia-agent
```

followed by the import-table gate (§11.3: every load-time import must be a KnownDLL;
everything else goes through `ia_platform::sys_lib`), the ≤ 25 MiB size check, Authenticode
signing (Azure Trusted Signing / EV HSM), and the `WinVerifyTrust` self-check. `+crt-static`
is applied only in the release profile (§11.3). `docs/release.md` is the home for these
CI-only steps. (The `aarch64` prebuilt libvpx is a CI prerequisite; this host builds `x64`.)

## Running

Build a console (dev) exe you can drive from a terminal (also `pnpm agent:build:dev` from the repo root):

```sh
cargo build --release -p ia-agent --features dev
./target/release/IndiansAssist.exe --help
```

The dev build adds, beyond `--api-origin` / `--signal-url`:

* `--auto-consent <view|control|elevated>`: **headless mode**. No window is created at all; consent is granted at
  that level with every monitor (clipboard off), file offers that pass the checks are accepted, and an Assist
  `level.request` is granted. This is the `pnpm e2e:p3` path. Without it (and in every release build) the native
  consent window decides.
* `--synthetic-capture`: use the generated-frame capturer instead of DXGI/GDI, and a no-op input / clipboard sink, so
  a session runs on a headless host and no injected input reaches the real desktop (the e2e and loopback path).
* `--no-self-delete`: keep the binary on exit (the §10 self-delete decision is still computed and logged).
* `--stop-after <secs>`: once the session is live, Stop it after this many seconds (a deterministic end for an
  automated run). It also sizes the signaling wait budget so the run is not cut short before the technician accepts.
* Two environment switches compiled **only** into dev builds (feature `dev` -> `ia-ui/dev`), for verification runs on
  a host where nobody can click: `IA_DEV_SHOW_INDICATOR_IN_CAPTURE=1` skips `WDA_EXCLUDEFROMCAPTURE` on the pill /
  panel so they can be screenshotted, and `IA_DEV_UI_AUTOPILOT=1` lets the UI answer for the user: it ticks the
  privacy box and presses **Share** 2 s after the consent window opens, accepts a file prompt and allows a level
  request 2 s after they appear, closes the ended view after 3 s, and obeys technician chat lines
  `ia-autopilot: view|control|clipboard on|clipboard off|chat|panel|stop|revoke` by emitting exactly the event the
  corresponding button emits (it bypasses only the physical-press gate). Neither exists in a release build.

These feed the repo-root `pnpm e2e:p3` harness (`apps/web/e2e/package3.spec.ts` + `agent-harness.ts`), which signs
up a p3_portable org in a browser, mints a token and spawns this binary as the Desk, then drives the full live
surface (knock, consent, SAS, video, monitor picker, input, chat, file, playbook, stats, elevation, Stop) against
the serve loop below. A dev `stop` line on stdin (what `agent-harness.interrupt()` writes) is a deterministic Stop
trigger alongside SIGINT and `--stop-after`.

Against a local API (`pnpm --filter @indiansassist/api dev`, signaling at `ws://localhost:4000/signal`):

```sh
# Headless (no windows):
./target/release/IndiansAssist.exe --code <12-digit> --api-origin http://localhost:4000 --auto-consent control
# With the real consent window, pill, panel and tray (synthetic frames, no real input injection):
./target/release/IndiansAssist.exe --code <12-digit> --api-origin http://localhost:4000 --synthetic-capture --no-self-delete
```

The agent resolves the token source (§2.1), opens the `/signal` socket as a native Origin-less Desk, sends
`desk.hello`, knocks/polls (20 s budget headless, 30 min with the consent window), and once a `session.created`
arrives runs the **live serve loop** (`ia_agent::serve`). The default release build (no `dev`) is a GUI-subsystem exe
with no console and no local override switches; it always shows the consent window.

### Manual check of the windows (documented script)

On a desktop where you can click:

1. Start the API on 4100 and the web app (`PORT=4100 API_ORIGIN=http://localhost:4100 SIGNUP_PLAN_TIER=p3_portable
   pnpm --filter @indiansassist/api dev`, `VITE_API_URL=http://localhost:4100 pnpm --filter @indiansassist/web dev`),
   sign up at `http://localhost:5173/signup`, raise your seat to `p3_portable`, create a one-time p3 token.
2. Run the dev exe with the code and `--api-origin http://localhost:4100 --synthetic-capture --no-self-delete` (no
   `--auto-consent`). Accept the knock in the console.
3. The consent window (520 x 720 logical, always on top) shows the technician, org, "Connecting through
   localhost:4100", the dev-build yellow line, the monitor checkboxes, View only / View and control, the clipboard box
   (disabled under View only), the privacy box and a 3:00 countdown. **Share my screen** stays disabled until the
   privacy box is ticked; Escape, closing the window or the countdown = Decline (`desk.consent revoked`).
4. After Share the window becomes the pill (top-centre, 420 x 44, no taskbar button, never focused, invisible to
   screen capture): "Sharing with ..." / "Security code NNN NNN" (must equal the console's) / timer / level chip, red
   Stop. A green tray icon appears (right-click: Show, View only, Stop sharing, Quit). Clicking the pill opens the panel.
5. Send a file from the console: the panel opens with the prompt (name, type, declared MIME, size; executables get a
   red warning and a second **Accept anyway** click). Accept: the file lands in `Downloads\IndiansAssist\` with a
   `Zone.Identifier` stream (`ZoneId=3`). Decline or 60 s: `file.reject declined`.
6. In the panel choose **View only**: the console loses Control. Use the console's **Ask the user**: the panel shows
   the Allow / Refuse card (60 s). Allow: the console's Control button is enabled again.
7. Tick the clipboard box (at control) and copy text on the Desk: the console receives it; a pill toast says so.
8. Click **Stop** on the pill: the console shows "Session ended"; the window becomes the ended view with the receipt.

## Self-delete stub

The released stub is byte-identical per download and Authenticode-signed; the per-download
configuration rides on the **filename desk code** (§2.3) or the signed `.iaconfig` sidecar
(§2.4), never on appended trailer bytes (which would break the signature). The stub removes
itself on a clean exit: the user instance via a fixed-text `%TEMP%` cmd stub whose arguments
are allow-listed (`ia-platform::selfdelete`), the elevated child via
`MOVEFILE_DELAY_UNTIL_REBOOT` with no user-writable script (§10 D2/D3). The decision logic is
implemented and tested (`ia_agent::elevate`, `ia_platform::selfdelete`); the serve loop computes
and logs the decision on Stop and, for a user standalone instance that is not keeping the binary,
runs `serve::selfdel::perform_self_delete`: it first deletes `%LOCALAPPDATA%\IndiansAssist\`, the
`<exe>.iaconfig` sidecar and the HKCU `indiansassist` handler key in-process, checks that `%TEMP%`
canonicalises under `%USERPROFILE%`, creates `%TEMP%\ia-cleanup-<32 hex>.cmd` with `CREATE_NEW`, and
spawns `%SystemRoot%\System32\cmd.exe /c <stub> <pid> <exe>` with
`CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB`. **It is never run by an automated
test** (the e2e passes `--no-self-delete`); only the decision, the stub text, the `%TEMP%`-under-profile
check and the stub name are unit-tested. The elevated child's `MoveFileEx` path is Phase-D-adjacent work.

## What is implemented and what is still stubbed

**Built and exercised on this MSVC host (default `media` + `winapi` + `gui`):**
* `ia-core` in full, cross-checked on gnu. The live-session **decision logic** of §3-§10 as pure, tested modules:
  `ctl` (encrypted `ia.control` dispatch, level / monitor / clipboard / secure-desktop gating, §5.1 error codes),
  `consent` (raise / lower rules, "elevated process, lower level re-imposes UIPI"), `stats`, `capture_decision` (3 DDA
  failures in 5 s => GDI), `filexfer` (A §8.3 chunk codec + receiver in **buffered or streaming** mode; the final-name
  choice is case-insensitive like NTFS), `handover`, `playbook` (pinned-hash `check_run`, launch plan, the typed
  server-path `validate_playbook_args` **and** the agent-path `validate_canonical_playbook_args` mirroring the TS
  `{ canonical: true }` mode, `param_env` for `IA_PARAM_<NAME>`; `ManifestEntry` carries the pinned `parameters` and
  `timeoutSec`), `clipsync` (§5.6 C2: `ia1.*` token and Luhn 12-digit code redaction, 64 KiB truncation), `teardown`,
  and the `voice` capability flag. `IA_INJECT_TAG` lives in `ia_core::types` (re-exported by `ia-input-win`).
  `tests/shared_vectors.rs` also loads `playbook-args.json` (`canonicalCases`, `cmdCases`).
* **Consent window, pill, panel, tray (`ia-ui`, §3.3 / §3.5).** One eframe event loop (glow renderer; the unused wgpu
  backend was dropped) on its own thread (`with_any_thread`), driven from the serve loop over
  `ia_ui::bridge::{UiCommand, UiEvent}`. The root viewport is the consent window and morphs into the pill after Share;
  the panel is a second (immediate) viewport anchored under the pill (closes on Escape or blur unless a prompt is
  pending); the ended view shows the receipt lines. Win32 treatment (`ia_ui::winhelp`): the pill gets
  `WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` (no taskbar button), is docked top-centre of the primary monitor
  and re-docked if it leaves every monitor; pill and panel get `WDA_EXCLUDEFROMCAPTURE`; topmost / visibility are
  re-asserted every 2 s; `MB_ICONASTERISK` when the session goes active. The pill is never closable. Tray
  (`tray-icon`): amber / green states, a red recording dot and a shield mark; left click toggles the panel; menu Show /
  View only / Stop sharing / Quit. Self-defence (`ia_ui::guard`): `WH_MOUSE_LL` + `WH_KEYBOARD_LL` on a dedicated
  message-loop thread drop every `IA_1`-tagged event over (mouse) or while foreground (keyboard) an agent window and
  count it as refused; untagged presses over agent windows are recorded, and every **grant-direction** control (Accept
  a file, Allow control, raise to control, clipboard on, drag the pill) needs one within the last 3 s, failing closed
  if the hooks are not installed, while **safe-direction** controls (Decline, Refuse, Stop, Revoke, View only,
  clipboard off) are never gated. The §3.5 Windows test is the pure hook verdict
  (`tagged_click_on_the_panel_allow_button_is_dropped`); no real tagged `SendInput` is fired on the test host.
* **Serve loop** (`serve`): consent from the window (release) or `--auto-consent` (dev headless); `desk.consent granted`
  carries the monitors and clipboard the Desk chose; decline / Escape / close / deadline send `desk.consent revoked`.
  Live: `ctl.event monitors` / `agent_level`; the VP8 pump (DXGI with GDI fallback, or the synthetic source);
  `agent.stats` every 2 s with **measured** values (see the review-fix list below); chat both ways (technician lines appear in the panel and as a
  pill toast; the panel sends Desk lines as A §8.1 `chat`); `recording.state` / `session.recording` drive the pill's
  recording label; file offers are **prompted** in the panel (auto-accepted only headless) and streamed to disk
  (below); an Assist `level.request` from `view` is **prompted** (its `ctl.res` is deferred until Allow / Refuse / 60 s;
  Allow sends `desk.consent_level control requested` with the `opId`, Refuse / timeout answer `refused` / `timeout`
  and send `desk.event consent.level_refused`); the Desk can **lower** to View only (input stops being honoured before
  `desk.consent_level view` is sent) and raise back, and toggle the clipboard (`desk.consent_clipboard`); the
  **clipboard watcher** polls `WinClipboard` every 400 ms while the switch is on at `control`, redacts / truncates and
  sends `ctl.event clipboard`, with a pill toast; **Revoke** sends `consent.revoked` on `ia.ctrl`, tears down and sends
  `desk.consent revoked`; **Stop** (pill / panel / tray) sends `stop.sharing`, tears down (input refused, capture
  stopped, a running playbook's job killed, a partial file deleted, keys dropped, peer closed), sends `session.end`,
  then shows the ended view; if the indicator UI dies the session stops (no indicator, no sharing).
* **Playbooks (`pbrun`, §8.4 / §8.5).** The child is created `CREATE_SUSPENDED | CREATE_NO_WINDOW`, assigned to a job
  object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then resumed (Toolhelp thread resume), so timeout / cancel / exit
  kill the whole tree; `timeoutSec` is the pinned manifest value (clamped 1..900; a run op cannot extend it);
  `playbook.cancel` kills the job (`error: 'cancelled'`; `{ cancelled }` reflects whether that run was live); output
  is streamed as it arrives (<= 8192-byte chunks, at most one frame per 100 ms, pending text flushed after 200 ms,
  `seq` across both streams), capped at 1 MiB with `truncated: true` (the pipes keep draining); PowerShell output is
  switched to UTF-8 by the launch wrapper, cmd output is decoded from the OEM code page line by line
  (`MultiByteToWideChar` rather than `encoding_rs`); the environment drops any inherited `IA_PARAM_*` and adds the
  canonical `IA_PARAM_<NAME>` values; the cmd run file is created `CREATE_NEW` with a protected owner-only DACL
  (`D:P(A;;FA;;;<user SID>)`) in `%LOCALAPPDATA%\IndiansAssist\run\` (also the working dir) and deleted after the run;
  all §8.4 checks (pinned hash, `requiresElevation` pin, canonical args, one run at a time) now run **before** the
  `ctl.res`, which answers `hash_mismatch` / `elevation_required` / `bad_args` / `busy` / `not_allowed` instead of
  `accepted`; **never elevated**: a process whose token is elevated refuses non-elevation playbooks (`spawn_failed`)
  rather than run them as administrator. A `pb.end` error is now included in the `desk.event playbook.run` audit.
  Tests: `tests/playbooks.rs` against `tests/fixtures/playbook-catalogue.json` (read-only fixture scripts: params /
  stderr / exit code / cwd and no inherited `IA_PARAM_` leak, UTF-8 output, a 2 s timeout, cancel killing a sleeping
  grandchild, the output cap, the cmd run file's DACL while in flight and its deletion, `CREATE_NEW`).
* **File receive (`filerecv`, §6.1 F3).** Save folder `Downloads\IndiansAssist\` via `FOLDERID_Downloads`; stale
  `*.iapart` older than 24 h swept on first use; the final name is chosen first against the folder and in-flight
  transfers, then `<final>.<8 hex>.iapart` is created `CREATE_NEW`, each accepted chunk appended, and it is renamed on
  `file.done` + hash match with `MoveFileExW` **without** `REPLACE_EXISTING` (re-numbered if the name was taken
  meanwhile); the Mark-of-the-Web `Zone.Identifier` (`ZoneId=3`) is written; `\\?\` paths throughout; size / name /
  passive-risk / reserved-stem rules from `ia-core`; one transfer at a time (`busy`); a cancelled or failed transfer
  deletes its part file.
* **DXGI Desktop Duplication (`ia-capture-win::dxgi`, §4.1).** `CreateDXGIFactory1` / `D3D11CreateDevice` late-bound
  through `ia_platform::sys_lib`; per monitor the output is matched by device name, duplicated, copied to a staging
  texture and converted BGRA -> I420; a wait timeout re-sends the last frame; failures feed `DxgiHealth`, and a monitor
  that hits 3 failures in 5 s is captured with GDI for the rest of the session.
* `tests/loopback.rs` (two-peer media + handshake, encrypted control over real peers, fake-Assist control / chat / file
  / playbook / Stop) now runs the playbook through the real hardened runner and relays its `pb.output` over the
  encrypted channel, and adds a streaming `.iapart` -> final name + MOTW case. **`pnpm e2e:p3` passes** (16/16, twice,
  `E2E_API_PORT=4100`) in headless `--auto-consent control` mode.

**Verified with the real windows** (dev exe, API on 4100, a Playwright-driven console, `--synthetic-capture`): the host
workstation was **locked** during the run (LogonUI up, every screen capture black), so no click could be delivered and
nothing could be screenshotted. The windows were driven with `IA_DEV_UI_AUTOPILOT=1` and inspected with `EnumWindows` /
`GetWindowLongPtr` / `GetWindowDisplayAffinity`. Observed: consent window 668 x 947 physical (520 x 720 logical at
125 %), `TOPMOST`; with no answer the server's 180 s consent deadline ended the session and the agent exited cleanly;
after Share the pill at (697,8), 525 x 55 physical, `TOPMOST | TOOLWINDOW | NOACTIVATE`, display affinity `0x11`
(`WDA_EXCLUDEFROMCAPTURE`); the panel opened for the file prompt, `TOPMOST | TOOLWINDOW`, affinity `0x11`; hooks
installed; agent and console security codes equal; the file was prompted, accepted, saved with the right sha256 and
`ZoneId=3`; the Desk chat line reached the console; View only lowered the level; the console's **Ask the user**
produced the panel prompt and Allow re-enabled the console's Control button; Stop ended the session in the console, the
ended view appeared, then `session.end` and the self-delete decision. **Not verified with a physical mouse**: the
rendered pixels, physical clicks, dragging the pill, the tray icon and menu, and the physical-press gate in action.

**Phase C review fixes (data/phase-c-review, this pass):**
* **§1.3 step 9 (C1 / F7 / F8).** A frame that fails `SecChannel::open` (decrypt / replay / sequence / oversize) ends
  the session as `LiveOutcome::SecFailed`: `sec.fail { reason }` on `ia.sec`, WS `desk.event sec.failed
  { reason, channel }`, hard-rule-2 teardown, WS `session.end { note: 'sec:<reason>' }`. `on_message` / `on_close`
  are registered on all six encrypted channels **before** `sec.commit` (frames buffer on the inbound bus until keys
  exist); a channel close while the PC is alive or a remote `ondatachannel` on the Desk PC is `sec.fail channel`
  (fails are tagged with the key generation so a rebuild ignores the old PC's closes). Handshake / negotiation
  failures (timeout, fingerprint, received `sec.fail`, mac, no answer) emit the same `sec.failed` + `session.end`
  instead of the process exiting. Unit test: an injected tampered frame opens as `decrypt` and yields
  `note: 'sec:decrypt'`.
* **`ia.sec` driver (C14 / F15).** Constant-time fingerprint compare (`subtle`); reasons aligned with the contract
  table (unknown suite / `v` = `suite`, checked first; wrong sessionId / side, second hello, malformed frames, unknown
  `t` and an unknown received `sec.fail` reason = `commit`); the shared secret is `Zeroizing`; one 10 s budget from
  `ia.sec` open rather than per message.
* **ICE servers (F5).** `consent.ok.iceServers` (`urls` string or array, `username`, `credential`) becomes the
  `RTCConfiguration` of every PC the agent builds.
* **Rebuild (F2 / §3.7).** `assist.reconnected { state: 'active' }`, `ice.refresh`, or a peer connection
  `disconnected` for more than 8 s closes the PC, builds a fresh one (tracks + seven channels), re-offers
  `{ restart: true, gen: gen + 1 }` (the console accepts exactly `lastGen + 1`), re-runs the handshake under the new
  gen and restarts the pump; `failed` tears down with `sec:timeout`. Not exercised by the e2e.
* **Stats (F13 / C-06).** `agent.stats` every 2 s (`AGENT_STATS_INTERVAL_MS`) from a send-path meter: `sentKbps`,
  `sentFps` / `captureFps`, `encodeMs` and per-monitor fps are measured; `targetKbps` / `rung` / `floorMode` come from
  `ia_core::abr::AbrController` fed by REMB and receiver-report loss read from the RTP sender's RTCP (the REMB is
  raised to the loss-free delivered throughput of the interval, a measured lower bound: Chrome keeps a stale ~200 kbps
  REMB when transport-cc is negotiated and the sender never probes, which otherwise showed a false "Low bandwidth
  mode" at ~1 Mbps); `os.quality`
  sets the controller preset; `cpuPercent` and `recorderKbps` are `null` (not measured).
* **Desk reporter (F14).** `desk.event control.input` (+ `input.text_burst` above 200 chars) every 10 s when non-empty
  and once more before `session.end`; `desk.event file.received { fileId, direction, name, bytes, sha256 }` after a
  save; `ctl.event prompt` for the file and level prompt cards (`shown` / `answered`, the shared states).
* **`ctl.res` shape (found while running the e2e, pre-existing).** Every agent `ctl.res` lacked `ts` and a refusal
  carried `error: "<code>"`; the shared strict `controlResponseSchema` wants `ts` and `error: { code, message }`, so the
  console dropped every agent response (`[sec] dropped message on ia.control bad_payload`; the e2e passed only because
  its assertions read the agent log). `ia_core::ctl::{ok_response, error_response}` now build the exact shape and the
  serve loop uses them.
* **Playbook ids (C6).** `ctl::dispatch_playbook_run` refuses a `runId` that is not `^[0-9a-f]{32}$`, a non-UUID
  `playbookId` or a non-64-hex `bodyHash` with `bad_args` (cancel likewise checks `runId`); `pbrun` re-checks the
  lower-case hex `runId` before it becomes a path component.
* **Startup (C10, partial).** First statement of `main()`: `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)`
  + `SetDllDirectoryW("")`. A non-`dev` build has no `ws://localhost` default (it uses a compiled `IA_API_ORIGIN`,
  else an empty URL).
* **Elevation (F11 / C-03).** Until the runas relaunch exists, an **interactive** build answers
  `elevation.request` with `ctl.event elevation { state: 'failed', cause: 'policy' }` and `desk.event
  elevation.failed { error: 'uac_unavailable' }` and does **not** send `desk.elevation` (no hand-over that can never
  complete, no `handover_expired` chain). The **headless dev** path (`--auto-consent`, the e2e) still sends
  `desk.elevation`, so the existing `elevation.handover_minted` e2e assertion keeps covering the server mint.

**Stubbed / not yet wired:**
* **Server recorder (F12 / C-05)**: the agent does not answer `webrtc.offer { peer: 'recorder' }`; no second
  PeerConnection was wired this pass. The API side should exclude `p3_portable` from `needsRecorder` until it is.
* **ABR -> encoder**: the rung is computed and reported but not applied back to libvpx (the wrapper has no runtime
  bitrate / fps / size setter; the pump stays at 1200 kbps / 15 fps at native size). No TWCC estimator input.
* **C10 rest**: the late-bound system libraries are not all routed through `ia_platform::sys_lib`, there is no local
  `checkToken` against the region key before the first network call, and no WinVerifyTrust self-check.
* **Elevation**: the `ShellExecuteExW(runas)` relaunch, the named-pipe transport and the elevated child stay stubbed.
  The admin-instance playbook paths (limited linked token, `%ProgramData%` run dir with the high-integrity label) are
  not implemented; an elevated agent refuses non-elevation playbooks instead.
* **1.5 s pre-consent sleep** (headless only) is kept until the console reliably gets the level on resume /
  `session.created`; dropping it now would race the e2e console's `consent.changed` subscription.
* **Consent window extras**: no org logo (`logoData`), no "Screen capture is not available" Retry step before consent
  (capture starts after `consent.ok`), a generic region in the recording sentence, no §2.4 / §2.6 sidecar lines (only
  the dev-build line).
* **Panel extras**: no Keep-installed (D5) option, no "Send a file" (F5, `IFileOpenDialog`), no `IA_FILE_OFFER` send
  prompt from playbook output (§8.5 O1; the marker parser exists), no **Open folder** / sniffed-type display, no receipt
  JSON download (the ended view shows a text receipt only), no microphone button.
* **Desk -> Assist clipboard** is polled (400 ms, sequence-number debounce) rather than `AddClipboardFormatListener`;
  the `clipboard.sync` §3.8 aggregate is not reported.
* **Capture**: one monitor (the primary consented one) is streamed; DXGI is unverified on a live desktop (the locked
  host made the capture test fall back to GDI, which the test accepts); no dirty rects / cursor compositing, no SIMD
  `yuvutils-rs` / `fast_image_resize` path, capture runs on a runtime worker rather than a dedicated thread, and no
  `ctl.event capture` on a path change.
* **Voice**: the Opus encoder links and the capability flag is wired (off), but the cpal capture / render loop and the
  audio track are not wired.
* H.264 (Media Foundation) and AV1 (`rav1e`) encoders are not built; VP8 / VP9 via libvpx are.
* The release import-table gate has not been re-audited after adding eframe (glow) / tray-icon (a CI step).

## Contract deviations (see also the final report)

* **Prebuilt libvpx** via `shiguredo_libvpx` instead of a vendored `env-libvpx-sys`/`vpx`
  build (no nasm/make on this host); see the libvpx note above. `VP8E_SET_SCREEN_CONTENT_MODE`
  is not exposed by that wrapper.
* **webrtc-rs pinned to `=0.17.1`** — the last release with the classic
  `MediaEngine`/`interceptor`/`TrackLocalStaticSample` API this code targets; its sibling
  crates are pinned to the matching patch in `Cargo.lock`.
* Cross-language parity: `crates/ia-core/tests/shared_vectors.rs` loads the shared fixtures in
  `packages/shared/test/fixtures/agent/` (`sec-vectors.json`, `agent-names.json`,
  `file-lists.json`), the same files the TypeScript and Kotlin tests load (§13.1, §15.1). The
  contract's per-topic fixture names (`file-names.json`, `playbook-args.json`, `abr.json`,
  `sdp-codecs.json`, `playbook-frames.json`) are not split out yet: file names live in
  `sec-vectors.json`, and the ABR, SDP-codec and playbook vectors are still this crate's own.
