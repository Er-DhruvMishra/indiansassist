//! Agent UI (contract §3.3 consent window, §3.5 pill/panel/tray, Stop receipt).
//!
//! The view-model in [`model`] holds the logic the contract is specific about — the
//! consent payload a valid form produces, the pill's always-visible fields incl. the
//! security code, the level chip wording that distinguishes integrity from level, and the
//! §3.5 self-defence decisions (the hook verdict that drops injected `IA_1`-tagged input over
//! the agent's own windows, and the grant/safe gating of prompt controls) — and is tested
//! with no windowing system. [`bridge`] is the serve-loop <-> UI channel vocabulary.
//!
//! Behind `gui`: [`app`] (the eframe application on its own thread: consent window that
//! morphs into the pill, the panel viewport, the ended view), [`tray`], [`guard`] (the
//! `WH_MOUSE_LL` / `WH_KEYBOARD_LL` hooks) and `winhelp` (topmost / tool-window /
//! exclude-from-capture / re-dock on the eframe HWNDs).

pub mod bridge;
pub mod model;

#[cfg(feature = "gui")]
pub mod app;
#[cfg(feature = "gui")]
pub mod guard;
#[cfg(feature = "gui")]
pub mod tray;
#[cfg(all(feature = "gui", windows))]
pub mod winhelp;
