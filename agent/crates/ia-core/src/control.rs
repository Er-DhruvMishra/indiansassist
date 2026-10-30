//! The native control-op table (contract §5.1) and the elevation outcome enums (§3.8),
//! mirroring `@indiansassist/shared` `agent/control.ts` and `enums.ts`. The names are
//! checked against `packages/shared/test/fixtures/agent/agent-names.json` by
//! `tests/shared_vectors.rs`.

use serde::{Deserialize, Serialize};

use crate::types::AgentConsentLevel;

/// `AGENT_CONTROL_OPS` in shared order. `level.request` is the reused B op; every other B op
/// is answered `not_supported` by the agent.
pub const AGENT_CONTROL_OPS: &[&str] = &[
    "os.monitors",
    "os.monitor.select",
    "os.quality",
    "os.pointer",
    "os.scroll",
    "os.key",
    "os.text",
    "os.nav",
    "clipboard.set",
    "os.input_lock",
    "os.privacy_screen",
    "level.request",
    "elevation.request",
    "playbook.run",
    "playbook.cancel",
];

/// `AGENT_CONTROL_ERROR_CODES`: the §5.1 additions to `CONTROL_ERROR_CODES`.
pub const AGENT_CONTROL_ERROR_CODES: &[&str] = &[
    "elevation_required",
    "no_such_monitor",
    "blocked_uipi",
    "secure_desktop",
    "secure_window",
    "clipboard_off",
    "hash_mismatch",
    "busy",
];

/// `AGENT_CONTROL_EVENT_KINDS`: the new `ctl.event` kinds (§5.1).
pub const AGENT_CONTROL_EVENT_KINDS: &[&str] = &[
    "monitors",
    "capture",
    "agent_level",
    "clipboard",
    "elevation",
    "input_blocked",
];

/// Whether `op` is one of the native ops (anything else: `not_supported`).
pub fn is_agent_control_op(op: &str) -> bool {
    AGENT_CONTROL_OPS.contains(&op)
}

/// `agentMinLevelFor(op, args)`; `None` for an op outside the table. `playbook.run` needs
/// `elevated` when its `requiresElevation` arg is true.
pub fn agent_min_level_for(op: &str, requires_elevation: bool) -> Option<AgentConsentLevel> {
    use AgentConsentLevel::*;
    Some(match op {
        "os.monitors" | "os.monitor.select" | "os.quality" | "level.request" => View,
        "os.input_lock" | "os.privacy_screen" => Elevated,
        "playbook.run" if requires_elevation => Elevated,
        "os.pointer" | "os.scroll" | "os.key" | "os.text" | "os.nav" | "clipboard.set"
        | "elevation.request" | "playbook.run" | "playbook.cancel" => Control,
        _ => return None,
    })
}

/// `ELEVATION_DENY_CAUSES` (`elevation.denied.cause`, §3.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElevationDenyCause {
    Refused,
    Timeout,
    UacCancelled,
    Policy,
}

impl ElevationDenyCause {
    pub const ALL: [Self; 4] = [
        Self::Refused,
        Self::Timeout,
        Self::UacCancelled,
        Self::Policy,
    ];
}

/// `ELEVATION_FAIL_ERRORS` (`elevation.failed.error`, §3.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElevationFailError {
    LaunchFailed,
    HandoverExpired,
    HandoverRejected,
    ConnectFailed,
    UacUnavailable,
    ImageMismatch,
}

impl ElevationFailError {
    pub const ALL: [Self; 6] = [
        Self::LaunchFailed,
        Self::HandoverExpired,
        Self::HandoverRejected,
        Self::ConnectFailed,
        Self::UacUnavailable,
        Self::ImageMismatch,
    ];
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_op_has_a_level_and_unknown_ops_have_none() {
        for op in AGENT_CONTROL_OPS {
            assert!(agent_min_level_for(op, false).is_some(), "{op}");
        }
        assert_eq!(agent_min_level_for("tab.list", false), None);
        assert_eq!(
            agent_min_level_for("playbook.run", true),
            Some(AgentConsentLevel::Elevated)
        );
        assert!(!is_agent_control_op("input.mode"));
    }
}
