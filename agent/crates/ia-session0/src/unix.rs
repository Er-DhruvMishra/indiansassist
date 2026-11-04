//! The Unix session-0 transport (contract F §8.2 and the §16.3 coordinator decision): the D §4.2
//! duplex channel over an **inherited socketpair** instead of a named pipe.
//!
//! On Linux (and later macOS) there is no `\\.\pipe\...` the two processes rendezvous on and that
//! a third process could squat. The service creates `socketpair(AF_UNIX, SOCK_STREAM |
//! SOCK_CLOEXEC)`, clears `CLOEXEC` on the child end, and passes it to the worker as **fd 3**; the
//! worker's first act is `fcntl(3, F_SETFD, FD_CLOEXEC)`, so nothing it later spawns (an `sh`
//! playbook, `xdg-open`) inherits the channel. The blob and the frames ([`crate::blob`],
//! [`crate::proto`]) travel over it unchanged.
//!
//! Because the channel is a private, already-connected fd pair rather than a name, the C §7.2
//! pid / image checks reduce to two decisions, both pure and tested here:
//!
//! * the **worker** checks that `getppid()` is the service pid the blob carries
//!   ([`worker_parent_matches`]), and that `SO_PEERCRED` on fd 3 names that same pid;
//! * the **service** checks that the peer is the child it spawned ([`service_peer_matches`]).
//!
//! One kernel fact shapes the service side: for a `socketpair(2)`, `SO_PEERCRED` returns the
//! credentials in effect **when the pair was created** — the service's own — on both ends
//! (unix(7)). It therefore cannot name the worker. The service compares the pid `fork` returned
//! with the `ready { pid }` frame the worker sends and with `/proc/<pid>/exe`; the fd itself is
//! unforgeable, because only that child inherited it (every other fd the service holds is
//! `CLOEXEC`). The worker's `SO_PEERCRED` check is sound for the same reason in reverse.
//!
//! A richer verdict that also compares the peer's image ([`unix_peer_verdict`]) backs both: on
//! Linux the image is read from `/proc/<pid>/exe`; the macOS code-signing check that replaces that
//! comparison lives in an apple-owned block the apple stream fills.
//!
//! This module is built `cfg(unix)` — on Windows it is absent and the named-pipe transport in
//! [`crate::pipe`] is used instead.

use std::io;
use std::os::unix::io::RawFd;

/// Why a socketpair peer was refused. Each is a hard failure: the side that sees it drops the
/// connection rather than talking to something it cannot identify.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnixPeerRefusal {
    /// The peer's pid is not the one this side expected (the spawned child, or the parent).
    WrongPid,
    /// The peer runs an image that is not the installed binary.
    WrongImage,
    /// The peer's image could not be read at all.
    UnknownImage,
}

/// What this side expects of the other.
#[derive(Debug, Clone)]
pub struct UnixPeerExpectation<'a> {
    /// The pid this side expects: the spawned child (service side) or the parent (worker side).
    pub pid: i32,
    /// The installed image the peer must be running (`/usr/lib/indiansassist/ia-desktop` for the
    /// worker, `.../ia-service` for the service).
    pub image: &'a str,
}

/// The pid and image actually observed (from `SO_PEERCRED` / `getppid` and `/proc/<pid>/exe`);
/// `image` is `None` when it could not be read.
#[derive(Debug, Clone)]
pub struct UnixPeerObservation<'a> {
    pub pid: i32,
    pub image: Option<&'a str>,
}

/// The worker's rule (§8.2): `getppid()` must be the service pid the blob carries. A pid of 0 or a
/// negative value is never a valid parent (the service died before the death signal was armed).
pub fn worker_parent_matches(blob_service_pid: i32, actual_ppid: i32) -> bool {
    blob_service_pid > 1 && actual_ppid == blob_service_pid
}

/// The service's rule (§8.2): the peer's pid — the `ready { pid }` the worker reports, checked
/// against `/proc/<pid>/exe` — must be the child `fork` returned (see the module note on why
/// `SO_PEERCRED` cannot be used on this side of a socketpair).
pub fn service_peer_matches(spawned_child_pid: i32, peer_pid: i32) -> bool {
    spawned_child_pid > 1 && peer_pid == spawned_child_pid
}

/// Compare an observed image path (as `/proc/<pid>/exe` resolves it) with the installed path.
///
/// A deleted-and-replaced binary resolves with a trailing `" (deleted)"`, which is stripped before
/// the comparison; paths are compared exactly otherwise (Linux file names are case-sensitive).
pub fn same_unix_image(observed: &str, expected: &str) -> bool {
    let observed = observed
        .strip_suffix(" (deleted)")
        .unwrap_or(observed)
        .trim();
    !expected.is_empty() && observed == expected.trim()
}

/// The §8.2 / C §7.2 peer check as a decision, used by both ends. The pid is the primary gate (a
/// socketpair has no name to squat); the image comparison is the second line of defence.
pub fn unix_peer_verdict(
    expected: &UnixPeerExpectation<'_>,
    observed: &UnixPeerObservation<'_>,
) -> Result<(), UnixPeerRefusal> {
    if expected.pid <= 1 || observed.pid != expected.pid {
        return Err(UnixPeerRefusal::WrongPid);
    }
    match observed.image {
        None => Err(UnixPeerRefusal::UnknownImage),
        Some(got) if same_unix_image(got, expected.image) => Ok(()),
        Some(_) => Err(UnixPeerRefusal::WrongImage),
    }
}

/// The peer identity `(uid, pid)` of the process on the other end of a connected `AF_UNIX` socket.
///
/// The Linux arm reads `SO_PEERCRED`. The macOS arm (apple-owned) reads `getpeereid` for the uid
/// and `LOCAL_PEERPID` for the pid; until the apple stream fills it, it returns
/// [`io::ErrorKind::Unsupported`], so a Linux build is unaffected and a macOS build compiles.
#[cfg(unix)]
pub fn peer_identity(fd: RawFd) -> io::Result<(u32, i32)> {
    #[cfg(target_os = "linux")]
    {
        linux_peer_cred(fd)
    }
    #[cfg(target_os = "macos")]
    {
        // apple-owned: begin
        // F §8.2 / §16.3: the macOS peer lookup (`getpeereid` + `getsockopt(LOCAL_PEERPID)`).
        // Empty until the apple stream fills it; the stub returns `Unsupported` so the macOS
        // P4 build compiles and macOS P4 end to end is reported blocked on this item.
        let _ = fd;
        Err(io::Error::from(io::ErrorKind::Unsupported))
        // apple-owned: end
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = fd;
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

/// The installed image the peer `pid` is running, for [`unix_peer_verdict`].
///
/// The Linux arm reads `/proc/<pid>/exe`. The macOS code-signing check that replaces this
/// comparison (a `SecCode` designated-requirement check) is an apple-owned block the apple stream
/// fills; until then it returns `None`, so the pid check stands alone on macOS.
#[cfg(unix)]
pub fn peer_image(pid: i32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/exe"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }
    #[cfg(target_os = "macos")]
    {
        // apple-owned: begin
        // F §8.2 / §16.3: the macOS `SecCode` designated-requirement check in place of Linux's
        // `/proc/<pid>/exe` comparison. Empty until the apple stream fills it.
        let _ = pid;
        None
        // apple-owned: end
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(target_os = "linux")]
fn linux_peer_cred(fd: RawFd) -> io::Result<(u32, i32)> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` and `len` are valid for writes of the sizes passed; `fd` is a borrowed,
    // caller-owned socket fd that outlives this call.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((cred.uid, cred.pid))
}

/// This process's parent pid (`getppid`), for the worker's §8.2 check.
#[cfg(unix)]
pub fn parent_pid() -> i32 {
    // SAFETY: getppid has no preconditions and cannot fail.
    unsafe { libc::getppid() }
}

/// Set `FD_CLOEXEC` on `fd` (the worker's first act on fd 3, §8.2), preserving any other flags.
#[cfg(unix)]
pub fn set_cloexec(fd: RawFd) -> io::Result<()> {
    set_cloexec_flag(fd, true)
}

/// Clear `FD_CLOEXEC` on `fd` (the service does this on the child end before the launch, §8.2).
#[cfg(unix)]
pub fn clear_cloexec(fd: RawFd) -> io::Result<()> {
    set_cloexec_flag(fd, false)
}

/// Whether `FD_CLOEXEC` is set on `fd` (used by the tests to prove the worker armed it).
#[cfg(unix)]
pub fn is_cloexec(fd: RawFd) -> io::Result<bool> {
    // SAFETY: `F_GETFD` reads the descriptor flags of a borrowed fd and takes no pointer.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(flags & libc::FD_CLOEXEC != 0)
}

#[cfg(unix)]
fn set_cloexec_flag(fd: RawFd, on: bool) -> io::Result<()> {
    // SAFETY: `F_GETFD` / `F_SETFD` read and write the descriptor flags of a borrowed fd.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let next = if on {
        flags | libc::FD_CLOEXEC
    } else {
        flags & !libc::FD_CLOEXEC
    };
    // SAFETY: as above; `next` is a valid flag set derived from the current one.
    let rc = unsafe { libc::fcntl(fd, libc::F_SETFD, next) };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKER_IMAGE: &str = "/usr/lib/indiansassist/ia-desktop";

    #[test]
    fn the_worker_accepts_only_the_service_pid_the_blob_names() {
        assert!(worker_parent_matches(4321, 4321));
        assert!(!worker_parent_matches(4321, 9999));
        // pid 0 and 1 are never a valid service parent (the service died before pdeathsig armed).
        assert!(!worker_parent_matches(0, 0));
        assert!(!worker_parent_matches(1, 1));
    }

    #[test]
    fn the_service_accepts_only_the_child_it_spawned() {
        assert!(service_peer_matches(5050, 5050));
        assert!(!service_peer_matches(5050, 5051));
        assert!(!service_peer_matches(0, 0));
    }

    #[test]
    fn the_image_comparison_tolerates_a_replaced_binary_but_not_a_different_one() {
        assert!(same_unix_image(WORKER_IMAGE, WORKER_IMAGE));
        assert!(same_unix_image(
            "/usr/lib/indiansassist/ia-desktop (deleted)",
            WORKER_IMAGE
        ));
        assert!(!same_unix_image("/tmp/evil/ia-desktop", WORKER_IMAGE));
        assert!(!same_unix_image(WORKER_IMAGE, ""));
    }

    #[test]
    fn the_peer_verdict_gates_on_pid_then_image() {
        let expect = UnixPeerExpectation {
            pid: 5050,
            image: WORKER_IMAGE,
        };
        assert_eq!(
            unix_peer_verdict(
                &expect,
                &UnixPeerObservation {
                    pid: 5050,
                    image: Some(WORKER_IMAGE),
                },
            ),
            Ok(())
        );
        assert_eq!(
            unix_peer_verdict(
                &expect,
                &UnixPeerObservation {
                    pid: 9999,
                    image: Some(WORKER_IMAGE),
                },
            ),
            Err(UnixPeerRefusal::WrongPid)
        );
        assert_eq!(
            unix_peer_verdict(
                &expect,
                &UnixPeerObservation {
                    pid: 5050,
                    image: Some("/home/x/Downloads/ia-desktop"),
                },
            ),
            Err(UnixPeerRefusal::WrongImage)
        );
        assert_eq!(
            unix_peer_verdict(
                &expect,
                &UnixPeerObservation {
                    pid: 5050,
                    image: None,
                },
            ),
            Err(UnixPeerRefusal::UnknownImage)
        );
    }

    // ---- real socketpair round trip (§8.12 Linux layer) ------------------------------------

    /// A real socketpair carries the blob and a frame between two threads, and `peer_identity`
    /// reads the peer's uid and pid off the live socket. Both ends are in this process, so the
    /// peer pid is our own pid and the peer uid our own uid — which is exactly what the service's
    /// and worker's checks compare against when they run for real.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_socketpair_carries_a_blob_and_reports_the_peer_identity() {
        use crate::blob::LaunchBlob;
        use crate::proto::{read_frame, write_frame, WorkerFrame};
        use std::io::BufReader;
        use std::os::unix::io::AsRawFd;
        use std::os::unix::net::UnixStream;

        let (service_end, worker_end) = UnixStream::pair().expect("socketpair");

        // The worker's first act on fd 3 is to arm FD_CLOEXEC (§8.2).
        set_cloexec(worker_end.as_raw_fd()).unwrap();
        assert!(is_cloexec(worker_end.as_raw_fd()).unwrap());

        // Both ends are this process: SO_PEERCRED reports our own uid and pid on each side.
        // SAFETY: getpid / getuid have no preconditions.
        let me_pid = unsafe { libc::getpid() };
        let me_uid = unsafe { libc::getuid() };
        let (puid, ppid) = peer_identity(service_end.as_raw_fd()).unwrap();
        assert_eq!(puid, me_uid);
        assert_eq!(ppid, me_pid);
        assert!(service_peer_matches(me_pid, ppid));

        // The service writes the blob then a frame; the worker reads them back.
        let mut service_end = service_end;
        let b = sample_blob();
        write_frame(&mut service_end, &b).unwrap();
        write_frame(&mut service_end, &WorkerFrame::Alive).unwrap();

        let mut reader = BufReader::new(worker_end);
        let got: LaunchBlob = read_frame(&mut reader).unwrap();
        assert_eq!(got.session_id, b.session_id);
        assert_eq!(
            read_frame::<_, WorkerFrame>(&mut reader).unwrap(),
            WorkerFrame::Alive
        );
    }

    #[cfg(target_os = "linux")]
    fn sample_blob() -> crate::blob::LaunchBlob {
        use crate::blob::{BlobConsent, LaunchBlob, LinuxLaunch};
        use ia_core::fleet::{Assist, Secret};
        use ia_core::policy::{ConsentDecision, UnattendedPolicy};
        LaunchBlob {
            v: 1,
            session_id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b".into(),
            api_origin: "https://in.example".into(),
            signal_url: "wss://in.example/signal".into(),
            assist: Assist {
                name: "Asha".into(),
            },
            reason: None,
            unattended: true,
            decision: ConsentDecision::AutoGrant,
            policy: UnattendedPolicy::default(),
            consent: Some(BlobConsent {
                level: "control".into(),
                monitors: vec![1],
                clipboard: false,
            }),
            recording_mode: "none".into(),
            gen: 0,
            device_id: "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a".into(),
            secure_desktop: false,
            worker_credential: Secret::new("A".repeat(43)),
            worker_credential_expires_at: "2026-11-01T10:02:00.000Z".into(),
            linux: Some(LinuxLaunch {
                display: ":97".into(),
                session_type: "x11".into(),
                uid: 1000,
                xdg_runtime_dir: "/run/user/1000".into(),
                service_pid: 4321,
                session_id: None,
            }),
        }
    }
}
