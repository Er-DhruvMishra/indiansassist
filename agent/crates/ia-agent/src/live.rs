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
use ia_core::ctl::{dispatch, Action, CtlReq, DispatchCtx, KeyKind, PointerKind};
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
}

/// Serves `ia.control` for the Desk: holds the live consent and the consented monitors,
/// gates every op and applies OS input through the injected sink.
pub struct ControlServer {
    pub consent: LiveConsent,
    pub monitors: Vec<MonitorInfo>,
    pub secure_desktop: bool,
    pub input: ControlInputAggregate,
}

impl ControlServer {
    pub fn new(consent: LiveConsent, monitors: Vec<MonitorInfo>, viewed_monitor: u32) -> Self {
        let window_ms = 10_000;
        Self {
            consent,
            monitors,
            secure_desktop: false,
            input: ControlInputAggregate::new(window_ms, viewed_monitor),
        }
    }

    fn ctx(&self) -> DispatchCtx {
        DispatchCtx {
            level: self.consent.level,
            integrity: self.consent.integrity,
            clipboard_enabled: self.consent.clipboard_active(),
            consented_monitors: self.consent.consented_monitors.clone(),
            secure_desktop: self.secure_desktop,
        }
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
        let effect = self.apply(&d.action, &req, input_sink, clipboard);
        Some((d.response, effect))
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
        assert_eq!(res["error"], serde_json::json!("not_allowed"));
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
        assert_eq!(res["error"], serde_json::json!("clipboard_off"));
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
