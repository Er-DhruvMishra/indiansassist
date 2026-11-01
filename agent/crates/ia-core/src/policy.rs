//! Phase D unattended policy and the consent / action decisions (`docs/specs/phase-d-contracts.md`
//! §6.1, §6.2 and rule 9.9).
//!
//! The server owns the decision at session open and at dispatch; the service re-runs the same
//! rules on the device before it acts (rule 9.9 "again on the device before running"), so the
//! two implementations must never drift. They are held together by
//! `packages/shared/test/fixtures/fleet/decisions.json`, which
//! `packages/shared/test/fleet-policy.test.ts` and `tests/fleet_vectors.rs` both replay.
//! The TypeScript authority is `packages/shared/src/fleet/policy.ts`.

use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use crate::{CoreError, CoreResult};

/// `maxUnattendedMinutes` cap (`LIMITS.maxUnattendedMinutesCap`).
pub const MAX_UNATTENDED_MINUTES_CAP: u32 = 1440;

/// `UNATTENDED_MODES` (§6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnattendedMode {
    Allow,
    ApprovalOnly,
    Deny,
}

/// `INTERACTIVE_STATES` (§3.4): `none` = nobody logged on, `locked` = logged on but locked or
/// disconnected, `active` = a user is present at the console.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractiveStateName {
    None,
    Locked,
    Active,
}

/// `CONSENT_DECISIONS` (§6.2): what the desktop worker does at launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentDecision {
    AutoGrant,
    LocalApproval,
    LocalConsent,
}

/// `APPROVED_BY` (§6.3, rule 9.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovedBy {
    Policy,
    LocalUser,
    AutoAfterTimeout,
}

/// `DEVICE_ACTION_KINDS` (rule 9.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceActionKind {
    PlaybookRun,
    FilePush,
    Print,
    Message,
}

/// One `allowedHours` window: ISO weekdays (Mon = 1), `HH:MM` bounds with `from < to`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyWindow {
    pub days: Vec<u8>,
    pub from: String,
    pub to: String,
}

/// `allowedHours`: an IANA zone and 1..14 windows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AllowedHours {
    pub tz: String,
    pub windows: Vec<PolicyWindow>,
}

/// `UnattendedPolicy` (§6.1). Every key is required; `allowedHours` and `autoAllowAfterSec`
/// are the only nullable ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnattendedPolicy {
    pub mode: UnattendedMode,
    pub require_local_approval_when_present: bool,
    pub auto_allow_after_sec: Option<u32>,
    pub allowed_hours: Option<AllowedHours>,
    pub recording_required: bool,
    pub allow_logon_screen: bool,
    pub allow_secure_desktop: bool,
    pub allow_privileged: bool,
    pub allow_input_lock: bool,
    pub allow_privacy_screen: bool,
    pub allow_amt_sol: bool,
    pub allow_amt_boot_redirect: bool,
    pub notify_local_user: bool,
    pub max_unattended_minutes: u32,
}

/// Distinguishes "the key is absent" from "the key is explicitly `null`" for the two nullable
/// policy keys: an absent key leaves the inherited value, an explicit `null` clears it (the TS
/// `definedOnly` rule drops `undefined` and keeps `null`).
fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// A group's `default_policy` or a device's `unattended_policy` override: the same keys and
/// value rules, every one optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnattendedPolicyPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<UnattendedMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub require_local_approval_when_present: Option<bool>,
    /// `Some(None)` is an explicit `null` (back to "no countdown"); absent leaves the inherited value.
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_allow_after_sec: Option<Option<u32>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub allowed_hours: Option<Option<AllowedHours>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_logon_screen: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_secure_desktop: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_privileged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_input_lock: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_privacy_screen: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_amt_sol: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_amt_boot_redirect: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify_local_user: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_unattended_minutes: Option<u32>,
}

impl Default for UnattendedPolicy {
    /// The org default of §6.1 (W42): approval required until an admin opts a group into `allow`.
    fn default() -> Self {
        Self {
            mode: UnattendedMode::ApprovalOnly,
            require_local_approval_when_present: true,
            auto_allow_after_sec: None,
            allowed_hours: None,
            recording_required: true,
            allow_logon_screen: false,
            allow_secure_desktop: false,
            allow_privileged: true,
            allow_input_lock: false,
            allow_privacy_screen: false,
            allow_amt_sol: false,
            allow_amt_boot_redirect: false,
            notify_local_user: true,
            max_unattended_minutes: 120,
        }
    }
}

fn is_hhmm(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit()
        && s[..2].parse::<u8>().is_ok_and(|h| h <= 23)
        && s[3..].parse::<u8>().is_ok_and(|m| m <= 59)
}

/// True for an IANA zone this build knows (the `chrono-tz` database).
pub fn is_time_zone(tz: &str) -> bool {
    !tz.is_empty() && tz.len() <= 64 && tz.parse::<Tz>().is_ok()
}

impl AllowedHours {
    fn validate(&self) -> CoreResult<()> {
        if !is_time_zone(&self.tz) {
            return Err(CoreError::Invalid(format!(
                "allowedHours.tz: unknown IANA zone {}",
                self.tz
            )));
        }
        if self.windows.is_empty() || self.windows.len() > 14 {
            return Err(CoreError::Invalid(
                "allowedHours.windows: 1..14 windows".into(),
            ));
        }
        for w in &self.windows {
            if w.days.is_empty() || w.days.len() > 7 || w.days.iter().any(|d| !(1..=7).contains(d))
            {
                return Err(CoreError::Invalid(
                    "allowedHours window days: 1..7 ISO weekdays".into(),
                ));
            }
            let mut seen = [false; 8];
            for d in &w.days {
                if seen[*d as usize] {
                    return Err(CoreError::Invalid(
                        "allowedHours window days must be unique".into(),
                    ));
                }
                seen[*d as usize] = true;
            }
            if !is_hhmm(&w.from) || !is_hhmm(&w.to) {
                return Err(CoreError::Invalid(
                    "allowedHours window bounds are HH:MM".into(),
                ));
            }
            if w.from >= w.to {
                return Err(CoreError::Invalid(
                    "allowedHours window: from must be before to (write an overnight window as two windows)".into(),
                ));
            }
        }
        Ok(())
    }
}

impl UnattendedPolicy {
    /// The value rules of §6.1, applied after a merge exactly as the shared schema re-validates.
    pub fn validate(&self) -> CoreResult<()> {
        if let Some(s) = self.auto_allow_after_sec {
            if !(10..=120).contains(&s) {
                return Err(CoreError::Invalid(
                    "autoAllowAfterSec is null or 10..120".into(),
                ));
            }
        }
        if self.max_unattended_minutes > MAX_UNATTENDED_MINUTES_CAP {
            return Err(CoreError::Invalid("maxUnattendedMinutes is 0..1440".into()));
        }
        if let Some(h) = &self.allowed_hours {
            h.validate()?;
        }
        Ok(())
    }

    fn apply(&mut self, p: &UnattendedPolicyPatch) {
        macro_rules! set {
            ($($f:ident),+ $(,)?) => { $(if let Some(v) = p.$f.clone() { self.$f = v; })+ };
        }
        set!(
            mode,
            require_local_approval_when_present,
            recording_required,
            allow_logon_screen,
            allow_secure_desktop,
            allow_privileged,
            allow_input_lock,
            allow_privacy_screen,
            allow_amt_sol,
            allow_amt_boot_redirect,
            notify_local_user,
            max_unattended_minutes,
        );
        if let Some(v) = p.auto_allow_after_sec {
            self.auto_allow_after_sec = v;
        }
        if let Some(v) = p.allowed_hours.clone() {
            self.allowed_hours = v;
        }
    }
}

/// §2.2 merge order: `{ ...orgDefault, ...group.defaultPolicy, ...device.unattendedPolicy }`,
/// then re-validated. An invalid combination is an error, never a silently clamped policy.
pub fn resolve_unattended_policy(
    device: Option<&UnattendedPolicyPatch>,
    group: Option<&UnattendedPolicyPatch>,
    org_default: Option<&UnattendedPolicyPatch>,
) -> CoreResult<UnattendedPolicy> {
    let mut out = UnattendedPolicy::default();
    for p in [org_default, group, device].into_iter().flatten() {
        out.apply(p);
    }
    out.validate()?;
    Ok(out)
}

fn minutes_of(hhmm: &str) -> u32 {
    let h: u32 = hhmm[..2].parse().unwrap_or(0);
    let m: u32 = hhmm[3..].parse().unwrap_or(0);
    h * 60 + m
}

/// ISO weekday (Mon = 1) and minutes-since-midnight of `now` in `tz`.
fn local_day_time(now: DateTime<Utc>, tz: Tz) -> (u8, u32) {
    let local = now.with_timezone(&tz);
    (
        local.weekday().number_from_monday() as u8,
        local.hour() * 60 + local.minute(),
    )
}

/// §6.1: `null` hours = any time; otherwise inside at least one window (`from` inclusive,
/// `to` exclusive). An unknown zone is treated as outside every window — a policy that cannot
/// be evaluated must not open a machine.
pub fn is_within_policy_window(policy: &UnattendedPolicy, now: DateTime<Utc>) -> bool {
    let Some(h) = &policy.allowed_hours else {
        return true;
    };
    let Ok(tz) = h.tz.parse::<Tz>() else {
        return false;
    };
    let (day, mins) = local_day_time(now, tz);
    h.windows
        .iter()
        .any(|w| w.days.contains(&day) && minutes_of(&w.from) <= mins && mins < minutes_of(&w.to))
}

/// The next window start at or after `now` (minute resolution, searched over 8 days), or
/// `None` for "any time" and for a policy with no reachable window. Queued actions wait for it.
pub fn next_policy_window_start(
    policy: &UnattendedPolicy,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    policy.allowed_hours.as_ref()?;
    // Round up to the next whole minute, then walk minute by minute (same as the TS side).
    let start = now
        + Duration::seconds(if now.timestamp_subsec_nanos() > 0 || now.second() > 0 {
            1
        } else {
            0
        });
    let mut t = Utc
        .timestamp_opt(((start.timestamp() + 59) / 60) * 60, 0)
        .single()?;
    let end = t + Duration::days(8);
    while t < end {
        if is_within_policy_window(policy, t) {
            return Some(t);
        }
        t += Duration::minutes(1);
    }
    None
}

/// "Present" (§3.4): a user is logged on and unlocked at the console. An unknown state is not
/// present (the safer reading).
pub fn is_present(interactive: Option<InteractiveStateName>) -> bool {
    interactive == Some(InteractiveStateName::Active)
}

/// Why a device session was refused (§6.2); each maps to the REST error the console shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRefusal {
    NobodyPresent,
    UnattendedDenied,
    ApprovalRequired,
    OutsidePolicyWindow,
    PreloginNotPermitted,
    RecorderRequired,
}

/// The §6.2 outcome: either what the worker should do, or the refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SessionDecision {
    Allowed { decision: ConsentDecision },
    Refused { error: SessionRefusal },
}

/// The inputs of the §6.2 table.
#[derive(Debug, Clone)]
pub struct SessionInput<'a> {
    pub unattended: bool,
    pub policy: &'a UnattendedPolicy,
    pub interactive: Option<InteractiveStateName>,
    pub now: DateTime<Utc>,
    /// `Some(false)` means this node has no recorder; `None` = not checked by the caller.
    pub recorder_available: Option<bool>,
}

/// §6.2, in the contract's check order (after the caller's `device_offline` / `device_busy`
/// checks): the mode table, then for unattended sessions `allowedHours` and the pre-login
/// gate, then for every P4 session the recorder requirement.
pub fn decide_device_session(p: &SessionInput<'_>) -> SessionDecision {
    let policy = p.policy;
    let present = is_present(p.interactive);
    let decision = if !p.unattended {
        if !present {
            return SessionDecision::Refused {
                error: SessionRefusal::NobodyPresent,
            };
        }
        ConsentDecision::LocalConsent
    } else {
        match policy.mode {
            UnattendedMode::Deny => {
                return SessionDecision::Refused {
                    error: SessionRefusal::UnattendedDenied,
                }
            }
            UnattendedMode::ApprovalOnly => {
                if !present {
                    return SessionDecision::Refused {
                        error: SessionRefusal::ApprovalRequired,
                    };
                }
                ConsentDecision::LocalApproval
            }
            UnattendedMode::Allow => {
                if present && policy.require_local_approval_when_present {
                    ConsentDecision::LocalApproval
                } else {
                    ConsentDecision::AutoGrant
                }
            }
        }
    };
    if p.unattended {
        if !is_within_policy_window(policy, p.now) {
            return SessionDecision::Refused {
                error: SessionRefusal::OutsidePolicyWindow,
            };
        }
        // An unknown interactive state counts as nobody logged on, the safer reading.
        if p.interactive.unwrap_or(InteractiveStateName::None) == InteractiveStateName::None
            && !policy.allow_logon_screen
        {
            return SessionDecision::Refused {
                error: SessionRefusal::PreloginNotPermitted,
            };
        }
    }
    if policy.recording_required && p.recorder_available == Some(false) {
        return SessionDecision::Refused {
            error: SessionRefusal::RecorderRequired,
        };
    }
    SessionDecision::Allowed { decision }
}

/// Rule 9.9: what to do with a device action, at the `POST` (`queue`) or at dispatch and again
/// on the device (`dispatch`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ActionDecision {
    /// Queue it (the `POST` passes the gate).
    Accept,
    /// Refuse at the `POST`: `mode = deny`.
    Refuse { error: ActionError },
    /// Keep it `queued` until the next `allowedHours` window (or until it expires).
    Hold { reason: ActionHold },
    /// Fail it: `deny` reached after queueing, or a privileged action without `allowPrivileged`.
    Fail { error: ActionError },
    /// Run it now; `notify` means show the local toast first.
    Run {
        #[serde(rename = "approvedBy")]
        approved_by: ApprovedBy,
        notify: bool,
    },
    /// Show the action approval card; `wait_for_presence` means nobody is there yet.
    Approval {
        #[serde(rename = "autoAllowAfterSec")]
        auto_allow_after_sec: Option<u32>,
        #[serde(rename = "waitForPresence")]
        wait_for_presence: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionError {
    UnattendedDenied,
    Policy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionHold {
    OutsidePolicyWindow,
}

/// The stage rule 9.9 is being evaluated at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStage {
    Queue,
    Dispatch,
}

/// The inputs of rule 9.9.
#[derive(Debug, Clone)]
pub struct ActionInput<'a> {
    pub stage: ActionStage,
    pub kind: DeviceActionKind,
    pub privileged: bool,
    pub policy: &'a UnattendedPolicy,
    pub interactive: Option<InteractiveStateName>,
    pub now: DateTime<Utc>,
}

/// Rule 9.9. `message` is never gated (it executes nothing) and runs with `approvedBy: policy`.
pub fn decide_device_action(p: &ActionInput<'_>) -> ActionDecision {
    let policy = p.policy;
    let present = is_present(p.interactive);
    if p.kind == DeviceActionKind::Message {
        return match p.stage {
            ActionStage::Queue => ActionDecision::Accept,
            ActionStage::Dispatch => ActionDecision::Run {
                approved_by: ApprovedBy::Policy,
                notify: present,
            },
        };
    }
    if p.stage == ActionStage::Queue {
        return if policy.mode == UnattendedMode::Deny {
            ActionDecision::Refuse {
                error: ActionError::UnattendedDenied,
            }
        } else {
            ActionDecision::Accept
        };
    }
    if policy.mode == UnattendedMode::Deny {
        return ActionDecision::Fail {
            error: ActionError::Policy,
        };
    }
    if !is_within_policy_window(policy, p.now) {
        return ActionDecision::Hold {
            reason: ActionHold::OutsidePolicyWindow,
        };
    }
    if p.privileged && !policy.allow_privileged {
        return ActionDecision::Fail {
            error: ActionError::Policy,
        };
    }
    if policy.mode == UnattendedMode::ApprovalOnly {
        return ActionDecision::Approval {
            auto_allow_after_sec: None,
            wait_for_presence: !present,
        };
    }
    if !present {
        return ActionDecision::Run {
            approved_by: ApprovedBy::Policy,
            notify: false,
        };
    }
    if !policy.require_local_approval_when_present {
        return ActionDecision::Run {
            approved_by: ApprovedBy::Policy,
            notify: true,
        };
    }
    ActionDecision::Approval {
        auto_allow_after_sec: policy.auto_allow_after_sec,
        wait_for_presence: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn office_hours() -> AllowedHours {
        AllowedHours {
            tz: "Asia/Kolkata".into(),
            windows: vec![PolicyWindow {
                days: vec![1, 2, 3, 4, 5],
                from: "09:00".into(),
                to: "18:00".into(),
            }],
        }
    }

    #[test]
    fn the_default_policy_is_the_safe_one() {
        let p = UnattendedPolicy::default();
        assert_eq!(p.mode, UnattendedMode::ApprovalOnly);
        assert!(
            !p.allow_logon_screen
                && !p.allow_secure_desktop
                && !p.allow_input_lock
                && !p.allow_privacy_screen
        );
        assert!(p.validate().is_ok());
    }

    #[test]
    fn the_merge_runs_org_then_group_then_device() {
        let org = UnattendedPolicyPatch {
            mode: Some(UnattendedMode::Allow),
            ..Default::default()
        };
        let group = UnattendedPolicyPatch {
            allow_input_lock: Some(true),
            max_unattended_minutes: Some(60),
            ..Default::default()
        };
        let device = UnattendedPolicyPatch {
            max_unattended_minutes: Some(30),
            ..Default::default()
        };
        let p = resolve_unattended_policy(Some(&device), Some(&group), Some(&org)).unwrap();
        assert_eq!(p.mode, UnattendedMode::Allow);
        assert!(p.allow_input_lock);
        assert_eq!(p.max_unattended_minutes, 30);
    }

    #[test]
    fn an_invalid_merge_result_is_refused() {
        let device = UnattendedPolicyPatch {
            auto_allow_after_sec: Some(Some(5)),
            ..Default::default()
        };
        assert!(resolve_unattended_policy(Some(&device), None, None).is_err());
    }

    #[test]
    fn the_window_is_read_in_its_own_zone() {
        let p = UnattendedPolicy {
            allowed_hours: Some(office_hours()),
            ..Default::default()
        };
        // Monday 10:00 IST is Monday 04:30 UTC: inside. 03:00 UTC (08:30 IST) is outside.
        assert!(is_within_policy_window(&p, at("2026-11-02T04:30:00Z")));
        assert!(!is_within_policy_window(&p, at("2026-11-02T03:00:00Z")));
        // Sunday is not in `days`.
        assert!(!is_within_policy_window(&p, at("2026-11-01T04:30:00Z")));
    }

    #[test]
    fn an_unknown_zone_closes_the_window_rather_than_opening_it() {
        let p = UnattendedPolicy {
            allowed_hours: Some(AllowedHours {
                tz: "Mars/Olympus".into(),
                windows: office_hours().windows,
            }),
            ..Default::default()
        };
        assert!(!is_within_policy_window(&p, at("2026-11-02T04:30:00Z")));
    }

    #[test]
    fn the_next_window_start_is_the_first_minute_inside() {
        let p = UnattendedPolicy {
            allowed_hours: Some(office_hours()),
            ..Default::default()
        };
        let next = next_policy_window_start(&p, at("2026-11-02T03:00:00Z")).unwrap();
        assert_eq!(next, at("2026-11-02T03:30:00Z")); // 09:00 IST
        assert!(
            next_policy_window_start(&UnattendedPolicy::default(), at("2026-11-02T03:00:00Z"))
                .is_none()
        );
    }

    #[test]
    fn an_attended_request_needs_somebody_present_and_ignores_hours() {
        let p = UnattendedPolicy {
            allowed_hours: Some(office_hours()),
            ..Default::default()
        };
        let base = SessionInput {
            unattended: false,
            policy: &p,
            interactive: Some(InteractiveStateName::Active),
            now: at("2026-11-02T20:00:00Z"),
            recorder_available: None,
        };
        assert_eq!(
            decide_device_session(&base),
            SessionDecision::Allowed {
                decision: ConsentDecision::LocalConsent
            }
        );
        let away = SessionInput {
            interactive: Some(InteractiveStateName::Locked),
            ..base.clone()
        };
        assert_eq!(
            decide_device_session(&away),
            SessionDecision::Refused {
                error: SessionRefusal::NobodyPresent
            }
        );
    }

    #[test]
    fn the_prelogin_gate_closes_before_a_worker_is_launched() {
        let p = UnattendedPolicy {
            mode: UnattendedMode::Allow,
            ..Default::default()
        };
        let input = SessionInput {
            unattended: true,
            policy: &p,
            interactive: Some(InteractiveStateName::None),
            now: at("2026-11-02T04:30:00Z"),
            recorder_available: None,
        };
        assert_eq!(
            decide_device_session(&input),
            SessionDecision::Refused {
                error: SessionRefusal::PreloginNotPermitted
            }
        );
        let allowed = UnattendedPolicy {
            allow_logon_screen: true,
            ..p.clone()
        };
        assert_eq!(
            decide_device_session(&SessionInput {
                policy: &allowed,
                ..input.clone()
            }),
            SessionDecision::Allowed {
                decision: ConsentDecision::AutoGrant
            }
        );
    }

    #[test]
    fn a_privileged_action_without_the_flag_fails_at_dispatch_not_at_queue() {
        let p = UnattendedPolicy {
            mode: UnattendedMode::Allow,
            allow_privileged: false,
            ..Default::default()
        };
        let base = ActionInput {
            stage: ActionStage::Queue,
            kind: DeviceActionKind::PlaybookRun,
            privileged: true,
            policy: &p,
            interactive: Some(InteractiveStateName::None),
            now: at("2026-11-02T04:30:00Z"),
        };
        assert_eq!(decide_device_action(&base), ActionDecision::Accept);
        assert_eq!(
            decide_device_action(&ActionInput {
                stage: ActionStage::Dispatch,
                ..base.clone()
            }),
            ActionDecision::Fail {
                error: ActionError::Policy
            }
        );
    }

    #[test]
    fn a_message_is_never_gated() {
        let p = UnattendedPolicy {
            mode: UnattendedMode::Deny,
            ..Default::default()
        };
        let base = ActionInput {
            stage: ActionStage::Queue,
            kind: DeviceActionKind::Message,
            privileged: false,
            policy: &p,
            interactive: Some(InteractiveStateName::Active),
            now: at("2026-11-02T04:30:00Z"),
        };
        assert_eq!(decide_device_action(&base), ActionDecision::Accept);
        assert_eq!(
            decide_device_action(&ActionInput {
                stage: ActionStage::Dispatch,
                ..base.clone()
            }),
            ActionDecision::Run {
                approved_by: ApprovedBy::Policy,
                notify: true
            }
        );
    }
}
