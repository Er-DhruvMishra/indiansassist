//! F §8.8 (linux-p4 L3): systemd's stop is a clean exit in every state. The real binary runs in
//! dev `--console` mode under a temporary data directory, **unenrolled with no enrollment file**,
//! so it waits (§8.2f) and touches no bus, display or network; SIGTERM must end it with status 0
//! (before the stop handler it died of the signal: exit status 143).
#![cfg(all(target_os = "linux", feature = "linux-service", feature = "dev"))]

use std::io::{BufRead, BufReader};
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

fn stops_cleanly_on(sig: libc::c_int) {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_ia-service"))
        .args(["--console", "--data-dir"])
        .arg(dir.path())
        // No notify socket, no bus: nothing outside the temporary directory is named.
        .env_remove("NOTIFY_SOCKET")
        .env(
            "DBUS_SYSTEM_BUS_ADDRESS",
            "unix:path=/nonexistent/ia-test-bus",
        )
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            "unix:path=/nonexistent/ia-test-bus",
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Wait until it says it is waiting for the enrollment file (the state that used to die).
    let (tx, rx) = mpsc::channel();
    let stderr = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if line.contains("waiting for the enrollment file") {
                let _ = tx.send(());
            }
        }
    });
    if rx.recv_timeout(Duration::from_secs(20)).is_err() {
        let _ = child.kill();
        panic!("the service never reached the unenrolled wait");
    }
    // SAFETY: kill(2) on the pid of the child this test spawned and still owns.
    assert_eq!(unsafe { libc::kill(child.id() as libc::pid_t, sig) }, 0);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            panic!("the service did not stop within 5 s of the signal");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(status.signal(), None, "killed by a signal: {status:?}");
    assert_eq!(status.code(), Some(0), "{status:?}");
}

#[test]
fn sigterm_while_waiting_unenrolled_exits_zero() {
    stops_cleanly_on(libc::SIGTERM);
}

#[test]
fn sigint_while_waiting_unenrolled_exits_zero() {
    stops_cleanly_on(libc::SIGINT);
}
