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
| Keycloak | Apache-2.0 | SSO / OIDC (optional) | planned, Phase E |
| SeaweedFS | Apache-2.0 | object storage (Compose default, S3 gateway) | self-hosted service |
| Garage | AGPL-3.0 (run only as an unmodified separate process over its S3 API, nothing linked or copied) | object storage, optional alternative | self-hosted service, not the default |
| prom-client | Apache-2.0 | `/metrics` | in use (Phase A) |
| nginx | BSD-2-Clause | TLS termination, reverse proxy, static web | self-hosted service |
| ioredis | MIT | Valkey client (redis presence driver) | in use (Phase A, multi-node) |
| @aws-sdk/client-s3, @aws-sdk/s3-request-presigner | Apache-2.0 | s3 storage driver | in use (Phase A) |
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
