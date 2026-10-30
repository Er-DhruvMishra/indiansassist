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
| `ia-ui` | the consent / pill / panel / self-defence view-model (pure, tested); egui/eframe rendering behind `gui` | view-model (egui behind `gui`) |
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
* `gui` (on `ia-ui`): egui/eframe/tray-icon rendering.
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

The dev build adds, beyond `--api-origin` / `--signal-url` / `--auto-consent <view|control|elevated>`:

* `--synthetic-capture` — use the generated-frame capturer instead of DXGI/GDI, so a session runs on a headless
  host (the Playwright `e2e:p3` and the loopback path).
* `--no-self-delete` — keep the binary on exit (the §10 self-delete decision is still computed and logged).
* `--stop-after <secs>` — once the session is live, Stop it after this many seconds (a deterministic end for an
  automated run). It also sizes the signaling wait budget so the run is not cut short before the technician accepts.

These feed the repo-root `pnpm e2e:p3` harness (`apps/web/e2e/package3.spec.ts` + `agent-harness.ts`), which signs
up a p3_portable org in a browser, mints a token and spawns this binary as the Desk. The harness is in place; the
assertions after the knock wait on the live serve loop below.

Against a local API (`pnpm --filter @indiansassist/api dev`, signaling at
`ws://localhost:4000/signal`):

```sh
./target/release/IndiansAssist.exe --code <12-digit> --api-origin http://localhost:4000
```

The agent resolves the token source (§2.1), opens the `/signal` socket as a native
Origin-less Desk, sends `desk.hello`, and knocks/polls. **The dev API has no P3 signaling
path yet**, so a `p3_portable` session cannot complete end to end: an unknown code returns
`token_not_found` and the agent reports the outcome and exits — the hello/knock/poll
exchange is what is exercised live. The consent window, the `ia.sec` handshake over the data
channel, the encrypted `ia.control` ops and the video tracks attach once a real
`session.created` arrives, and the two-peer media + crypto path is covered by the in-process
loopback test (below).

The default release build (no `dev`) is a GUI-subsystem exe with no console and no local
override switches; it is the shape CI signs and serves.

## Self-delete stub

The released stub is byte-identical per download and Authenticode-signed; the per-download
configuration rides on the **filename desk code** (§2.3) or the signed `.iaconfig` sidecar
(§2.4), never on appended trailer bytes (which would break the signature). The stub removes
itself on a clean exit: the user instance via a fixed-text `%TEMP%` cmd stub whose arguments
are allow-listed (`ia-platform::selfdelete`), the elevated child via
`MOVEFILE_DELAY_UNTIL_REBOOT` with no user-writable script (§10 D2/D3). The decision logic is
implemented and tested (`ia_agent::elevate`, `ia_platform::selfdelete`); the actual process
spawn / `MoveFileEx` wiring is the remaining self-delete work.

## What is implemented and what is still stubbed

**Built and exercised on this MSVC host (default `media` + `winapi` + `gui`):**
* `ia-core` in full, cross-checked on gnu. The live-session **decision logic** of §3-§10 is
  now here as pure, tested modules: the encrypted `ia.control` dispatch with level / monitor /
  clipboard / secure-desktop gating and the §5.1 error codes (`ctl`), the live consent state
  machine incl. the raise/lower rules and the "elevated process, lower level re-imposes UIPI"
  policy (`consent`), the `agent.stats` wire shape plus the §3.8 `control.input` (with the
  `monitorId` inference and the `input.text_burst` threshold) and `clipboard.sync` aggregators
  (`stats`), the "3 DDA failures in 5 s => GDI" fallback decision (`capture_decision`), the
  A §8.3 file chunk codec + the streaming receiver (name/size/hash validation, collision-free
  `(2)` naming) (`filexfer`), the §7.2 hand-over payload codec + §7.3 order of operations
  (`handover`), the §8.4 playbook run checks (pinned-hash re-check, elevation gate) + the
  stdin/cmd launch plan and `ranAs` (`playbook`), the §3.2/§3.5 teardown + Stop order + the
  §10 self-delete decision (`teardown`), and the `voice` capability flag that drops when no
  audio device is present (`types::windows_features`).
* `ia-agent`: CLI parsing with the dev switches (`cli`), token-source precedence
  (`tokensource`), the SDP codec table + `MediaEngine` registration (`codecs`), the `ia.sec`
  handshake **driver** (`sechs`), the VP8 encoder over prebuilt libvpx (`vp8`), the synthetic
  capture source (`capture`), the webrtc-rs peer with per-monitor VP8 tracks + the seven data
  channels + `a=max-message-size:131072` (`peer`), the data-channel handshake + sample pump
  (`channels`), the rustls `/signal` client with `desk.hello`/knock/poll (`signal`), the
  session orchestration (`session`), and the **control-serving seam** (`live::ControlServer`)
  that turns a decrypted `ia.control` frame into a `ctl.res` and drives the `InputSink` /
  `ClipboardBridge` traits, unit-tested with a mock sink.
* The `winapi` layer (DXGI/GDI capture scaffolding, monitor enumeration, `SendInput`
  injection + scancodes, registry protocol handler, known folders, `sys_lib`).
* The `gui` view-model and its egui rendering (consent window, pill, panel).
* Tests: all unit tests; the **two-peer webrtc loopback** (`tests/loopback.rs`
  `media_loopback`) — two real peers negotiate, complete the §1.3 handshake with matching
  SAS, and a **VP8 keyframe arrives at the receiving peer**; the **headless fake-Assist
  loopback** (same file) — over real `SecChannel`s the receiving party sends encrypted
  `ctl.req os.input` and asserts `ctl.res ok` at `control` / `not_allowed` at `view`, round-
  trips a chat message and its ack, offers a small file and asserts the saved name and bytes,
  runs a `playbook.run` against a pinned manifest entry and asserts `pb.output` / `pb.end`
  exit 0, and triggers Stop asserting the teardown order and the (dry-run) self-delete
  decision; Windows-only, skip-if-no-monitor tests for monitor enumeration and `SendInput`.

**Stubbed / not yet wired (needs the P3 API path, a display, or Phase D):**
* **The live I/O glue past `session.created`.** The decision logic above is implemented and
  tested; what still waits on the dev API's P3 signaling is the stitching: the egui consent-
  window / pill / panel **event loop**, the async webrtc data-channel **serve loop** that
  reads frames, opens them with the `SecChannel`, calls `live::ControlServer` per frame and
  the stats timer, and the real-OS ends of each action (`SendInput`, clipboard set/listen,
  monitor select, `agent.stats` emission). The handshake over the real `ia.sec` channel in a
  live session reuses `channels::run_handshake` (proven by the loopback).
* **Elevation**: the payload codec, the order of operations, the hand-over claim check and the
  self-delete decision are tested; the real `ShellExecuteExW(runas)`, the named-pipe transport
  and the `MOVEFILE_DELAY_UNTIL_REBOOT` / cmd-stub spawn stay behind `cfg(windows)` and are
  driven once the live session exists.
* **Voice**: the Opus encoder (`audiopus`) links and the capability flag is wired (off when no
  device), but the cpal duplex capture/render loop and the audio RTP track are not wired.
* **Capture**: the GDI fallback + enumeration are real and the DDA->GDI fallback *decision* is
  tested (`capture_decision`); the DXGI Desktop Duplication primary path and the SIMD
  `yuvutils-rs`/`fast_image_resize` conversion are still to come (the self-contained BT.601
  converter in `ia-capture-win::convert` is the oracle).
* **Playbooks / files**: the arg validation, hash re-check, launch plan, receiver and chunk
  codec are tested; the actual process spawn (stdin/cmd/job object) and the `.iapart`
  streaming-to-disk + Mark-of-the-Web wiring are the remaining platform work.
* H.264 (Media Foundation) and AV1 (`rav1e`, feature `av1`) encoders are not built in the
  default set; VP8/VP9 via libvpx are.

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
