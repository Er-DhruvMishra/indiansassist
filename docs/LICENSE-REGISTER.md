# Licence register

Our code: source available (PRD section 15.5). Third party components we build on or run beside. Working agreement (contracts section 15): every new runtime dependency or Compose image is added here with its licence in the same change, and the register is reviewed at the end of every phase.

| Component | Licence | Use | Status |
|---|---|---|---|
| Fastify, @fastify/* | MIT | API server | in use (Phase A) |
| ws | MIT | WebSocket signaling | in use |
| Drizzle ORM | Apache-2.0 | DB access, migrations | in use |
| PGlite (@electric-sql/pglite) | Apache-2.0 | embedded Postgres for dev/test | in use |
| node-postgres (pg) | MIT | Postgres driver | in use |
| zod | MIT | validation | in use |
| @noble/ed25519, @noble/hashes | MIT | token signing, hashing | in use |
| @noble/curves 1.9.7, @noble/ciphers 1.3.0 | MIT | Phase C §1.3 `ia.sec` handshake (X25519) and XChaCha20-Poly1305 frames in `@indiansassist/shared` `agent/sec.ts` (console side) | in use (Phase C) |
| argon2 | MIT | password hashing | in use |
| React, react-dom, react-router, Vite, Tailwind CSS | MIT | Assist console (incl. client-side routing), Desk web room | in use |
| dotenv | BSD-2-Clause | loads `.env` into the API process in dev/self-host | in use (Phase A) |
| qrcode | MIT | renders the join-link QR on the P3 join page (§2.7) and the dashboard | in use (Phase C, web) |
| Playwright (@playwright/test) and the Chromium build it downloads | Apache-2.0 (Chromium: BSD-3-Clause) | Package 1 two-browser e2e (`apps/web/e2e`) and the Package 2 extension e2e (`apps/extension/test/e2e`, unpacked extension in a persistent Chromium context); dev only, not shipped | in use (dev) |
| coturn | BSD-3-Clause | STUN/TURN | self-hosted service |
| PostgreSQL | PostgreSQL Licence | database | self-hosted service |
| Valkey | BSD-3-Clause | presence / pub-sub (Redis compatible) | self-hosted service |
| Keycloak | Apache-2.0 | optional IdP a self-hoster may point an org at (Compose profile `sso`); the api is the OIDC relying party and SAML SP itself (Phase E W60), nothing of Keycloak is linked or required | optional self-hosted service, not a dependency |
| SeaweedFS | Apache-2.0 | object storage (Compose default, S3 gateway) | self-hosted service |
| Garage | AGPL-3.0 (run only as an unmodified separate process over its S3 API, nothing linked or copied) | object storage, optional alternative | self-hosted service, not the default |
| prom-client | Apache-2.0 | `/metrics` | in use (Phase A) |
| nginx | BSD-2-Clause | TLS termination, reverse proxy, static web | self-hosted service |
| ioredis | MIT | Valkey client (redis presence driver) | in use (Phase A, multi-node) |
| @aws-sdk/client-s3, @aws-sdk/s3-request-presigner | Apache-2.0 | s3 storage driver | in use (Phase A) |
| nodemailer 8 | MIT-0 | `smtp` driver of the consent-receipt mailer (`apps/api/src/mail`, Phase D rule 6.4d); the default `log` driver needs nothing | in use (Phase D, api) |
| OpenBao (or HashiCorp Vault) | MPL-2.0 (OpenBao; run only as an unmodified separate service over its HTTP API, nothing linked or copied; the api's client is plain `fetch`) | credential vault for AMT admin credentials and privileged-playbook secrets, read by the api only (Phase D rule 9.8, W37/W40) | self-hosted service, optional |
| rrweb 2.1.7 (exact pin) with rrweb-snapshot, rrdom, @rrweb/types, @rrweb/utils, mitt, @xstate/fsm, base64-arraybuffer | MIT (all) | P2 DOM mirroring: replay in the Assist console's replayer frame (`apps/web`); `record()` in the extension capture script (`apps/extension`, bundled into `content.js`) | in use (Phase B, web and extension) |
| @types/chrome 0.3.4 (+ @types/har-format) | MIT | extension API typings (`apps/extension`, dev only, not shipped) | in use (dev, Phase B) |
| eslint-plugin-no-unsanitized 4.1.5 | MPL-2.0 (unmodified dev tool, nothing copied into our code, not shipped) | bans `innerHTML` and friends in `apps/extension` (section 12.1) | in use (dev, Phase B) |
| pion/webrtc v4 (with pion/ice, interceptor, rtcp, rtp, dtls, srtp, sctp, sdp, stun, turn, transport, mdns, logging, randutil, datachannel) | MIT | server-side recorder (`services/recorder`): receive-only peer connection, RTP depacketising, NACK / PLI | in use (Phase A.2) |
| at-wat/ebml-go | Apache-2.0 | server-side recorder: incremental WebM (Matroska) writer | in use (Phase A.2) |
| gorilla/websocket | BSD-2-Clause | server-side recorder: `/signal` client | in use (Phase A.2) |
| prometheus/client_golang (+ client_model, common, procfs; beorn7/perks, cespare/xxhash MIT; munnerz/goautoneg BSD-3-Clause) | Apache-2.0 | server-side recorder `/metrics` | in use (Phase A.2) |
| golang.org/x/{crypto,net,sys,time}, google.golang.org/protobuf, google/uuid, wlynxg/anet | BSD-3-Clause | indirect dependencies of the recorder | in use (Phase A.2) |
| Go toolchain and standard library (golang:1.27 build image) | BSD-3-Clause | builds `services/recorder` | in use (build only) |
| distroless static-debian12 base image | Apache-2.0 (Debian packages under their own permissive licences) | recorder runtime image | self-hosted image |
| **Phase C portable agent (`agent/`, Rust)** | | | |
| serde, serde_json | MIT OR Apache-2.0 | agent wire types (`ia-core`) | in use (Phase C) |
| x25519-dalek | BSD-3-Clause | §1.3 X25519 key agreement | in use (Phase C) |
| ed25519-dalek | BSD-3-Clause | compact-token / signed-sidecar verification | in use (Phase C) |
| chacha20poly1305 | MIT OR Apache-2.0 | §1.3 XChaCha20-Poly1305 frame crypto | in use (Phase C) |
| hkdf, sha2, hmac | MIT OR Apache-2.0 | §1.3 KDF, confirmation MAC, hashing | in use (Phase C) |
| zeroize | MIT OR Apache-2.0 | wipe ephemeral keys | in use (Phase C) |
| subtle | BSD-3-Clause | constant-time compares | in use (Phase C) |
| base64, hex | MIT OR Apache-2.0 | base64url / hex encodings | in use (Phase C) |
| rand, rand_core | MIT OR Apache-2.0 | CSPRNG (desk codes, ephemeral keys) | in use (Phase C) |
| getrandom | MIT OR Apache-2.0 | OS entropy (via rand); the earlier `=0.2.11` gnu-only pin is lifted now the MSVC host is the build target (ia-core still cross-checks on gnu) | in use (Phase C) |
| regex | MIT OR Apache-2.0 | filename grammar, cmd value rule, path allow-list | in use (Phase C) |
| url | MIT OR Apache-2.0 | strict deep-link parsing (§2.5) | in use (Phase C) |
| icu_normalizer 2.4 (+ icu_normalizer_data, icu_provider, icu_collections, zerovec; already pulled in by url -> idna) | Unicode-3.0 | NFC in the A F5 `sanitiseFileName` port (`ia_core::files`) | in use (Phase C) |
| thiserror | MIT OR Apache-2.0 | error types | in use (Phase C) |
| tracing, tracing-subscriber | MIT | structured logs (redacted per A §6) | in use (Phase C) |
| windows, windows-sys (windows-rs) | MIT OR Apache-2.0 | DXGI/GDI, SendInput, registry, known folders, WinVerifyTrust (`windows-sys` is the raw-FFI companion crate) | in use (Phase C, `winapi` feature) |
| libloading | ISC | §14 late binding of non-KnownDLL system libraries | in use (Phase C, `winapi` feature) |
| egui, eframe | MIT OR Apache-2.0 | consent/pill/panel UI | in use (Phase C, `gui` feature) |
| tray-icon | MIT OR Apache-2.0 | tray icon | in use (Phase C, `gui` feature) |
| winit | Apache-2.0 | the windowing event loop eframe builds on; used for `EventLoopBuilderExtWindows::with_any_thread` on the pill/consent windows | in use (Phase C, `gui` feature) |
| tokio, tokio-tungstenite, futures-util | MIT (futures-util MIT OR Apache-2.0) | async runtime + `/signal` WS client | in use (Phase C, `media` feature) |
| bytes, async-trait | MIT (async-trait MIT OR Apache-2.0) | data-channel buffers and webrtc-rs async callback traits | in use (Phase C, `media` feature) |
| webrtc (webrtc-rs, pinned =0.17.1, with its ice/dtls/srtp/sctp/sdp/interceptor/rtp/rtcp/stun/turn/util/mdns/data/media crates and ring) | MIT OR Apache-2.0 (ring: ISC AND MIT AND OpenSSL) | native WebRTC peer (last release with the classic MediaEngine/interceptor API) | in use (Phase C, `media` feature) |
| shiguredo_libvpx (=2026.2.0-canary.3; downloads a prebuilt static libvpx v1.17.0) | Apache-2.0 (wrapper); libvpx BSD-3-Clause | VP8/VP9 encode (prebuilt libvpx: no nasm/make needed on this host; §11.2 deviation from vpx-sys/vendored, see agent/README.md) | in use (Phase C, `media` feature) |
| audiopus, audiopus_sys (libopus built from source via `cc`) | MIT (wrapper); libopus BSD-3-Clause | Opus voice encode (capability advertised; RTP audio path is stubbed, see agent/README.md) | in use (Phase C, `media` feature) |
| rav1e | BSD-2-Clause | AV1 (feature `av1`, off by default) | planned (Phase C, off by default) |
| openh264 | BSD-2-Clause (Cisco binary caveat, §4.2: MPEG-LA royalty exposure; not shipped in the default build) | H.264 software (feature `h264-sw`, off by default) | planned (Phase C, off by default) |
| yuvutils-rs | BSD-3-Clause OR Apache-2.0 | BGRA→I420 (SIMD; the self-contained converter is the interim path) | planned (Phase C capture path) |
| **Phase D installed service (`agent/`, Rust: `ia-service`, `ia-session0`, `ia-waker`, `ia-vault`, `ia-watchdog`, `ia-desktop`)** | | | |
| windows-service 0.7 | MIT OR Apache-2.0 | SCM integration for both service binaries (D §4.1, §10.1): the dispatcher, the control handler, the failure actions | in use (Phase D, `service` feature) |
| chrono 0.4, chrono-tz 0.10 | MIT OR Apache-2.0 (chrono-tz bundles the IANA tz database, which is public domain) | the device evaluates `allowedHours` in its own zone before it acts (D §6.1, rule 9.9), and stamps tamper events (rule 10.5) | in use (Phase D) |
| md-5 0.10 | MIT OR Apache-2.0 | HTTP Digest authentication to AMT firmware, which offers no other scheme (D rule 8.4c); not used for anything else | in use (Phase D, `ia-waker`) |
| ureq 2 (with rustls, webpki-roots, ring) | MIT OR Apache-2.0 (ring: ISC AND MIT AND OpenSSL) | the service's own HTTP calls: enrollment, the signed deregister, fetching a pushed file, and the AMT WS-Management POST (D §3.2, §4.1, rule 9.4, rule 8.4b) | in use (Phase D, `service` / `net` features) |
| tempfile 3 | MIT OR Apache-2.0 | temporary directories in the service's own tests (config, identity, tamper-log round trips); dev only, not shipped | in use (dev, Phase D) |
| fast_image_resize | MIT OR Apache-2.0 | ladder downscale | planned (Phase C capture path) |
| image | MIT OR Apache-2.0 | org-logo decode with limits (§3.3) | planned (Phase C `gui`) |
| cpal | MIT OR Apache-2.0 | WASAPI audio I/O (voice device layer; full duplex stubbed) | in use (Phase C `media`) |
| crossbeam-channel | MIT OR Apache-2.0 | bounded capture/encode channels (§4.1) | planned (Phase C `media`) |
| rustls, webpki-roots | Apache-2.0 / MIT / ISC (webpki-roots MPL-2.0) | TLS for the WS/HTTP client (no native-tls/schannel) | in use (Phase C `media`) |
| **Phase C Android host (`apps/android`, Kotlin)** | | | |
| io.getstream:stream-webrtc-android 1.3.10 (prebuilt Google libwebrtc) | Apache-2.0 (wrapper); libwebrtc BSD-3-Clause with its bundled third-party code (BoringSSL OpenSSL/ISC, libvpx BSD-3-Clause, libopus BSD-3-Clause, libyuv BSD-3-Clause, usrsctp BSD-3-Clause) | MediaProjection capture into a VideoTrack, MediaCodec / VP8 encode, SDP/ICE/DTLS-SRTP/SCTP, voice | in use (Phase C) |
| com.google.crypto.tink:tink-android 1.18.0 (pinned; `subtle` X25519/HKDF/Ed25519 and `aead.internal.InsecureNonceXChaCha20Poly1305`) | Apache-2.0 | §1.3 handshake and frame crypto, compact-token Ed25519 verification | in use (Phase C) |
| com.squareup.okhttp3:okhttp 4.12.0 (+ okio) | Apache-2.0 | `/signal` WebSocket (no Origin) and token lookup REST | in use (Phase C) |
| org.jetbrains.kotlinx:kotlinx-serialization-json 1.9.0, kotlinx-coroutines-android 1.10.2, Kotlin stdlib and serialization compiler plugin 2.2.20 | Apache-2.0 | wire types, UI state flows | in use (Phase C) |
| AndroidX core-ktx 1.16.0, activity-ktx 1.10.1, lifecycle-runtime-ktx 2.9.1 | Apache-2.0 | activities, result contracts, lifecycle | in use (Phase C) |
| com.journeyapps:zxing-android-embedded 4.3.0 (+ com.google.zxing:core) | Apache-2.0 | QR scan of the join link (§12.3) | in use (Phase C) |
| Android Gradle Plugin 9.0.1, Gradle 9.3.1 wrapper (`apps/android/gradlew`, gradle-wrapper.jar) | Apache-2.0 | Android build (dev/CI only, not shipped) | in use (build only) |
| JUnit 4.13.2; AndroidX Test (ext-junit 1.2.1, runner 1.6.2, rules 1.6.1, UiAutomator 2.3.0) | EPL-1.0 (JUnit); Apache-2.0 (AndroidX Test) | JVM unit and instrumented tests (dev only, not shipped) | in use (dev) |
| com.goterl:lazysodium-android | ISC | fallback only if Tink `subtle` becomes unusable (§12.1) | not used |
| RustDesk, MinIO source | AGPL | reference reading only, never copied | forbidden in repo |
| **Phase D packaging (`packaging/`)** | | | |
| WiX Toolset v5 (5.0.2, installed as the .NET global tool `wix`: `dotnet tool install --global wix --version 5.0.2`) | MS-RL (Microsoft Reciprocal License); used only as an unmodified build tool, no WiX source copied into our code, no WiX binaries checked in; the MSI carries only the standard Windows Installer tables WiX emits and our own custom-action DLL (`packaging/windows/ca`, built from our source with crates already listed above: serde, serde_json, windows-sys) | compiles `packaging/windows/IndiansAssist.wxs` into the agent MSI and runs the ICE validation (`wix msi validate`), Phase D §11.2 / §12.2 | build tool, not shipped |
| **Phase E (`docs/specs/phase-e-contracts.md` section 9; "planned, Phase E <stream>" rows flip to "in use" when that stream installs the package)** | | | |
| undici 8.12.3 (exact pin) | MIT | `undici.fetch` and the pinned-address `undici.Agent` of the egress guard `egressFetch` (`apps/api/src/lib/egress.ts`, E §2.2) | in use (Phase E foundation, api) |
| openid-client 6.x (+ jose 6, oauth4webapi 3) | MIT (all) | OIDC relying party, authorization code + PKCE (E §3.4) | in use (Phase E sso; installed by the coordinator before the streams so the lockfile has one writer) |
| @node-saml/node-saml 5.x (+ xml-crypto 6, @xmldom/xmldom, @xmldom/is-dom-node, xml2js, xmlbuilder, xml-encryption, xpath) | MIT (all) | SAML 2.0 SP, SP-initiated (E §3.5) | in use (Phase E sso; installed by the coordinator before the streams so the lockfile has one writer) |
| @peculiar/x509 3.x (+ tsyringe, @peculiar/asn1-*, @peculiar/utils) | MIT (all) | the self-signed SAML SP certificate (E §3.5 S7) | in use (Phase E sso; installed by the coordinator before the streams so the lockfile has one writer) |
| @anthropic-ai/sdk 1.x (+ standardwebhooks MIT, json-schema-to-ts MIT, @opentelemetry/api Apache-2.0) | Apache-2.0 (E W73) | the opt-in `anthropic` summary provider (E §5.7) | in use (Phase E ai; installed by the coordinator before the streams so the lockfile has one writer) |
| vLLM, llama.cpp, Ollama (any one, chosen by the operator) | Apache-2.0, MIT, MIT | optional model server behind `AI_LOCAL_ENDPOINTS` (E §5.6); a separate service, nothing linked; the model weights' licence is the operator's | self-hosted service, optional (Phase E ai) |
| x11rb 0.13.2 (+ x11rb-protocol 0.13.2; features `randr`, `shm`, `xfixes`, `xtest`; licence read from the crate manifest in the local Cargo registry) | MIT OR Apache-2.0 | Linux X11 protocol client, pure Rust, no libX11 link: RandR, MIT-SHM, XTEST, XFixes (`ia-capture-x11`, `ia-input-x11`, `ia-ui` pill treatment; E §7.2) | in use (Phase E linux, Linux-target dependency only) |
| arboard 3.7.0 (a direct dependency of `ia-input-x11`, default features off, X11 backend) | MIT OR Apache-2.0 | Linux clipboard and the clipboard token carrier (E §7.2, §7.6) | in use (Phase E linux, Linux-target dependency only) |
| ksni 0.3.7 (features `blocking`, `tokio`) + zbus 5.19.0 (pulled by ksni; licences read from the crate manifests in the local Cargo registry; Phase F makes zbus a direct dependency of `ia-service` too, see the Phase F rows) | Unlicense (ksni), MIT (zbus) | best-effort StatusNotifierItem tray over D-Bus, no GTK (E §7.3b) | in use (Phase E linux, Linux-target dependency only) |
| libc 0.2.191 | MIT OR Apache-2.0 | `SO_PEERCRED`, `memfd_create`, `getuid` / `geteuid`, `setsid`, `killpg`, the sealed memfd of the `sh` runner on Linux (E §7.2, §7.7, §7.8) | in use (Phase E linux, Linux-target dependency only) |
| ashpd 0.13.13 (features `screencast` and `tokio`, `default-features = false`; uses zbus `^5.13`, satisfied by the locked 5.19.0; pinned by Phase F §10, licence confirmed from the crate manifest at install) | MIT | the portal ScreenCast client of the `portal` companion binary shipped in the single Linux download (F §9.2), Linux-target dependency only | planned, Phase F wayland |
| cargo-zigbuild 0.24.0 (`cargo install cargo-zigbuild --locked`, user-level in WSL), Zig 0.15.2 (the official x86_64-linux tarball, sha256 checked against ziglang.org's index, unpacked under `~/.local/zig-0.15.2`) | MIT (cargo-zigbuild, from its crate manifest), MIT (Zig, from its LICENSE file) | the Linux release build against the glibc 2.35 floor (E §7.9) | build only, not shipped (Phase E linux) |
| **Phase F (`docs/specs/phase-f-contracts.md` section 10; "planned, Phase F <stream>" rows flip to "in use" when that stream adds the dependency; Phase F adds no npm package)** | | | |
| zbus 5.19.0 as a direct Linux-target dependency of `ia-service` (`version = "=5.19.0"`, `default-features = false`, feature `tokio`, the backend ksni already uses, so nothing new entered `Cargo.lock`; licence MIT confirmed from the crate manifest in the local Cargo registry) | MIT | logind and systemd over the system bus: session discovery and its signals, `NRestarts`, unit state (F §8.4, §8.8); `ia-service/src/linux/{logind,sdnotify}.rs` | in use (Phase F linux-p4, Linux-target dependency only) |
| cargo-deb 3.8.0 (`cargo install cargo-deb --version 3.8.0 --locked`, user-level in WSL; read from crates.io metadata on 2 Nov 2026) | MIT | builds the `.deb` from the release binaries with `--no-build --no-strip` (F §8.9; `packaging/linux/build-wsl.sh`, `pnpm linux:pkg`) | build only, not shipped (in use, Phase F linux-p4) |
| cargo-generate-rpm 0.21.1 (`cargo install cargo-generate-rpm --version 0.21.1 --locked`, user-level in WSL; read from crates.io metadata on 2 Nov 2026) | MIT | builds the `.rpm` from the release binaries with `--auto-req no` (F §8.9; `packaging/linux/build-wsl.sh`, `pnpm linux:pkg`) | build only, not shipped (in use, Phase F linux-p4) |
| Ubuntu Base 22.04 root file system (`ubuntu-base-22.04.5-base-amd64.tar.gz` from cdimage.ubuntu.com/ubuntu-base/releases/22.04/release, sha256 `242cd8898b33ea806ef5f13b1076ed7c76f9f989d18384452f7166692438ff1a` pinned in `agent/scripts/pkg-sandbox-test.sh` and listed in the published SHA256SUMS; downloaded once into `~/.cache/ia-throwaway/` in WSL) | various free licences (Ubuntu) | the T1 bubblewrap sandbox install test (F §8.12): extracted into a temporary directory per run and deleted after it | in use, test only, not shipped (Phase F linux-p4) |
| rpm, ansible-core, ansible-lint (WSL system packages, installed by the user) | LGPL-2.1+/GPL-2.0+ (rpm), GPL-3.0+ (ansible-core), MIT (ansible-lint) | read-only package inspection and Ansible role linting (F §8.12, `packaging/linux/check-wsl.sh`); nothing linked or copied | in use, test tools on the build host, not shipped (Phase F linux-p4) |
| qrcode (Rust crate) 0.14.1 (`version = "=0.14.1"`, `default-features = false`, so no `image` or `svg` renderer and no transitive crate; Windows- and Linux-target dependency of `ia-ui`; licence MIT OR Apache-2.0 confirmed from the crate manifest in the local Cargo registry) | MIT OR Apache-2.0 | the camera-link QR beside a technician's chat message in the Windows and Linux agents' panel (F §6.1, `ia-ui/src/camqr.rs`) | in use (Phase F linux-p4) |
| pipewire 0.10.1 + libspa 0.10.1 (+ `pipewire-sys`, `libspa-sys`; build-time bindgen and clang-sys, licences confirmed from their manifests at install) | MIT (pipewire, libspa); links libpipewire-0.3 (MIT) at run time on the Desk | PipeWire stream consumer of the portal build (F §9.2), Linux-target only | planned, Phase F wayland |
| eframe `wayland` feature families (winit Wayland backend, smithay-client-toolkit, wayland-client, wayland-protocols, wayland-backend; licences confirmed from their manifests at install) | MIT (expected; confirmed at install) | the consent window and pill on Wayland in the portal build, libwayland opened at run time (F §9.2) | planned, Phase F wayland |
| sway, swaybg, pipewire, wireplumber, xdg-desktop-portal, xdg-desktop-portal-wlr, clang (WSL system packages, installed by the user) | MIT, MIT, MIT, MIT, LGPL-2.1+, MIT, Apache-2.0 with LLVM exception | the headless portal test stack and the portal build (F §9.6) | planned, Phase F wayland (test and build tools, not shipped) |
| androidx.browser:browser 1.10.0 (Custom Tabs; licence from the Google Maven POM, 2 Nov 2026) | Apache-2.0 | **Give help** in the Android app opens the mobile console in a Custom Tab (F §7.8) | in use (Phase F mobile) |
| objc2 0.6.5, block2 0.6.2, objc2-foundation 0.3.2 (MIT); objc2-app-kit 0.3.2, objc2-screen-capture-kit 0.3.2, objc2-core-graphics 0.3.2, objc2-core-foundation 0.3.2, objc2-core-media 0.3.2, objc2-core-video 0.3.2, dispatch2 0.3.1 (Zlib OR Apache-2.0 OR MIT); licences from cargo metadata, 3 Nov 2026 | MIT; Zlib OR Apache-2.0 OR MIT | macOS frameworks from Rust: ScreenCaptureKit, CoreMedia and CoreVideo sample buffers, CGEvent, AppKit, GCD queues (F §17.2), in `ia-capture-mac`, `ia-input-mac` and `ia-platform`, macOS-target only | in use (Phase F apple) |
| stasel/WebRTC 155.0.0 (a binary distribution of Google WebRTC M155 through Swift Package Manager, `exactVersion: 155.0.0` in `apps/ios/project.yml`; git 44f36788497f701bc8c0306de3a1c2511d56019d; binaryTarget `WebRTC-M155.xcframework.zip`, SwiftPM checksum cb9adacf2d6bbf598d1d9e3e6c16d8fb97ca987b5b697746891828f9dc068ffe) | BSD-3-Clause (the packager's BSD-3-Clause and Google WebRTC's BSD notice) | the iOS broadcast extension's WebRTC peer connection (F §17.4); linked by the app, which embeds the dynamic framework | in use (Phase F apple, iOS; SwiftPM is not scanned by `license-check.mjs`) |
| XcodeGen 2.46.0 (generates `apps/ios/*.xcodeproj` from `apps/ios/project.yml` on the Mac) | MIT | the iOS project file (F §17.4) | build only (Phase F apple, a tool on the Mac; never shipped) |
| Xcode, `pkgbuild`, `productbuild`, `codesign`, `notarytool` (Apple developer tools on the Mac) | Apple's Xcode licence | building, signing and packaging the macOS agent and the iOS app (F §17) | planned, Phase F apple (build tools, not shipped) |
