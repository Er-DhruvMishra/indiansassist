//! Windows OS-level input (contract §5). The scancode table ([`scancodes`]) and the
//! virtual-desktop pointer mapping ([`mapping`]) are pure math and are tested on any
//! target (contract §15.2 "pure math tests ungated"). `SendInput` / clipboard injection
//! ([`inject`]) is compiled under the `winapi` feature.

pub mod mapping;
pub mod scancodes;

#[cfg(all(windows, feature = "winapi"))]
pub mod inject;

#[cfg(all(windows, feature = "winapi"))]
pub mod clipboard;

/// The agent's own injection tag written to `dwExtraInfo` (`IA_1`, contract §5.3), so the
/// §3.5 low-level hooks can drop injected events over the agent's own windows.
pub const IA_INJECT_TAG: usize = 0x4941_5F31;
