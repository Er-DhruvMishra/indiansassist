//! Elevation hand-over flow (contract §7.3) and the self-delete decision (§10 D1/D3).
//! Pure state logic; tested.

use ia_core::types::{AgentConsentLevel, ElevationLevel};

/// Why an elevation request was denied (`ELEVATION_DENY_CAUSES`, §3.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyCause {
    Refused,
    Timeout,
    UacCancelled,
    Policy,
}

/// Why an elevation hand-over failed (`ELEVATION_FAIL_ERRORS`, §3.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailError {
    LaunchFailed,
    HandoverExpired,
    HandoverRejected,
    ConnectFailed,
    UacUnavailable,
    ImageMismatch,
}

/// The agent-side elevation state (contract §7.3 steps 2-5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElevationState {
    Idle,
    /// The indicator prompt card is shown (Allow / Refuse, 60 s).
    PromptShown,
    /// UAC dialog raised; the child is launching.
    UacShown,
    /// The child connected and took the session over (this user instance will exit).
    HandedOver,
    Denied(DenyCause),
    Failed(FailError),
}

/// Events applied to the elevation state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElevationEvent {
    /// `elevation.request` arrived from the console.
    Requested,
    /// The Desk clicked **Allow** with a physical click (§3.5).
    AllowPhysical,
    /// Refuse / 60 s timeout.
    RefuseOrTimeout(DenyCause),
    /// `ShellExecuteExW(runas)` raised the UAC dialog.
    UacRaised,
    /// User cancelled UAC (ERROR_CANCELLED 1223): the user instance stays in control.
    UacCancelled,
    /// `ShellExecuteExW` failed for a reason other than cancellation.
    LaunchFailed,
    /// The elevated child connected (session.handed_over / child success).
    ChildConnected,
    /// 20 s elapsed with no hand-over signal.
    ConnectTimeout,
}

impl ElevationState {
    pub fn apply(self, ev: ElevationEvent) -> ElevationState {
        use ElevationEvent::*;
        use ElevationState::*;
        match (self, ev) {
            (Idle, Requested) => PromptShown,
            (PromptShown, AllowPhysical) => UacShown,
            (PromptShown, RefuseOrTimeout(c)) => Denied(c),
            (UacShown, UacCancelled) => Denied(DenyCause::UacCancelled),
            (UacShown, LaunchFailed) => Failed(FailError::LaunchFailed),
            (UacShown, ChildConnected) => HandedOver,
            (UacShown, ConnectTimeout) => Failed(FailError::ConnectFailed),
            // Any other event is a no-op.
            (s, _) => s,
        }
    }

    /// After a denial or failure the user instance keeps the session (§7.3 steps 3, 5).
    pub fn user_keeps_session(self) -> bool {
        matches!(
            self,
            ElevationState::Denied(_)
                | ElevationState::Failed(_)
                | ElevationState::PromptShown
                | ElevationState::UacShown
                | ElevationState::Idle
        )
    }
}

// The self-delete decision (§10) is pure session-lifecycle logic and lives in
// `ia_core::teardown` so the headless loopback test can assert it too; re-exported here
// because the elevation flow is where it is consumed.
pub use ia_core::teardown::{deletes_on_exit, uses_reboot_delete, ProcessRole};

/// The hand-over hello's claimed client fields the server checks (§7.2 (4)); the agent
/// builds them from the parent's measured state. Returns whether the child's claim is
/// internally consistent before it is sent.
pub fn handover_claim_ok(
    child_integrity: ElevationLevel,
    original_arch: &str,
    child_arch: &str,
    original_features_has_elevation: bool,
) -> bool {
    child_integrity == ElevationLevel::Admin
        && original_arch == child_arch
        && original_features_has_elevation
}

/// After hand-over the session is `elevated` integrity but the level may be lower if the
/// Desk later dropped it (§3.4). This is the integrity, not the level.
pub fn post_handover_integrity(_level: AgentConsentLevel) -> ElevationLevel {
    ElevationLevel::Admin
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_leads_to_uac_then_handover() {
        let s = ElevationState::Idle
            .apply(ElevationEvent::Requested)
            .apply(ElevationEvent::AllowPhysical);
        assert_eq!(s, ElevationState::UacShown);
        assert_eq!(
            s.apply(ElevationEvent::ChildConnected),
            ElevationState::HandedOver
        );
    }

    #[test]
    fn refuse_and_uac_cancel_keep_user_in_control() {
        let refused =
            ElevationState::PromptShown.apply(ElevationEvent::RefuseOrTimeout(DenyCause::Refused));
        assert_eq!(refused, ElevationState::Denied(DenyCause::Refused));
        assert!(refused.user_keeps_session());

        let cancelled = ElevationState::UacShown.apply(ElevationEvent::UacCancelled);
        assert_eq!(cancelled, ElevationState::Denied(DenyCause::UacCancelled));
        assert!(cancelled.user_keeps_session());
    }

    #[test]
    fn connect_timeout_fails_and_user_keeps_session() {
        let s = ElevationState::UacShown.apply(ElevationEvent::ConnectTimeout);
        assert_eq!(s, ElevationState::Failed(FailError::ConnectFailed));
        assert!(s.user_keeps_session());
    }

    #[test]
    fn exactly_one_instance_deletes() {
        // When elevation was used: the child deletes, the handed-over user does not.
        assert!(deletes_on_exit(ProcessRole::ElevatedChild, false));
        assert!(!deletes_on_exit(ProcessRole::UserHandedOver, false));
        // Standalone user deletes.
        assert!(deletes_on_exit(ProcessRole::UserStandalone, false));
        // Keep skips every delete.
        assert!(!deletes_on_exit(ProcessRole::ElevatedChild, true));
        assert!(!deletes_on_exit(ProcessRole::UserStandalone, true));
    }

    #[test]
    fn reboot_delete_only_for_child() {
        assert!(uses_reboot_delete(ProcessRole::ElevatedChild));
        assert!(!uses_reboot_delete(ProcessRole::UserStandalone));
    }

    #[test]
    fn handover_claim_requires_admin_same_arch_and_feature() {
        assert!(handover_claim_ok(ElevationLevel::Admin, "x64", "x64", true));
        assert!(!handover_claim_ok(ElevationLevel::User, "x64", "x64", true));
        assert!(!handover_claim_ok(
            ElevationLevel::Admin,
            "x64",
            "arm64",
            true
        ));
        assert!(!handover_claim_ok(
            ElevationLevel::Admin,
            "x64",
            "x64",
            false
        ));
    }
}
