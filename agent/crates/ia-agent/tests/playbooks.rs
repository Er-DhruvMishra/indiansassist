//! Playbook hardening (contract §8.4 / §8.5) against a fixture catalogue of **read-only**
//! scripts (`tests/fixtures/playbook-catalogue.json`): the pinned-hash + canonical-args
//! checks, `IA_PARAM_*` delivery (and no inherited `IA_PARAM_*` leak), exit codes, stderr,
//! UTF-8 output, `timeoutSec` enforcement, cancel killing the whole process tree through the
//! job object, the 1 MiB-style cap with `truncated`, and the cmd run file's owner-only DACL
//! and deletion. Every run happens in a temp run dir the test creates.
#![cfg(windows)]

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
    interpreter: PlaybookInterpreter,
    body: String,
    params: Vec<PlaybookParam>,
    timeout_sec: u32,
}

fn catalogue() -> Vec<Fixture> {
    let p =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/playbook-catalogue.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    v["playbooks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| Fixture {
            id: p["id"].as_str().unwrap().into(),
            interpreter: match p["interpreter"].as_str().unwrap() {
                "cmd" => PlaybookInterpreter::Cmd,
                _ => PlaybookInterpreter::Powershell,
            },
            body: p["body"].as_str().unwrap().into(),
            params: serde_json::from_value(p["parameters"].clone()).unwrap(),
            timeout_sec: p["timeoutSec"].as_u64().unwrap() as u32,
        })
        .collect()
}

fn fixture(name_id_suffix: &str) -> Fixture {
    catalogue()
        .into_iter()
        .find(|f| f.id.ends_with(name_id_suffix))
        .unwrap()
}

fn sha(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

fn manifest_of(f: &Fixture) -> ManifestEntry {
    ManifestEntry {
        id: f.id.clone(),
        body_hash: sha(&f.body),
        requires_elevation: false,
        parameters: f.params.clone(),
        timeout_sec: f.timeout_sec,
    }
}

fn run_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "ia-pb-test-{tag}-{}-{}",
        std::process::id(),
        rand::random::<u32>()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn run_id(n: u8) -> String {
    format!("{n:02x}").repeat(16)
}

/// The agent's whole pre-run path: check_run against the pinned manifest, canonical args,
/// then the spec the serve loop hands to the runner.
fn spec_for(f: &Fixture, args: &[(&str, &str)], dir: &Path, n: u8) -> RunSpec {
    let m = manifest_of(f);
    let args: BTreeMap<String, Value> = args
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    let req = RunRequest {
        run_id: run_id(n),
        playbook_id: f.id.clone(),
        body_hash: sha(&f.body),
        body: f.body.clone(),
        interpreter: f.interpreter,
        requires_elevation: false,
        timeout_sec: f.timeout_sec,
        args: args.clone(),
    };
    check_run(&req, std::slice::from_ref(&m), ElevationLevel::User).expect("check_run");
    let canonical =
        validate_canonical_playbook_args(&m.parameters, &args, f.interpreter).expect("args");
    RunSpec {
        run_id: req.run_id,
        interpreter: f.interpreter,
        body: f.body.clone(),
        env: param_env(&canonical),
        secret_env: vec![],
        timeout: Duration::from_secs(m.effective_timeout_sec(f.timeout_sec) as u64),
        run_dir: dir.to_path_buf(),
        limits: OutputLimits {
            tick: Duration::from_millis(5),
            flush_after: Duration::from_millis(20),
            ..OutputLimits::default()
        },
    }
}

fn text_of(events: &[RunEvent], stream: &str) -> String {
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

#[test]
fn tampered_body_and_bad_args_never_reach_the_runner() {
    let f = fixture("0001");
    let m = manifest_of(&f);
    let mut req = RunRequest {
        run_id: run_id(1),
        playbook_id: f.id.clone(),
        body_hash: sha(&f.body),
        body: format!("{}\nRemove-Item C:\\x", f.body),
        interpreter: f.interpreter,
        requires_elevation: false,
        timeout_sec: 60,
        args: BTreeMap::new(),
    };
    assert_eq!(
        check_run(&req, std::slice::from_ref(&m), ElevationLevel::User),
        Err(PlaybookError::HashMismatch)
    );
    req.body = f.body.clone();
    req.requires_elevation = true;
    assert_eq!(
        check_run(&req, std::slice::from_ref(&m), ElevationLevel::User),
        Err(PlaybookError::HashMismatch) // requiresElevation must equal the pin
    );
    // A cmd-injection value is refused by the canonical validation.
    let cmd = fixture("0006");
    let bad: BTreeMap<String, Value> = [("host".to_string(), json!("x & calc"))].into();
    assert!(validate_canonical_playbook_args(&cmd.params, &bad, cmd.interpreter).is_err());
}

#[test]
fn powershell_gets_params_stderr_cwd_and_exit_code() {
    std::env::set_var("IA_PARAM_LEAK", "inherited");
    let dir = run_dir("ps");
    let f = fixture("0001");
    let (events, end) = pbrun::run_collect(spec_for(&f, &[("host", "example.com")], &dir, 2));
    let out = text_of(&events, "stdout");
    assert!(out.contains("host=example.com count=4 leak=[]"), "{out}");
    assert!(
        out.to_lowercase()
            .contains(&format!("cwd={}", dir.display()).to_lowercase()),
        "{out}"
    );
    assert!(text_of(&events, "stderr").contains("to stderr"));
    assert_eq!(end.exit, Some(3));
    assert_eq!(end.error, None);
    assert!(!end.truncated);
    // seq is strictly increasing across both streams.
    let seqs: Vec<u32> = events
        .iter()
        .filter_map(|e| match e {
            RunEvent::Output { seq, .. } => Some(*seq),
            _ => None,
        })
        .collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn output_is_utf8() {
    let dir = run_dir("utf8");
    let (events, end) = pbrun::run_collect(spec_for(&fixture("0002"), &[], &dir, 3));
    assert_eq!(end.exit, Some(0));
    assert!(
        text_of(&events, "stdout").contains("café नमस्ते ok"),
        "{events:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn timeout_kills_the_job() {
    let dir = run_dir("timeout");
    let started = Instant::now();
    let (events, end) = pbrun::run_collect(spec_for(&fixture("0003"), &[], &dir, 4));
    assert_eq!(end.error, Some(PlaybookError::Timeout));
    assert_eq!(end.exit, None);
    assert!(started.elapsed() < Duration::from_secs(20));
    assert!(text_of(&events, "stdout").contains("sleeping"));
    assert!(!text_of(&events, "stdout").contains("never"));
    let _ = std::fs::remove_dir_all(&dir);
}

fn process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is closed; a failed open means the process is gone.
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code).is_ok();
        let _ = CloseHandle(h);
        ok && code == 259 // STILL_ACTIVE
    }
}

#[test]
fn cancel_kills_the_whole_tree() {
    let dir = run_dir("tree");
    let spec = spec_for(&fixture("0004"), &[], &dir, 5);
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = pbrun::start(spec, move |e| {
        let _ = tx.send(e);
    });
    // Wait for the grandchild's pid.
    let mut child_pid = None;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut seen = Vec::new();
    while child_pid.is_none() && Instant::now() < deadline {
        if let Ok(e) = rx.recv_timeout(Duration::from_millis(200)) {
            if let RunEvent::Output { chunk, .. } = &e {
                if let Some(rest) = chunk.split("CHILD ").nth(1) {
                    child_pid = rest
                        .split_whitespace()
                        .next()
                        .and_then(|p| p.parse::<u32>().ok());
                }
            }
            seen.push(e);
        }
    }
    let child_pid = child_pid.unwrap_or_else(|| panic!("no CHILD line: {seen:?}"));
    assert!(process_alive(child_pid), "grandchild should be running");
    handle.cancel();
    handle.join();
    let end = rx
        .try_iter()
        .find_map(|e| match e {
            RunEvent::End(end) => Some(end),
            _ => None,
        })
        .expect("end");
    assert_eq!(end.error, Some(PlaybookError::Cancelled));
    assert_eq!(end.exit, None);
    // The job took the grandchild with it.
    let gone_by = Instant::now() + Duration::from_secs(5);
    while process_alive(child_pid) && Instant::now() < gone_by {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !process_alive(child_pid),
        "grandchild {child_pid} survived the cancel"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn output_cap_truncates() {
    let dir = run_dir("flood");
    let mut spec = spec_for(&fixture("0005"), &[], &dir, 6);
    spec.limits.cap_bytes = 4096;
    let (events, end) = pbrun::run_collect(spec);
    let total: usize = events
        .iter()
        .map(|e| match e {
            RunEvent::Output { chunk, .. } => chunk.len(),
            _ => 0,
        })
        .sum();
    assert_eq!(end.exit, Some(0));
    assert!(end.truncated);
    assert_eq!(total, 4096);
    assert!(events.iter().all(|e| match e {
        RunEvent::Output { chunk, .. } => chunk.len() <= 8192,
        _ => true,
    }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cmd_run_file_is_owner_only_and_deleted() {
    let dir = run_dir("cmd");
    let f = fixture("0006");
    let spec = spec_for(&f, &[("host", "srv-1.example")], &dir, 7);
    let run_file = pbrun::cmd_run_file(&dir, &spec.run_id);
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = pbrun::start(spec, move |e| {
        let _ = tx.send(e);
    });
    // While the run is in flight (the body pings for ~1 s) the file exists with the DACL.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !run_file.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(run_file.exists(), "run file never appeared");
    assert!(
        pbrun::win::dacl_is_owner_only(&run_file).unwrap(),
        "DACL is not owner-only"
    );
    handle.join();
    let events: Vec<RunEvent> = rx.try_iter().collect();
    let end = events
        .iter()
        .find_map(|e| match e {
            RunEvent::End(end) => Some(end.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(end.exit, Some(2));
    assert!(
        text_of(&events, "stdout").contains("cmd host srv-1.example"),
        "{events:?}"
    );
    assert!(!run_file.exists(), "run file not deleted");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn owner_only_file_refuses_an_existing_name() {
    let dir = run_dir("createnew");
    let p = dir.join("x.cmd");
    pbrun::win::create_owner_only_file(&p, b"echo 1").unwrap();
    assert!(pbrun::win::dacl_is_owner_only(&p).unwrap());
    // CREATE_NEW: a second create (e.g. a planted file) fails instead of being reused.
    assert!(pbrun::win::create_owner_only_file(&p, b"echo 2").is_err());
    assert_eq!(std::fs::read(&p).unwrap(), b"echo 1");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn this_test_process_is_not_elevated_so_runs_are_allowed() {
    // The gate itself is unit-tested in pbrun; here: the real token query agrees with the
    // medium-integrity test host, so the gate lets an unelevated playbook through.
    let elevated = pbrun::process_is_elevated();
    assert_eq!(
        pbrun::never_elevated_gate(false, elevated).is_ok(),
        !elevated
    );
}
