//! Encrypted `ia.control` request dispatch (contract §5.1): parse a `ctl.req`, gate it by
//! the live consent level (`view | control | elevated`), the Desk clipboard toggle, the
//! consented-monitor set and the secure-desktop state, and return the `ctl.res` plus the
//! side effect to perform. Pure: the actual `SendInput` / clipboard / capture calls live in
//! the `-win` crates and are driven from the agent binary by matching on [`Action`].
//!
//! The error codes are exactly `CONTROL_ERROR_CODES` + the §5.1 additions
//! ([`crate::control::AGENT_CONTROL_ERROR_CODES`]).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::control::{agent_min_level_for, is_agent_control_op};
use crate::types::{
    agent_level_at_least, AgentConsentLevel, ElevationLevel, Modifiers, QualityPreset,
};

/// A parsed `ctl.req` (contract §5.1 envelope). `args` stays a `Value` and is interpreted
/// per op by [`dispatch`].
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CtlReq {
    pub id: String,
    pub op: String,
    #[serde(default)]
    pub args: Value,
}

impl CtlReq {
    /// Parse a `ctl.req` frame; `None` when `t` is not `ctl.req` or the shape is wrong.
    pub fn parse(json_text: &str) -> Option<CtlReq> {
        let v: Value = serde_json::from_str(json_text).ok()?;
        if v.get("t").and_then(|t| t.as_str()) != Some("ctl.req") {
            return None;
        }
        let id = v.get("id")?.as_str()?.to_string();
        let op = v.get("op")?.as_str()?.to_string();
        let args = v.get("args").cloned().unwrap_or(Value::Null);
        Some(CtlReq { id, op, args })
    }
}

/// The side effect a successful (or event-driven) op asks the agent to perform. The pure
/// dispatcher decides *whether* and *what*; the binary performs it on the OS.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Reply only (e.g. `os.monitors`, a `not_supported` op): nothing to do on the OS.
    None,
    Pointer {
        monitor_id: u32,
        kind: PointerKind,
        nx: f32,
        ny: f32,
        button: u8,
        modifiers: Modifiers,
    },
    Scroll {
        monitor_id: u32,
        nx: f32,
        ny: f32,
        dx: i32,
        dy: i32,
    },
    Key {
        kind: KeyKind,
        key: String,
        code: String,
        modifiers: Modifiers,
    },
    Text {
        text: String,
    },
    ClipboardSet {
        text: String,
    },
    SelectMonitors {
        monitor_ids: Vec<u32>,
    },
    Quality {
        preset: QualityPreset,
    },
    /// Assist asks for `control` (shows the Allow/Refuse card, §3.4).
    LevelRequest {
        level: AgentConsentLevel,
        reason: String,
    },
    /// Assist asks for admin rights (shows the elevation card, §7.3; in P4 the level is
    /// raised in place with no relaunch, §5.2 / W32).
    ElevationRequest {
        reason: String,
    },
    /// §5.4 `os.input_lock`: block the local keyboard and mouse while the technician works.
    /// Only a service-tier worker produces this; a portable agent answers `not_supported`.
    InputLock {
        locked: bool,
    },
    /// §5.4 `os.privacy_screen`: blank the physical monitors behind a branded overlay.
    PrivacyScreen {
        on: bool,
    },
    /// §5.4 `os.sas`: press Ctrl+Alt+Del through the service's `SendSAS`. No process can
    /// inject it (C §5.4), so the worker asks the service over the §4.2 pipe.
    SendSas,
    /// A validated run op to hand to the playbook runner (§8.4).
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerKind {
    Move,
    Down,
    Up,
    Click,
    Dblclick,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyKind {
    Down,
    Up,
    Press,
}

/// The live context the dispatcher gates against (contract §3.4, §5.5).
#[derive(Debug, Clone)]
pub struct DispatchCtx {
    pub level: AgentConsentLevel,
    pub integrity: ElevationLevel,
    /// Desk clipboard switch (default off, §3.3/§5.6).
    pub clipboard_enabled: bool,
    /// Monitors the Desk consented to and that currently exist (ids).
    pub consented_monitors: Vec<u32>,
    /// True while the UAC secure desktop is up: every input/capture op answers `secure_desktop`.
    pub secure_desktop: bool,
    /// `Some` only in a Phase D desktop worker (D §5.4). A portable Phase C agent leaves it
    /// `None` and the service-grade ops keep answering `not_supported { phase_d }`, which is
    /// what the console greys its buttons by.
    pub service: Option<ServiceGrade>,
}

/// What a service-tier worker may do (D §5.4): the policy flags, and what this build actually
/// implements. A feature that is not built answers `not_supported` and is not advertised, so a
/// technician never sees a live button that fails when pressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ServiceGrade {
    /// `allowInputLock` of the effective policy (rule 5.4a).
    pub allow_input_lock: bool,
    /// `allowPrivacyScreen` of the effective policy (rule 5.4a).
    pub allow_privacy_screen: bool,
    /// Whether this build has the local input lock (`BlockInput`).
    pub input_lock_built: bool,
    /// Whether this build has the privacy-screen overlay.
    pub privacy_screen_built: bool,
    /// Whether the service could reach `SendSAS` on this machine.
    pub sas_built: bool,
}

impl DispatchCtx {
    fn has_monitor(&self, id: u32) -> bool {
        self.consented_monitors.contains(&id)
    }
}

/// The dispatch outcome: the `ctl.res` JSON to seal back and the [`Action`] to perform.
#[derive(Debug, Clone, PartialEq)]
pub struct Dispatched {
    pub response: Value,
    pub action: Action,
    /// `true` when the op was refused (counts as `refused` in the §3.8 `control.input` aggregate).
    pub refused: bool,
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A successful `ctl.res` in the exact shared shape (`controlResponseSchema`, strict):
/// `{ t, id, ok: true, result, ts }`. The console drops a response without `ts`.
pub fn ok_response(id: &str, result: Value) -> Value {
    json!({ "t": "ctl.res", "id": id, "ok": true, "result": result, "ts": now_ms() })
}

/// A refused `ctl.res` in the exact shared shape: `{ t, id, ok: false, error: { code, message },
/// ts }` (the B §5.1 envelope reused by P3; `message` is at most 200 chars, empty when none).
pub fn error_response(id: &str, code: &str, message: Option<&str>) -> Value {
    let message: String = message.unwrap_or("").chars().take(200).collect();
    json!({
        "t": "ctl.res", "id": id, "ok": false,
        "error": { "code": code, "message": message },
        "ts": now_ms(),
    })
}

/// The error code of a `ctl.res` built by [`error_response`] (`None` for a success).
pub fn error_code(res: &Value) -> Option<&str> {
    res.get("error")
        .and_then(|e| e.get("code"))
        .and_then(|c| c.as_str())
}

fn ok_res(id: &str, result: Value) -> Value {
    ok_response(id, result)
}

fn err_res(id: &str, code: &str, message: Option<&str>) -> Value {
    error_response(id, code, message)
}

fn refused(id: &str, code: &str, message: Option<&str>) -> Dispatched {
    Dispatched {
        response: err_res(id, code, message),
        action: Action::None,
        refused: true,
    }
}

fn modifiers_of(args: &Value) -> Modifiers {
    serde_json::from_value(args.get("modifiers").cloned().unwrap_or(Value::Null))
        .unwrap_or_default()
}

/// Dispatch one request against the live context (contract §5.1). Never panics; a malformed
/// op or args answers `bad_args`, an unknown op `not_supported`.
pub fn dispatch(req: &CtlReq, ctx: &DispatchCtx) -> Dispatched {
    let id = req.id.as_str();

    if !is_agent_control_op(&req.op) {
        return Dispatched {
            response: err_res(id, "not_supported", None),
            action: Action::None,
            refused: false,
        };
    }

    // `requiresElevation` only matters for playbook.run's min level.
    let requires_elevation = req
        .args
        .get("requiresElevation")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let min_level = match agent_min_level_for(&req.op, requires_elevation) {
        Some(l) => l,
        None => return refused(id, "not_supported", None),
    };

    // Level gate first (contract §5.1 "refused with not_allowed below control").
    if !agent_level_at_least(ctx.level, min_level) {
        let code = if min_level == AgentConsentLevel::Elevated && req.op == "playbook.run" {
            "elevation_required"
        } else {
            "not_allowed"
        };
        return refused(id, code, None);
    }

    // The secure desktop blocks every input/capture-affecting op (§5.5).
    if ctx.secure_desktop && is_input_op(&req.op) {
        return refused(id, "secure_desktop", None);
    }

    match req.op.as_str() {
        "os.monitors" => Dispatched {
            response: ok_res(
                id,
                json!({ "monitors": [], "selected": ctx.consented_monitors }),
            ),
            action: Action::None,
            refused: false,
        },
        "os.monitor.select" => dispatch_monitor_select(id, &req.args, ctx),
        "os.quality" => dispatch_quality(id, &req.args),
        "os.pointer" => dispatch_pointer(id, &req.args, ctx),
        "os.scroll" => dispatch_scroll(id, &req.args, ctx),
        "os.key" => dispatch_key(id, &req.args),
        "os.text" => dispatch_text(id, &req.args),
        "os.nav" => refused(id, "not_supported", Some("nav")),
        "clipboard.set" => dispatch_clipboard_set(id, &req.args, ctx),
        "os.input_lock" => dispatch_input_lock(id, &req.args, ctx),
        "os.privacy_screen" => dispatch_privacy_screen(id, &req.args, ctx),
        "os.sas" => dispatch_sas(id, ctx),
        "level.request" => dispatch_level_request(id, &req.args),
        "elevation.request" => dispatch_elevation_request(id, &req.args),
        "playbook.run" => dispatch_playbook_run(id, req, ctx),
        "playbook.cancel" => dispatch_playbook_cancel(id, &req.args),
        _ => refused(id, "not_supported", None),
    }
}

/// Rule 5.4a / §5.5: a service-grade op is refused with `not_supported { phase_d }` on a
/// portable agent, `not_supported { <feature> }` on a service build that does not implement it,
/// and `not_allowed` when the policy flag is false. The distinction matters to a technician:
/// the first two say "this machine cannot", the third says "this machine may not" — and only
/// the third can be fixed by an org_admin changing the policy.
fn service_gate(
    id: &str,
    ctx: &DispatchCtx,
    allowed: bool,
    built: bool,
    what: &str,
) -> Option<Dispatched> {
    let Some(_) = ctx.service else {
        return Some(refused(id, "not_supported", Some("phase_d")));
    };
    if !built {
        return Some(refused(id, "not_supported", Some(what)));
    }
    if !allowed {
        return Some(refused(id, "not_allowed", None));
    }
    None
}

fn dispatch_input_lock(id: &str, args: &Value, ctx: &DispatchCtx) -> Dispatched {
    let s = ctx.service.unwrap_or_default();
    if let Some(refusal) = service_gate(
        id,
        ctx,
        s.allow_input_lock,
        s.input_lock_built,
        "input_lock",
    ) {
        return refusal;
    }
    match args.get("locked").and_then(Value::as_bool) {
        Some(locked) => Dispatched {
            response: ok_res(id, json!({ "locked": locked })),
            action: Action::InputLock { locked },
            refused: false,
        },
        None => refused(id, "bad_args", None),
    }
}

fn dispatch_privacy_screen(id: &str, args: &Value, ctx: &DispatchCtx) -> Dispatched {
    let s = ctx.service.unwrap_or_default();
    if let Some(refusal) = service_gate(
        id,
        ctx,
        s.allow_privacy_screen,
        s.privacy_screen_built,
        "privacy_screen",
    ) {
        return refusal;
    }
    match args.get("on").and_then(Value::as_bool) {
        Some(on) => Dispatched {
            response: ok_res(id, json!({ "on": on })),
            action: Action::PrivacyScreen { on },
            refused: false,
        },
        None => refused(id, "bad_args", None),
    }
}

fn dispatch_sas(id: &str, ctx: &DispatchCtx) -> Dispatched {
    let s = ctx.service.unwrap_or_default();
    // `os.sas` has no policy flag of its own: it is reached through privileged mode, which
    // `allowPrivileged` already gates (rule 5.2a).
    if let Some(refusal) = service_gate(id, ctx, true, s.sas_built, "sas") {
        return refusal;
    }
    Dispatched {
        response: ok_res(id, json!({})),
        action: Action::SendSas,
        refused: false,
    }
}

fn is_input_op(op: &str) -> bool {
    matches!(
        op,
        "os.pointer" | "os.scroll" | "os.key" | "os.text" | "os.nav" | "clipboard.set"
    )
}

fn dispatch_monitor_select(id: &str, args: &Value, ctx: &DispatchCtx) -> Dispatched {
    let ids: Vec<u32> = match args.get("monitorIds").and_then(|v| v.as_array()) {
        Some(a) => a
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as u32))
            .collect(),
        None => return refused(id, "bad_args", None),
    };
    if ids.is_empty() || ids.iter().any(|m| !ctx.has_monitor(*m)) {
        return refused(id, "no_such_monitor", None);
    }
    Dispatched {
        response: ok_res(id, json!({ "selected": ids })),
        action: Action::SelectMonitors { monitor_ids: ids },
        refused: false,
    }
}

fn dispatch_quality(id: &str, args: &Value) -> Dispatched {
    let preset: Option<QualityPreset> =
        serde_json::from_value(args.get("preset").cloned().unwrap_or(Value::Null)).ok();
    match preset {
        Some(preset) => Dispatched {
            response: ok_res(
                id,
                json!({ "preset": preset, "rung": serde_json::Value::Null }),
            ),
            action: Action::Quality { preset },
            refused: false,
        },
        None => refused(id, "bad_args", None),
    }
}

fn dispatch_pointer(id: &str, args: &Value, ctx: &DispatchCtx) -> Dispatched {
    let monitor_id = match args.get("monitorId").and_then(|v| v.as_u64()) {
        Some(n) => n as u32,
        None => return refused(id, "bad_args", None),
    };
    if !ctx.has_monitor(monitor_id) {
        return refused(id, "no_such_monitor", None);
    }
    let kind: Option<PointerKind> =
        serde_json::from_value(args.get("kind").cloned().unwrap_or(Value::Null)).ok();
    let (Some(kind), Some(nx), Some(ny)) = (
        kind,
        args.get("nx").and_then(|v| v.as_f64()),
        args.get("ny").and_then(|v| v.as_f64()),
    ) else {
        return refused(id, "bad_args", None);
    };
    let button = args.get("button").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
    if button > 4 {
        return refused(id, "bad_args", None);
    }
    Dispatched {
        response: ok_res(id, json!({})),
        action: Action::Pointer {
            monitor_id,
            kind,
            nx: nx as f32,
            ny: ny as f32,
            button,
            modifiers: modifiers_of(args),
        },
        refused: false,
    }
}

fn dispatch_scroll(id: &str, args: &Value, ctx: &DispatchCtx) -> Dispatched {
    let monitor_id = match args.get("monitorId").and_then(|v| v.as_u64()) {
        Some(n) => n as u32,
        None => return refused(id, "bad_args", None),
    };
    if !ctx.has_monitor(monitor_id) {
        return refused(id, "no_such_monitor", None);
    }
    let (Some(nx), Some(ny), Some(dx), Some(dy)) = (
        args.get("nx").and_then(|v| v.as_f64()),
        args.get("ny").and_then(|v| v.as_f64()),
        args.get("dx").and_then(|v| v.as_i64()),
        args.get("dy").and_then(|v| v.as_i64()),
    ) else {
        return refused(id, "bad_args", None);
    };
    if !(-20..=20).contains(&dx) || !(-20..=20).contains(&dy) {
        return refused(id, "bad_args", None);
    }
    Dispatched {
        response: ok_res(id, json!({})),
        action: Action::Scroll {
            monitor_id,
            nx: nx as f32,
            ny: ny as f32,
            dx: dx as i32,
            dy: dy as i32,
        },
        refused: false,
    }
}

fn dispatch_key(id: &str, args: &Value) -> Dispatched {
    let kind: Option<KeyKind> =
        serde_json::from_value(args.get("kind").cloned().unwrap_or(Value::Null)).ok();
    let (Some(kind), Some(key), Some(code)) = (
        kind,
        args.get("key").and_then(|v| v.as_str()),
        args.get("code").and_then(|v| v.as_str()),
    ) else {
        return refused(id, "bad_args", None);
    };
    if key.is_empty() || key.len() > 64 || code.is_empty() || code.len() > 64 {
        return refused(id, "bad_args", None);
    }
    let modifiers = modifiers_of(args);
    // The SAS combination (Ctrl+Alt+Delete) cannot be injected (§5.4).
    if code == "Delete" && modifiers.ctrl && modifiers.alt {
        return Dispatched {
            response: err_res(id, "not_supported", Some("sas")),
            action: Action::None,
            refused: true,
        };
    }
    Dispatched {
        response: ok_res(id, json!({})),
        action: Action::Key {
            kind,
            key: key.to_string(),
            code: code.to_string(),
            modifiers,
        },
        refused: false,
    }
}

fn dispatch_text(id: &str, args: &Value) -> Dispatched {
    let text = match args.get("text").and_then(|v| v.as_str()) {
        Some(t) if !t.is_empty() && t.chars().count() <= 1024 => t.to_string(),
        _ => return refused(id, "bad_args", None),
    };
    Dispatched {
        response: ok_res(id, json!({})),
        action: Action::Text { text },
        refused: false,
    }
}

fn dispatch_clipboard_set(id: &str, args: &Value, ctx: &DispatchCtx) -> Dispatched {
    if !ctx.clipboard_enabled {
        return refused(id, "clipboard_off", None);
    }
    let text = match args.get("text").and_then(|v| v.as_str()) {
        Some(t) if t.len() <= crate::types::limits::CLIPBOARD_MAX_BYTES => t.to_string(),
        _ => return refused(id, "bad_args", None),
    };
    Dispatched {
        response: ok_res(id, json!({})),
        action: Action::ClipboardSet { text },
        refused: false,
    }
}

fn dispatch_level_request(id: &str, args: &Value) -> Dispatched {
    // `level.request` accepts only `control` for the agent; `elevated` answers bad_args (§3.4).
    let level: Option<AgentConsentLevel> =
        serde_json::from_value(args.get("level").cloned().unwrap_or(Value::Null)).ok();
    let reason = args
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    match level {
        Some(AgentConsentLevel::Control) => Dispatched {
            response: ok_res(id, json!({ "level": "control" })),
            action: Action::LevelRequest {
                level: AgentConsentLevel::Control,
                reason,
            },
            refused: false,
        },
        _ => refused(id, "bad_args", None),
    }
}

fn dispatch_elevation_request(id: &str, args: &Value) -> Dispatched {
    let reason = match args.get("reason").and_then(|v| v.as_str()) {
        Some(r) if !r.is_empty() && r.chars().count() <= 500 => r.to_string(),
        _ => return refused(id, "bad_args", None),
    };
    Dispatched {
        // The op returns `{ accepted: true }` at once; the outcome is event-driven (§7.3).
        response: ok_res(id, json!({ "accepted": true })),
        action: Action::ElevationRequest { reason },
        refused: false,
    }
}

/// `true` if `s` is exactly `n` lower-case hex characters (contract §8.4 `runId`/`bodyHash`).
fn is_hex_lower(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `true` if `s` is a canonical lower/upper-hex UUID (8-4-4-4-12, contract §8.4 `playbookId`).
fn is_uuid(s: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == groups.len()
        && parts
            .iter()
            .zip(groups)
            .all(|(p, g)| p.len() == g && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn dispatch_playbook_run(id: &str, req: &CtlReq, _ctx: &DispatchCtx) -> Dispatched {
    let args = &req.args;
    let (Some(run_id), Some(playbook_id), Some(body_hash), Some(body)) = (
        args.get("runId").and_then(|v| v.as_str()),
        args.get("playbookId").and_then(|v| v.as_str()),
        args.get("bodyHash").and_then(|v| v.as_str()),
        args.get("body").and_then(|v| v.as_str()),
    ) else {
        return refused(id, "bad_args", None);
    };
    // `ctl.req.id` must equal `runId` (contract §8.4, so both reporters pair on opId).
    if req.id != run_id {
        return refused(id, "bad_args", None);
    }
    // Identifier shapes (contract §8.4, security C6): `runId` is 32 lower-case hex, `playbookId`
    // a UUID, `bodyHash` 64 lower-case hex. These are used as `opId`/path components downstream,
    // so a bad shape is refused here before anything touches the filesystem.
    if !is_hex_lower(run_id, 32) || !is_uuid(playbook_id) || !is_hex_lower(body_hash, 64) {
        return refused(id, "bad_args", None);
    }
    let requires_elevation = args
        .get("requiresElevation")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Dispatched {
        response: ok_res(id, json!({ "accepted": true })),
        action: Action::PlaybookRun {
            run_id: run_id.to_string(),
            playbook_id: playbook_id.to_string(),
            body_hash: body_hash.to_string(),
            body: body.to_string(),
            requires_elevation,
        },
        refused: false,
    }
}

fn dispatch_playbook_cancel(id: &str, args: &Value) -> Dispatched {
    let run_id = match args.get("runId").and_then(|v| v.as_str()) {
        Some(r) if is_hex_lower(r, 32) => r.to_string(),
        _ => return refused(id, "bad_args", None),
    };
    // `ctl.req.id` must equal `runId + ":cancel"` (contract §8.4).
    if id != format!("{run_id}:cancel") {
        return refused(id, "bad_args", None);
    }
    Dispatched {
        response: ok_res(id, json!({ "cancelled": true })),
        action: Action::PlaybookCancel { run_id },
        refused: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(level: AgentConsentLevel) -> DispatchCtx {
        DispatchCtx {
            level,
            integrity: ElevationLevel::User,
            clipboard_enabled: false,
            consented_monitors: vec![1, 2],
            secure_desktop: false,
            // A portable Phase C agent: the service-grade ops stay `not_supported`.
            service: None,
        }
    }

    /// A Phase D worker's context, with the policy flags and what this build implements.
    fn worker_ctx(level: AgentConsentLevel, service: ServiceGrade) -> DispatchCtx {
        DispatchCtx {
            service: Some(service),
            ..ctx(level)
        }
    }

    fn all_built(allow_lock: bool, allow_privacy: bool) -> ServiceGrade {
        ServiceGrade {
            allow_input_lock: allow_lock,
            allow_privacy_screen: allow_privacy,
            input_lock_built: true,
            privacy_screen_built: true,
            sas_built: true,
        }
    }

    #[test]
    fn the_service_grade_ops_stay_phase_d_on_a_portable_agent() {
        let cx = ctx(AgentConsentLevel::Elevated);
        for (op, args) in [
            ("os.input_lock", json!({ "locked": true })),
            ("os.privacy_screen", json!({ "on": true })),
            ("os.sas", json!({})),
        ] {
            let d = dispatch(&req(op, "l", args), &cx);
            assert!(d.refused, "{op} must be refused on a portable agent");
            assert_eq!(d.response["error"]["code"], "not_supported");
            assert_eq!(d.response["error"]["message"], "phase_d");
        }
    }

    #[test]
    fn a_worker_locks_input_when_the_policy_allows_it() {
        let cx = worker_ctx(AgentConsentLevel::Elevated, all_built(true, true));
        let d = dispatch(&req("os.input_lock", "l", json!({ "locked": true })), &cx);
        assert!(!d.refused);
        assert_eq!(d.action, Action::InputLock { locked: true });
        assert_eq!(d.response["result"]["locked"], true);
        let off = dispatch(&req("os.input_lock", "l", json!({ "locked": false })), &cx);
        assert_eq!(off.action, Action::InputLock { locked: false });
    }

    #[test]
    fn a_policy_that_forbids_a_protection_answers_not_allowed_not_not_supported() {
        let cx = worker_ctx(AgentConsentLevel::Elevated, all_built(false, false));
        for (op, args) in [
            ("os.input_lock", json!({ "locked": true })),
            ("os.privacy_screen", json!({ "on": true })),
        ] {
            let d = dispatch(&req(op, "l", args), &cx);
            assert!(d.refused);
            assert_eq!(d.response["error"]["code"], "not_allowed", "{op}");
        }
    }

    #[test]
    fn a_protection_this_build_does_not_implement_says_so_rather_than_claiming_policy() {
        let service = ServiceGrade {
            allow_input_lock: true,
            allow_privacy_screen: true,
            input_lock_built: true,
            privacy_screen_built: false,
            sas_built: false,
        };
        let cx = worker_ctx(AgentConsentLevel::Elevated, service);
        let d = dispatch(&req("os.privacy_screen", "p", json!({ "on": true })), &cx);
        assert_eq!(d.response["error"]["code"], "not_supported");
        assert_eq!(d.response["error"]["message"], "privacy_screen");
        let s = dispatch(&req("os.sas", "s", json!({})), &cx);
        assert_eq!(s.response["error"]["code"], "not_supported");
        assert_eq!(s.response["error"]["message"], "sas");
    }

    #[test]
    fn every_service_grade_op_needs_privileged_mode() {
        let cx = worker_ctx(AgentConsentLevel::Control, all_built(true, true));
        for (op, args) in [
            ("os.input_lock", json!({ "locked": true })),
            ("os.privacy_screen", json!({ "on": true })),
            ("os.sas", json!({})),
        ] {
            let d = dispatch(&req(op, "l", args), &cx);
            assert!(d.refused, "{op} at control must be refused");
            // C §5.1: below the minimum level the code is `not_allowed`, the same code rule
            // 5.4a uses for a policy refusal. The console shows the op as unavailable either
            // way; the audit chain is where the two are told apart.
            assert_eq!(d.response["error"]["code"], "not_allowed", "{op}");
        }
    }

    #[test]
    fn the_sas_op_takes_no_arguments_and_asks_the_service_to_press_it() {
        let cx = worker_ctx(AgentConsentLevel::Elevated, all_built(false, false));
        let d = dispatch(&req("os.sas", "s", json!({})), &cx);
        assert!(
            !d.refused,
            "os.sas is gated by privileged mode, not by the lock flags"
        );
        assert_eq!(d.action, Action::SendSas);
    }

    #[test]
    fn a_malformed_protection_request_is_bad_args() {
        let cx = worker_ctx(AgentConsentLevel::Elevated, all_built(true, true));
        assert_eq!(
            dispatch(&req("os.input_lock", "l", json!({})), &cx).response["error"]["code"],
            "bad_args"
        );
        assert_eq!(
            dispatch(&req("os.privacy_screen", "p", json!({ "on": "yes" })), &cx).response["error"]
                ["code"],
            "bad_args"
        );
    }

    fn req(op: &str, id: &str, args: Value) -> CtlReq {
        CtlReq {
            id: id.into(),
            op: op.into(),
            args,
        }
    }

    #[test]
    fn parse_ctl_req() {
        let r = CtlReq::parse(r#"{"t":"ctl.req","id":"7","op":"os.monitors","args":{}}"#).unwrap();
        assert_eq!(r.op, "os.monitors");
        assert_eq!(r.id, "7");
        assert!(CtlReq::parse(r#"{"t":"ctl.res","id":"7"}"#).is_none());
    }

    #[test]
    fn os_monitors_allowed_at_view() {
        let d = dispatch(
            &req("os.monitors", "1", json!({})),
            &ctx(AgentConsentLevel::View),
        );
        assert_eq!(d.response["ok"], json!(true));
        assert_eq!(d.action, Action::None);
        assert!(!d.refused);
    }

    #[test]
    fn pointer_needs_control_and_is_refused_at_view() {
        let p = req(
            "os.pointer",
            "9",
            json!({ "monitorId": 1, "kind": "move", "nx": 0.5, "ny": 0.5 }),
        );
        // view => not_allowed
        let d = dispatch(&p, &ctx(AgentConsentLevel::View));
        assert_eq!(d.response["error"]["code"], json!("not_allowed"));
        assert!(d.refused);
        // control => an InjectPointer action and ok
        let d = dispatch(&p, &ctx(AgentConsentLevel::Control));
        assert_eq!(d.response["ok"], json!(true));
        assert!(matches!(d.action, Action::Pointer { monitor_id: 1, .. }));
    }

    #[test]
    fn pointer_on_unconsented_monitor_is_no_such_monitor() {
        let p = req(
            "os.pointer",
            "9",
            json!({ "monitorId": 7, "kind": "move", "nx": 0.5, "ny": 0.5 }),
        );
        let d = dispatch(&p, &ctx(AgentConsentLevel::Control));
        assert_eq!(d.response["error"]["code"], json!("no_such_monitor"));
    }

    #[test]
    fn clipboard_set_gated_on_the_desk_switch() {
        let c = req("clipboard.set", "3", json!({ "text": "hi" }));
        let d = dispatch(&c, &ctx(AgentConsentLevel::Control));
        assert_eq!(d.response["error"]["code"], json!("clipboard_off"));
        let mut cx = ctx(AgentConsentLevel::Control);
        cx.clipboard_enabled = true;
        let d = dispatch(&c, &cx);
        assert_eq!(d.response["ok"], json!(true));
        assert!(matches!(d.action, Action::ClipboardSet { .. }));
    }

    #[test]
    fn secure_desktop_blocks_input_only() {
        let mut cx = ctx(AgentConsentLevel::Control);
        cx.secure_desktop = true;
        let p = req(
            "os.pointer",
            "9",
            json!({ "monitorId": 1, "kind": "click", "nx": 0.1, "ny": 0.1 }),
        );
        assert_eq!(
            dispatch(&p, &cx).response["error"]["code"],
            json!("secure_desktop")
        );
        // os.monitors is not an input op, so it still works.
        assert_eq!(
            dispatch(&req("os.monitors", "1", json!({})), &cx).response["ok"],
            json!(true)
        );
    }

    #[test]
    fn ctrl_alt_delete_is_not_supported() {
        let k = req(
            "os.key",
            "k",
            json!({ "kind": "press", "key": "Delete", "code": "Delete",
                    "modifiers": { "ctrl": true, "shift": false, "alt": true, "meta": false } }),
        );
        let d = dispatch(&k, &ctx(AgentConsentLevel::Control));
        assert_eq!(d.response["error"]["code"], json!("not_supported"));
        assert_eq!(d.response["error"]["message"], json!("sas"));
    }

    #[test]
    fn input_lock_and_privacy_answer_phase_d() {
        let mut cx = ctx(AgentConsentLevel::Elevated);
        cx.integrity = ElevationLevel::Admin;
        let d = dispatch(&req("os.input_lock", "l", json!({ "locked": true })), &cx);
        assert_eq!(d.response["error"]["code"], json!("not_supported"));
        assert_eq!(d.response["error"]["message"], json!("phase_d"));
    }

    #[test]
    fn unknown_op_is_not_supported_and_not_counted_refused() {
        let d = dispatch(
            &req("tab.list", "t", json!({})),
            &ctx(AgentConsentLevel::Control),
        );
        assert_eq!(d.response["error"]["code"], json!("not_supported"));
        assert!(!d.refused);
    }

    #[test]
    fn elevation_request_requires_control_and_accepts_at_once() {
        let r = req(
            "elevation.request",
            "e",
            json!({ "reason": "install a driver" }),
        );
        assert_eq!(
            dispatch(&r, &ctx(AgentConsentLevel::View)).response["error"]["code"],
            json!("not_allowed")
        );
        let d = dispatch(&r, &ctx(AgentConsentLevel::Control));
        assert_eq!(d.response["result"]["accepted"], json!(true));
        assert!(matches!(d.action, Action::ElevationRequest { .. }));
    }

    #[test]
    fn playbook_run_requires_elevated_when_flagged_and_id_must_equal_run_id() {
        let run_id = "ab".repeat(16);
        let pb_id = "11111111-1111-1111-1111-111111111111";
        let body_hash = "cd".repeat(32);
        let good = req(
            "playbook.run",
            &run_id,
            json!({ "runId": run_id, "playbookId": pb_id, "bodyHash": body_hash, "body": "echo",
                    "requiresElevation": false }),
        );
        let d = dispatch(&good, &ctx(AgentConsentLevel::Control));
        assert!(matches!(d.action, Action::PlaybookRun { .. }));

        // requiresElevation at control => elevation_required
        let needs = req(
            "playbook.run",
            &run_id,
            json!({ "runId": run_id, "playbookId": pb_id, "bodyHash": body_hash, "body": "x",
                    "requiresElevation": true }),
        );
        assert_eq!(
            dispatch(&needs, &ctx(AgentConsentLevel::Control)).response["error"]["code"],
            json!("elevation_required")
        );

        // ctl.req.id != runId => bad_args
        let mismatched = req(
            "playbook.run",
            "wrong",
            json!({ "runId": run_id, "playbookId": pb_id, "bodyHash": body_hash, "body": "x",
                    "requiresElevation": false }),
        );
        assert_eq!(
            dispatch(&mismatched, &ctx(AgentConsentLevel::Control)).response["error"]["code"],
            json!("bad_args")
        );

        // A bad identifier shape (non-hex runId / non-UUID playbookId / short bodyHash) is
        // refused with bad_args before anything runs (security C6).
        let bad_shapes = [
            json!({ "runId": run_id, "playbookId": "not-a-uuid", "bodyHash": body_hash, "body": "x", "requiresElevation": false }),
            json!({ "runId": run_id, "playbookId": pb_id, "bodyHash": "short", "body": "x", "requiresElevation": false }),
        ];
        for args in bad_shapes {
            let r = req("playbook.run", &run_id, args);
            assert_eq!(
                dispatch(&r, &ctx(AgentConsentLevel::Control)).response["error"]["code"],
                json!("bad_args")
            );
        }
        // A runId that is not 32 hex (so ctl.req.id matches but the shape is wrong) => bad_args.
        let bad_run = req(
            "playbook.run",
            "zz",
            json!({ "runId": "zz", "playbookId": pb_id, "bodyHash": body_hash, "body": "x", "requiresElevation": false }),
        );
        assert_eq!(
            dispatch(&bad_run, &ctx(AgentConsentLevel::Control)).response["error"]["code"],
            json!("bad_args")
        );
    }

    #[test]
    fn responses_match_the_shared_strict_ctl_res_shape() {
        // controlResponseSchema (shared, strict): ok => { t, id, ok, result, ts };
        // refused => { t, id, ok, error: { code, message }, ts }. Nothing else.
        let ok = ok_response("7", json!({}));
        let mut keys: Vec<&str> = ok.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["id", "ok", "result", "t", "ts"]);
        let err = error_response("8", "not_allowed", None);
        let mut keys: Vec<&str> = err
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["error", "id", "ok", "t", "ts"]);
        assert_eq!(
            err["error"],
            json!({ "code": "not_allowed", "message": "" })
        );
        assert_eq!(error_code(&err), Some("not_allowed"));
        assert!(err["ts"].as_u64().unwrap() > 0);
    }

    #[test]
    fn nav_is_not_supported_on_windows() {
        let d = dispatch(
            &req("os.nav", "n", json!({ "action": "back" })),
            &ctx(AgentConsentLevel::Control),
        );
        assert_eq!(d.response["error"]["code"], json!("not_supported"));
        assert_eq!(d.response["error"]["message"], json!("nav"));
    }

    #[test]
    fn monitor_select_validates_the_set() {
        let ok = req("os.monitor.select", "m", json!({ "monitorIds": [1, 2] }));
        let d = dispatch(&ok, &ctx(AgentConsentLevel::View));
        assert_eq!(
            d.action,
            Action::SelectMonitors {
                monitor_ids: vec![1, 2]
            }
        );
        let bad = req("os.monitor.select", "m", json!({ "monitorIds": [1, 9] }));
        assert_eq!(
            dispatch(&bad, &ctx(AgentConsentLevel::View)).response["error"]["code"],
            json!("no_such_monitor")
        );
    }
}
