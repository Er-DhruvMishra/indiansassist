//! F §8.2 / §8.5 end to end between two real processes: this test plays the service, forks the
//! real `ia-desktop` with the §8.5 `spawn_worker` (dev mode: no uid change), hands it the blob on
//! fd 3, and reads its `ready { pid }`. A blob naming another service pid is refused by the worker
//! before it says anything (the `getppid` check).
//!
//! The worker binary is named by `IA_DESKTOP_BIN` (the WSL gate script sets it to the dev build);
//! without it the test says so and passes. The worker gets `--synthetic-capture`, no display and no
//! session bus, and a signal URL nobody listens on, so it reaches nothing outside this test (S2,
//! S3).
#![cfg(all(target_os = "linux", feature = "linux-service"))]

use std::io::BufReader;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::Duration;

use ia_core::fleet::{Assist, Secret};
use ia_core::policy::{ConsentDecision, UnattendedPolicy};
use ia_platform::linux::service::sys::{spawn_worker, terminate_pid};
use ia_platform::linux::service::{SessionKind, SpawnInputs, SpawnPlan};
use ia_session0::blob::{BlobConsent, LaunchBlob, LinuxLaunch};
use ia_session0::proto::{read_frame, write_frame, WorkerFrame};
use ia_session0::unix::service_peer_matches;

fn worker_bin() -> Option<String> {
    std::env::var("IA_DESKTOP_BIN")
        .ok()
        .filter(|p| std::path::Path::new(p).is_file())
}

fn blob(service_pid: i32, runtime: &str) -> LaunchBlob {
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    LaunchBlob {
        v: 1,
        session_id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b".into(),
        api_origin: "http://127.0.0.1:9".into(),
        signal_url: "ws://127.0.0.1:9/signal".into(),
        assist: Assist {
            name: "Test Assist".into(),
        },
        reason: None,
        unattended: true,
        decision: ConsentDecision::AutoGrant,
        policy: UnattendedPolicy::default(),
        consent: Some(BlobConsent {
            level: "view".into(),
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
            display: String::new(),
            session_type: "wayland".into(),
            uid,
            xdg_runtime_dir: runtime.into(),
            service_pid,
            session_id: None,
        }),
    }
}

/// Fork the worker, hand it `blob`, and return the first frame it sends (or `None` when it closed
/// the channel without one), its pid, and — when it closed the channel — its exit code.
fn launch(
    bin: &str,
    blob: &LaunchBlob,
    home: &std::path::Path,
) -> (Option<WorkerFrame>, i32, Option<i32>) {
    let runtime = home.join("run");
    std::fs::create_dir_all(&runtime).unwrap();
    // SAFETY: getuid / getgid have no preconditions.
    let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
    let mut plan = SpawnPlan::build(&SpawnInputs {
        worker_image: bin.into(),
        uid,
        gid,
        supplementary_gids: vec![],
        home: home.to_string_lossy().into_owned(),
        user: "ia-test".into(),
        shell: "/bin/sh".into(),
        lang: None,
        session: SessionKind::Wayland,
        display: None,
        xdg_runtime_dir: runtime.to_string_lossy().into_owned(),
        dbus_session_bus: Some(format!("unix:path={}/no-session-bus", home.display())),
        pipe_fd: 3,
        dev_console: true,
    });
    plan.argv.extend([
        "--synthetic-capture".to_string(),
        "--no-self-delete".to_string(),
    ]);
    let (service_end, child_end) = UnixStream::pair().unwrap();
    let mut child = spawn_worker(&plan, child_end.as_raw_fd()).unwrap();
    drop(child_end);
    let pid = child.id() as i32;
    let mut w = service_end.try_clone().unwrap();
    let _ = write_frame(&mut w, blob);
    service_end
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let mut reader = BufReader::new(service_end);
    let first = read_frame::<_, WorkerFrame>(&mut reader).ok();
    if first.is_some() {
        terminate_pid(pid, Duration::from_secs(2));
        let _ = child.wait();
        (first, pid, None)
    } else {
        let code = child.wait().ok().and_then(|s| s.code());
        (first, pid, code)
    }
}

#[test]
fn the_real_worker_accepts_its_service_and_refuses_another() {
    let Some(bin) = worker_bin() else {
        eprintln!("IA_DESKTOP_BIN is not set; the two-process handshake has nothing to launch");
        return;
    };
    let home = std::env::temp_dir().join(format!(
        "ia-handshake-{}-{}",
        std::process::id(),
        ia_core::rnd::hex(4)
    ));
    std::fs::create_dir_all(&home).unwrap();
    let runtime = home.join("run").to_string_lossy().into_owned();

    // This process forks the worker, so it is the worker's parent and the socketpair's creator.
    // SAFETY: getpid has no preconditions.
    let me = unsafe { libc::getpid() };
    let (first, pid, _) = launch(&bin, &blob(me, &runtime), &home);
    match first {
        Some(WorkerFrame::Ready { pid: reported }) => {
            assert!(
                service_peer_matches(pid, reported as i32),
                "ready names the child fork returned"
            );
        }
        other => panic!("the worker should have said ready, got {other:?}"),
    }

    // A blob naming another service pid: the worker's getppid check refuses it before it says
    // anything, and it exits 1 (its refusal path).
    let (first, _, code) = launch(&bin, &blob(me + 1_000_000, &runtime), &home);
    assert_eq!(
        first, None,
        "a worker whose parent is not the blob's service says nothing"
    );
    assert_eq!(code, Some(1), "the worker refused and exited 1");

    let _ = std::fs::remove_dir_all(&home);
}
