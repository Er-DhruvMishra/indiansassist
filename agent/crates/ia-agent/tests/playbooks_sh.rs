//! The Linux `sh` playbook runner (Phase E §7.8) against a fixture catalogue of **read-only**
//! scripts (`tests/fixtures/playbook-catalogue-sh.json`): the body on fd 3 with stdin from
//! `/dev/null`, `IA_PARAM_*` delivery (and no inherited `IA_PARAM_*` leak), exit codes, stderr,
//! lossy UTF-8 output, the working directory, the timeout and cancel killing the whole process
//! group (SIGTERM, then SIGKILL after 2 s), and the output cap. Every run happens in a temp run
//! dir the test creates.
#![cfg(target_os = "linux")]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ia_agent::pbrun::{self, OutputLimits, RunEvent, RunSpec};
use ia_core::playbook::{
    check_run, param_env, validate_canonical_playbook_args, ManifestEntry, PlaybookError,
    PlaybookParam, RunRequest,
};
use ia_core::types::{ElevationLevel, PlaybookInterpreter};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

struct Fixture {
    id: String,
    body: String,
    params: Vec<PlaybookParam>,
    timeout_sec: u32,
}

fn fixture(id_suffix: &str) -> Fixture {
    let p =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/playbook-catalogue-sh.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    v["playbooks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            assert_eq!(p["interpreter"], "sh");
            Fixture {
                id: p["id"].as_str().unwrap().into(),
                body: p["body"].as_str().unwrap().into(),
                params: serde_json::from_value(p["parameters"].clone()).unwrap(),
                timeout_sec: p["timeoutSec"].as_u64().unwrap() as u32,
            }
        })
        .find(|f| f.id.ends_with(id_suffix))
        .unwrap()
}

fn sha(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

fn run_dir(tag: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "ia-sh-test-{tag}-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ))
        .join("indiansassist")
        .join("run")
}

fn spec_for(f: &Fixture, args: &[(&str, &str)], dir: &Path, timeout_sec: u64) -> RunSpec {
    let manifest = ManifestEntry {
        id: f.id.clone(),
        body_hash: sha(&f.body),
        requires_elevation: false,
        parameters: f.params.clone(),
        timeout_sec: f.timeout_sec,
    };
    // Canonical-string args, as the 202 reply carries them (C §8.4).
    let args: BTreeMap<String, Value> = args
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    let run = RunRequest {
        run_id: "ab".repeat(16),
        playbook_id: f.id.clone(),
        body_hash: sha(&f.body),
        body: f.body.clone(),
        interpreter: PlaybookInterpreter::Sh,
        requires_elevation: false,
        timeout_sec: f.timeout_sec,
        args: args.clone(),
    };
    check_run(&run, std::slice::from_ref(&manifest), ElevationLevel::User).expect("check_run");
    let canonical =
        validate_canonical_playbook_args(&f.params, &args, PlaybookInterpreter::Sh).expect("args");
    RunSpec {
        run_id: "ab".repeat(16),
        interpreter: PlaybookInterpreter::Sh,
        body: f.body.clone(),
        env: param_env(&canonical),
        secret_env: vec![],
        timeout: Duration::from_secs(timeout_sec),
        run_dir: dir.to_path_buf(),
        limits: OutputLimits {
            tick: Duration::from_millis(5),
            flush_after: Duration::from_millis(0),
            ..OutputLimits::default()
        },
    }
}

fn text(events: &[RunEvent], stream: &str) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            RunEvent::Output {
                stream: s, chunk, ..
            } if *s == stream => Some(chunk.as_str()),
            _ => None,
        })
        .collect()
}

fn cleanup(dir: &Path) {
    // run_dir() is <tmp>/ia-sh-test-*/indiansassist/run: remove the whole test root.
    if let Some(root) = dir.parent().and_then(|p| p.parent()) {
        let _ = std::fs::remove_dir_all(root);
    }
}

#[test]
fn params_arrive_as_environment_with_no_inherited_leak_and_the_exit_code_is_kept() {
    // An inherited IA_PARAM_* must not reach the child (the runner removes every one).
    std::env::set_var("IA_PARAM_LEAK", "inherited");
    let f = fixture("101");
    let dir = run_dir("params");
    let (events, end) = pbrun::run_collect(spec_for(
        &f,
        &[("host", "example.com"), ("count", "2")],
        &dir,
        30,
    ));
    let out = text(&events, "stdout");
    assert!(out.contains("host=example.com count=2 leak=[]"), "{out}");
    assert!(out.contains(&format!("cwd={}", dir.display())), "{out}");
    assert_eq!(text(&events, "stderr").trim(), "to stderr");
    assert_eq!(end.exit, Some(3));
    assert_eq!(end.error, None);
    // The run dir is private.
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
    // Nothing but the run dir was created: the body never touched the disk.
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    cleanup(&dir);
}

#[test]
fn stdin_is_dev_null_so_the_script_cannot_read_its_own_body() {
    let f = fixture("102");
    let dir = run_dir("stdin");
    let (events, end) = pbrun::run_collect(spec_for(&f, &[], &dir, 30));
    let out = text(&events, "stdout");
    // With the body on stdin, `read` would have consumed the script's own next line.
    assert!(out.contains("stdin=eof"), "{out}");
    assert!(out.contains("after cat"), "{out}");
    assert_eq!(end.exit, Some(0));
    cleanup(&dir);
}

#[test]
fn output_is_decoded_as_lossy_utf8() {
    let f = fixture("103");
    let dir = run_dir("unicode");
    let (events, end) = pbrun::run_collect(spec_for(&f, &[], &dir, 30));
    let out = text(&events, "stdout");
    assert!(out.contains("café नमस्ते ok"), "{out}");
    assert!(out.contains("bad \u{FFFD} byte"), "{out}");
    assert_eq!(end.exit, Some(0));
    cleanup(&dir);
}

#[test]
fn the_timeout_kills_the_group_and_reports_timeout() {
    let f = fixture("104");
    let dir = run_dir("timeout");
    let started = Instant::now();
    let (events, end) = pbrun::run_collect(spec_for(&f, &[], &dir, 2));
    assert_eq!(end.error, Some(PlaybookError::Timeout));
    assert_eq!(end.exit, None);
    assert!(text(&events, "stdout").contains("started"));
    assert!(!text(&events, "stdout").contains("never"));
    assert!(started.elapsed() < Duration::from_secs(10));
    cleanup(&dir);
}

fn alive(pid: i32) -> bool {
    // A zombie still answers kill(0); read the state instead.
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(s) => !s
            .rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z')),
        Err(_) => false,
    }
}

#[test]
fn cancel_kills_a_sleeping_grandchild_through_the_process_group() {
    let f = fixture("105");
    let dir = run_dir("cancel");
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = pbrun::start(spec_for(&f, &[], &dir, 60), move |e| {
        let _ = tx.send(e);
    });
    // Wait for the grandchild's pid.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut child_pid = None;
    let mut seen = String::new();
    while Instant::now() < deadline && child_pid.is_none() {
        if let Ok(RunEvent::Output { chunk, .. }) = rx.recv_timeout(Duration::from_millis(100)) {
            seen.push_str(&chunk);
            child_pid = seen
                .lines()
                .find_map(|l| l.strip_prefix("child="))
                .and_then(|p| p.trim().parse::<i32>().ok());
        }
    }
    let child_pid = child_pid.expect("the grandchild reported its pid");
    assert!(alive(child_pid));
    handle.cancel();
    handle.join();
    let end = rx
        .try_iter()
        .find_map(|e| match e {
            RunEvent::End(end) => Some(end),
            _ => None,
        })
        .expect("a run always ends");
    assert_eq!(end.error, Some(PlaybookError::Cancelled));
    let gone_by = Instant::now() + Duration::from_secs(5);
    while alive(child_pid) && Instant::now() < gone_by {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(child_pid), "the grandchild left the group alive");
    cleanup(&dir);
}

#[test]
fn a_group_that_ignores_sigterm_is_killed_after_the_grace_period() {
    let f = fixture("107");
    let dir = run_dir("sigterm");
    let started = Instant::now();
    let (events, end) = pbrun::run_collect(spec_for(&f, &[], &dir, 1));
    assert!(text(&events, "stdout").contains("armed"));
    assert_eq!(end.error, Some(PlaybookError::Timeout));
    let took = started.elapsed();
    assert!(
        took >= Duration::from_secs(3) && took < Duration::from_secs(12),
        "SIGKILL follows SIGTERM after 2 s: {took:?}"
    );
    cleanup(&dir);
}

#[test]
fn the_output_cap_truncates() {
    let f = fixture("106");
    let dir = run_dir("cap");
    let mut spec = spec_for(&f, &[], &dir, 30);
    spec.limits.cap_bytes = 4096;
    let (events, end) = pbrun::run_collect(spec);
    let total: usize = events
        .iter()
        .map(|e| match e {
            RunEvent::Output { chunk, .. } => chunk.len(),
            _ => 0,
        })
        .sum();
    assert_eq!(total, 4096);
    assert!(end.truncated);
    assert_eq!(end.exit, Some(0));
    cleanup(&dir);
}

#[test]
fn a_powershell_body_is_refused_on_linux() {
    let f = fixture("101");
    let dir = run_dir("ps");
    let mut spec = spec_for(&f, &[("host", "example.com")], &dir, 30);
    spec.interpreter = PlaybookInterpreter::Powershell;
    let (_, end) = pbrun::run_collect(spec);
    assert_eq!(end.error, Some(PlaybookError::SpawnFailed));
    cleanup(&dir);
}
