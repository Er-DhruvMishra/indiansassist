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

This machine runs **only** the `x86_64-pc-windows-gnu` toolchain (rustup's self-contained
MinGW linker). It has **no MSVC build tools, no C compiler, no `nasm`, no `make`, no
`cmake`** — the bundled `x86_64-w64-mingw32-gcc.exe` is a *linker only* (it has no `cc1`),
and there is no `as.exe`.

Two consequences shape the whole workspace:

1. **The default build is pure Rust and green on gnu.** `cargo build` / `cargo test` /
   `cargo clippy` with no features touch no C and compile here. This is where every
   security-critical piece lives — the `ia.sec` X25519 + HKDF + XChaCha20-Poly1305
   handshake and frames, the token/sidecar/filename grammars, file sanitisation, playbook
   argument validation, the ABR controller and the state machine — fully implemented and
   unit-tested, plus a headless loopback integration test that runs the handshake and an
   encrypted `ia.control`/`ia.chat`/frame round-trip end to end in-process.

2. **Everything that needs a C toolchain is behind an off-by-default feature.**
   * `media` (on `ia-agent`): the `webrtc` crate (→ `ring`), libvpx, libopus, rustls, cpal —
     all need a C compiler + nasm. Built in CI on the msvc release targets.
   * `winapi` (on `ia-platform` / `ia-input-win` / `ia-capture-win`): the `windows` crate
     (prebuilt `windows-targets` import libs, no `dlltool`) — the real `SendInput`,
     DXGI/GDI capture, registry, known folders and `sys_lib` late-binding.
   * `gui` (on `ia-ui`): egui/eframe/tray-icon rendering.

### `getrandom` pin

`getrandom` ≥ 0.2.12 links the Windows CSPRNG via `raw-dylib`, which on the gnu toolchain
needs `dlltool` **and** `as`; this machine has neither. `ia-core` pins `getrandom = "=0.2.11"`,
which links `advapi32` the ordinary way against the bundled `libadvapi32.a`. CI on the msvc
targets has no such constraint.

### `dlltool` on PATH

The gnu toolchain's `dlltool.exe` lives in
`$(rustc --print sysroot)/lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained` and is not
on PATH by default here. Nothing in the default build needs it (the `getrandom` pin removes
the only `raw-dylib` user), but the root `agent:*` npm scripts add that directory to PATH so
a future `raw-dylib` dependency links without manual setup.

## Gates (run from `agent/`)

```sh
export PATH="$USERPROFILE/.cargo/bin:$(rustc --print sysroot)/lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained:$PATH"
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
```

or from the repo root: `pnpm agent:build`, `pnpm agent:test`, `pnpm agent:clippy`.

### CI (release, msvc)

CI adds the msvc targets and a full C toolchain + nasm, then builds the signed release:

```sh
cargo build --release --locked --features media \
  --target x86_64-pc-windows-msvc
cargo build --release --locked --features media \
  --target aarch64-pc-windows-msvc
```

followed by the import-table gate (§11.3: every load-time import must be a KnownDLL;
everything else goes through `ia_platform::sys_lib`), the ≤ 25 MiB size check, Authenticode
signing (Azure Trusted Signing / EV HSM), and the `WinVerifyTrust` self-check. `+crt-static`
is applied only in the release profile because it behaves differently on gnu (§11.3).
`docs/release.md` is the home for these CI-only steps.

## Running against `pnpm dev`

The runnable agent requires the `media` + `winapi` + `gui` features, hence a C toolchain —
it is produced by CI, not by this machine. With that build:

1. `pnpm dev` brings up `apps/api` (signaling at `ws://localhost:4000/signal`) and
   `apps/web`.
2. Create a `p3_portable` token in the dashboard and download the stub, or run
   `IndiansAssist.exe --code <12-digit>` / `--url indiansassist://join?t=<compact>`.
3. The agent resolves the token source (the default dev build prints which carrier won and
   exits), shows the consent window, and on **Share my screen** connects as a native Desk.

## Self-delete stub in CI

The released stub is byte-identical per download and Authenticode-signed; the per-download
configuration rides on the **filename desk code** (§2.3) or the signed `.iaconfig` sidecar
(§2.4), never on appended trailer bytes (which would break the signature). The stub removes
itself on a clean exit: the user instance via a fixed-text `%TEMP%` cmd stub whose arguments
are allow-listed (`ia-platform::selfdelete`), the elevated child via
`MOVEFILE_DELAY_UNTIL_REBOOT` with no user-writable script (§10 D2/D3).

## What is implemented here vs. CI

**Built and tested on the gnu dev machine (default features):** all of `ia-core`; the
pure logic of every other crate (scancode table, pointer mapping, BGRA→I420 converter,
canvas letterbox, UI view-model + self-defence gate, token-source precedence, elevation
flow, self-delete decision, SDP codec spec); the headless loopback test.

**Compiled by CI (feature-gated; needs a C toolchain / display):** the `windows`-crate
Win32 layer (`winapi`), the egui rendering (`gui`), and the webrtc-rs peer + libvpx/libopus
encoders + signaling (`media`), including the full two-peer DTLS-SRTP/SCTP variant of the
loopback test.

## Contract deviations (see also the final report)

* Cross-language parity: `crates/ia-core/tests/shared_vectors.rs` loads the shared fixtures in
  `packages/shared/test/fixtures/agent/` (`sec-vectors.json`, `agent-names.json`,
  `file-lists.json`), the same files the TypeScript and Kotlin tests load (§13.1, §15.1). The
  contract's per-topic fixture names (`file-names.json`, `playbook-args.json`, `abr.json`,
  `sdp-codecs.json`, `playbook-frames.json`) are not split out yet: file names live in
  `sec-vectors.json`, and the ABR, SDP-codec and playbook vectors are still this crate's own.
* `ia-capture-win`'s `winapi` path ships the GDI fallback capturer and monitor enumeration;
  the DXGI Desktop Duplication primary path (§4.1) and the SIMD `yuvutils-rs`/`fast_image_resize`
  conversion are the remaining capture work (the self-contained BT.601 converter is the
  oracle they are checked against).
* The `media` peer module is scaffolded (codec table, structure) but the full webrtc-rs wiring
  is CI-track work because it cannot build on this machine.
