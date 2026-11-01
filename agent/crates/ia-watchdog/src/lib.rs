//! `ia-watchdog`: the §10.1 watchdog's decision, as a table.
//!
//! Two things watch `IndiansAssistAgent`: a second service (`IndiansAssistWatchdog`) and a
//! scheduled task (`IndiansAssist Watchdog`, at startup and every 5 minutes). Either may be the
//! only one left — that is the point of having both — so both run the same check and the same
//! decision, which lives here.
//!
//! What the watchdog is honest about (§10.4): a local administrator can stop a service they
//! own, and can stop the watchdog too. The value is **visibility**, not prevention: every stop,
//! disable, deletion and binary change is recorded as a signed tamper event, backfilled to the
//! server on the next connection, and shown red in the fleet view. An attacker can disable the
//! agent; they cannot do it silently.
//!
//! The one rule that is easy to get wrong, and is the reason this is a table rather than a
//! handful of `if`s: **a modified binary is never restarted.** Restarting it would be the
//! watchdog helpfully running an attacker's replacement. It is recorded and left stopped
//! (§10.3 "refuses to spawn the worker until repaired").

use ia_core::fleet::TamperCause;
use ia_platform::ServiceState;
use serde::{Deserialize, Serialize};

/// The service the watchdog watches.
pub const AGENT_SERVICE: &str = "IndiansAssistAgent";
/// The watchdog's own service name.
pub const WATCHDOG_SERVICE: &str = "IndiansAssistWatchdog";
/// The §10.1 scheduled task.
pub const WATCHDOG_TASK: &str = "IndiansAssist Watchdog";
/// How often the service loop and the task check (§10.1: every 5 minutes).
pub const CHECK_INTERVAL_SEC: u64 = 300;
/// At most this many restart attempts inside [`RESTART_WINDOW_SEC`]. Past it the watchdog
/// records and stops trying: a service that will not stay up is a problem for a person, and a
/// restart loop would bury the evidence under its own noise.
pub const RESTART_MAX_IN_WINDOW: u32 = 3;
pub const RESTART_WINDOW_SEC: u64 = 1800;

/// What one check saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    /// What the SCM says about `IndiansAssistAgent`.
    pub agent: ServiceState,
    /// §10.3: the agent and worker binaries match the installed manifest (sha256) and are
    /// signed by `IA_EXPECTED_SIGNER`.
    pub binaries_ok: bool,
    /// §10.4: `config.json` and `manifest.json` hash to what was recorded.
    pub config_ok: bool,
    /// The §10.1 scheduled task is registered.
    pub task_registered: bool,
    /// Restart attempts already made inside the window.
    pub restarts_in_window: u32,
}

/// What the watchdog does about it. Every variant carries the tamper cause to record, except
/// [`Verdict::Healthy`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Verdict {
    /// Nothing to do.
    Healthy,
    /// Start the service, and record `cause`.
    Restart { cause: TamperCause },
    /// Set the start type back to automatic, then start it; record `disabled`.
    EnableThenRestart { cause: TamperCause },
    /// The service registration is gone: re-register it from the preserved MSI cache, then
    /// start it; record `deleted`.
    Reregister { cause: TamperCause },
    /// Record the cause and do **not** start anything (a modified binary, or too many restarts
    /// in the window).
    RecordOnly {
        cause: TamperCause,
        why: &'static str,
    },
    /// Re-register the scheduled task (it was removed), and record nothing: a missing task is
    /// not evidence of tampering by itself — an upgrade can drop it — and the service's own
    /// start-up registration is the other half of this belt and braces.
    RegisterTask,
}

/// The §10.1 decision.
pub fn decide(o: &Observation) -> Verdict {
    // A modified binary comes first: whatever else is true, the watchdog must not start it.
    if !o.binaries_ok {
        return Verdict::RecordOnly {
            cause: TamperCause::BinaryChanged,
            why: "the agent binary does not match the installed manifest; it is not restarted",
        };
    }
    // A changed config is recorded even while the service runs happily: §10.4's value is the
    // record, and the service re-reads its config, so a change takes effect without a restart.
    if !o.config_ok {
        return Verdict::RecordOnly {
            cause: TamperCause::ConfigChanged,
            why: "the configuration or manifest hash changed",
        };
    }
    let cause = match o.agent {
        ServiceState::Running | ServiceState::StartPending => {
            return if o.task_registered {
                Verdict::Healthy
            } else {
                Verdict::RegisterTask
            };
        }
        // Mid-stop: let it finish and look again at the next check rather than fighting the SCM.
        ServiceState::StopPending => return Verdict::Healthy,
        ServiceState::Stopped => TamperCause::Stopped,
        ServiceState::Disabled => TamperCause::Disabled,
        ServiceState::Missing => TamperCause::Deleted,
    };
    if o.restarts_in_window >= RESTART_MAX_IN_WINDOW {
        return Verdict::RecordOnly {
            cause,
            why: "the restart budget for this window is spent; a person needs to look",
        };
    }
    match o.agent {
        ServiceState::Disabled => Verdict::EnableThenRestart { cause },
        ServiceState::Missing => Verdict::Reregister { cause },
        _ => Verdict::Restart { cause },
    }
}

/// The cause recorded *after* a restart the watchdog performed, so the chain shows both the
/// stop and the repair (§10.1 `watchdog_restarted`).
pub fn restarted_cause() -> TamperCause {
    TamperCause::WatchdogRestarted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy() -> Observation {
        Observation {
            agent: ServiceState::Running,
            binaries_ok: true,
            config_ok: true,
            task_registered: true,
            restarts_in_window: 0,
        }
    }

    #[test]
    fn a_running_service_with_its_task_is_left_alone() {
        assert_eq!(decide(&healthy()), Verdict::Healthy);
    }

    #[test]
    fn a_stopped_disabled_or_deleted_service_is_repaired_and_recorded() {
        assert_eq!(
            decide(&Observation {
                agent: ServiceState::Stopped,
                ..healthy()
            }),
            Verdict::Restart {
                cause: TamperCause::Stopped
            }
        );
        assert_eq!(
            decide(&Observation {
                agent: ServiceState::Disabled,
                ..healthy()
            }),
            Verdict::EnableThenRestart {
                cause: TamperCause::Disabled
            }
        );
        assert_eq!(
            decide(&Observation {
                agent: ServiceState::Missing,
                ..healthy()
            }),
            Verdict::Reregister {
                cause: TamperCause::Deleted
            }
        );
    }

    #[test]
    fn a_modified_binary_is_recorded_and_never_restarted() {
        for state in [
            ServiceState::Stopped,
            ServiceState::Running,
            ServiceState::Disabled,
            ServiceState::Missing,
        ] {
            let v = decide(&Observation {
                agent: state,
                binaries_ok: false,
                ..healthy()
            });
            match v {
                Verdict::RecordOnly { cause, .. } => assert_eq!(cause, TamperCause::BinaryChanged),
                other => panic!("a modified binary must never be started: {other:?}"),
            }
        }
    }

    #[test]
    fn a_changed_config_is_recorded_even_while_the_service_is_healthy() {
        let v = decide(&Observation {
            config_ok: false,
            ..healthy()
        });
        assert_eq!(
            v,
            Verdict::RecordOnly {
                cause: TamperCause::ConfigChanged,
                why: "the configuration or manifest hash changed",
            }
        );
    }

    #[test]
    fn a_service_that_is_still_stopping_is_given_time() {
        assert_eq!(
            decide(&Observation {
                agent: ServiceState::StopPending,
                ..healthy()
            }),
            Verdict::Healthy
        );
        assert_eq!(
            decide(&Observation {
                agent: ServiceState::StartPending,
                ..healthy()
            }),
            Verdict::Healthy
        );
    }

    #[test]
    fn the_restart_budget_stops_a_loop_but_still_records() {
        let o = Observation {
            agent: ServiceState::Stopped,
            restarts_in_window: RESTART_MAX_IN_WINDOW,
            ..healthy()
        };
        match decide(&o) {
            Verdict::RecordOnly { cause, why } => {
                assert_eq!(cause, TamperCause::Stopped);
                assert!(why.contains("budget"));
            }
            other => panic!("{other:?}"),
        }
        // One attempt below the budget still tries.
        let o = Observation {
            restarts_in_window: RESTART_MAX_IN_WINDOW - 1,
            ..o
        };
        assert_eq!(
            decide(&o),
            Verdict::Restart {
                cause: TamperCause::Stopped
            }
        );
    }

    #[test]
    fn a_missing_scheduled_task_is_re_registered_without_crying_tamper() {
        assert_eq!(
            decide(&Observation {
                task_registered: false,
                ..healthy()
            }),
            Verdict::RegisterTask
        );
    }

    #[test]
    fn a_repair_is_itself_recorded() {
        assert_eq!(restarted_cause(), TamperCause::WatchdogRestarted);
    }
}
