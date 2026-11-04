//! Desktop selection (§5.3), `InteractiveState` derivation (§3.4) and the secure-surface
//! gates (rule 5.1c) — the decisions behind `DesktopBridge`, as pure functions over a table of
//! facts.
//!
//! Keeping them here rather than inside the Win32 calls is what makes them testable: §15.2
//! asks for "desktop-selection logic and `InteractiveState` derivation against a mock
//! `WTS`/desktop table", and no automated run may touch `CreateProcessAsUser`. The Win32 side
//! (in `win`) does nothing but fill in [`SessionFacts`] and perform what these return.

use serde::{Deserialize, Serialize};

use ia_core::fleet::InteractiveState;
use ia_core::policy::{InteractiveStateName, UnattendedPolicy};
use ia_platform::DesktopTarget;

/// What the service reads from WTS and the desktop API each time it re-evaluates (§5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFacts {
    /// `WTSGetActiveConsoleSessionId`, or `None` when there is no console session
    /// (`0xFFFFFFFF`, which happens during a fast-user-switch transition).
    pub console_session_id: Option<u32>,
    /// A user is logged on to the console session (a user token exists for it).
    pub logged_on: bool,
    /// The console session is locked (`WTSSessionInfoEx` / `SessionFlags`).
    pub locked: bool,
    /// The console session is connected (`WTSConnectState == WTSActive`); false while it is
    /// disconnected, which §3.4 treats as locked.
    pub connected: bool,
    /// The current input desktop is `Winlogon` — a UAC prompt, Ctrl+Alt+Del or the lock screen
    /// is on screen right now.
    pub secure_desktop_input: bool,
    /// `GetLastInputInfo` in the console session, or `None` when it cannot be read.
    pub idle_sec: Option<u32>,
    /// Epoch ms the facts were read.
    pub at: i64,
}

impl SessionFacts {
    /// The pre-login state: no console session, or one with nobody logged on.
    pub fn nobody_logged_on(&self) -> bool {
        self.console_session_id.is_none() || !self.logged_on
    }
}

/// §3.4: `none` = nobody logged on to the console session, `locked` = logged on but locked or
/// disconnected, `active` = logged on and unlocked at the console.
///
/// `idleSec` is reported but never decides anything: "an idle, unlocked desktop counts as
/// present, the safer reading".
pub fn derive_interactive(f: &SessionFacts) -> InteractiveState {
    let state = if f.nobody_logged_on() {
        InteractiveStateName::None
    } else if f.locked || !f.connected {
        InteractiveStateName::Locked
    } else {
        InteractiveStateName::Active
    };
    InteractiveState {
        state,
        // Idle time only means something while somebody is actually logged on and unlocked.
        idle_sec: if state == InteractiveStateName::Active {
            f.idle_sec
        } else {
            None
        },
        at: f.at,
        display: None,
    }
}

/// §5.3: which desktop a live session's worker must target.
///
/// A secure desktop that is currently the input desktop wins over "active": a UAC prompt in
/// front of an unlocked session is what the technician needs to see (subject to the rule 5.1c
/// gate, which decides whether they *may*), and capturing `Default` while `Winlogon` has the
/// input would deliver a frozen desktop.
pub fn select_desktop(f: &SessionFacts) -> DesktopTarget {
    if f.nobody_logged_on() {
        return DesktopTarget::LogonScreen;
    }
    if f.locked || !f.connected || f.secure_desktop_input {
        return DesktopTarget::SecureDesktop;
    }
    DesktopTarget::ConsoleDefault {
        session_id: f.console_session_id.unwrap_or(0),
    }
}

/// Whether a change of facts needs the worker killed and relaunched (§5.3 row 4) or merely a
/// notification down the pipe.
///
/// A relaunch is needed exactly when the worker would have to run under a different token: the
/// console session changed, or the target moved between a user desktop and a `Winlogon` one.
/// Everything else (a lock while already on the secure desktop, an idle-time change) is a
/// notification, which keeps a fast lock/unlock from tearing a session down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// Nothing the worker needs to hear about.
    None,
    /// Tell the worker (new interactive state, same desktop and token).
    Notify { target: DesktopTarget },
    /// Kill the worker and launch a new one with `gen + 1` and a fresh worker credential.
    Rebuild { target: DesktopTarget },
}

pub fn transition(from: &SessionFacts, to: &SessionFacts) -> Transition {
    let (a, b) = (select_desktop(from), select_desktop(to));
    let token_changed = match (a, b) {
        (
            DesktopTarget::ConsoleDefault { session_id: x },
            DesktopTarget::ConsoleDefault { session_id: y },
        ) => x != y,
        // Between a user desktop and a LocalSystem one, and between the logon screen and a
        // logged-on secure desktop (a user arrived), the token differs.
        (x, y) => std::mem::discriminant(&x) != std::mem::discriminant(&y),
    };
    if token_changed {
        return Transition::Rebuild { target: b };
    }
    if derive_interactive(from).state != derive_interactive(to).state
        || from.secure_desktop_input != to.secure_desktop_input
    {
        return Transition::Notify { target: b };
    }
    Transition::None
}

/// Rule 5.1c: what the worker may do with a secure surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceVerdict {
    /// Capture and input flow; write `capture.secure_desktop { surface, durationMs }`.
    Allowed,
    /// Hold the last pre-secure-desktop frame, show "Windows security screen (hidden by
    /// policy)", and answer input with `ctl.res` error `secure_desktop`.
    HiddenByPolicy,
    /// The session should never have been opened: pre-login without `allowLogonScreen`. The
    /// server refuses this at `POST` with `409 prelogin_not_permitted`, so a worker that sees
    /// it has been started wrongly and must not capture.
    PreloginNotPermitted,
}

/// `SECURE_DESKTOP_SURFACES`: which surface an audit entry names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecureSurface {
    Logon,
    Uac,
    Lock,
}

impl SecureSurface {
    pub fn as_str(self) -> &'static str {
        match self {
            SecureSurface::Logon => "logon",
            SecureSurface::Uac => "uac",
            SecureSurface::Lock => "lock",
        }
    }
}

/// Which surface the worker is looking at, for the `capture.secure_desktop` entry. `None` on an
/// ordinary user desktop.
pub fn surface_of(target: DesktopTarget, f: &SessionFacts) -> Option<SecureSurface> {
    match target {
        DesktopTarget::ConsoleDefault { .. } => None,
        DesktopTarget::LogonScreen => Some(SecureSurface::Logon),
        // A locked session shows the lock screen; an unlocked one showing Winlogon is a UAC
        // (or Ctrl+Alt+Del) prompt.
        DesktopTarget::SecureDesktop => Some(if f.locked || !f.connected {
            SecureSurface::Lock
        } else {
            SecureSurface::Uac
        }),
    }
}

/// Rule 5.1c, both gates. `elevated` is `session.consent_level === 'elevated'`.
pub fn secure_surface_verdict(
    target: DesktopTarget,
    policy: &UnattendedPolicy,
    elevated: bool,
) -> SurfaceVerdict {
    match target {
        DesktopTarget::ConsoleDefault { .. } => SurfaceVerdict::Allowed,
        // First gate: pre-login is `allowLogonScreen` alone — the logon screen shows no user
        // content, so `control` suffices.
        DesktopTarget::LogonScreen => {
            if policy.allow_logon_screen {
                SurfaceVerdict::Allowed
            } else {
                SurfaceVerdict::PreloginNotPermitted
            }
        }
        // Second gate: the secure desktop of a logged-on user needs privileged mode *and* the
        // flag. Either missing holds the frame rather than showing it.
        DesktopTarget::SecureDesktop => {
            if elevated && policy.allow_secure_desktop {
                SurfaceVerdict::Allowed
            } else {
                SurfaceVerdict::HiddenByPolicy
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ia_core::policy::UnattendedMode;

    fn facts() -> SessionFacts {
        SessionFacts {
            console_session_id: Some(1),
            logged_on: true,
            locked: false,
            connected: true,
            secure_desktop_input: false,
            idle_sec: Some(12),
            at: 1_762_000_000_000,
        }
    }

    fn policy(logon: bool, secure: bool) -> UnattendedPolicy {
        UnattendedPolicy {
            mode: UnattendedMode::Allow,
            allow_logon_screen: logon,
            allow_secure_desktop: secure,
            ..Default::default()
        }
    }

    #[test]
    fn the_interactive_state_table_is_the_contract_one() {
        let active = facts();
        assert_eq!(
            derive_interactive(&active).state,
            InteractiveStateName::Active
        );
        assert_eq!(derive_interactive(&active).idle_sec, Some(12));

        let locked = SessionFacts {
            locked: true,
            ..facts()
        };
        assert_eq!(
            derive_interactive(&locked).state,
            InteractiveStateName::Locked
        );
        assert_eq!(
            derive_interactive(&locked).idle_sec,
            None,
            "idle time of a locked session means nothing"
        );

        let disconnected = SessionFacts {
            connected: false,
            ..facts()
        };
        assert_eq!(
            derive_interactive(&disconnected).state,
            InteractiveStateName::Locked
        );

        for f in [
            SessionFacts {
                logged_on: false,
                ..facts()
            },
            SessionFacts {
                console_session_id: None,
                ..facts()
            },
        ] {
            assert_eq!(derive_interactive(&f).state, InteractiveStateName::None);
        }
    }

    #[test]
    fn an_idle_unlocked_desktop_still_counts_as_present() {
        let idle = SessionFacts {
            idle_sec: Some(100_000),
            ..facts()
        };
        assert_eq!(
            derive_interactive(&idle).state,
            InteractiveStateName::Active
        );
        assert!(ia_core::policy::is_present(Some(
            derive_interactive(&idle).state
        )));
    }

    #[test]
    fn the_desktop_selection_table_is_the_contract_one() {
        assert_eq!(
            select_desktop(&facts()),
            DesktopTarget::ConsoleDefault { session_id: 1 }
        );
        assert_eq!(
            select_desktop(&SessionFacts {
                locked: true,
                ..facts()
            }),
            DesktopTarget::SecureDesktop
        );
        assert_eq!(
            select_desktop(&SessionFacts {
                secure_desktop_input: true,
                ..facts()
            }),
            DesktopTarget::SecureDesktop,
            "a UAC prompt in front of an unlocked session is the secure desktop"
        );
        assert_eq!(
            select_desktop(&SessionFacts {
                logged_on: false,
                ..facts()
            }),
            DesktopTarget::LogonScreen
        );
        assert_eq!(
            select_desktop(&SessionFacts {
                console_session_id: None,
                ..facts()
            }),
            DesktopTarget::LogonScreen
        );
    }

    #[test]
    fn a_fast_user_switch_rebuilds_but_a_lock_only_notifies() {
        let a = facts();
        // Another user takes the console: a different token, so a rebuild with gen + 1.
        let switched = SessionFacts {
            console_session_id: Some(3),
            ..facts()
        };
        assert_eq!(
            transition(&a, &switched),
            Transition::Rebuild {
                target: DesktopTarget::ConsoleDefault { session_id: 3 }
            }
        );
        // Locking moves from the user desktop to Winlogon: also a different token.
        let locked = SessionFacts {
            locked: true,
            ..facts()
        };
        assert_eq!(
            transition(&a, &locked),
            Transition::Rebuild {
                target: DesktopTarget::SecureDesktop
            }
        );
        // A UAC prompt while already on the secure desktop: a notification, not a teardown.
        let uac = SessionFacts {
            locked: true,
            secure_desktop_input: true,
            ..facts()
        };
        assert_eq!(
            transition(&locked, &uac),
            Transition::Notify {
                target: DesktopTarget::SecureDesktop
            }
        );
        // Nothing changed.
        assert_eq!(transition(&a, &facts()), Transition::None);
        // Idle time alone is not a transition.
        assert_eq!(
            transition(
                &a,
                &SessionFacts {
                    idle_sec: Some(900),
                    ..facts()
                }
            ),
            Transition::None
        );
    }

    #[test]
    fn a_user_arriving_at_the_logon_screen_rebuilds_onto_their_desktop() {
        let pre = SessionFacts {
            logged_on: false,
            ..facts()
        };
        assert_eq!(
            transition(&pre, &facts()),
            Transition::Rebuild {
                target: DesktopTarget::ConsoleDefault { session_id: 1 }
            }
        );
    }

    #[test]
    fn an_ordinary_desktop_needs_no_gate() {
        assert_eq!(
            secure_surface_verdict(
                DesktopTarget::ConsoleDefault { session_id: 1 },
                &policy(false, false),
                false
            ),
            SurfaceVerdict::Allowed
        );
        assert_eq!(
            surface_of(DesktopTarget::ConsoleDefault { session_id: 1 }, &facts()),
            None
        );
    }

    #[test]
    fn the_prelogin_gate_is_the_flag_alone_and_control_suffices() {
        assert_eq!(
            secure_surface_verdict(DesktopTarget::LogonScreen, &policy(false, false), true),
            SurfaceVerdict::PreloginNotPermitted
        );
        assert_eq!(
            secure_surface_verdict(DesktopTarget::LogonScreen, &policy(true, false), false),
            SurfaceVerdict::Allowed,
            "the logon screen shows no user content, so privileged mode is not required"
        );
    }

    #[test]
    fn the_secure_desktop_of_a_logged_on_user_needs_both_privileged_mode_and_the_flag() {
        for (elevated, flag, want) in [
            (false, false, SurfaceVerdict::HiddenByPolicy),
            (true, false, SurfaceVerdict::HiddenByPolicy),
            (false, true, SurfaceVerdict::HiddenByPolicy),
            (true, true, SurfaceVerdict::Allowed),
        ] {
            assert_eq!(
                secure_surface_verdict(DesktopTarget::SecureDesktop, &policy(true, flag), elevated),
                want,
                "elevated={elevated} allowSecureDesktop={flag}"
            );
        }
    }

    #[test]
    fn the_audited_surface_names_what_is_on_screen() {
        assert_eq!(
            surface_of(DesktopTarget::LogonScreen, &facts()),
            Some(SecureSurface::Logon)
        );
        assert_eq!(
            surface_of(
                DesktopTarget::SecureDesktop,
                &SessionFacts {
                    locked: true,
                    ..facts()
                }
            ),
            Some(SecureSurface::Lock)
        );
        assert_eq!(
            surface_of(
                DesktopTarget::SecureDesktop,
                &SessionFacts {
                    secure_desktop_input: true,
                    ..facts()
                }
            ),
            Some(SecureSurface::Uac)
        );
        assert_eq!(SecureSurface::Uac.as_str(), "uac");
    }
}
