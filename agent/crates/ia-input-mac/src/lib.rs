//! `ia-input-mac`: the macOS CGEvent input of the macOS portable agent (Phase F §17.2): CGEvent input (mouse and keyboard posted at `kCGHIDEventTap`, Unicode text, the W3C `code` to virtual-key table, and the `refuses_pointer` / `refuses_keyboard` guard).
//!
//! Landed by F0 as an empty stub so the workspace, the `ia-agent/macos` feature and the
//! `// apple-owned` hooks have something to name. **The apple stream owns this crate** (§1.4)
//! and is the only stream that edits it. Everything is behind `cfg(target_os = "macos")`, so the
//! Windows and Linux builds and their `--all-features` gates compile nothing from it.

/// The macOS implementation (apple stream). Empty until then.
#[cfg(target_os = "macos")]
pub mod macos {}
