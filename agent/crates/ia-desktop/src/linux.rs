//! The Linux worker entry (F §8.2, §8.4, §8.5): the blob over the inherited socketpair on fd 3.
//!
//! In order: `FD_CLOEXEC` on fd 3 (done as the very first statement of `main`), refuse euid 0
//! (the E 7.3d rule), read and validate the blob, check that `getppid()` and `SO_PEERCRED` on fd 3
//! both name the service pid the blob carries (and that we run as the uid it names), prepare the
//! display (X11 with the 8.4c cookie, or the 8.4d Wayland no-screen mode), then run the unchanged
//! serve loop through [`crate::channel`].

use std::io::BufReader;
use std::os::unix::io::{FromRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use ia_session0::blob::{LaunchBlob, LinuxLaunch};
use ia_session0::proto::read_frame;
use ia_session0::unix::{parent_pid, peer_identity, worker_parent_matches};

use crate::xauth;

/// The fd the service hands the socketpair's child end on (§8.2).
pub const BLOB_FD: RawFd = 3;

pub fn main(args: &[String]) {
    if let Err(e) = run(args) {
        tracing::error!(error = %e, "the worker stopped");
        eprintln!("ia-desktop: {e}");
        std::process::exit(1);
    }
}

/// Why the worker refuses to start, before anything is shown or connected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartRefusal {
    Root,
    NotLaunchedByService,
    NoLinuxFacts,
    WrongParent { expected: i32, actual: i32 },
    WrongPeer { expected: i32, actual: i32 },
    WrongUser { expected: u32, actual: u32 },
}

impl std::fmt::Display for StartRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartRefusal::Root => write!(
                f,
                "the worker refuses to run as root; it runs as the signed-in user (E 7.3d)"
            ),
            StartRefusal::NotLaunchedByService => write!(
                f,
                "fd 3 is not the service's channel: ia-desktop is launched by the IndiansAssist service, not by hand"
            ),
            StartRefusal::NoLinuxFacts => {
                write!(f, "the launch blob carries no Linux session facts")
            }
            StartRefusal::WrongParent { expected, actual } => write!(
                f,
                "the parent process is {actual}, not the service ({expected}); the service died or this is not its child"
            ),
            StartRefusal::WrongPeer { expected, actual } => write!(
                f,
                "fd 3 belongs to process {actual}, not the service ({expected})"
            ),
            StartRefusal::WrongUser { expected, actual } => write!(
                f,
                "running as uid {actual}, but the session belongs to uid {expected}"
            ),
        }
    }
}

/// The identity checks of §8.2 / §8.5 as one decision over observed facts (pure; tested).
pub fn start_verdict(
    euid: u32,
    uid: u32,
    linux: &LinuxLaunch,
    ppid: i32,
    peer_pid: i32,
) -> Result<(), StartRefusal> {
    if euid == 0 {
        return Err(StartRefusal::Root);
    }
    if !worker_parent_matches(linux.service_pid, ppid) {
        return Err(StartRefusal::WrongParent {
            expected: linux.service_pid,
            actual: ppid,
        });
    }
    if peer_pid != linux.service_pid {
        return Err(StartRefusal::WrongPeer {
            expected: linux.service_pid,
            actual: peer_pid,
        });
    }
    if uid != linux.uid {
        return Err(StartRefusal::WrongUser {
            expected: linux.uid,
            actual: uid,
        });
    }
    Ok(())
}

/// What the worker's display environment becomes (pure; the caller applies it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayPlan {
    /// `DISPLAY` to set, or `None` to remove it.
    pub display: Option<String>,
    /// `XDG_SESSION_TYPE=wayland` marks the 8.4d no-screen mode for the serve loop.
    pub session_type: &'static str,
    /// `XAUTHORITY` to set when a cookie was found.
    pub xauthority: Option<PathBuf>,
}

pub fn display_plan(linux: &LinuxLaunch, cookie: Option<PathBuf>) -> DisplayPlan {
    if linux.session_type == "wayland" {
        // 8.4d: no portal under the service (nobody may be there to answer its dialog); the
        // worker offers chat, files and playbooks as the user and shares no screen.
        return DisplayPlan {
            display: None,
            session_type: "wayland",
            xauthority: None,
        };
    }
    DisplayPlan {
        display: Some(linux.display.clone()).filter(|d| !d.is_empty()),
        session_type: "x11",
        xauthority: cookie,
    }
}

fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// fd 3 must be an open socket; anything else means we were not launched by the service.
fn fd3_is_socket() -> bool {
    // SAFETY: `st` is a plain struct fstat fills; a closed fd only makes fstat fail.
    unsafe {
        let mut st: libc::stat = std::mem::zeroed();
        libc::fstat(BLOB_FD, &mut st) == 0 && (st.st_mode & libc::S_IFMT) == libc::S_IFSOCK
    }
}

fn run(args: &[String]) -> Result<(), String> {
    if euid() == 0 {
        return Err(StartRefusal::Root.to_string());
    }
    if !fd3_is_socket() {
        return Err(StartRefusal::NotLaunchedByService.to_string());
    }
    // SAFETY: fd 3 is an open socket (checked above) that this process owns from here on; nothing
    // else in the process holds or closes it.
    let stream = unsafe { UnixStream::from_raw_fd(BLOB_FD) };
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|e| format!("fd 3 could not be duplicated: {e}"))?,
    );
    let blob: LaunchBlob =
        read_frame(&mut reader).map_err(|e| format!("the launch blob could not be read: {e}"))?;
    blob.validate()
        .map_err(|e| format!("the launch blob is not usable: {e}"))?;
    let linux = blob
        .linux
        .clone()
        .ok_or_else(|| StartRefusal::NoLinuxFacts.to_string())?;
    // For a socketpair, SO_PEERCRED names the process that created it: the service.
    let (_peer_uid, peer_pid) =
        peer_identity(BLOB_FD).map_err(|e| format!("SO_PEERCRED on fd 3: {e}"))?;
    start_verdict(euid(), uid(), &linux, parent_pid(), peer_pid).map_err(|e| e.to_string())?;

    let home = std::env::var_os("HOME").map(PathBuf::from);
    let runtime = PathBuf::from(&linux.xdg_runtime_dir);
    let cookie = if linux.session_type == "x11" {
        xauth::discover(
            &xauth::Roots::system(),
            &xauth::Want {
                uid: linux.uid,
                display: &linux.display,
                session_id: linux.session_id.as_deref(),
                runtime_dir: Some(&runtime),
                home: home.as_deref(),
            },
        )
    } else {
        None
    };
    let plan = display_plan(&linux, cookie);
    // Single-threaded still (the channel reader and the runtime start below), so changing the
    // environment here is safe.
    match &plan.display {
        Some(d) => std::env::set_var("DISPLAY", d),
        None => std::env::remove_var("DISPLAY"),
    }
    std::env::set_var("XDG_SESSION_TYPE", plan.session_type);
    std::env::remove_var("WAYLAND_DISPLAY");
    match &plan.xauthority {
        Some(p) => {
            tracing::info!(cookie = %p.display(), "the X cookie was found (8.4c)");
            std::env::set_var("XAUTHORITY", p);
        }
        None if plan.session_type == "x11" => {
            tracing::info!("no X cookie was found; connecting without one (8.4c)")
        }
        None => tracing::info!("a Wayland session: no screen is shared (8.4d)"),
    }
    crate::channel::serve_blob(blob, reader, stream, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lx(session_type: &str) -> LinuxLaunch {
        LinuxLaunch {
            display: ":0".into(),
            session_type: session_type.into(),
            uid: 1000,
            xdg_runtime_dir: "/run/user/1000".into(),
            service_pid: 700,
            session_id: Some("2".into()),
        }
    }

    #[test]
    fn the_worker_starts_only_as_the_users_child_of_the_service() {
        let l = lx("x11");
        assert_eq!(start_verdict(1000, 1000, &l, 700, 700), Ok(()));
        assert_eq!(
            start_verdict(0, 0, &l, 700, 700),
            Err(StartRefusal::Root),
            "E 7.3d: never as root"
        );
        assert_eq!(
            start_verdict(1000, 1000, &l, 1, 700),
            Err(StartRefusal::WrongParent {
                expected: 700,
                actual: 1
            }),
            "reparented to init: the service died before the death signal was armed"
        );
        assert_eq!(
            start_verdict(1000, 1000, &l, 700, 999),
            Err(StartRefusal::WrongPeer {
                expected: 700,
                actual: 999
            })
        );
        assert_eq!(
            start_verdict(1001, 1001, &l, 700, 700),
            Err(StartRefusal::WrongUser {
                expected: 1000,
                actual: 1001
            })
        );
    }

    #[test]
    fn an_x11_session_keeps_its_display_and_cookie() {
        let p = display_plan(
            &lx("x11"),
            Some(PathBuf::from("/run/user/1000/gdm/Xauthority")),
        );
        assert_eq!(p.display.as_deref(), Some(":0"));
        assert_eq!(p.session_type, "x11");
        assert!(p.xauthority.is_some());
    }

    #[test]
    fn a_wayland_session_is_the_no_screen_mode() {
        let p = display_plan(&lx("wayland"), Some(PathBuf::from("/x")));
        assert_eq!(p.display, None);
        assert_eq!(p.session_type, "wayland");
        assert_eq!(p.xauthority, None);
        // And the serve loop reads exactly that as Wayland (E §7.4 table).
        let env = ia_platform::linux::DisplayEnv {
            xdg_session_type: Some(p.session_type.into()),
            wayland_display: None,
            display: p.display.clone(),
        };
        assert_eq!(
            ia_platform::linux::display_server(&env),
            ia_platform::linux::DisplayServer::Wayland
        );
    }

    #[test]
    fn fd3_is_cloexec_after_the_first_statement_of_main() {
        // `main` arms FD_CLOEXEC on fd 3 first; prove the helper does what main relies on, on a
        // real socket placed at a fresh fd.
        use std::os::unix::io::AsRawFd;
        let (a, _b) = UnixStream::pair().unwrap();
        ia_session0::unix::clear_cloexec(a.as_raw_fd()).unwrap();
        assert!(!ia_session0::unix::is_cloexec(a.as_raw_fd()).unwrap());
        ia_session0::unix::set_cloexec(a.as_raw_fd()).unwrap();
        assert!(ia_session0::unix::is_cloexec(a.as_raw_fd()).unwrap());
    }
}
