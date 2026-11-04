//! The Linux service seam (contract F §8.2, §8.4, §8.5, §8.8). Two layers:
//!
//! * the **OS layer**, [`sys`] (`cfg(target_os = "linux")` + `linux-os`): `sd_notify` over
//!   `$NOTIFY_SOCKET` (no libsystemd), the `pre_exec` that performs a [`SpawnPlan`] in
//!   [`privilege_order`], worker supervision over `waitpid`, the account and network facts, and
//!   `ServiceHost` / `DesktopBridge` built on them. The two D-Bus clients those need (systemd's
//!   unit API and logind) are the [`SystemdUnits`] and [`LogindSource`] seams, implemented over
//!   zbus in `ia-service` — zbus is a direct dependency of `ia-service` only (§10). The `Waker` is
//!   `ia_waker::LocalWaker` fed with [`sys::ipv4_interfaces`] and [`sys::gateway`]; `Amt` is
//!   [`LinuxAmt`] (`present: false`);
//! * the **pure layer**, everything that can be decided without touching the OS, so it is a
//!   table the service only carries out:
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
    /// `Id` (`2`, `c1`): names the session scope for the 8.4c cookie discovery.
    pub id: String,
    /// `User`: the session owner's uid (the uid the worker runs as, §8.5).
    pub uid: u32,
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
    /// The `InteractiveState` the service reports (§3.4), stamped with `at`, with the §8.3e
    /// `display` of a target session.
    pub fn interactive_state(&self, at_ms: i64) -> InteractiveState {
        InteractiveState {
            state: self.state,
            // Idle time only means something while somebody is there and unlocked (D §3.4).
            idle_sec: if self.state == InteractiveStateName::Active {
                self.idle_sec
            } else {
                None
            },
            at: at_ms,
            display: self.display.map(|d| d.as_str().to_string()),
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

    /// The fd number the socketpair end must land on in the child (fd 3).
    pub fn pipe_fd(&self) -> i32 {
        self.fds
            .iter()
            .find(|(_, t)| *t == FdTarget::SocketPair)
            .map(|(n, _)| *n)
            .unwrap_or(3)
    }
}

/// `LANG` from a `/etc/locale.conf` or `/etc/default/locale` text (the system locale: logind does
/// not expose a session's `LANG`, so this is the closest readable value; `None` → `C.UTF-8`).
pub fn lang_from_locale_conf(text: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let v = l.trim().strip_prefix("LANG=")?;
        let v = v.trim().trim_matches('"').trim_matches('\'');
        let ok = !v.is_empty()
            && v.len() <= 64
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'@'));
        ok.then(|| v.to_string())
    })
}

// ---- sd_notify (§8.8) -------------------------------------------------------------------------

/// `sd_notify` states the service sends (§8.8): after the enrollment state is loaded, every 20 s
/// from the main loop, and on the way out.
pub const NOTIFY_READY: &str = "READY=1";
pub const NOTIFY_WATCHDOG: &str = "WATCHDOG=1";
pub const NOTIFY_STOPPING: &str = "STOPPING=1";
/// §8.8: `WATCHDOG=1` every 20 s against the unit's `WatchdogSec=60`.
pub const WATCHDOG_INTERVAL_SEC: u64 = 20;

/// Where `$NOTIFY_SOCKET` points: a filesystem path, or an abstract name (`@…`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotifyTarget {
    Path(String),
    Abstract(Vec<u8>),
}

/// Parse `$NOTIFY_SOCKET` (`None` when unset, empty or neither form: not run by systemd).
pub fn notify_target(value: Option<&str>) -> Option<NotifyTarget> {
    let v = value?.trim();
    if let Some(name) = v.strip_prefix('@') {
        return (!name.is_empty()).then(|| NotifyTarget::Abstract(name.as_bytes().to_vec()));
    }
    v.starts_with('/')
        .then(|| NotifyTarget::Path(v.to_string()))
}

// ---- systemd and logind seams ----------------------------------------------------------------

use crate::service::{DesktopError, ServiceError, ServiceState};

/// The systemd D-Bus calls the service needs for its own unit (§8.2): implemented over zbus in
/// `ia-service` (zbus is a direct dependency of `ia-service` only, §10), so this crate stays free
/// of a D-Bus stack.
pub trait SystemdUnits: Send + Sync {
    /// `(ActiveState, UnitFileState)` of `unit`.
    fn unit_state(&self, unit: &str) -> Result<(String, String), ServiceError>;
    /// `StartUnit(unit, "replace")`.
    fn start_unit(&self, unit: &str) -> Result<(), ServiceError>;
    /// The unit's `NRestarts` (the §8.8 `watchdog_restarted` tamper input).
    fn n_restarts(&self, unit: &str) -> Result<u32, ServiceError>;
}

/// logind over the system bus (§8.4a), implemented over zbus in `ia-service`.
pub trait LogindSource: Send + Sync {
    /// `seat0`'s `ActiveSession` and its properties, or `None` when the seat has none.
    fn active_session(&self) -> Result<Option<LogindSession>, DesktopError>;
}

/// systemd's `(ActiveState, UnitFileState)` as the D §10.1 [`ServiceState`].
pub fn service_state_of(active_state: &str, unit_file_state: &str) -> ServiceState {
    let running = matches!(active_state, "active" | "reloading");
    if !running && matches!(unit_file_state, "" | "not-found") {
        return ServiceState::Missing;
    }
    if !running && matches!(unit_file_state, "disabled" | "masked" | "masked-runtime") {
        return ServiceState::Disabled;
    }
    match active_state {
        "active" | "reloading" => ServiceState::Running,
        "activating" => ServiceState::StartPending,
        "deactivating" => ServiceState::StopPending,
        _ => ServiceState::Stopped,
    }
}

/// F §8.2: `Amt` on Linux reports `present: false` (no MEI access in Phase F) and refuses to
/// proxy; the service advertises neither `amt` nor `amt_proxy` (§8.7).
#[derive(Debug, Clone, Copy, Default)]
pub struct LinuxAmt;

impl crate::service::Amt for LinuxAmt {
    fn inventory(&self) -> ia_core::fleet::AmtInventory {
        ia_core::fleet::AmtInventory {
            present: false,
            provisioned: false,
            version: None,
            host: None,
            tls: false,
            power_state: None,
        }
    }

    fn command(
        &self,
        _req: &crate::service::AmtRequest<'_>,
    ) -> Result<crate::service::AmtOutcome, crate::service::AmtError> {
        Err(crate::service::AmtError::Unsupported)
    }
}

// ---- network facts for the waker (rule 8.2a) --------------------------------------------------

/// The default route's interface and gateway from a `/proc/net/route` text.
pub fn default_gateway(proc_net_route: &str) -> Option<(String, std::net::Ipv4Addr)> {
    proc_net_route.lines().skip(1).find_map(|l| {
        let cols: Vec<&str> = l.split_whitespace().collect();
        if cols.len() < 8 || cols[1] != "00000000" || cols[7] != "00000000" {
            return None;
        }
        let gw = u32::from_str_radix(cols[2], 16).ok()?;
        // The kernel prints the raw network-order word in host order, so its native bytes are the
        // address bytes.
        let addr = std::net::Ipv4Addr::from(gw.to_ne_bytes());
        (!addr.is_unspecified()).then(|| (cols[0].to_string(), addr))
    })
}

/// The MAC of `ip` from a `/proc/net/arp` text (a complete entry only), lower-case colon form.
pub fn arp_mac(proc_net_arp: &str, ip: std::net::Ipv4Addr) -> Option<String> {
    let want = ip.to_string();
    proc_net_arp.lines().skip(1).find_map(|l| {
        let cols: Vec<&str> = l.split_whitespace().collect();
        if cols.len() < 4 || cols[0] != want {
            return None;
        }
        let flags = u32::from_str_radix(cols[2].trim_start_matches("0x"), 16).ok()?;
        let mac = cols[3].to_ascii_lowercase();
        (flags & 0x2 != 0 && mac != "00:00:00:00:00:00").then_some(mac)
    })
}

/// The calls that need the OS: `sd_notify`, the §8.5 spawn, worker supervision, the network and
/// account facts, and the `ServiceHost` / `DesktopBridge` impls built on them.
#[cfg(all(target_os = "linux", feature = "linux-os"))]
pub mod sys {
    use std::ffi::{CStr, CString};
    use std::io;
    use std::net::Ipv4Addr;
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::io::RawFd;
    use std::os::unix::net::{SocketAddr, UnixDatagram};
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::{Child, Command, Stdio};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::{
        logind_facts, notify_target, service_state_of, LogindSource, NotifyTarget, PrivilegeStep,
        SpawnPlan, SystemdUnits, NOTIFY_READY, NOTIFY_STOPPING,
    };
    use crate::service::{
        DesktopBridge, DesktopError, DesktopTarget, LaunchedWorker, ServiceError, ServiceHost,
        ServiceState,
    };

    /// Send one `sd_notify` datagram to `target`.
    pub fn notify_to(target: &NotifyTarget, state: &str) -> io::Result<()> {
        let sock = UnixDatagram::unbound()?;
        match target {
            NotifyTarget::Path(p) => sock.send_to(state.as_bytes(), p)?,
            NotifyTarget::Abstract(name) => {
                let addr = SocketAddr::from_abstract_name(name)?;
                sock.send_to_addr(state.as_bytes(), &addr)?
            }
        };
        Ok(())
    }

    /// `sd_notify(state)` over `$NOTIFY_SOCKET` (no libsystemd). `Ok(false)` when the service
    /// is not run by systemd (the `--console` dev mode), which is not an error.
    pub fn sd_notify(state: &str) -> io::Result<bool> {
        let value = std::env::var("NOTIFY_SOCKET").ok();
        match notify_target(value.as_deref()) {
            Some(t) => notify_to(&t, state).map(|_| true),
            None => Ok(false),
        }
    }

    /// The §8.5 launch: fork, then in the child — before `exec` and in exactly the plan's order —
    /// place the socketpair end on fd 3 without `CLOEXEC`, `setsid`, `setgroups`, `setgid`,
    /// `setuid`, `PR_SET_PDEATHSIG(SIGTERM)`, and the `getppid` recheck. Any failure aborts the
    /// child before `exec`. The environment is emptied and set to exactly `plan.env`; fd 0 is
    /// `/dev/null`, fds 1 and 2 are inherited (the journal under systemd).
    pub fn spawn_worker(plan: &SpawnPlan, child_fd: RawFd) -> io::Result<Child> {
        // SAFETY: getpid has no preconditions.
        let service_pid = unsafe { libc::getpid() };
        let target_fd = plan.pipe_fd();
        let order = plan.order.clone();
        let (uid, gid, groups): (libc::uid_t, libc::gid_t, Vec<libc::gid_t>) = match &plan.cred {
            Some(c) => (c.uid, c.gid, c.supplementary_gids.clone()),
            None => (0, 0, Vec::new()),
        };
        let mut cmd = Command::new(&plan.image);
        cmd.args(plan.argv.iter().skip(1))
            .env_clear()
            .envs(plan.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .current_dir(&plan.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        // SAFETY: the closure runs in the forked child before exec and makes only
        // async-signal-safe calls (dup2, fcntl, setsid, setgroups, setgid, setuid, prctl,
        // getppid) on values computed before the fork; it allocates nothing.
        unsafe {
            cmd.pre_exec(move || {
                if child_fd == target_fd {
                    let flags = libc::fcntl(target_fd, libc::F_GETFD);
                    if flags < 0
                        || libc::fcntl(target_fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                } else if libc::dup2(child_fd, target_fd) < 0 {
                    // dup2 leaves the new descriptor without CLOEXEC.
                    return Err(io::Error::last_os_error());
                }
                for step in &order {
                    let rc = match step {
                        PrivilegeStep::SetSid => libc::setsid(),
                        PrivilegeStep::SetGroups => libc::setgroups(groups.len(), groups.as_ptr()),
                        PrivilegeStep::SetGid => libc::setgid(gid),
                        PrivilegeStep::SetUid => libc::setuid(uid),
                        PrivilegeStep::SetPdeathSig => {
                            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong)
                        }
                        PrivilegeStep::CheckGetppid => {
                            if libc::getppid() != service_pid {
                                // The service died between fork and here: the death signal
                                // was never armed, so the child must not live on.
                                return Err(io::Error::from_raw_os_error(libc::ESRCH));
                            }
                            0
                        }
                    };
                    if rc < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        cmd.spawn()
    }

    /// Reap `pid` if it has exited. `true` when it is gone (reaped, or not ours and not alive).
    fn reaped(pid: i32) -> bool {
        let mut status = 0;
        // SAFETY: WNOHANG never blocks; `status` is a valid out-pointer.
        let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if r == pid {
            return true;
        }
        // SAFETY: signal 0 only checks existence.
        r < 0 && unsafe { libc::kill(pid, 0) } != 0
    }

    /// Whether the worker is alive (supervision; reaps it when it has exited).
    pub fn pid_alive(pid: i32) -> bool {
        pid > 1 && !reaped(pid)
    }

    /// §8.5: SIGTERM, then SIGKILL after `grace`.
    pub fn terminate_pid(pid: i32, grace: Duration) {
        if pid <= 1 {
            return;
        }
        // SAFETY: plain signal delivery to a pid we launched.
        unsafe { libc::kill(pid, libc::SIGTERM) };
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if reaped(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // SAFETY: as above; the blocking wait reaps the killed child.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            let mut status = 0;
            libc::waitpid(pid, &mut status, 0);
        }
    }

    /// The account facts the spawn plan needs (`getpwuid_r`).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct UserInfo {
        pub name: String,
        pub uid: u32,
        pub gid: u32,
        pub home: String,
        pub shell: String,
    }

    pub fn user_info(uid: u32) -> Option<UserInfo> {
        let mut buf = vec![0u8; 16 * 1024];
        // SAFETY: `pwd` and `result` are out-parameters; `buf` is sized and its length passed;
        // the strings are copied out before `buf` is dropped.
        unsafe {
            let mut pwd: libc::passwd = std::mem::zeroed();
            let mut result: *mut libc::passwd = std::ptr::null_mut();
            let rc = libc::getpwuid_r(
                uid,
                &mut pwd,
                buf.as_mut_ptr().cast(),
                buf.len(),
                &mut result,
            );
            if rc != 0 || result.is_null() {
                return None;
            }
            let s = |p: *const libc::c_char| {
                if p.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(p).to_string_lossy().into_owned()
                }
            };
            Some(UserInfo {
                name: s(pwd.pw_name),
                uid: pwd.pw_uid,
                gid: pwd.pw_gid,
                home: s(pwd.pw_dir),
                shell: s(pwd.pw_shell),
            })
        }
    }

    /// The user's supplementary groups (`getgrouplist`), primary gid included.
    pub fn supplementary_groups(name: &str, gid: u32) -> Vec<u32> {
        let Ok(cname) = CString::new(name) else {
            return vec![gid];
        };
        let mut n: libc::c_int = 32;
        loop {
            let mut groups = vec![0 as libc::gid_t; n as usize];
            let mut count = n;
            // SAFETY: `groups` has room for `count` entries; getgrouplist updates `count`.
            let rc =
                unsafe { libc::getgrouplist(cname.as_ptr(), gid, groups.as_mut_ptr(), &mut count) };
            if rc >= 0 {
                groups.truncate(count.max(0) as usize);
                return groups;
            }
            if count <= n || n >= 65_536 {
                return vec![gid];
            }
            n = count;
        }
    }

    /// One usable IPv4 interface (up, not loopback).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct NetIface {
        pub name: String,
        pub addr: Ipv4Addr,
        pub prefix_len: u8,
        pub mac: Option<String>,
    }

    /// The usable IPv4 interfaces (`getifaddrs`), with each one's MAC from sysfs.
    pub fn ipv4_interfaces() -> Vec<NetIface> {
        let mut out = Vec::new();
        // SAFETY: getifaddrs allocates a list freed by freeifaddrs below; every pointer is
        // checked for null before it is read, and nothing outlives the list.
        unsafe {
            let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
            if libc::getifaddrs(&mut ifap) != 0 {
                return out;
            }
            let mut cur = ifap;
            while !cur.is_null() {
                let ifa = &*cur;
                cur = ifa.ifa_next;
                if ifa.ifa_addr.is_null() || ifa.ifa_netmask.is_null() {
                    continue;
                }
                if i32::from((*ifa.ifa_addr).sa_family) != libc::AF_INET {
                    continue;
                }
                let flags = ifa.ifa_flags as libc::c_int;
                if flags & libc::IFF_UP == 0 || flags & libc::IFF_LOOPBACK != 0 {
                    continue;
                }
                let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                let mask = &*(ifa.ifa_netmask as *const libc::sockaddr_in);
                let addr = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                let prefix_len = u32::from_be(mask.sin_addr.s_addr).count_ones() as u8;
                let name = CStr::from_ptr(ifa.ifa_name).to_string_lossy().into_owned();
                let mac = std::fs::read_to_string(
                    Path::new("/sys/class/net").join(&name).join("address"),
                )
                .ok()
                .map(|m| m.trim().to_ascii_lowercase())
                .filter(|m| m.len() == 17 && m != "00:00:00:00:00:00");
                out.push(NetIface {
                    name,
                    addr,
                    prefix_len,
                    mac,
                });
            }
            libc::freeifaddrs(ifap);
        }
        out
    }

    /// The default route's interface and gateway, and the gateway's MAC when the ARP cache has it.
    pub fn gateway() -> Option<(String, Ipv4Addr, Option<String>)> {
        let route = std::fs::read_to_string("/proc/net/route").ok()?;
        let (iface, gw) = super::default_gateway(&route)?;
        let mac = std::fs::read_to_string("/proc/net/arp")
            .ok()
            .and_then(|t| super::arp_mac(&t, gw));
        Some((iface, gw, mac))
    }

    /// §8.2 `ServiceHost`: `sd_notify` for the lifecycle, the systemd D-Bus API (through
    /// [`SystemdUnits`]) for `query_state` and `start`; the failure actions and the scheduled
    /// task are carried by the unit file itself, so those answer `Ok`.
    pub struct LinuxServiceHost {
        pub units: Arc<dyn SystemdUnits>,
    }

    impl ServiceHost for LinuxServiceHost {
        fn report_running(&self) -> Result<(), ServiceError> {
            sd_notify(NOTIFY_READY)
                .map(|_| ())
                .map_err(|e| ServiceError::Os(e.to_string()))
        }
        fn report_stopped(&self, _exit_code: u32) -> Result<(), ServiceError> {
            sd_notify(NOTIFY_STOPPING)
                .map(|_| ())
                .map_err(|e| ServiceError::Os(e.to_string()))
        }
        fn set_failure_actions(
            &self,
            _name: &str,
            _delays: &[Duration],
        ) -> Result<(), ServiceError> {
            // `Restart=on-failure` and `RestartSec=5` are in the unit (§8.8).
            Ok(())
        }
        fn query_state(&self, name: &str) -> Result<ServiceState, ServiceError> {
            let (active, file) = self.units.unit_state(name)?;
            Ok(service_state_of(&active, &file))
        }
        fn start(&self, name: &str) -> Result<(), ServiceError> {
            self.units.start_unit(name)
        }
        fn set_auto_start(&self, _name: &str) -> Result<(), ServiceError> {
            // The package enables the unit (`postinst`, §8.9).
            Ok(())
        }
        fn register_task(&self, _name: &str, _xml: &Path) -> Result<(), ServiceError> {
            // No watchdog task on Linux: systemd's `WatchdogSec=` replaces it (W110).
            Ok(())
        }
        fn task_exists(&self, _name: &str) -> Result<bool, ServiceError> {
            Ok(true)
        }
    }

    /// §8.4 `DesktopBridge` over logind. The worker itself is launched with [`spawn_worker`]
    /// (the socketpair and the §8.5 plan do not fit the Windows-shaped `launch_worker`, which
    /// therefore refuses); supervision and teardown are the D §4.2 rule over `waitpid`.
    pub struct LinuxDesktopBridge {
        pub logind: Arc<dyn LogindSource>,
    }

    impl DesktopBridge for LinuxDesktopBridge {
        fn interactive_state(&self) -> Result<ia_core::fleet::InteractiveState, DesktopError> {
            let session = self.logind.active_session()?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Ok(logind_facts(session.as_ref()).interactive_state(now))
        }
        fn console_session_id(&self) -> Option<u32> {
            let session = self.logind.active_session().ok().flatten()?;
            logind_facts(Some(&session))
                .is_target
                .then(|| session.id.parse().ok())
                .flatten()
        }
        fn secure_desktop_is_input(&self) -> bool {
            false
        }
        fn launch_worker(
            &self,
            _image: &Path,
            _pipe_suffix: &str,
            _target: DesktopTarget,
        ) -> Result<LaunchedWorker, DesktopError> {
            Err(DesktopError::Launch(
                "the Linux worker is launched over a socketpair with spawn_worker (F §8.5)".into(),
            ))
        }
        fn terminate_worker(&self, worker: &LaunchedWorker) -> Result<(), DesktopError> {
            terminate_pid(worker.pid as i32, Duration::from_secs(5));
            Ok(())
        }
        fn worker_alive(&self, worker: &LaunchedWorker) -> bool {
            pid_alive(worker.pid as i32)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::super::{SessionKind, SpawnInputs};
        use super::*;
        use std::io::Read;
        use std::os::unix::io::AsRawFd;
        use std::os::unix::net::UnixStream;

        #[test]
        fn sd_notify_reaches_a_datagram_socket_and_is_silent_without_one() {
            let dir = std::env::temp_dir().join(format!("ia-notify-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("notify.sock");
            let _ = std::fs::remove_file(&path);
            let rx = UnixDatagram::bind(&path).unwrap();
            notify_to(
                &NotifyTarget::Path(path.to_string_lossy().into_owned()),
                NOTIFY_READY,
            )
            .unwrap();
            let mut buf = [0u8; 64];
            let n = rx.recv(&mut buf).unwrap();
            assert_eq!(&buf[..n], b"READY=1");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn the_dev_spawn_hands_fd_3_and_only_the_planned_environment_to_the_child() {
            let home = std::env::temp_dir().join(format!("ia-spawn-{}", std::process::id()));
            std::fs::create_dir_all(&home).unwrap();
            let (parent_end, child_end) = UnixStream::pair().unwrap();
            let mut plan = SpawnPlan::build(&SpawnInputs {
                worker_image: "/bin/sh".into(),
                // SAFETY: getuid / getgid have no preconditions.
                uid: unsafe { libc::getuid() },
                gid: unsafe { libc::getgid() },
                supplementary_gids: vec![],
                home: home.to_string_lossy().into_owned(),
                user: "ia-test".into(),
                shell: "/bin/sh".into(),
                lang: None,
                session: SessionKind::X11,
                display: Some(":97".into()),
                xdg_runtime_dir: home.to_string_lossy().into_owned(),
                dbus_session_bus: None,
                pipe_fd: 3,
                dev_console: true,
            });
            plan.argv.extend([
                "-c".to_string(),
                "printf 'cwd=%s\\n' \"$(pwd)\" >&3; env >&3".to_string(),
            ]);
            let mut child = spawn_worker(&plan, child_end.as_raw_fd()).unwrap();
            drop(child_end);
            let mut out = String::new();
            let mut parent_end = parent_end;
            parent_end.read_to_string(&mut out).unwrap();
            assert!(child.wait().unwrap().success());
            assert!(out.contains(&format!("cwd={}", home.display())), "{out}");
            assert!(out.contains("PATH=/usr/local/bin:/usr/bin:/bin"), "{out}");
            assert!(out.contains("DISPLAY=:97"), "{out}");
            assert!(out.contains("LANG=C.UTF-8"), "{out}");
            // The test process's own environment (cargo sets these) did not leak.
            assert!(!out.contains("CARGO_PKG_NAME"), "{out}");
            assert!(!out.contains("DBUS_SESSION_BUS_ADDRESS"), "{out}");
            let _ = std::fs::remove_dir_all(&home);
        }

        #[test]
        fn a_spawned_worker_is_supervised_and_terminated() {
            let home = std::env::temp_dir();
            let (_a, b) = UnixStream::pair().unwrap();
            let mut plan = SpawnPlan::build(&SpawnInputs {
                worker_image: "/bin/sh".into(),
                uid: 0,
                gid: 0,
                supplementary_gids: vec![],
                home: home.to_string_lossy().into_owned(),
                user: "ia-test".into(),
                shell: "/bin/sh".into(),
                lang: None,
                session: SessionKind::Wayland,
                display: None,
                xdg_runtime_dir: home.to_string_lossy().into_owned(),
                dbus_session_bus: None,
                pipe_fd: 3,
                dev_console: true,
            });
            plan.argv.extend(["-c".to_string(), "sleep 30".to_string()]);
            let mut child = spawn_worker(&plan, b.as_raw_fd()).unwrap();
            let pid = child.id() as i32;
            assert!(pid_alive(pid));
            terminate_pid(pid, Duration::from_secs(2));
            assert!(!pid_alive(pid));
            // Already reaped by terminate_pid; this only satisfies the handle.
            let _ = child.wait();
        }

        #[test]
        fn the_account_facts_of_this_user_are_readable() {
            // SAFETY: getuid has no preconditions.
            let me = unsafe { libc::getuid() };
            let u = user_info(me).expect("this user has a passwd entry");
            assert_eq!(u.uid, me);
            assert!(!u.name.is_empty());
            assert!(supplementary_groups(&u.name, u.gid).contains(&u.gid));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_session() -> LogindSession {
        LogindSession {
            id: "2".into(),
            uid: 1000,
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

    #[test]
    fn the_socketpair_lands_on_fd_3() {
        assert_eq!(SpawnPlan::build(&inputs()).pipe_fd(), 3);
    }

    #[test]
    fn the_system_locale_is_read_and_a_strange_value_is_not() {
        assert_eq!(
            lang_from_locale_conf("# x\nLANG=\"en_IN.UTF-8\"\nLC_TIME=C\n").as_deref(),
            Some("en_IN.UTF-8")
        );
        assert_eq!(lang_from_locale_conf("LANG=$(reboot)"), None);
        assert_eq!(lang_from_locale_conf("LC_ALL=C"), None);
    }

    #[test]
    fn notify_socket_values_parse_to_a_path_or_an_abstract_name() {
        assert_eq!(
            notify_target(Some("/run/systemd/notify")),
            Some(NotifyTarget::Path("/run/systemd/notify".into()))
        );
        assert_eq!(
            notify_target(Some("@/org/freedesktop/systemd1/notify/1")),
            Some(NotifyTarget::Abstract(
                b"/org/freedesktop/systemd1/notify/1".to_vec()
            ))
        );
        for v in [None, Some(""), Some("@"), Some("relative/sock")] {
            assert_eq!(notify_target(v), None, "{v:?}");
        }
        assert_eq!(NOTIFY_READY, "READY=1");
        assert_eq!(NOTIFY_WATCHDOG, "WATCHDOG=1");
        // §8.8: three pings fit inside WatchdogSec=60.
        const _: () = assert!(WATCHDOG_INTERVAL_SEC * 3 <= 60);
    }

    #[test]
    fn systemd_unit_states_map_to_the_d_service_states() {
        assert_eq!(service_state_of("active", "enabled"), ServiceState::Running);
        assert_eq!(
            service_state_of("activating", "enabled"),
            ServiceState::StartPending
        );
        assert_eq!(
            service_state_of("deactivating", "enabled"),
            ServiceState::StopPending
        );
        assert_eq!(service_state_of("failed", "enabled"), ServiceState::Stopped);
        assert_eq!(
            service_state_of("inactive", "disabled"),
            ServiceState::Disabled
        );
        assert_eq!(
            service_state_of("inactive", "masked"),
            ServiceState::Disabled
        );
        assert_eq!(service_state_of("inactive", ""), ServiceState::Missing);
        // A running unit is running, whatever its enablement.
        assert_eq!(
            service_state_of("active", "disabled"),
            ServiceState::Running
        );
    }

    #[test]
    fn linux_amt_is_absent_and_refuses_to_proxy() {
        use crate::service::{Amt, AmtProxyOp, AmtRequest};
        let amt = LinuxAmt;
        assert!(!amt.inventory().present);
        let req = AmtRequest {
            host: "10.0.0.9",
            tls: true,
            user: "admin",
            password: zeroize::Zeroizing::new(String::new()),
            op: AmtProxyOp::PowerOn,
        };
        assert!(amt.command(&req).is_err());
    }

    #[test]
    fn the_default_gateway_and_its_mac_are_read_from_proc() {
        let route =
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
                     eth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n\
                     eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n";
        let (iface, gw) = default_gateway(route).unwrap();
        assert_eq!(iface, "eth0");
        assert_eq!(gw, std::net::Ipv4Addr::new(192, 168, 0, 1));
        let arp =
            "IP address       HW type     Flags       HW address            Mask     Device\n\
                   192.168.0.7      0x1         0x2         11:22:33:44:55:66     *        eth0\n\
                   192.168.0.1      0x1         0x2         AA:BB:CC:DD:EE:FF     *        eth0\n";
        assert_eq!(arp_mac(arp, gw).as_deref(), Some("aa:bb:cc:dd:ee:ff"));
        let incomplete = "IP address HW type Flags HW address Mask Device\n\
                          192.168.0.1 0x1 0x0 00:00:00:00:00:00 * eth0\n";
        assert_eq!(arp_mac(incomplete, gw), None);
        assert_eq!(default_gateway("Iface\tDestination\n"), None);
    }
}
