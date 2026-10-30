//! webrtc-rs peer wiring (contract §1.2, §3.6, §4), compiled under `media`.
//!
//! NOTE: the `media` feature pulls `webrtc` (→ `ring`) and the libvpx/libopus encoders,
//! which need a C toolchain + nasm. That toolchain is absent on the gnu dev machine, so
//! this module and `tests/loopback.rs` are **built and run in CI** on the msvc targets,
//! not by the default dev gate. See agent/README.md.
//!
//! Structure (built here when `media` is on):
//! * `MediaEngine` registered from [`crate::codecs`] (exact fmtp lines),
//! * one `TrackLocalStaticSample` per consented monitor (§3.6 M1), plus the recorder track,
//! * the seven data channels created by the Desk once per PC (§1.3), with `ia.sec` carrying
//!   the [`ia_core::sec`] handshake and the rest wrapped in [`ia_core::secchan`] frames,
//! * the [`ia_core::abr`] controller fed from RTCP (REMB/TWCC).

/// Placeholder entry used by `main` under the `media` feature until the full peer loop is
/// wired; the real `run()` opens the WS signaling client and the peer connection.
pub fn run_placeholder() {
    tracing::info!("media build: peer wiring is CI-compiled; see agent/README.md");
}
