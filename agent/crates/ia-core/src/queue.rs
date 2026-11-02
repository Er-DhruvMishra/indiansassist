//! The device side of the offline action queue (`docs/specs/phase-d-contracts.md` §9).
//!
//! The server decides what to dispatch; the device re-runs the rule 9.9 gate before it acts
//! ("at dispatch and again on the device before running"), because the policy or the person at
//! the keyboard may have changed since the action was queued. This module is that second
//! evaluation plus the drain order and the pinned-playbook check, with no I/O:
//!
//! * **Order** is by `createdAt`, oldest first, so a queue that built up overnight runs in the
//!   order the technician created it.
//! * **An expired action is never run**, even if the server still sent it (clocks differ; the
//!   device refuses rather than running something a week stale).
//! * **A playbook body is checked against the manifest** from `device.hello.ok` (rule 9.3), so
//!   a body that changed server-side after queueing cannot run under the old pin.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::fleet::QueuedAction;
use crate::playbook::{ManifestEntry, PlaybookError, RunRequest};
use crate::policy::{
    decide_device_action, ActionDecision, ActionInput, ActionStage, DeviceActionKind,
    InteractiveStateName, UnattendedPolicy,
};
use crate::types::PlaybookInterpreter;

/// What the device does with one queued action.
#[derive(Debug, Clone, PartialEq)]
pub enum QueuePlan {
    /// Run it now (`notify` = show the visibility toast of rule 9.9 first).
    Run { decision: ActionDecision },
    /// Show the action approval card and report `awaiting_approval`.
    Approval {
        auto_allow_after_sec: Option<u32>,
        wait_for_presence: bool,
    },
    /// Report `failed { error }` without running anything.
    Fail { error: &'static str },
    /// Leave it alone: the server holds it until the next `allowedHours` window.
    Hold,
    /// Skip it silently: it is expired, already finished, or not for this device.
    Skip { why: SkipReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    Expired,
    AlreadyFinal,
    OtherDevice,
}

/// Is this action privileged (rule 9.9)? `vault_refs` comes from the manifest entry, because
/// the device only ever learns about vault-backed playbooks from its own catalogue.
pub fn is_privileged(kind: DeviceActionKind, payload: &Value, vault_refs: usize) -> bool {
    match kind {
        DeviceActionKind::PlaybookRun => {
            payload.get("requiresElevation").and_then(Value::as_bool) == Some(true)
                || vault_refs > 0
        }
        DeviceActionKind::Print => payload.get("printer").and_then(Value::as_str).is_some(),
        _ => false,
    }
}

/// The drain order of a `device.hello.ok.queued` list: indices into `actions`, oldest first.
/// Equal (or missing) `createdAt` keeps the server's order, so the list is never shuffled.
pub fn drain_order(actions: &[QueuedAction]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..actions.len()).collect();
    idx.sort_by(|a, b| {
        actions[*a]
            .created_at
            .cmp(&actions[*b].created_at)
            .then(a.cmp(b))
    });
    idx
}

/// The second evaluation of rule 9.9, on the device.
pub fn plan_for(
    action: &QueuedAction,
    device_id: &str,
    vault_refs: usize,
    policy: &UnattendedPolicy,
    interactive: Option<InteractiveStateName>,
    now: DateTime<Utc>,
) -> QueuePlan {
    if action.device_id != device_id {
        return QueuePlan::Skip {
            why: SkipReason::OtherDevice,
        };
    }
    if matches!(
        action.state.as_str(),
        "done" | "failed" | "cancelled" | "expired"
    ) {
        return QueuePlan::Skip {
            why: SkipReason::AlreadyFinal,
        };
    }
    if let Ok(expires) = DateTime::parse_from_rfc3339(&action.expires_at) {
        if expires.with_timezone(&Utc) <= now {
            return QueuePlan::Skip {
                why: SkipReason::Expired,
            };
        }
    }
    let decision = decide_device_action(&ActionInput {
        stage: ActionStage::Dispatch,
        kind: action.kind,
        privileged: is_privileged(action.kind, &action.payload, vault_refs),
        policy,
        interactive,
        now,
    });
    match decision {
        ActionDecision::Run { .. } => QueuePlan::Run { decision },
        ActionDecision::Approval {
            auto_allow_after_sec,
            wait_for_presence,
        } => QueuePlan::Approval {
            auto_allow_after_sec,
            wait_for_presence,
        },
        ActionDecision::Hold { .. } => QueuePlan::Hold,
        ActionDecision::Fail { .. } | ActionDecision::Refuse { .. } => {
            QueuePlan::Fail { error: "policy" }
        }
        // `accept` is the `POST` stage only; reaching it here would be a server bug, and
        // refusing is safer than running an ungated action.
        ActionDecision::Accept => QueuePlan::Fail { error: "policy" },
    }
}

/// A dispatched `playbook_run` payload (rule 9.3 as the api sends it: the pinned body and its
/// hash travel with the action).
#[derive(Debug, Clone, PartialEq)]
pub struct PlaybookAction {
    pub playbook_id: String,
    pub body: String,
    pub body_hash: String,
    pub interpreter: PlaybookInterpreter,
    pub requires_elevation: bool,
    pub timeout_sec: u32,
    pub args: BTreeMap<String, Value>,
}

/// Reads a dispatched `playbook_run` payload. A payload missing the body (as a `hello.ok`
/// queue entry is, before dispatch) is `None` rather than an error.
pub fn playbook_action(payload: &Value) -> Option<PlaybookAction> {
    let o = payload.as_object()?;
    let interpreter = match o.get("interpreter")?.as_str()? {
        "powershell" => PlaybookInterpreter::Powershell,
        "cmd" => PlaybookInterpreter::Cmd,
        "sh" => PlaybookInterpreter::Sh,
        _ => return None,
    };
    Some(PlaybookAction {
        playbook_id: o.get("playbookId")?.as_str()?.to_string(),
        body: o.get("body")?.as_str()?.to_string(),
        body_hash: o.get("bodyHash")?.as_str()?.to_string(),
        interpreter,
        requires_elevation: o
            .get("requiresElevation")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        timeout_sec: o.get("timeoutSec").and_then(Value::as_u64).unwrap_or(0) as u32,
        args: o
            .get("args")
            .and_then(Value::as_object)
            .map(|a| a.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default(),
    })
}

/// Rule 9.3: the body must hash to the pin the manifest carries, and the elevation flag must
/// match. Reuses the C §8.4 checks so an action run and an in-session run are gated alike.
pub fn check_queued_playbook(
    a: &PlaybookAction,
    run_id: &str,
    manifest: &[ManifestEntry],
    integrity: crate::types::ElevationLevel,
) -> Result<RunRequest, PlaybookError> {
    let run = RunRequest {
        run_id: run_id.to_string(),
        playbook_id: a.playbook_id.clone(),
        body_hash: a.body_hash.clone(),
        body: a.body.clone(),
        interpreter: a.interpreter,
        requires_elevation: a.requires_elevation,
        timeout_sec: a.timeout_sec,
        args: a.args.clone(),
    };
    crate::playbook::check_run(&run, manifest, integrity)?;
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DEV: &str = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn action(id: &str, created: &str, kind: DeviceActionKind, payload: Value) -> QueuedAction {
        QueuedAction {
            id: id.into(),
            device_id: DEV.into(),
            kind,
            payload,
            state: "queued".into(),
            reason: None,
            approved_by: None,
            created_at: created.into(),
            expires_at: "2026-12-01T00:00:00.000Z".into(),
        }
    }

    fn allow() -> UnattendedPolicy {
        UnattendedPolicy {
            mode: crate::policy::UnattendedMode::Allow,
            require_local_approval_when_present: false,
            ..Default::default()
        }
    }

    #[test]
    fn the_drain_is_oldest_first_and_stable() {
        let list = vec![
            action(
                "c",
                "2026-11-01T12:00:00.000Z",
                DeviceActionKind::Message,
                json!({}),
            ),
            action(
                "a",
                "2026-11-01T09:00:00.000Z",
                DeviceActionKind::Message,
                json!({}),
            ),
            action(
                "b",
                "2026-11-01T09:00:00.000Z",
                DeviceActionKind::Message,
                json!({}),
            ),
        ];
        let order: Vec<&str> = drain_order(&list)
            .into_iter()
            .map(|i| list[i].id.as_str())
            .collect();
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[test]
    fn an_expired_or_finished_action_or_one_for_another_device_is_skipped() {
        let policy = allow();
        let now = at("2026-11-02T04:30:00Z");
        let mut expired = action(
            "x",
            "2026-10-01T00:00:00.000Z",
            DeviceActionKind::Message,
            json!({}),
        );
        expired.expires_at = "2026-10-08T00:00:00.000Z".into();
        assert_eq!(
            plan_for(&expired, DEV, 0, &policy, None, now),
            QueuePlan::Skip {
                why: SkipReason::Expired
            }
        );
        let mut done = action(
            "y",
            "2026-11-01T00:00:00.000Z",
            DeviceActionKind::Message,
            json!({}),
        );
        done.state = "done".into();
        assert_eq!(
            plan_for(&done, DEV, 0, &policy, None, now),
            QueuePlan::Skip {
                why: SkipReason::AlreadyFinal
            }
        );
        let other = action(
            "z",
            "2026-11-01T00:00:00.000Z",
            DeviceActionKind::Message,
            json!({}),
        );
        assert_eq!(
            plan_for(
                &other,
                "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
                0,
                &policy,
                None,
                now
            ),
            QueuePlan::Skip {
                why: SkipReason::OtherDevice
            }
        );
    }

    #[test]
    fn the_device_reruns_the_gate_and_can_refuse_what_the_server_dispatched() {
        // The policy went to `deny` while the device was offline: the queued action fails.
        let denied = UnattendedPolicy {
            mode: crate::policy::UnattendedMode::Deny,
            ..Default::default()
        };
        let a = action(
            "a",
            "2026-11-01T09:00:00.000Z",
            DeviceActionKind::PlaybookRun,
            json!({ "requiresElevation": false }),
        );
        assert_eq!(
            plan_for(&a, DEV, 0, &denied, None, at("2026-11-02T04:30:00Z")),
            QueuePlan::Fail { error: "policy" }
        );
    }

    #[test]
    fn awaiting_approval_is_what_a_present_user_under_an_approval_policy_gets() {
        let policy = UnattendedPolicy {
            auto_allow_after_sec: Some(30),
            ..allow()
        };
        let policy = UnattendedPolicy {
            require_local_approval_when_present: true,
            ..policy
        };
        let a = action(
            "a",
            "2026-11-01T09:00:00.000Z",
            DeviceActionKind::FilePush,
            json!({}),
        );
        assert_eq!(
            plan_for(
                &a,
                DEV,
                0,
                &policy,
                Some(InteractiveStateName::Active),
                at("2026-11-02T04:30:00Z")
            ),
            QueuePlan::Approval {
                auto_allow_after_sec: Some(30),
                wait_for_presence: false
            }
        );
        // Nobody there: it waits in `awaiting_approval` rather than running.
        let approval_only = UnattendedPolicy::default();
        assert_eq!(
            plan_for(
                &a,
                DEV,
                0,
                &approval_only,
                Some(InteractiveStateName::Locked),
                at("2026-11-02T04:30:00Z")
            ),
            QueuePlan::Approval {
                auto_allow_after_sec: None,
                wait_for_presence: true
            }
        );
    }

    #[test]
    fn a_vault_backed_playbook_counts_as_privileged_even_without_requires_elevation() {
        let payload = json!({ "requiresElevation": false });
        assert!(!is_privileged(DeviceActionKind::PlaybookRun, &payload, 0));
        assert!(is_privileged(DeviceActionKind::PlaybookRun, &payload, 1));
        assert!(is_privileged(
            DeviceActionKind::Print,
            &json!({ "printer": "Reception" }),
            0
        ));
        assert!(!is_privileged(DeviceActionKind::Print, &json!({}), 0));
        assert!(!is_privileged(DeviceActionKind::Message, &json!({}), 2));
    }

    #[test]
    fn a_dispatched_playbook_is_read_and_pinned_against_the_manifest() {
        use sha2::{Digest, Sha256};
        let body = "Get-Service -Name Spooler\n";
        let hash = hex::encode(Sha256::digest(body.as_bytes()));
        let payload = json!({
            "playbookId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
            "name": "Check the spooler",
            "args": {},
            "requiresElevation": false,
            "bodyHash": hash,
            "body": body,
            // The installed service is Windows-only (D §11.1); the pin check is the same on
            // every host, so the test uses the interpreter the agent on this host runs.
            "interpreter": if cfg!(windows) { "powershell" } else { "sh" },
            "timeoutSec": 60,
        });
        let a = playbook_action(&payload).expect("a dispatched payload");
        let manifest = vec![ManifestEntry {
            id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
            body_hash: hash.clone(),
            requires_elevation: false,
            parameters: vec![],
            timeout_sec: 60,
        }];
        assert!(
            check_queued_playbook(&a, "run1", &manifest, crate::types::ElevationLevel::Admin)
                .is_ok()
        );

        // A body that changed server-side after queueing cannot run under the old pin.
        let tampered = PlaybookAction {
            body: "Remove-Item C:\\ -Recurse\n".into(),
            ..a.clone()
        };
        assert_eq!(
            check_queued_playbook(
                &tampered,
                "run1",
                &manifest,
                crate::types::ElevationLevel::Admin
            )
            .unwrap_err(),
            PlaybookError::HashMismatch
        );
        // A playbook that is not in this device's catalogue is refused.
        assert_eq!(
            check_queued_playbook(&a, "run1", &[], crate::types::ElevationLevel::Admin)
                .unwrap_err(),
            PlaybookError::NotAllowed
        );
    }

    #[test]
    fn a_queue_entry_without_a_body_is_not_a_runnable_playbook() {
        assert!(playbook_action(&json!({ "playbookId": "x", "args": {} })).is_none());
    }
}
