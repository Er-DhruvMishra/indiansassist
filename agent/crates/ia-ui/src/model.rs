//! UI view-model (pure). Tested without any windowing system.

use ia_core::types::{AgentConsentLevel, ElevationLevel, MonitorInfo};

/// A monitor row in the consent window (contract §3.3).
#[derive(Debug, Clone)]
pub struct MonitorChoice {
    pub info: MonitorInfo,
    pub checked: bool,
}

/// The consent window state (contract §3.3).
#[derive(Debug, Clone)]
pub struct ConsentModel {
    pub technician: String,
    pub org: String,
    pub monitors: Vec<MonitorChoice>,
    /// `view` or `control`; `elevated` is never offered here.
    pub level: AgentConsentLevel,
    /// Share clipboard text both ways — default off (§3.3).
    pub clipboard: bool,
    /// Required "I have closed or hidden anything private" checkbox.
    pub privacy_ack: bool,
}

/// The validated `desk.consent { native }` payload (contract §3.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentPayload {
    pub level: AgentConsentLevel,
    pub monitors: Vec<u32>,
    pub clipboard: bool,
}

impl ConsentModel {
    pub fn new(technician: &str, org: &str, monitors: Vec<MonitorInfo>) -> Self {
        Self {
            technician: technician.to_string(),
            org: org.to_string(),
            monitors: monitors
                .into_iter()
                .map(|info| MonitorChoice {
                    info,
                    checked: true,
                }) // all checked by default
                .collect(),
            level: AgentConsentLevel::Control, // default control (§3.3)
            clipboard: false,                  // default off (§3.3)
            privacy_ack: false,
        }
    }

    /// The **Share my screen** button is enabled only when at least one monitor is checked
    /// and the privacy checklist box is ticked (§3.3).
    pub fn can_share(&self) -> bool {
        self.privacy_ack && self.monitors.iter().any(|m| m.checked)
    }

    /// Build the consent payload, or `None` when the form is incomplete.
    pub fn payload(&self) -> Option<ConsentPayload> {
        if !self.can_share() {
            return None;
        }
        // `view` forces clipboard off (the switch is disabled under view, §3.3).
        let clipboard = self.clipboard && self.level >= AgentConsentLevel::Control;
        Some(ConsentPayload {
            level: self.level,
            monitors: self
                .monitors
                .iter()
                .filter(|m| m.checked)
                .map(|m| m.info.id)
                .collect(),
            clipboard,
        })
    }
}

/// The level chip on the pill (§3.5): distinguishes the consent level from the process
/// integrity, so nobody mistakes an elevated process at a lower level for full elevation.
pub fn level_chip(level: AgentConsentLevel, integrity: ElevationLevel) -> String {
    match (integrity, level) {
        (ElevationLevel::Admin, AgentConsentLevel::Elevated) => "Elevated".into(),
        (ElevationLevel::Admin, AgentConsentLevel::Control) => "Elevated process (control)".into(),
        (ElevationLevel::Admin, AgentConsentLevel::View) => "Elevated process (view only)".into(),
        (ElevationLevel::User, AgentConsentLevel::View) => "View only".into(),
        (ElevationLevel::User, _) => "Control".into(),
    }
}

/// The always-visible pill face (contract §3.5).
#[derive(Debug, Clone)]
pub struct PillModel {
    pub technician: String,
    pub org: String,
    pub elapsed_secs: u64,
    /// The six-digit security code, shown as `483 920` on the face (§1.3 step 7).
    pub sas_display: String,
    pub recording: bool,
    pub recording_is_server: bool,
    pub integrity: ElevationLevel,
    pub level: AgentConsentLevel,
}

impl PillModel {
    /// The line of text on the pill face.
    pub fn face_text(&self) -> String {
        format!("Sharing with {} ({})", self.technician, self.org)
    }
    pub fn timer_text(&self) -> String {
        let (h, m, s) = (
            self.elapsed_secs / 3600,
            (self.elapsed_secs % 3600) / 60,
            self.elapsed_secs % 60,
        );
        if h > 0 {
            format!("{h}:{m:02}:{s:02}")
        } else {
            format!("{m}:{s:02}")
        }
    }
    pub fn recording_label(&self) -> Option<&'static str> {
        if !self.recording {
            None
        } else if self.recording_is_server {
            Some("Recording (server)")
        } else {
            Some("Recording")
        }
    }
    pub fn chip(&self) -> String {
        level_chip(self.level, self.integrity)
    }
    pub fn show_shield(&self) -> bool {
        self.integrity == ElevationLevel::Admin
    }
    pub fn security_code_line(&self) -> String {
        format!("Security code {}", self.sas_display)
    }
}

/// §3.5 self-defence: a prompt control (file accept, clipboard switch, elevation Allow,
/// Keep, etc.) is actionable only by **physical** input. `tagged` is true when the event's
/// `dwExtraInfo == IA_1` (the agent's own injection tag); `over_agent_window` is true when
/// the cursor is over an agent HWND. An injected (tagged) event on an agent window is
/// dropped and counted as `refused` (contract §3.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptClick {
    pub tagged_injected: bool,
    pub over_agent_window: bool,
    /// `GetAsyncKeyState` confirms a physical button where the OS provides it.
    pub physical_confirmed: bool,
}

/// Returns whether the prompt click is accepted. The decisive rule: a tagged event over an
/// agent window is never accepted; a physical event is.
pub fn accept_prompt_click(c: PromptClick) -> bool {
    if c.tagged_injected && c.over_agent_window {
        return false; // injected self-approval attempt
    }
    if c.tagged_injected {
        return false; // tagged but somewhere else: still not physical
    }
    c.physical_confirmed
}

/// What the §3.5 low-level mouse hook (`WH_MOUSE_LL`) does with one event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookVerdict {
    /// An `IA_1`-tagged (agent-injected) event over an agent window: swallowed, counted as
    /// `refused`. The technician can never click the agent's own prompts.
    Drop,
    /// An untagged button press over an agent window: passed on and remembered as the
    /// physical press that may operate a grant-direction prompt control.
    PassPhysical,
    /// Anything else: passed on untouched.
    Pass,
}

/// The mouse hook decision (contract §3.5): `extra_info` is `MSLLHOOKSTRUCT.dwExtraInfo`.
pub fn mouse_hook_verdict(
    extra_info: usize,
    over_agent_window: bool,
    is_button_down: bool,
) -> HookVerdict {
    let tagged = extra_info == ia_core::types::IA_INJECT_TAG;
    match (tagged, over_agent_window, is_button_down) {
        (true, true, _) => HookVerdict::Drop,
        (false, true, true) => HookVerdict::PassPhysical,
        _ => HookVerdict::Pass,
    }
}

/// The keyboard hook decision (contract §3.5): tagged keys are dropped while an agent window
/// is the foreground window.
pub fn key_hook_drops(extra_info: usize, agent_is_foreground: bool) -> bool {
    extra_info == ia_core::types::IA_INJECT_TAG && agent_is_foreground
}

/// Which way a prompt control moves the session (contract §3.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptDirection {
    /// Gives the technician more (Accept a file, Allow control, clipboard on, raise the
    /// level, Keep): needs a recent **physical** press over the agent window.
    Grant,
    /// Gives the technician less (Decline, Refuse, Stop, Revoke, View only, clipboard off):
    /// never gated, so the Desk can always back out.
    Safe,
}

/// Whether a clicked prompt control may act.
pub fn prompt_allowed(direction: PromptDirection, physical_press_recent: bool) -> bool {
    match direction {
        PromptDirection::Safe => true,
        PromptDirection::Grant => physical_press_recent,
    }
}

/// The Stop receipt summary (contract §3.5), beyond the A D6 fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub monitors_shared: u32,
    pub level_changes: u32,
    pub clipboard_to_assist: u32,
    pub clipboard_to_desk: u32,
    pub elevation_requested: u32,
    pub elevation_granted: u32,
    pub sidecar_used: bool,
    /// Every security code of the session, by key generation.
    pub sas_by_gen: Vec<(u16, String)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(id: u32, primary: bool) -> MonitorInfo {
        MonitorInfo {
            id,
            name: format!("DISPLAY{id}"),
            primary,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            mid: None,
        }
    }

    #[test]
    fn share_requires_privacy_ack_and_a_monitor() {
        let mut m = ConsentModel::new("Asha", "Acme", vec![mon(1, true)]);
        assert!(!m.can_share()); // privacy not acked
        m.privacy_ack = true;
        assert!(m.can_share());
        m.monitors[0].checked = false;
        assert!(!m.can_share()); // no monitor
        assert_eq!(m.payload(), None);
    }

    #[test]
    fn payload_defaults_control_clipboard_off() {
        let mut m = ConsentModel::new("Asha", "Acme", vec![mon(1, true), mon(2, false)]);
        m.privacy_ack = true;
        let p = m.payload().unwrap();
        assert_eq!(p.level, AgentConsentLevel::Control);
        assert_eq!(p.monitors, vec![1, 2]);
        assert!(!p.clipboard);
    }

    #[test]
    fn view_level_forces_clipboard_off() {
        let mut m = ConsentModel::new("Asha", "Acme", vec![mon(1, true)]);
        m.privacy_ack = true;
        m.level = AgentConsentLevel::View;
        m.clipboard = true; // user somehow set it
        assert!(!m.payload().unwrap().clipboard);
    }

    #[test]
    fn level_chip_distinguishes_integrity_from_level() {
        assert_eq!(
            level_chip(AgentConsentLevel::Control, ElevationLevel::User),
            "Control"
        );
        assert_eq!(
            level_chip(AgentConsentLevel::View, ElevationLevel::User),
            "View only"
        );
        assert_eq!(
            level_chip(AgentConsentLevel::Elevated, ElevationLevel::Admin),
            "Elevated"
        );
        assert_eq!(
            level_chip(AgentConsentLevel::Control, ElevationLevel::Admin),
            "Elevated process (control)"
        );
        assert_eq!(
            level_chip(AgentConsentLevel::View, ElevationLevel::Admin),
            "Elevated process (view only)"
        );
    }

    #[test]
    fn pill_face_and_security_code_always_present() {
        let p = PillModel {
            technician: "Asha".into(),
            org: "Acme".into(),
            elapsed_secs: 3725,
            sas_display: "483 920".into(),
            recording: true,
            recording_is_server: true,
            integrity: ElevationLevel::Admin,
            level: AgentConsentLevel::Control,
        };
        assert_eq!(p.face_text(), "Sharing with Asha (Acme)");
        assert_eq!(p.timer_text(), "1:02:05");
        assert_eq!(p.recording_label(), Some("Recording (server)"));
        assert!(p.show_shield());
        assert_eq!(p.chip(), "Elevated process (control)");
        assert_eq!(p.security_code_line(), "Security code 483 920");
    }

    /// Contract §3.5 Windows test: a mock-`SendInput` tagged click on the panel's **Allow**
    /// button must be dropped. The hook sees `dwExtraInfo == IA_1` over an agent window and
    /// swallows it, so no press is recorded and the grant-direction control cannot act.
    #[test]
    fn tagged_click_on_the_panel_allow_button_is_dropped() {
        let tag = ia_core::types::IA_INJECT_TAG;
        assert_eq!(mouse_hook_verdict(tag, true, true), HookVerdict::Drop);
        assert_eq!(mouse_hook_verdict(tag, true, false), HookVerdict::Drop);
        // The same tagged click elsewhere is the technician's normal input.
        assert_eq!(mouse_hook_verdict(tag, false, true), HookVerdict::Pass);
        // A physical click over the panel is remembered as the press that may grant.
        assert_eq!(mouse_hook_verdict(0, true, true), HookVerdict::PassPhysical);
        assert_eq!(mouse_hook_verdict(0, true, false), HookVerdict::Pass);
        // With no physical press, Allow cannot act; Refuse always can.
        assert!(!prompt_allowed(PromptDirection::Grant, false));
        assert!(prompt_allowed(PromptDirection::Grant, true));
        assert!(prompt_allowed(PromptDirection::Safe, false));
        // Tagged keys are dropped only while an agent window is foreground.
        assert!(key_hook_drops(tag, true));
        assert!(!key_hook_drops(tag, false));
        assert!(!key_hook_drops(0, true));
    }

    #[test]
    fn injected_click_on_agent_window_is_refused() {
        // The technician's tagged click on Allow is dropped (§3.5 self-defence).
        assert!(!accept_prompt_click(PromptClick {
            tagged_injected: true,
            over_agent_window: true,
            physical_confirmed: false,
        }));
        // A physical click is accepted.
        assert!(accept_prompt_click(PromptClick {
            tagged_injected: false,
            over_agent_window: true,
            physical_confirmed: true,
        }));
        // A tagged click elsewhere is still not physical.
        assert!(!accept_prompt_click(PromptClick {
            tagged_injected: true,
            over_agent_window: false,
            physical_confirmed: false,
        }));
    }
}
