//! Running a device action on the device (§9).
//!
//! The server decides what to dispatch; `ia_core::queue` re-runs the rule 9.9 gate here before
//! anything executes. This module is the part that actually does something, and the part that
//! has to be careful:
//!
//! * **A playbook runs through the Phase C runner** (`ia_agent::pbrun`): the same job object,
//!   the same output cap, the same owner-only run file, the same pinned-hash check. There is no
//!   second implementation to keep in step (§4.3's principle applied to actions).
//! * **A pushed file is never executed** (rule 9.4). It is written under
//!   `%ProgramData%\IndiansAssist\pushes`, its sha256 is checked, and it gets the
//!   Mark-of-the-Web, so Windows treats it as downloaded.
//! * **A secret is opened, injected and wiped** (rule 9.8), and masked out of anything the
//!   child printed before the result is reported.
//! * **What this build cannot do, it fails honestly.** Printing (rule 9.5) needs the
//!   `__ia_print` built-in playbook, which does not exist yet, so a `print` action fails with
//!   `unsupported` rather than reporting a success nobody can see.

use std::path::Path;

use ia_core::fleet::DeviceActionResult;
use ia_core::policy::DeviceActionKind;
use ia_vault::Injector;

/// What an action produced, before it is signed and reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub ok: bool,
    pub result: DeviceActionResult,
    /// Captured output, masked. Never reported to the server (C §8.5: output is not chained);
    /// kept so the service can log the first lines of a failure locally.
    pub output: String,
}

impl Outcome {
    pub fn failed(error: &str) -> Self {
        Self {
            ok: false,
            result: DeviceActionResult {
                error: Some(error.chars().take(200).collect()),
                ..Default::default()
            },
            output: String::new(),
        }
    }
}

/// Rule 9.6: a notification, which executes nothing. `show` is the platform toast; it returns
/// false when nobody is logged on to see it, which is reported as `done` with a note — the
/// action did happen (the message was queued for the session), and lying either way would be
/// worse.
pub fn run_message(payload: &serde_json::Value, show: impl FnOnce(&str, &str) -> bool) -> Outcome {
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("IndiansAssist");
    let body = payload.get("body").and_then(|v| v.as_str()).unwrap_or("");
    if body.is_empty() {
        return Outcome::failed("the message has no body");
    }
    let shown = show(title, body);
    Outcome {
        ok: true,
        result: DeviceActionResult {
            path: None,
            error: if shown {
                None
            } else {
                Some("nobody is logged on; the message was not shown".into())
            },
            ..Default::default()
        },
        output: String::new(),
    }
}

/// Rule 9.4: fetch `fileRef` into `dir`, check the hash, write the Mark-of-the-Web. `fetch`
/// does the HTTP so this is testable without a network.
pub fn run_file_push(
    payload: &serde_json::Value,
    dir: &Path,
    max_bytes: u64,
    fetch: impl FnOnce(&str) -> Result<Vec<u8>, String>,
) -> Outcome {
    let Some(file_ref) = payload.get("fileRef").and_then(|v| v.as_str()) else {
        return Outcome::failed("the action has no fileRef");
    };
    let Some(name) = payload.get("name").and_then(|v| v.as_str()) else {
        return Outcome::failed("the action has no file name");
    };
    let want_sha = payload
        .get("sha256")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let declared = payload.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
    if declared > max_bytes {
        return Outcome::failed("the file is larger than this device accepts");
    }
    // A presigned URL is the only form rule 9.4 allows; anything else is refused before a
    // request is made, so a malformed action cannot make the service fetch an arbitrary scheme.
    if !(file_ref.starts_with("https://") || file_ref.starts_with("http://")) {
        return Outcome::failed("fileRef is not an http(s) URL");
    }
    let Some(target) = crate::paths::Paths::at(dir.parent().unwrap_or(dir)).inside(dir, name)
    else {
        return Outcome::failed("the file name is not usable on this device");
    };
    let bytes = match fetch(file_ref) {
        Ok(b) => b,
        Err(e) => return Outcome::failed(&format!("the file could not be fetched: {e}")),
    };
    if declared > 0 && bytes.len() as u64 != declared {
        return Outcome::failed("the fetched file is not the size the action declared");
    }
    let got = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(&bytes))
    };
    if !want_sha.is_empty() && !got.eq_ignore_ascii_case(want_sha) {
        return Outcome::failed("the fetched file does not match its sha256");
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        return Outcome::failed(&format!("the pushes folder could not be created: {e}"));
    }
    if let Err(e) = std::fs::write(&target, &bytes) {
        return Outcome::failed(&format!("the file could not be written: {e}"));
    }
    // C §6.1 F3: Windows must know this came from elsewhere.
    #[cfg(all(windows, feature = "service"))]
    if let Err(e) = ia_agent::filerecv::write_motw(&target) {
        tracing::warn!(error = %e, "the Mark-of-the-Web could not be written");
    }
    Outcome {
        ok: true,
        result: DeviceActionResult {
            path: Some(target.display().to_string()),
            ..Default::default()
        },
        output: String::new(),
    }
}

/// Rule 9.5. Not built: the `__ia_print` built-in playbook does not exist, so this fails
/// honestly instead of pretending. The console shows the failure and the technician can queue
/// a playbook that prints, which is the same thing with its own audit trail.
pub fn run_print(_payload: &serde_json::Value) -> Outcome {
    Outcome::failed("unsupported: printing is not implemented on this device build")
}

/// Rule 9.3 + 9.8: run the pinned playbook with its secrets, masking them out of the output.
///
/// `run` is the Phase C runner, passed in so the gate logic is testable without spawning a
/// process. The injector is wiped before this returns, on every path.
pub fn run_playbook(
    action: &ia_core::queue::PlaybookAction,
    run_id: &str,
    manifest: &[ia_core::playbook::ManifestEntry],
    mut injector: Injector,
    run: impl FnOnce(
        &ia_core::playbook::RunRequest,
        Vec<(String, ia_core::fleet::Secret)>,
    ) -> (String, ia_core::fleet::DeviceActionResult),
) -> Outcome {
    // The worker and the service both run as LocalSystem, so an action playbook is "admin"
    // for the C §8.4 gate; a non-elevation playbook is still refused there rather than being
    // run as administrator by accident.
    let request = match ia_core::queue::check_queued_playbook(
        action,
        run_id,
        manifest,
        ia_core::types::ElevationLevel::Admin,
    ) {
        Ok(r) => r,
        Err(e) => {
            injector.wipe();
            return Outcome::failed(&format!("{e:?}").to_lowercase());
        }
    };
    let secrets = injector
        .take_environment()
        .into_iter()
        .map(|(k, v)| (k, ia_core::fleet::Secret::new(v.to_string())))
        .collect();
    let (output, mut result) = run(&request, secrets);
    let masked = injector.mask(&output);
    injector.wipe();
    if result.ran_as.is_none() {
        result.ran_as = Some("admin".to_string());
    }
    Outcome {
        ok: result.error.is_none(),
        result,
        output: masked,
    }
}

/// The real playbook run (the Phase C runner).
#[cfg(feature = "service")]
pub fn phase_c_runner(
    request: &ia_core::playbook::RunRequest,
    secrets: Vec<(String, ia_core::fleet::Secret)>,
    run_dir: &Path,
    timeout: std::time::Duration,
) -> (String, DeviceActionResult) {
    use ia_agent::pbrun::{run_collect, OutputLimits, RunEvent, RunSpec};
    let canonical: std::collections::BTreeMap<String, String> = request
        .args
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
        .collect();
    let spec = RunSpec {
        run_id: request.run_id.clone(),
        interpreter: request.interpreter,
        body: request.body.clone(),
        env: ia_core::playbook::param_env(&canonical),
        secret_env: secrets,
        timeout,
        run_dir: run_dir.to_path_buf(),
        limits: OutputLimits::default(),
    };
    let (events, end) = run_collect(spec);
    let mut output = String::new();
    for e in events {
        if let RunEvent::Output { chunk, .. } = e {
            output.push_str(&chunk);
        }
    }
    (
        output,
        DeviceActionResult {
            exit: end.exit,
            ran_as: Some("admin".to_string()),
            duration_ms: Some(end.duration_ms),
            error: end.error.map(|e| format!("{e:?}").to_lowercase()),
            ..Default::default()
        },
    )
}

/// Which kinds this build can actually perform. The console greys the rest through the device's
/// features; this is the second line of that honesty, on the device.
pub fn is_supported(kind: DeviceActionKind) -> bool {
    !matches!(kind, DeviceActionKind::Print)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_message_is_shown_and_reported_done() {
        let mut seen = None;
        let out = run_message(
            &json!({ "title": "IT", "body": "We will connect shortly" }),
            |t, b| {
                seen = Some((t.to_string(), b.to_string()));
                true
            },
        );
        assert!(out.ok);
        assert_eq!(seen, Some(("IT".into(), "We will connect shortly".into())));
        assert!(out.result.error.is_none());
    }

    #[test]
    fn a_message_nobody_saw_says_so_rather_than_claiming_success_quietly() {
        let out = run_message(&json!({ "title": "IT", "body": "hello" }), |_, _| false);
        assert!(out.ok);
        assert!(out
            .result
            .error
            .as_deref()
            .unwrap()
            .contains("nobody is logged on"));
    }

    #[test]
    fn a_message_with_no_body_is_a_failure() {
        assert!(!run_message(&json!({ "title": "IT" }), |_, _| true).ok);
    }

    fn push_dir() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("pushes");
        (root, dir)
    }

    #[test]
    fn a_pushed_file_is_written_and_its_hash_checked() {
        let (_root, dir) = push_dir();
        let content = b"quarterly numbers".to_vec();
        let sha = {
            use sha2::Digest as _;
            hex::encode(sha2::Sha256::digest(&content))
        };
        let out = run_file_push(
            &json!({ "fileRef": "https://store.example/x", "name": "report.pdf", "bytes": content.len(), "sha256": sha }),
            &dir,
            1 << 30,
            |_| Ok(content.clone()),
        );
        assert!(out.ok, "{out:?}");
        let path = std::path::PathBuf::from(out.result.path.unwrap());
        assert_eq!(path.parent().unwrap(), dir);
        assert_eq!(std::fs::read(&path).unwrap(), content);
    }

    #[test]
    fn a_file_whose_hash_or_size_does_not_match_is_not_kept() {
        let (_root, dir) = push_dir();
        let out = run_file_push(
            &json!({ "fileRef": "https://store.example/x", "name": "report.pdf", "bytes": 3, "sha256": "ab".repeat(32) }),
            &dir,
            1 << 30,
            |_| Ok(b"different".to_vec()),
        );
        assert!(!out.ok);
        assert!(out.result.error.unwrap().contains("size"));
        let out = run_file_push(
            &json!({ "fileRef": "https://store.example/x", "name": "report.pdf", "bytes": 9, "sha256": "ab".repeat(32) }),
            &dir,
            1 << 30,
            |_| Ok(b"different".to_vec()),
        );
        assert!(!out.ok);
        assert!(out.result.error.unwrap().contains("sha256"));
        assert!(
            !dir.join("report.pdf").exists(),
            "nothing is written when the check fails"
        );
    }

    #[test]
    fn a_file_name_that_tries_to_escape_lands_in_the_folder_or_is_refused() {
        let (_root, dir) = push_dir();
        let content = b"x".to_vec();
        let sha = {
            use sha2::Digest as _;
            hex::encode(sha2::Sha256::digest(&content))
        };
        let out = run_file_push(
            &json!({ "fileRef": "https://store.example/x", "name": r"..\..\Windows\System32\evil.exe", "bytes": 1, "sha256": sha }),
            &dir,
            1 << 30,
            |_| Ok(content.clone()),
        );
        if out.ok {
            let path = std::path::PathBuf::from(out.result.path.unwrap());
            assert_eq!(
                path.parent().unwrap(),
                dir,
                "a hostile name must not leave the folder"
            );
        }
    }

    #[test]
    fn a_file_ref_that_is_not_http_is_refused_before_any_fetch() {
        let (_root, dir) = push_dir();
        let out = run_file_push(
            &json!({ "fileRef": "file:///C:/Windows/System32/config/SAM", "name": "x", "bytes": 1, "sha256": "" }),
            &dir,
            1 << 30,
            |_| panic!("nothing should be fetched"),
        );
        assert!(!out.ok);
    }

    #[test]
    fn a_file_over_the_limit_is_refused_before_any_fetch() {
        let (_root, dir) = push_dir();
        let out = run_file_push(
            &json!({ "fileRef": "https://store.example/x", "name": "big.iso", "bytes": 5_000_000_000u64, "sha256": "" }),
            &dir,
            2_147_483_648,
            |_| panic!("nothing should be fetched"),
        );
        assert!(!out.ok);
    }

    #[test]
    fn printing_fails_honestly_and_is_not_advertised_as_supported() {
        let out = run_print(&json!({ "fileRef": "https://store.example/x", "name": "x.pdf" }));
        assert!(!out.ok);
        assert!(out.result.error.unwrap().starts_with("unsupported"));
        assert!(!is_supported(DeviceActionKind::Print));
        for k in [
            DeviceActionKind::PlaybookRun,
            DeviceActionKind::FilePush,
            DeviceActionKind::Message,
        ] {
            assert!(is_supported(k));
        }
    }

    fn playbook_action(
        body: &str,
    ) -> (
        ia_core::queue::PlaybookAction,
        Vec<ia_core::playbook::ManifestEntry>,
    ) {
        let hash = {
            use sha2::Digest as _;
            hex::encode(sha2::Sha256::digest(body.as_bytes()))
        };
        let payload = json!({
            "playbookId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
            "args": {},
            "requiresElevation": false,
            "bodyHash": hash,
            "body": body,
            "interpreter": if cfg!(windows) { "powershell" } else { "sh" },
            "timeoutSec": 30,
        });
        let action = ia_core::queue::playbook_action(&payload).unwrap();
        let manifest = vec![ia_core::playbook::ManifestEntry {
            id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
            body_hash: hash,
            requires_elevation: false,
            parameters: vec![],
            timeout_sec: 30,
        }];
        (action, manifest)
    }

    fn sealed_secret(
        env: &str,
        value: &str,
        kex: &[u8; 32],
        device: &str,
    ) -> ia_core::fleet::ActionSecret {
        ia_core::fleet::ActionSecret {
            env: env.to_string(),
            sealed: ia_core::seal::seal_to_device(
                &ia_core::seal::kex_public_key_of(kex),
                device,
                ia_core::seal::SealPurpose::VaultSecret,
                value.as_bytes(),
                None,
                None,
            )
            .unwrap(),
        }
    }

    #[test]
    fn a_playbook_run_injects_its_secret_and_masks_it_out_of_the_output() {
        let (action, manifest) = playbook_action("Write-Output $env:IA_API_KEY\n");
        let kex = [0x33u8; 32];
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let injector = Injector::open(
            &[sealed_secret(
                "IA_API_KEY",
                "sk-live-9f8e7d6c",
                &kex,
                device,
            )],
            &kex,
            device,
        )
        .unwrap();
        let out = run_playbook(
            &action,
            &"a".repeat(32),
            &manifest,
            injector,
            |_req, secrets| {
                // The child sees the secret...
                assert_eq!(secrets.len(), 1);
                assert_eq!(secrets[0].0, "IA_API_KEY");
                assert_eq!(secrets[0].1.expose(), "sk-live-9f8e7d6c");
                // ...and prints it.
                (
                    "the key is sk-live-9f8e7d6c\n".to_string(),
                    DeviceActionResult {
                        exit: Some(0),
                        ..Default::default()
                    },
                )
            },
        );
        assert!(out.ok);
        // ...but the captured output the service keeps is masked.
        assert_eq!(out.output, "the key is ***\n");
        assert_eq!(out.result.ran_as.as_deref(), Some("admin"));
    }

    #[test]
    fn a_playbook_whose_body_changed_since_queueing_does_not_run() {
        let (action, _) = playbook_action("Get-Service\n");
        let (_, other_manifest) = playbook_action("Remove-Item C:\\ -Recurse\n");
        let out = run_playbook(
            &action,
            &"a".repeat(32),
            &other_manifest,
            Injector::empty(),
            |_, _| panic!("a changed body must not run"),
        );
        assert!(!out.ok);
        assert!(out.result.error.unwrap().contains("hashmismatch"));
    }

    #[test]
    fn a_playbook_not_in_this_devices_catalogue_does_not_run() {
        let (action, _) = playbook_action("Get-Service\n");
        let out = run_playbook(&action, &"a".repeat(32), &[], Injector::empty(), |_, _| {
            panic!("an unknown playbook must not run")
        });
        assert!(!out.ok);
        assert!(out.result.error.unwrap().contains("notallowed"));
    }

    #[test]
    fn a_failed_run_reports_its_error_and_still_masks_what_it_printed() {
        let (action, manifest) = playbook_action("exit 3\n");
        let kex = [0x33u8; 32];
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let injector = Injector::open(
            &[sealed_secret("IA_TOKEN", "tok-abcdef", &kex, device)],
            &kex,
            device,
        )
        .unwrap();
        let out = run_playbook(&action, &"a".repeat(32), &manifest, injector, |_, _| {
            (
                "failed with tok-abcdef\n".to_string(),
                DeviceActionResult {
                    exit: Some(3),
                    error: Some("timeout".into()),
                    ..Default::default()
                },
            )
        });
        assert!(!out.ok);
        assert_eq!(out.output, "failed with ***\n");
        assert_eq!(out.result.exit, Some(3));
    }
}
