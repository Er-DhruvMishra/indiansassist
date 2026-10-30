//! The live consent state during `active` (contract §3.4): the level, the Desk clipboard
//! switch, the integrity, the consented and selected monitor sets, and the rules for
//! raising / lowering the level and toggling the clipboard. Pure; the window / pill UI and
//! the `desk.consent_level` / `desk.consent_clipboard` WS messages are driven from this.
//!
//! The §3.3 consent *window* model lives in `ia-ui`; this is what the model becomes once the
//! session is live and the technician asks for changes.

use crate::types::{agent_level_at_least, AgentConsentLevel, ElevationLevel};

/// The outcome of an Assist level request (contract §3.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LevelRequestOutcome {
    /// Already at or above the asked level: nothing to prompt, answer at once.
    AlreadyGranted,
    /// Show the Allow / Refuse card (60 s).
    Prompt,
    /// `elevated` is never reached through `level.request` (only §7): answer `bad_args`.
    BadArgs,
}

/// The live consent context (contract §3.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveConsent {
    pub level: AgentConsentLevel,
    pub integrity: ElevationLevel,
    pub clipboard: bool,
    pub consented_monitors: Vec<u32>,
    pub selected_monitors: Vec<u32>,
    /// How many level changes happened this session (for the receipt, §3.5).
    pub level_changes: u32,
}

impl LiveConsent {
    /// Build from the §3.3 consent payload at `active`. Default selection is the primary
    /// (first) consented monitor (§3.6 M2).
    pub fn new(level: AgentConsentLevel, clipboard: bool, consented_monitors: Vec<u32>) -> Self {
        let selected_monitors = consented_monitors.first().copied().into_iter().collect();
        Self {
            level,
            integrity: ElevationLevel::User,
            clipboard: clipboard && agent_level_at_least(level, AgentConsentLevel::Control),
            consented_monitors,
            selected_monitors,
            level_changes: 0,
        }
    }

    /// Whether `clipboard.set` and Desk->Assist clipboard events are allowed right now
    /// (contract §5.6 C1: the switch is on **and** the level is at least `control`).
    pub fn clipboard_active(&self) -> bool {
        self.clipboard && agent_level_at_least(self.level, AgentConsentLevel::Control)
    }

    /// An Assist `level.request { level }` (contract §3.4).
    pub fn request_level(&self, level: AgentConsentLevel) -> LevelRequestOutcome {
        match level {
            AgentConsentLevel::Elevated => LevelRequestOutcome::BadArgs,
            l if agent_level_at_least(self.level, l) => LevelRequestOutcome::AlreadyGranted,
            _ => LevelRequestOutcome::Prompt,
        }
    }

    /// The Desk allowed the raise (physical click already checked by the caller, §3.5).
    pub fn grant_level(&mut self, level: AgentConsentLevel) {
        if level != self.level && level != AgentConsentLevel::Elevated {
            self.level = level;
            self.level_changes += 1;
        }
    }

    /// The Desk lowered the level from the pill menu. Lowering from `elevated` keeps the
    /// elevated process (the level drops, not the integrity, §3.4).
    pub fn lower_level(&mut self, level: AgentConsentLevel) {
        if agent_level_at_least(self.level, level) && level != self.level {
            self.level = level;
            self.level_changes += 1;
        }
    }

    /// Hand-over set the process to admin integrity and the level to `elevated` (§3.2/§7.3).
    pub fn apply_handover(&mut self) {
        self.integrity = ElevationLevel::Admin;
        if self.level != AgentConsentLevel::Elevated {
            self.level = AgentConsentLevel::Elevated;
            self.level_changes += 1;
        }
    }

    /// Toggle the clipboard switch (physical click already checked by the caller, §3.5).
    /// Returns the effective state (forced off under `view`).
    pub fn toggle_clipboard(&mut self, on: bool) -> bool {
        self.clipboard = on;
        self.clipboard_active()
    }

    /// Contract §3.4: when the process is elevated but the level is below `elevated`, the
    /// admin instance **re-imposes UIPI by policy** — input into above-medium-integrity
    /// windows is refused `blocked_uipi` as if UIPI applied. Returns whether that policy is
    /// in force right now.
    pub fn uipi_reimposed_by_policy(&self) -> bool {
        self.integrity == ElevationLevel::Admin && self.level != AgentConsentLevel::Elevated
    }

    /// `os.monitor.select`: only consented monitors may be selected (§3.6 M2).
    pub fn select_monitors(&mut self, ids: &[u32]) -> Result<(), &'static str> {
        if ids.is_empty() || ids.iter().any(|m| !self.consented_monitors.contains(m)) {
            return Err("no_such_monitor");
        }
        self.selected_monitors = ids.to_vec();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> LiveConsent {
        LiveConsent::new(AgentConsentLevel::Control, false, vec![1, 2])
    }

    #[test]
    fn new_selects_the_primary_and_honours_clipboard_gate() {
        let c = LiveConsent::new(AgentConsentLevel::View, true, vec![3, 4]);
        assert_eq!(c.selected_monitors, vec![3]);
        // clipboard asked on but level is view => inactive.
        assert!(!c.clipboard_active());
    }

    #[test]
    fn assist_raises_from_view_prompts_then_grants() {
        let mut c = LiveConsent::new(AgentConsentLevel::View, false, vec![1]);
        assert_eq!(
            c.request_level(AgentConsentLevel::Control),
            LevelRequestOutcome::Prompt
        );
        c.grant_level(AgentConsentLevel::Control);
        assert_eq!(c.level, AgentConsentLevel::Control);
        assert_eq!(c.level_changes, 1);
        // Asking for control again is already-granted.
        assert_eq!(
            c.request_level(AgentConsentLevel::Control),
            LevelRequestOutcome::AlreadyGranted
        );
    }

    #[test]
    fn elevated_never_via_level_request() {
        let c = base();
        assert_eq!(
            c.request_level(AgentConsentLevel::Elevated),
            LevelRequestOutcome::BadArgs
        );
    }

    #[test]
    fn lowering_from_elevated_keeps_integrity_and_reimposes_uipi() {
        let mut c = base();
        c.apply_handover();
        assert_eq!(c.level, AgentConsentLevel::Elevated);
        assert_eq!(c.integrity, ElevationLevel::Admin);
        assert!(!c.uipi_reimposed_by_policy()); // level == elevated: no re-imposition

        c.lower_level(AgentConsentLevel::Control);
        assert_eq!(c.level, AgentConsentLevel::Control);
        assert_eq!(c.integrity, ElevationLevel::Admin); // integrity stays
        assert!(c.uipi_reimposed_by_policy()); // now re-imposed by policy
    }

    #[test]
    fn clipboard_toggle_respects_level() {
        let mut c = base();
        assert!(c.toggle_clipboard(true)); // control + on => active
        c.lower_level(AgentConsentLevel::View);
        assert!(!c.clipboard_active()); // view forces it off
    }

    #[test]
    fn select_only_consented_monitors() {
        let mut c = base();
        assert!(c.select_monitors(&[1, 2]).is_ok());
        assert_eq!(c.select_monitors(&[9]), Err("no_such_monitor"));
        assert_eq!(c.select_monitors(&[]), Err("no_such_monitor"));
    }
}
