//! Live-session control serving (contract §5): turn a decrypted `ia.control` text frame into
//! a `ctl.res` and the OS effect, driving the `ia-platform` [`InputSink`] / [`ClipboardBridge`]
//! traits. The crypto framing is [`ia_core::secchan`] and the gating/parse is
//! [`ia_core::ctl`]; this is the seam that applies the resulting [`Action`] to Windows.
//!
//! It is platform-free (the traits are the seam), so it is built and unit-tested in every
//! gate with a mock sink. The binary's data-channel loop (behind `media`) owns the
//! `SecChannel`, calls [`ControlServer::handle_text`] per frame, seals the returned response
//! and feeds the §3.8 `control.input` aggregate.

use serde_json::Value;

use ia_core::consent::LiveConsent;
use ia_core::ctl::{dispatch, Action, CtlReq, DispatchCtx, KeyKind, PointerKind, ServiceGrade};
use ia_core::stats::{ControlInputAggregate, InputKind};
use ia_core::types::MonitorInfo;
use ia_platform::traits::{ClipboardBridge, InputSink, KeyAction, PointerAction};

/// A control request that produced a side effect the binary must act on beyond the OS input
/// the server already applied (level/elevation/monitor/quality/playbook).
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEffect {
    None,
    SelectMonitors(Vec<u32>),
    Quality(ia_core::types::QualityPreset),
    LevelRequest {
        reason: String,
    },
    ElevationRequest {
        reason: String,
    },
    PlaybookRun {
        run_id: String,
        playbook_id: String,
        body_hash: String,
        body: String,
        requires_elevation: bool,
    },
    PlaybookCancel {
        run_id: String,
    },
    /// §5.4: the local input lock was turned on or off. `applied` is what the platform sink
    /// actually did, so the serve loop reports the state the machine is really in rather than
    /// the state that was asked for.
    InputLock {
        locked: bool,
        applied: bool,
    },
    /// §5.4: the privacy screen was turned on or off (the overlay is the serve loop's).
    PrivacyScreen {
        on: bool,
    },
    /// §5.4 `os.sas`: the service must press Ctrl+Alt+Del.
    SendSas,
}

/// Serves `ia.control` for the Desk: holds the live consent and the consented monitors,
/// gates every op and applies OS input through the injected sink.
pub struct ControlServer {
    pub consent: LiveConsent,
    pub monitors: Vec<MonitorInfo>,
    pub secure_desktop: bool,
    pub input: ControlInputAggregate,
    /// Phase D (§5.4): the policy flags and what this build implements. `None` in a portable
    /// Phase C agent, which keeps answering `not_supported { phase_d }`.
    pub service: Option<ServiceGrade>,
    /// The live protection state, so §5.4d can be reported.
    pub input_locked: bool,
    pub privacy_screen: bool,
}

impl ControlServer {
    pub fn new(consent: LiveConsent, monitors: Vec<MonitorInfo>, viewed_monitor: u32) -> Self {
        let window_ms = 10_000;
        Self {
            consent,
            monitors,
            secure_desktop: false,
            input: ControlInputAggregate::new(window_ms, viewed_monitor),
            service: None,
            input_locked: false,
            privacy_screen: false,
        }
    }

    fn ctx(&self) -> DispatchCtx {
        DispatchCtx {
            level: self.consent.level,
            integrity: self.consent.integrity,
            clipboard_enabled: self.consent.clipboard_active(),
            consented_monitors: self.consent.consented_monitors.clone(),
            secure_desktop: self.secure_desktop,
            service: self.service,
        }
    }

    /// Rule 5.4d "fail-open release": every protection comes off on a level drop below
    /// `elevated`, on teardown, and on session end. Returns what was released so the caller can
    /// chain each with its cause.
    pub fn release_protections(&mut self, input_sink: &mut dyn InputSink) -> (bool, bool) {
        let released_lock = self.input_locked;
        let released_privacy = self.privacy_screen;
        if released_lock {
            input_sink.block_local_input(false);
            self.input_locked = false;
        }
        self.privacy_screen = false;
        (released_lock, released_privacy)
    }

    fn monitor(&self, id: u32) -> Option<&MonitorInfo> {
        self.monitors.iter().find(|m| m.id == id)
    }

    /// Handle one decrypted `ia.control` text frame. Returns the `ctl.res` JSON to seal back
    /// and the [`SessionEffect`] the binary must drive (input ops are applied here via the
    /// sinks). A frame that is not a `ctl.req` returns `None`.
    pub fn handle_text(
        &mut self,
        text: &str,
        input_sink: &mut dyn InputSink,
        clipboard: &mut dyn ClipboardBridge,
    ) -> Option<(Value, SessionEffect)> {
        let req = CtlReq::parse(text)?;
        let d = dispatch(&req, &self.ctx());
        // `ctl::dispatch` is platform-free and cannot know the real monitor geometry, so it
        // answers `os.monitors` with an empty `monitors` array (contract §5.1); the serve seam
        // fills in the consented monitors it holds so the console's monitor picker is populated.
        let mut response = d.response;
        if req.op == "os.monitors" {
            if let Some(result) = response.get_mut("result").and_then(|r| r.as_object_mut()) {
                if let Ok(monitors) = serde_json::to_value(&self.monitors) {
                    result.insert("monitors".to_string(), monitors);
                }
            }
        }
        // Phase E rule 7.3c: a sink that guards before injecting (X11) refuses an event aimed at
        // an agent window; it is answered `not_allowed` and counted as refused, as C §3.5 does.
        if self.sink_refuses(&d.action, input_sink) {
            if let Some(kind) = input_kind_of(&req.op) {
                self.input.record(kind, None, 0, true);
            }
            let response = ia_core::ctl::error_response(&req.id, "not_allowed", None);
            return Some((response, SessionEffect::None));
        }
        let effect = self.apply(&d.action, &req, input_sink, clipboard);
        Some((response, effect))
    }

    /// Whether the sink's pre-injection guard (rule 7.3c) refuses this input action.
    fn sink_refuses(&self, action: &Action, input_sink: &mut dyn InputSink) -> bool {
        match action {
            // A pointer release is let through: X delivers it to the window that took the
            // press (the implicit grab), never newly to an agent window, and refusing it would
            // leave a button held down on the Desk.
            Action::Pointer {
                kind: PointerKind::Up,
                ..
            } => false,
            Action::Pointer {
                monitor_id, nx, ny, ..
            }
            | Action::Scroll {
                monitor_id, nx, ny, ..
            } => match self.monitor(*monitor_id) {
                Some(m) => input_sink.refuses_pointer(m, *nx, *ny),
                None => false,
            },
            Action::Key { .. } | Action::Text { .. } => input_sink.refuses_keyboard(),
            _ => false,
        }
    }

    fn apply(
        &mut self,
        action: &Action,
        req: &CtlReq,
        input_sink: &mut dyn InputSink,
        clipboard: &mut dyn ClipboardBridge,
    ) -> SessionEffect {
        match action {
            Action::None => {
                // A refused input op is still counted in the aggregate (§3.8).
                if let Some(kind) = input_kind_of(&req.op) {
                    self.input.record(kind, None, 0, true);
                }
                SessionEffect::None
            }
            Action::Pointer {
                monitor_id,
                kind,
                nx,
                ny,
                button,
                ..
            } => {
                if let Some(m) = self.monitor(*monitor_id).cloned() {
                    input_sink.pointer(&m, *nx, *ny, pointer_action(*kind, *button));
                }
                self.input
                    .record(InputKind::Pointer, Some(*monitor_id), 0, false);
                SessionEffect::None
            }
            Action::Scroll {
                monitor_id,
                nx,
                ny,
                dx,
                dy,
            } => {
                if let Some(m) = self.monitor(*monitor_id).cloned() {
                    input_sink.scroll(&m, *nx, *ny, *dx, *dy);
                }
                self.input
                    .record(InputKind::Scroll, Some(*monitor_id), 0, false);
                SessionEffect::None
            }
            Action::Key {
                kind,
                code,
                modifiers,
                ..
            } => {
                input_sink.key(code, key_action(*kind), *modifiers);
                self.input.record(InputKind::Key, None, 0, false);
                SessionEffect::None
            }
            Action::Text { text } => {
                input_sink.text(text);
                self.input
                    .record(InputKind::Text, None, utf16_len(text), false);
                SessionEffect::None
            }
            Action::ClipboardSet { text } => {
                clipboard.set_text(text);
                SessionEffect::None
            }
            Action::SelectMonitors { monitor_ids } => {
                let _ = self.consent.select_monitors(monitor_ids);
                SessionEffect::SelectMonitors(monitor_ids.clone())
            }
            Action::Quality { preset } => SessionEffect::Quality(*preset),
            Action::LevelRequest { reason, .. } => SessionEffect::LevelRequest {
                reason: reason.clone(),
            },
            Action::ElevationRequest { reason } => SessionEffect::ElevationRequest {
                reason: reason.clone(),
            },
            Action::PlaybookRun {
                run_id,
                playbook_id,
                body_hash,
                body,
                requires_elevation,
            } => SessionEffect::PlaybookRun {
                run_id: run_id.clone(),
                playbook_id: playbook_id.clone(),
                body_hash: body_hash.clone(),
                body: body.clone(),
                requires_elevation: *requires_elevation,
            },
            Action::PlaybookCancel { run_id } => SessionEffect::PlaybookCancel {
                run_id: run_id.clone(),
            },
            Action::InputLock { locked } => {
                // The sink says whether the platform did it; a sink that cannot answers false
                // and the serve loop turns that into `not_supported` rather than claiming a
                // lock that is not in force.
                let applied = input_sink.block_local_input(*locked);
                if applied {
                    self.input_locked = *locked;
                }
                SessionEffect::InputLock {
                    locked: *locked,
                    applied,
                }
            }
            Action::PrivacyScreen { on } => {
                self.privacy_screen = *on;
                SessionEffect::PrivacyScreen { on: *on }
            }
            Action::SendSas => SessionEffect::SendSas,
        }
    }
}

fn input_kind_of(op: &str) -> Option<InputKind> {
    Some(match op {
        "os.pointer" => InputKind::Pointer,
        "os.scroll" => InputKind::Scroll,
        "os.key" | "os.nav" => InputKind::Key,
        "os.text" => InputKind::Text,
        _ => return None,
    })
}

fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

fn pointer_action(kind: PointerKind, button: u8) -> PointerAction {
    match kind {
        PointerKind::Move => PointerAction::Move,
        PointerKind::Down => PointerAction::Down(button),
        PointerKind::Up => PointerAction::Up(button),
        PointerKind::Click => PointerAction::Click(button),
        PointerKind::Dblclick => PointerAction::DblClick(button),
    }
}

fn key_action(kind: KeyKind) -> KeyAction {
    match kind {
        KeyKind::Down => KeyAction::Down,
        KeyKind::Up => KeyAction::Up,
        KeyKind::Press => KeyAction::Press,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ia_core::types::AgentConsentLevel;

    #[derive(Default)]
    struct MockSink {
        pointers: Vec<(u32, PointerAction)>,
        texts: Vec<String>,
        /// Rule 7.3c: refuse a pointer whose `nx` is past this (an "agent window" on the right).
        refuse_right_of: Option<f32>,
        focus_on_agent_window: bool,
    }
    impl InputSink for MockSink {
        fn pointer(&mut self, monitor: &MonitorInfo, _nx: f32, _ny: f32, action: PointerAction) {
            self.pointers.push((monitor.id, action));
        }
        fn scroll(&mut self, _m: &MonitorInfo, _nx: f32, _ny: f32, _dx: i32, _dy: i32) {}
        fn key(&mut self, _code: &str, _a: KeyAction, _m: ia_core::types::Modifiers) {}
        fn text(&mut self, text: &str) {
            self.texts.push(text.to_string());
        }
        fn refuses_pointer(&mut self, _m: &MonitorInfo, nx: f32, _ny: f32) -> bool {
            self.refuse_right_of.is_some_and(|edge| nx > edge)
        }
        fn refuses_keyboard(&mut self) -> bool {
            self.focus_on_agent_window
        }
    }

    #[derive(Default)]
    struct MockClip {
        set: Vec<String>,
    }
    impl ClipboardBridge for MockClip {
        fn set_text(&mut self, text: &str) {
            self.set.push(text.to_string());
        }
        fn take_update(&mut self) -> Option<String> {
            None
        }
    }

    fn mon(id: u32) -> MonitorInfo {
        MonitorInfo {
            id,
            name: format!("M{id}"),
            primary: id == 1,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            mid: None,
        }
    }

    fn server(level: AgentConsentLevel) -> ControlServer {
        let consent = LiveConsent::new(level, false, vec![1, 2]);
        ControlServer::new(consent, vec![mon(1), mon(2)], 1)
    }

    #[test]
    fn pointer_at_control_reaches_the_sink() {
        let mut s = server(AgentConsentLevel::Control);
        let mut sink = MockSink::default();
        let mut clip = MockClip::default();
        let (res, effect) = s
            .handle_text(
                r#"{"t":"ctl.req","id":"1","op":"os.pointer","args":{"monitorId":2,"kind":"click","nx":0.5,"ny":0.5,"button":0}}"#,
                &mut sink,
                &mut clip,
            )
            .unwrap();
        assert_eq!(res["ok"], serde_json::json!(true));
        assert_eq!(effect, SessionEffect::None);
        assert_eq!(sink.pointers, vec![(2, PointerAction::Click(0))]);
    }

    #[test]
    fn a_sink_guard_refusal_is_answered_not_allowed_and_counted() {
        // Phase E rule 7.3c: the X11 sink refuses before injecting; the answer is C §3.5's.
        let mut s = server(AgentConsentLevel::Control);
        let mut sink = MockSink {
            refuse_right_of: Some(0.8),
            ..Default::default()
        };
        let mut clip = MockClip::default();
        let req = |nx: f32| {
            format!(
                r#"{{"t":"ctl.req","id":"7","op":"os.pointer","args":{{"monitorId":1,"kind":"click","nx":{nx},"ny":0.5,"button":0}}}}"#
            )
        };
        let (res, effect) = s.handle_text(&req(0.9), &mut sink, &mut clip).unwrap();
        assert_eq!(res["ok"], serde_json::json!(false));
        assert_eq!(res["id"], serde_json::json!("7"));
        assert_eq!(res["error"]["code"], serde_json::json!("not_allowed"));
        assert_eq!(effect, SessionEffect::None);
        assert!(
            sink.pointers.is_empty(),
            "a refused event is never injected"
        );
        assert_eq!(s.input.to_chain()["refused"], serde_json::json!(1));
        // Outside the agent window the same click is injected.
        let (res, _) = s.handle_text(&req(0.2), &mut sink, &mut clip).unwrap();
        assert_eq!(res["ok"], serde_json::json!(true));
        assert_eq!(sink.pointers.len(), 1);
        // Text while an agent window holds focus is refused too.
        sink.focus_on_agent_window = true;
        let (res, _) = s
            .handle_text(
                r#"{"t":"ctl.req","id":"8","op":"os.text","args":{"text":"hi"}}"#,
                &mut sink,
                &mut clip,
            )
            .unwrap();
        assert_eq!(res["error"]["code"], serde_json::json!("not_allowed"));
        assert!(sink.texts.is_empty());
    }

    #[test]
    fn pointer_at_view_is_refused_and_not_injected() {
        let mut s = server(AgentConsentLevel::View);
        let mut sink = MockSink::default();
        let mut clip = MockClip::default();
        let (res, _) = s
            .handle_text(
                r#"{"t":"ctl.req","id":"1","op":"os.pointer","args":{"monitorId":1,"kind":"move","nx":0.1,"ny":0.1,"button":0}}"#,
                &mut sink,
                &mut clip,
            )
            .unwrap();
        assert_eq!(res["error"]["code"], serde_json::json!("not_allowed"));
        assert!(sink.pointers.is_empty());
        // The refusal is counted in the aggregate.
        assert_eq!(s.input.to_chain()["refused"], serde_json::json!(1));
    }

    #[test]
    fn text_injects_and_counts_utf16_units() {
        let mut s = server(AgentConsentLevel::Control);
        let mut sink = MockSink::default();
        let mut clip = MockClip::default();
        s.handle_text(
            r#"{"t":"ctl.req","id":"2","op":"os.text","args":{"text":"hi"}}"#,
            &mut sink,
            &mut clip,
        )
        .unwrap();
        assert_eq!(sink.texts, vec!["hi".to_string()]);
        assert_eq!(s.input.to_chain()["textChars"], serde_json::json!(2));
    }

    #[test]
    fn elevation_request_surfaces_as_an_effect() {
        let mut s = server(AgentConsentLevel::Control);
        let mut sink = MockSink::default();
        let mut clip = MockClip::default();
        let (_res, effect) = s
            .handle_text(
                r#"{"t":"ctl.req","id":"e","op":"elevation.request","args":{"reason":"driver"}}"#,
                &mut sink,
                &mut clip,
            )
            .unwrap();
        assert_eq!(
            effect,
            SessionEffect::ElevationRequest {
                reason: "driver".into()
            }
        );
    }

    #[test]
    fn os_monitors_response_carries_the_real_monitor_list() {
        let mut s = server(AgentConsentLevel::View);
        let mut sink = MockSink::default();
        let mut clip = MockClip::default();
        let (res, effect) = s
            .handle_text(
                r#"{"t":"ctl.req","id":"m","op":"os.monitors","args":{}}"#,
                &mut sink,
                &mut clip,
            )
            .unwrap();
        assert_eq!(res["ok"], serde_json::json!(true));
        assert_eq!(effect, SessionEffect::None);
        // The serve seam fills `monitors` (ctl::dispatch leaves it empty); the picker needs it.
        let monitors = res["result"]["monitors"]
            .as_array()
            .expect("monitors array");
        assert_eq!(monitors.len(), 2);
        assert_eq!(monitors[0]["id"], serde_json::json!(1));
        assert_eq!(monitors[1]["name"], serde_json::json!("M2"));
        assert_eq!(res["result"]["selected"], serde_json::json!([1, 2]));
    }

    #[test]
    fn clipboard_set_requires_the_switch() {
        let mut s = server(AgentConsentLevel::Control);
        let mut sink = MockSink::default();
        let mut clip = MockClip::default();
        // off by default => clipboard_off, nothing set
        let (res, _) = s
            .handle_text(
                r#"{"t":"ctl.req","id":"c","op":"clipboard.set","args":{"text":"x"}}"#,
                &mut sink,
                &mut clip,
            )
            .unwrap();
        assert_eq!(res["error"]["code"], serde_json::json!("clipboard_off"));
        assert!(clip.set.is_empty());
        // turn it on => applied
        s.consent.toggle_clipboard(true);
        let (res, _) = s
            .handle_text(
                r#"{"t":"ctl.req","id":"c2","op":"clipboard.set","args":{"text":"y"}}"#,
                &mut sink,
                &mut clip,
            )
            .unwrap();
        assert_eq!(res["ok"], serde_json::json!(true));
        assert_eq!(clip.set, vec!["y".to_string()]);
    }
}
