//! Agent UI (contract §3.3 consent window, §3.5 pill/panel/tray, Stop receipt).
//!
//! The view-model in [`model`] holds the logic the contract is specific about — the
//! consent payload a valid form produces, the pill's always-visible fields incl. the
//! security code, the level chip wording that distinguishes integrity from level, and the
//! §3.5 self-defence gate that drops injected (`IA_1`-tagged) clicks on the agent's own
//! prompts — and is tested with no windowing system. The egui/eframe rendering (behind the
//! `gui` feature) is a thin view over this model.

pub mod model;

#[cfg(feature = "gui")]
pub mod render;
