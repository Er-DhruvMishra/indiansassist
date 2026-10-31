//! The §7.2 hand-over pipe transport (Windows): the parent's pipe, its client-pid / image checks
//! and the child's server-pid / image checks, over real named pipes. The "child" is this test
//! binary re-launched with `CreateProcess` (`std::process::Command`) running the ignored
//! `hopipe_child` entry, so the image check holds and **no UAC prompt is ever raised**
//! (`launch_elevated` is never called here).
#![cfg(windows)]

use std::process::{Command, Stdio};
use std::time::Duration;

use ia_agent::hopipe::{new_suffix, read_blob, HandoverServer, ImageHold, PipeError};

/// The child half, run only when the parent test launches it.
#[test]
#[ignore = "run by blob_reaches_the_verified_child as a child process"]
fn hopipe_child() {
    let (Ok(suffix), Ok(parent)) = (
        std::env::var("IA_HOPIPE_SUFFIX"),
        std::env::var("IA_HOPIPE_PARENT"),
    ) else {
        return;
    };
    // The child verifies its server is its parent (toolhelp) — here the test that spawned it.
    assert_eq!(
        ia_agent::hopipe::parent_pid(),
        parent.parse().ok(),
        "toolhelp sees the spawning test as the parent"
    );
    let blob = read_blob(&suffix, parent.parse().unwrap(), Duration::from_secs(10))
        .expect("child reads the blob");
    println!("HOPIPE-BLOB:{}", String::from_utf8_lossy(&blob));
}

#[test]
fn blob_reaches_the_verified_child() {
    let suffix = new_suffix();
    let server = HandoverServer::create(&suffix).expect("pipe");
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "hopipe_child", "--ignored", "--nocapture"])
        .env("IA_HOPIPE_SUFFIX", &suffix)
        .env("IA_HOPIPE_PARENT", std::process::id().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the child");
    let blob = br#"{"v":1,"handover":"test"}"#;
    server
        .serve_once(child.id(), blob, Duration::from_secs(20))
        .expect("the launched child is accepted and the blob written");
    let out = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains(r#"HOPIPE-BLOB:{"v":1,"handover":"test"}"#),
        "child output: {stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.status.success());
}

#[test]
fn a_client_that_is_not_the_launched_process_is_refused() {
    let suffix = new_suffix();
    let server = HandoverServer::create(&suffix).unwrap();
    // This process connects, but the server expects another pid (the "launched" child).
    let s2 = suffix.clone();
    let me = std::process::id();
    let client = std::thread::spawn(move || read_blob(&s2, me, Duration::from_secs(5)));
    let r = server.serve_once(me.wrapping_add(4), b"secret", Duration::from_secs(5));
    assert_eq!(r, Err(PipeError::WrongClient));
    // The refused client never receives the blob.
    if let Ok(b) = client.join().unwrap() {
        assert!(b.is_empty(), "the blob leaked to a wrong client");
    }
}

#[test]
fn the_child_refuses_a_server_that_is_not_its_parent() {
    let suffix = new_suffix();
    let server = HandoverServer::create(&suffix).unwrap();
    let me = std::process::id();
    let s2 = suffix.clone();
    let serve = std::thread::spawn(move || {
        let _ = server.serve_once(me, b"secret", Duration::from_secs(5));
    });
    // Expecting a different server pid: the open succeeds, the check fails, nothing is read.
    let r = read_blob(&s2, me.wrapping_add(4), Duration::from_secs(5));
    assert_eq!(r.map(|b| b.len()), Err(PipeError::WrongServer));
    let _ = serve.join();
}

#[test]
fn the_pipe_name_is_first_instance_only_and_waits_time_out() {
    let suffix = new_suffix();
    let server = HandoverServer::create(&suffix).unwrap();
    // A second instance of the same name (a squatter, or a racing second launch) is refused.
    assert!(matches!(
        HandoverServer::create(&suffix),
        Err(PipeError::Create)
    ));
    // Nobody connects: the parent gives up (the flow's 20 s, here 200 ms).
    assert_eq!(
        server.serve_once(1, b"x", Duration::from_millis(200)),
        Err(PipeError::Timeout)
    );
    // A child with no parent pipe times out too.
    assert_eq!(
        read_blob(&new_suffix(), 1, Duration::from_millis(200)).map(|b| b.len()),
        Err(PipeError::Timeout)
    );
}

#[test]
fn the_image_hold_blocks_writers_and_hashes_the_file() {
    use sha2::{Digest, Sha256};
    let dir = std::env::temp_dir().join(format!("ia-hold-{}", new_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("IndiansAssist.exe");
    std::fs::write(&path, b"MZ fake image").unwrap();
    let hold = ImageHold::open(&path).unwrap();
    assert_eq!(hold.sha256, hex::encode(Sha256::digest(b"MZ fake image")));
    // While held (FILE_SHARE_READ only) nobody can open the image for writing.
    assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
    // Readers are fine.
    assert!(std::fs::File::open(&path).is_ok());
    drop(hold);
    assert!(std::fs::OpenOptions::new().write(true).open(&path).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}
