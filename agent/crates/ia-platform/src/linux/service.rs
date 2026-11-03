//! The Linux service seam (contract F §8.2, §8.4, §8.5). The OS halves — `ServiceHost` over
//! `sd_notify` and systemd's D-Bus API, `DesktopBridge` over logind, the `pre_exec` that performs
//! the worker launch — live in `ia-service`'s `src/linux/*` behind the `linux-service` feature.
//! What lives **here** is everything that can be decided without touching the OS, so it is a pure
//! table the service only carries out:
//!
//! * [`logind_facts`] maps a logind session's properties to the §8.4b target and interactive
//!   state (the table §8.12 Pure requires a test for);
//! * [`SpawnPlan`] is the §8.5 worker launch **as data** — the uid, gid, groups, the emptied-then-
//!   exact environment, the fds and the exact order of the privilege-drop calls — so the order
//!   (`setgroups` → `setgid` → `setuid` → `PR_SET_PDEATHSIG` → the `getppid` check) is asserted by
//!   a test rather than trusted in a `pre_exec` closure nobody can unit-test.
//!
//! The module compiles on every host (it is pure), so these tables are tested in the Windows
//! `cargo test --all-features` gate as well as in WSL.

use ia_core::fleet::InteractiveState;
use ia_core::policy::InteractiveStateName;

/// The display server of a logind session (§8.4b `Type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    X11,
    Wayland,
}

impl SessionKind {
    /// The `sessionType` the §8.2 blob and the `interactiveState.display` carry.
    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::X11 => "x11",
            SessionKind::Wayland => "wayland",
        }
    }
}

/// The logind session properties §8.4a reads over the system bus, as plain data so the §8.4b
/// decision is a pure function of them.
#[derive(Debug, Clone)]
pub struct LogindSession {
    /// `Class`: `user`, `greeter`, …
    pub class: String,
    /// `Type`: `x11`, `wayland`, `tty`, …
    pub type_: String,
    /// `Active`: whether this is the seat's foreground session.
    pub active: bool,
    /// `Remote`: an SSH or XRDP session (never a target, §8.4b).
    pub remote: bool,
    /// `LockedHint`: the session is locked (still the target, 8.4e).
    pub locked_hint: bool,
    /// `IdleHint` / `IdleSinceHint` → seconds idle, when known.
    pub idle_sec: Option<u32>,
    /// `Display` (for example `:0`); empty when the session has none.
    pub display: String,
}

/// What §8.4b derives from a session: whether it is a target, and the interactive state and
/// display that `device.hello` and the §8.2 blob carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogindVerdict {
    /// The session is a controllable target (`Class = user`, `Remote = false`, `Active = true`).
    pub is_target: bool,
    /// `active`, `locked` or `none` (§8.4b).
    pub state: InteractiveStateName,
    /// `x11` / `wayland` for a target, `None` otherwise (the `interactiveState.display` field).
    pub display: Option<SessionKind>,
    /// The `DISPLAY` value a worker gets (`:0`), only for an X11 target.
    pub x_display: Option<String>,
    /// Seconds idle (`idleSec`), passed through from `IdleSinceHint`.
    pub idle_sec: Option<u32>,
}

fn kind_of(type_: &str) -> Option<SessionKind> {
    match type_ {
        "x11" => Some(SessionKind::X11),
        "wayland" => Some(SessionKind::Wayland),
        _ => None,
    }
}

/// The §8.4b table: a logind session's properties → target and interactive state.
///
/// A target is a `Class = user`, non-remote, active graphical session. A locked target stays a
/// target (8.4e) but its state is `locked`. Anything else — a greeter, a tty, a remote session,
/// nobody — is `none` and not a target.
pub fn logind_facts(session: Option<&LogindSession>) -> LogindVerdict {
    let none = LogindVerdict {
        is_target: false,
        state: InteractiveStateName::None,
        display: None,
        x_display: None,
        idle_sec: None,
    };
    let Some(s) = session else {
        return none;
    };
    let graphical = kind_of(&s.type_);
    let is_target = s.class == "user" && !s.remote && s.active && graphical.is_some();
    if !is_target {
        return none;
    }
    let state = if s.locked_hint {
        InteractiveStateName::Locked
    } else {
        InteractiveStateName::Active
    };
    let x_display = match graphical {
        Some(SessionKind::X11) if !s.display.is_empty() => Some(s.display.clone()),
        _ => None,
    };
    LogindVerdict {
        is_target: true,
        state,
        display: graphical,
        x_display,
        idle_sec: s.idle_sec,
    }
}

impl LogindVerdict {
    /// The `InteractiveState` the service reports (§3.4), stamped with `at`.
    pub fn interactive_state(&self, at_ms: i64) -> InteractiveState {
        InteractiveState {
            state: self.state,
            idle_sec: self.idle_sec,
            at: at_ms,
        }
    }
}

// ---- the §8.5 worker launch, as data ----------------------------------------------------------

/// One step of the §8.5 privilege drop, in the order the child performs it before `exec`. The
/// order is load-bearing: a uid change clears the parent-death signal, so `PR_SET_PDEATHSIG` must
/// come **after** `setuid`, and the `getppid` recheck after that (the service may have died in the
/// window, leaving the death signal never armed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivilegeStep {
    /// `setsid()`: a new session so a killed service's process group does not take the worker.
    SetSid,
    /// `setgroups(getgrouplist(user))`: the user's supplementary groups.
    SetGroups,
    /// `setgid(primary_gid)`.
    SetGid,
    /// `setuid(uid)`.
    SetUid,
    /// `prctl(PR_SET_PDEATHSIG, SIGTERM)` — after `setuid`, because the uid change cleared it.
    SetPdeathSig,
    /// `getppid()` compared with the service pid captured before `fork`; exit if it differs.
    CheckGetppid,
}

/// The ordered privilege-drop steps of §8.5. In dev `--console` mode the service runs as the
/// current user and performs no uid change, so `setgroups`/`setgid`/`setuid` are omitted; the
/// session, death signal and parent recheck still apply.
pub fn privilege_order(dev_console: bool) -> Vec<PrivilegeStep> {
    if dev_console {
        vec![
            PrivilegeStep::SetSid,
            PrivilegeStep::SetPdeathSig,
            PrivilegeStep::CheckGetppid,
        ]
    } else {
        vec![
            PrivilegeStep::SetSid,
            PrivilegeStep::SetGroups,
            PrivilegeStep::SetGid,
            PrivilegeStep::SetUid,
            PrivilegeStep::SetPdeathSig,
            PrivilegeStep::CheckGetppid,
        ]
    }
}

/// The facts §8.5 builds the worker's launch from. Everything here is known to the service before
/// the fork; the plan ([`SpawnPlan::build`]) turns it into the exact credentials, environment and
/// fds the child applies.
#[derive(Debug, Clone)]
pub struct SpawnInputs {
    /// `/usr/lib/indiansassist/ia-desktop` (the installed worker).
    pub worker_image: String,
    /// The uid of the active graphical session's user.
    pub uid: u32,
    /// The user's primary gid.
    pub gid: u32,
    /// The user's supplementary groups (`getgrouplist`).
    pub supplementary_gids: Vec<u32>,
    pub home: String,
    pub user: String,
    /// The user's login shell.
    pub shell: String,
    /// `LANG` from the session when readable, else `C.UTF-8`.
    pub lang: Option<String>,
    pub session: SessionKind,
    /// The `DISPLAY` for an X11 session; ignored for Wayland (no-screen).
    pub display: Option<String>,
    /// `/run/user/<uid>` in production, or the `--runtime-dir` override in dev.
    pub xdg_runtime_dir: String,
    /// The session bus address when its socket exists (`unix:path=/run/user/<uid>/bus`), for the
    /// E `ksni` tray; `None` when there is none (or `--session-bus none` in dev).
    pub dbus_session_bus: Option<String>,
    /// The socketpair child-end fd number the worker reads the blob from (fd 3, §8.2).
    pub pipe_fd: i32,
    /// Dev `--console` mode: no uid change.
    pub dev_console: bool,
}

/// Where a child fd points (§8.5: fd 0 `/dev/null`, fds 1 and 2 the journal, fd 3 the socketpair).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FdTarget {
    DevNull,
    /// Inherited from the service, whose stdout/stderr systemd routes to the journal.
    Journal,
    /// The socketpair child end, kept at this fd number.
    SocketPair,
}

/// The credentials the child applies, in [`privilege_order`]. `None` in dev `--console` mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredPlan {
    pub uid: u32,
    pub gid: u32,
    pub supplementary_gids: Vec<u32>,
}

/// The §8.5 launch as data: the image, argv, the emptied-then-exact environment, the working
/// directory, the fd map, the credentials and the call order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnPlan {
    pub image: String,
    pub argv: Vec<String>,
    /// The child's environment, cleared first then set to exactly these pairs, in a fixed order.
    pub env: Vec<(String, String)>,
    pub cwd: String,
    /// `(fd number, target)`, ascending.
    pub fds: Vec<(i32, FdTarget)>,
    /// The credentials to drop to, or `None` in dev `--console` mode.
    pub cred: Option<CredPlan>,
    pub order: Vec<PrivilegeStep>,
}

impl SpawnPlan {
    /// Build the plan from the facts. Pure: it touches no OS.
    pub fn build(inp: &SpawnInputs) -> Self {
        let mut env: Vec<(String, String)> = vec![
            ("HOME".into(), inp.home.clone()),
            ("USER".into(), inp.user.clone()),
            ("LOGNAME".into(), inp.user.clone()),
            ("SHELL".into(), inp.shell.clone()),
            ("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into()),
            (
                "LANG".into(),
                inp.lang.clone().unwrap_or_else(|| "C.UTF-8".into()),
            ),
            ("XDG_RUNTIME_DIR".into(), inp.xdg_runtime_dir.clone()),
        ];
        // DISPLAY only on X11; a Wayland worker starts in the no-screen mode (§8.4d) with none.
        if matches!(inp.session, SessionKind::X11) {
            if let Some(d) = &inp.display {
                if !d.is_empty() {
                    env.push(("DISPLAY".into(), d.clone()));
                }
            }
        }
        if let Some(bus) = &inp.dbus_session_bus {
            if !bus.is_empty() {
                env.push(("DBUS_SESSION_BUS_ADDRESS".into(), bus.clone()));
            }
        }
        let cred = if inp.dev_console {
            None
        } else {
            Some(CredPlan {
                uid: inp.uid,
                gid: inp.gid,
                supplementary_gids: inp.supplementary_gids.clone(),
            })
        };
        SpawnPlan {
            image: inp.worker_image.clone(),
            argv: vec![inp.worker_image.clone()],
            env,
            cwd: inp.home.clone(),
            fds: vec![
                (0, FdTarget::DevNull),
                (1, FdTarget::Journal),
                (2, FdTarget::Journal),
                (inp.pipe_fd, FdTarget::SocketPair),
            ],
            cred,
            order: privilege_order(inp.dev_console),
        }
    }

    /// The environment as a map lookup, for assertions and logging.
    pub fn env_value(&self, key: &str) -> Option<&str> {
        self.env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_session() -> LogindSession {
        LogindSession {
            class: "user".into(),
            type_: "x11".into(),
            active: true,
            remote: false,
            locked_hint: false,
            idle_sec: Some(12),
            display: ":0".into(),
        }
    }

    #[test]
    fn an_active_x11_user_session_is_the_target() {
        let v = logind_facts(Some(&target_session()));
        assert!(v.is_target);
        assert_eq!(v.state, InteractiveStateName::Active);
        assert_eq!(v.display, Some(SessionKind::X11));
        assert_eq!(v.x_display.as_deref(), Some(":0"));
        assert_eq!(v.idle_sec, Some(12));
    }

    #[test]
    fn a_locked_target_stays_a_target_but_reports_locked() {
        let v = logind_facts(Some(&LogindSession {
            locked_hint: true,
            ..target_session()
        }));
        assert!(v.is_target, "8.4e: a locked session stays the target");
        assert_eq!(v.state, InteractiveStateName::Locked);
    }

    #[test]
    fn a_wayland_target_carries_no_x_display() {
        let v = logind_facts(Some(&LogindSession {
            type_: "wayland".into(),
            display: String::new(),
            ..target_session()
        }));
        assert!(v.is_target);
        assert_eq!(v.display, Some(SessionKind::Wayland));
        assert_eq!(v.x_display, None);
    }

    #[test]
    fn a_greeter_a_remote_an_inactive_or_a_tty_session_is_never_a_target() {
        for s in [
            LogindSession {
                class: "greeter".into(),
                ..target_session()
            },
            LogindSession {
                remote: true,
                ..target_session()
            },
            LogindSession {
                active: false,
                ..target_session()
            },
            LogindSession {
                type_: "tty".into(),
                ..target_session()
            },
        ] {
            let v = logind_facts(Some(&s));
            assert!(!v.is_target);
            assert_eq!(v.state, InteractiveStateName::None);
            assert_eq!(v.display, None);
        }
        // Nobody signed in at all.
        assert_eq!(logind_facts(None).state, InteractiveStateName::None);
    }

    fn inputs() -> SpawnInputs {
        SpawnInputs {
            worker_image: "/usr/lib/indiansassist/ia-desktop".into(),
            uid: 1000,
            gid: 1000,
            supplementary_gids: vec![4, 27, 1000],
            home: "/home/asha".into(),
            user: "asha".into(),
            shell: "/bin/bash".into(),
            lang: Some("en_IN.UTF-8".into()),
            session: SessionKind::X11,
            display: Some(":0".into()),
            xdg_runtime_dir: "/run/user/1000".into(),
            dbus_session_bus: Some("unix:path=/run/user/1000/bus".into()),
            pipe_fd: 3,
            dev_console: false,
        }
    }

    #[test]
    fn pdeathsig_comes_after_setuid_and_the_getppid_check_after_that() {
        let order = privilege_order(false);
        let pos = |s: PrivilegeStep| order.iter().position(|x| *x == s).unwrap();
        assert!(
            pos(PrivilegeStep::SetPdeathSig) > pos(PrivilegeStep::SetUid),
            "a uid change clears the death signal, so it must be armed after setuid"
        );
        assert!(pos(PrivilegeStep::CheckGetppid) > pos(PrivilegeStep::SetPdeathSig));
        // setgroups → setgid → setuid, in that order (§8.5).
        assert!(pos(PrivilegeStep::SetGroups) < pos(PrivilegeStep::SetGid));
        assert!(pos(PrivilegeStep::SetGid) < pos(PrivilegeStep::SetUid));
    }

    #[test]
    fn dev_console_drops_no_credentials_but_still_arms_the_death_signal() {
        let order = privilege_order(true);
        assert!(!order.contains(&PrivilegeStep::SetUid));
        assert!(order.contains(&PrivilegeStep::SetPdeathSig));
        assert!(order.contains(&PrivilegeStep::CheckGetppid));
        let plan = SpawnPlan::build(&SpawnInputs {
            dev_console: true,
            ..inputs()
        });
        assert_eq!(plan.cred, None);
    }

    #[test]
    fn the_spawn_plan_carries_the_exact_environment_and_fds() {
        let plan = SpawnPlan::build(&inputs());
        assert_eq!(plan.env_value("PATH"), Some("/usr/local/bin:/usr/bin:/bin"));
        assert_eq!(plan.env_value("HOME"), Some("/home/asha"));
        assert_eq!(plan.env_value("LOGNAME"), Some("asha"));
        assert_eq!(plan.env_value("LANG"), Some("en_IN.UTF-8"));
        assert_eq!(plan.env_value("XDG_RUNTIME_DIR"), Some("/run/user/1000"));
        assert_eq!(plan.env_value("DISPLAY"), Some(":0"));
        assert_eq!(
            plan.env_value("DBUS_SESSION_BUS_ADDRESS"),
            Some("unix:path=/run/user/1000/bus")
        );
        assert_eq!(plan.cwd, "/home/asha");
        assert_eq!(
            plan.cred.as_ref().unwrap().supplementary_gids,
            vec![4, 27, 1000]
        );
        assert_eq!(plan.fds[0], (0, FdTarget::DevNull));
        assert_eq!(plan.fds[3], (3, FdTarget::SocketPair));
        // Nothing of the service's own environment leaks: only the §8.5 keys are present.
        let keys: Vec<&str> = plan.env.iter().map(|(k, _)| k.as_str()).collect();
        for k in &keys {
            assert!(
                matches!(
                    *k,
                    "HOME"
                        | "USER"
                        | "LOGNAME"
                        | "SHELL"
                        | "PATH"
                        | "LANG"
                        | "XDG_RUNTIME_DIR"
                        | "DISPLAY"
                        | "DBUS_SESSION_BUS_ADDRESS"
                ),
                "unexpected env key leaked: {k}"
            );
        }
    }

    #[test]
    fn a_wayland_worker_gets_no_display() {
        let plan = SpawnPlan::build(&SpawnInputs {
            session: SessionKind::Wayland,
            display: None,
            ..inputs()
        });
        assert_eq!(plan.env_value("DISPLAY"), None);
    }

    #[test]
    fn lang_falls_back_to_c_utf8_and_a_missing_bus_is_omitted() {
        let plan = SpawnPlan::build(&SpawnInputs {
            lang: None,
            dbus_session_bus: None,
            ..inputs()
        });
        assert_eq!(plan.env_value("LANG"), Some("C.UTF-8"));
        assert_eq!(plan.env_value("DBUS_SESSION_BUS_ADDRESS"), None);
    }
}
