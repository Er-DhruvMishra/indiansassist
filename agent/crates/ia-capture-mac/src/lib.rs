//! `ia-capture-mac`: the macOS ScreenCaptureKit capture of the macOS portable agent (Phase F §17.2): ScreenCaptureKit capture (`SCShareableContent`, one `SCStream` per consented display, BGRA `CVPixelBuffer` to `ia-frame` I420).
//!
//! Landed by F0 as an empty stub so the workspace, the `ia-agent/macos` feature and the
//! `// apple-owned` hooks have something to name. **The apple stream owns this crate** (§1.4)
//! and is the only stream that edits it. Everything is behind `cfg(target_os = "macos")`, so the
//! Windows and Linux builds and their `--all-features` gates compile nothing from it.

/// The macOS implementation (apple stream). Empty until then.
#[cfg(target_os = "macos")]
pub mod macos {}
