//! The §8.5 worker launch and the worker's channel (F §8.2, §8.5).
//!
//! In order: the service creates `socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC)`; forks; the
//! child places its end on fd 3 without `CLOEXEC` and drops privileges in the bound order
//! (`setsid` → `setgroups` → `setgid` → `setuid` → `PR_SET_PDEATHSIG` → the `getppid` check) and
//! execs `ia-desktop` with an emptied environment ([`ia_platform::linux::service::sys::
//! spawn_worker`]); the service checks `/proc/<pid>/exe` is the installed worker, writes the
//! blob, and serves the duplex frames until the worker ends.
//!
//! **The fork happens on the channel thread, which lives exactly as long as the worker.** Linux
//! delivers `PR_SET_PDEATHSIG` when the *thread* that forked the child exits, not the process; a
//! fork from a tokio blocking-pool thread would SIGTERM the worker when that thread retired after
//! ten idle seconds.
//!
//! The service checks the peer through the pid `fork` returned and the `ready { pid }` frame, not
//! `SO_PEERCRED`: for a socketpair, the kernel reports the creator's credentials (ours) on both
//! ends (`ia_session0::unix` explains it).

use std::io::{BufReader, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ia_platform::linux::service::sys::{
    spawn_worker, supplementary_groups, terminate_pid, user_info, UserInfo,
};
use ia_platform::linux::service::{
    lang_from_locale_conf, LogindSession, SessionKind, SpawnInputs, SpawnPlan,
};
use ia_platform::DesktopTarget;
use ia_session0::blob::LinuxLaunch;
use ia_session0::proto::{read_frame, write_frame, ServiceFrame, WorkerFrame};
use ia_session0::unix::{
    peer_image, service_peer_matches, unix_peer_verdict, UnixPeerExpectation, UnixPeerObservation,
};

use super::runtime::LinuxShared;
use crate::devicesock::SessionOpen;
use crate::worker::{answer_worker, blob_for, WorkerAction};

/// How long the service waits for the fork and exec to report back.
const SPAWN_TIMEOUT: Duration = Duration::from_secs(10);
/// §8.5: SIGTERM, then SIGKILL after 5 s.
const KILL_GRACE: Duration = Duration::from_secs(5);

/// The dev `--console` overrides of §8.5, so an end-to-end run names no real runtime directory,
/// session bus, system bus or display (S3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DevOverrides {
    /// `--runtime-dir`: the worker's `XDG_RUNTIME_DIR`.
    pub runtime_dir: Option<PathBuf>,
    /// `--session-bus <address|none>`.
    pub session_bus: Option<String>,
    /// `--system-bus`: the logind fake's private bus.
    pub system_bus: Option<String>,
    /// `--display`: the harness display (`:97`).
    pub display: Option<String>,
}

/// What a launch needs beyond the session: who the worker runs as, and where.
#[derive(Debug, Clone)]
pub struct PlanFacts<'a> {
    pub worker_image: &'a Path,
    pub user: &'a UserInfo,
    pub groups: Vec<u32>,
    pub lang: Option<String>,
    pub dev: &'a DevOverrides,
    pub dev_console: bool,
    /// Whether `/run/user/<uid>/bus` exists (production only).
    pub user_bus_exists: bool,
}

/// The §8.5 plan for `session` (pure: every fact is an argument).
pub fn plan_for(session: &LogindSession, f: &PlanFacts<'_>) -> SpawnPlan {
    let kind = if session.type_ == "wayland" {
        SessionKind::Wayland
    } else {
        SessionKind::X11
    };
    let runtime = f
        .dev
        .runtime_dir
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("/run/user/{}", f.user.uid));
    let bus = match f.dev.session_bus.as_deref() {
        Some("none") => None,
        Some(addr) => Some(addr.to_string()),
        None if f.dev_console => None,
        None => f
            .user_bus_exists
            .then(|| format!("unix:path=/run/user/{}/bus", f.user.uid)),
    };
    let display = f
        .dev
        .display
        .clone()
        .or_else(|| Some(session.display.clone()).filter(|d| !d.is_empty()));
    SpawnPlan::build(&SpawnInputs {
        worker_image: f.worker_image.to_string_lossy().into_owned(),
        uid: f.user.uid,
        gid: f.user.gid,
        supplementary_gids: f.groups.clone(),
        home: f.user.home.clone(),
        user: f.user.name.clone(),
        shell: if f.user.shell.is_empty() {
            "/bin/sh".into()
        } else {
            f.user.shell.clone()
        },
        lang: f.lang.clone(),
        session: kind,
        display,
        xdg_runtime_dir: runtime,
        dbus_session_bus: bus,
        pipe_fd: 3,
        dev_console: f.dev_console,
    })
}

/// The system locale (`LANG`), when readable; the plan falls back to `C.UTF-8`.
fn system_lang() -> Option<String> {
    ["/etc/locale.conf", "/etc/default/locale"]
        .iter()
        .find_map(|p| {
            std::fs::read_to_string(p)
                .ok()
                .and_then(|t| lang_from_locale_conf(&t))
        })
}

/// A launched worker and its channel.
pub struct LiveWorker {
    pub session_id: String,
    pub gen: u16,
    pub pid: i32,
    /// The logind session it was launched into (a switch away from it ends the worker).
    pub logind_id: String,
    pub uid: u32,
    pub open: SessionOpen,
    writer: Arc<Mutex<Option<UnixStream>>>,
    stopping: Arc<AtomicBool>,
}

impl LiveWorker {
    /// Push a frame to the worker (an interactive-state change, a stop).
    pub fn notify(&self, frame: &ServiceFrame) {
        if let Ok(mut guard) = self.writer.lock() {
            if let Some(w) = guard.as_mut() {
                if let Err(e) = write_frame(w, frame) {
                    tracing::debug!(error = %e, "the worker channel would not take a notification");
                }
            }
        }
    }

    /// End the worker (§8.5): ask it to stop, close the channel, then SIGTERM and SIGKILL after
    /// 5 s. Blocking; call it off the async threads.
    pub fn stop(&self, reason: &str) {
        self.stopping.store(true, Ordering::SeqCst);
        self.notify(&ServiceFrame::Stop {
            reason: reason.to_string(),
        });
        std::thread::sleep(Duration::from_millis(250));
        if let Ok(mut guard) = self.writer.lock() {
            if let Some(w) = guard.take() {
                let _ = w.shutdown(std::net::Shutdown::Both);
            }
        }
        terminate_pid(self.pid, KILL_GRACE);
    }
}

/// Launch a worker for `open` into `session` at generation `gen` (§8.5). Blocking.
pub fn launch(
    shared: &Arc<LinuxShared>,
    session: &LogindSession,
    open: &SessionOpen,
    gen: u16,
) -> Result<LiveWorker, String> {
    let device_id = shared.device_id().ok_or("the device is not enrolled")?;
    let (api_origin, worker_signal) = {
        let cfg = shared.config.lock().map_err(|_| "config lock")?;
        (cfg.api_origin.clone(), cfg.worker_signal_url())
    };
    // SAFETY: getuid has no preconditions.
    let me = unsafe { libc::getuid() };
    // A dev `--console` service runs as the current user and changes no uid (§8.5).
    let uid = if shared.dev_console { me } else { session.uid };
    if !shared.dev_console && uid == 0 {
        return Err("the session belongs to root; a worker never runs as root (E 7.3d)".into());
    }
    let user = user_info(uid).ok_or_else(|| format!("uid {uid} has no account entry"))?;
    let groups = supplementary_groups(&user.name, user.gid);
    let image = shared.layout.worker_image();
    let mut plan = plan_for(
        session,
        &PlanFacts {
            worker_image: &image,
            user: &user,
            groups,
            lang: system_lang(),
            dev: &shared.dev,
            dev_console: shared.dev_console,
            user_bus_exists: Path::new(&format!("/run/user/{uid}/bus")).exists(),
        },
    );
    plan.argv.extend(shared.worker_extra_args.iter().cloned());

    let monitors: Vec<u32> =
        (1..=shared.facts.lock().map(|f| f.monitors).unwrap_or(1) as u32).collect();
    let mut blob = blob_for(
        open,
        &device_id,
        &api_origin,
        &worker_signal,
        &monitors,
        gen,
        DesktopTarget::ConsoleDefault { session_id: 0 },
        &open.credential,
        &open.credential_expires_at,
    );
    // SAFETY: getpid has no preconditions.
    let service_pid = unsafe { libc::getpid() };
    blob.linux = Some(LinuxLaunch {
        display: plan.env_value("DISPLAY").unwrap_or_default().to_string(),
        session_type: if session.type_ == "wayland" {
            "wayland".into()
        } else {
            "x11".into()
        },
        uid,
        xdg_runtime_dir: plan
            .env_value("XDG_RUNTIME_DIR")
            .unwrap_or_default()
            .to_string(),
        service_pid,
        session_id: Some(session.id.clone()),
    });
    blob.validate()
        .map_err(|e| format!("the blob this service built is not valid: {e}"))?;

    let (service_end, child_end) = UnixStream::pair().map_err(|e| format!("socketpair: {e}"))?;
    let writer = Arc::new(Mutex::new(Some(
        service_end
            .try_clone()
            .map_err(|e| format!("socketpair: {e}"))?,
    )));
    let stopping = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<i32, String>>(1);

    let session_id = open.session_id.clone();
    let thread_shared = shared.clone();
    let thread_writer = writer.clone();
    let thread_stopping = stopping.clone();
    let expected_image = image.clone();
    std::thread::Builder::new()
        .name("ia-worker-channel".into())
        .spawn(move || {
            // The fork happens here, on the thread that outlives the worker (module note).
            let child = match spawn_worker(&plan, child_end.as_raw_fd()) {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(Err(format!("the worker could not be started: {e}")));
                    return;
                }
            };
            drop(child_end);
            let pid = child.id() as i32;
            // `child` is not waited on through std: supervision reaps by pid (`waitpid`).
            drop(child);
            let image_now = peer_image(pid);
            let verdict = unix_peer_verdict(
                &UnixPeerExpectation {
                    pid,
                    image: &canonical(&expected_image),
                },
                &UnixPeerObservation {
                    pid,
                    image: image_now.as_deref(),
                },
            );
            if let Err(why) = verdict {
                terminate_pid(pid, KILL_GRACE);
                let _ = tx.send(Err(format!(
                    "the launched process is not the worker: {why:?}"
                )));
                return;
            }
            let mut service_end = service_end;
            if let Err(e) = write_frame(&mut service_end, &blob) {
                terminate_pid(pid, KILL_GRACE);
                let _ = tx.send(Err(format!("the blob could not be written: {e}")));
                return;
            }
            let _ = tx.send(Ok(pid));
            serve_channel(
                &thread_shared,
                &session_id,
                pid,
                BufReader::new(service_end),
                &thread_writer,
            );
            // The channel closed: the worker ended, crashed or was stopped. Make sure it is gone,
            // and forget the session if it is still this one.
            if !thread_stopping.load(Ordering::SeqCst) {
                terminate_pid(pid, KILL_GRACE);
            }
            if let Ok(mut s) = thread_shared.session.lock() {
                if s.as_ref()
                    .is_some_and(|l| l.session_id == session_id && l.pid == pid)
                {
                    *s = None;
                }
            }
            tracing::info!(session = %session_id, pid, "the worker channel closed");
        })
        .map_err(|e| format!("the worker thread could not start: {e}"))?;

    let pid = rx
        .recv_timeout(SPAWN_TIMEOUT)
        .map_err(|_| "the worker launch did not report back".to_string())??;
    Ok(LiveWorker {
        session_id: open.session_id.clone(),
        gen,
        pid,
        logind_id: session.id.clone(),
        uid,
        open: open.clone(),
        writer,
        stopping,
    })
}

fn canonical(p: &Path) -> String {
    std::fs::canonicalize(p)
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Serve the worker's frames until the channel closes or the worker ends its session.
fn serve_channel(
    shared: &Arc<LinuxShared>,
    session_id: &str,
    child_pid: i32,
    mut reader: BufReader<UnixStream>,
    writer: &Arc<Mutex<Option<UnixStream>>>,
) {
    let reply = |frame: ServiceFrame| {
        if let Ok(mut guard) = writer.lock() {
            if let Some(w) = guard.as_mut() {
                let _ = write_frame(w, &frame);
                let _ = w.flush();
            }
        }
    };
    loop {
        let frame = match read_frame::<_, WorkerFrame>(&mut reader) {
            Ok(f) => f,
            Err(e) => {
                tracing::info!(session = %session_id, error = %e, "the worker channel ended");
                return;
            }
        };
        match answer_worker(&frame, session_id, &shared.identity) {
            WorkerAction::Reply(f) => reply(f),
            WorkerAction::Ready { pid } => {
                // §8.2: the peer is the child `fork` returned.
                if !service_peer_matches(child_pid, pid as i32) {
                    tracing::error!(
                        child_pid,
                        reported = pid,
                        "the worker's pid is not the child this service launched"
                    );
                    return;
                }
                tracing::info!(session = %session_id, pid, "the worker is serving");
            }
            WorkerAction::Alive => {}
            WorkerAction::Monitors { count } => {
                if let Ok(mut f) = shared.facts.lock() {
                    f.monitors = count;
                }
                tracing::info!(count, "the worker reported its monitors");
            }
            // No input lock or privacy screen on Linux (§8.7): nothing to remember.
            WorkerAction::Protections { .. } => {}
            // There is no secure desktop to move to; logind's signals drive any re-evaluation.
            WorkerAction::ReconsiderDesktop { reason } => {
                tracing::debug!(%reason, "a desktop re-evaluation request (nothing to switch on Linux)")
            }
            WorkerAction::SendSas { id } => reply(ServiceFrame::Error {
                re: id,
                code: "not_supported".into(),
            }),
            WorkerAction::Ended { reason } => {
                tracing::info!(session = %session_id, %reason, "the worker ended the session");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(kind: &str) -> LogindSession {
        LogindSession {
            id: "2".into(),
            uid: 1000,
            class: "user".into(),
            type_: kind.into(),
            active: true,
            remote: false,
            locked_hint: false,
            idle_sec: Some(0),
            display: ":0".into(),
        }
    }

    fn user() -> UserInfo {
        UserInfo {
            name: "asha".into(),
            uid: 1000,
            gid: 1000,
            home: "/home/asha".into(),
            shell: "/bin/bash".into(),
        }
    }

    fn facts<'a>(dev: &'a DevOverrides, u: &'a UserInfo, dev_console: bool) -> PlanFacts<'a> {
        PlanFacts {
            worker_image: Path::new("/usr/lib/indiansassist/ia-desktop"),
            user: u,
            groups: vec![1000, 27],
            lang: None,
            dev,
            dev_console,
            user_bus_exists: true,
        }
    }

    #[test]
    fn production_drops_to_the_session_user_with_its_bus_and_display() {
        let (dev, u) = (DevOverrides::default(), user());
        let plan = plan_for(&session("x11"), &facts(&dev, &u, false));
        assert_eq!(plan.cred.as_ref().unwrap().uid, 1000);
        assert_eq!(plan.env_value("DISPLAY"), Some(":0"));
        assert_eq!(plan.env_value("XDG_RUNTIME_DIR"), Some("/run/user/1000"));
        assert_eq!(
            plan.env_value("DBUS_SESSION_BUS_ADDRESS"),
            Some("unix:path=/run/user/1000/bus")
        );
        assert_eq!(plan.cwd, "/home/asha");
    }

    #[test]
    fn dev_console_names_only_the_harness_display_runtime_dir_and_no_session_bus() {
        let dev = DevOverrides {
            runtime_dir: Some(PathBuf::from("/tmp/ia-h/run")),
            session_bus: Some("none".into()),
            system_bus: Some("unix:path=/tmp/ia-h/system_bus".into()),
            display: Some(":97".into()),
        };
        let u = user();
        let plan = plan_for(&session("x11"), &facts(&dev, &u, true));
        assert_eq!(plan.cred, None, "no uid change in dev mode");
        assert_eq!(plan.env_value("DISPLAY"), Some(":97"));
        assert_eq!(plan.env_value("XDG_RUNTIME_DIR"), Some("/tmp/ia-h/run"));
        assert_eq!(plan.env_value("DBUS_SESSION_BUS_ADDRESS"), None);
        // Even without `--session-bus`, a dev run never names the user's real bus.
        let dev = DevOverrides {
            session_bus: None,
            ..dev
        };
        let plan = plan_for(&session("x11"), &facts(&dev, &u, true));
        assert_eq!(plan.env_value("DBUS_SESSION_BUS_ADDRESS"), None);
    }

    #[test]
    fn a_wayland_session_gets_no_display() {
        let (dev, u) = (DevOverrides::default(), user());
        let plan = plan_for(&session("wayland"), &facts(&dev, &u, false));
        assert_eq!(plan.env_value("DISPLAY"), None);
    }
}
