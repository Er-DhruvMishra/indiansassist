//! The on-disk side of the tamper outbox (§10.2) and the §10.3 integrity self-check.
//!
//! `ia_core::tamper` owns the rules (sign, batch, acknowledge, what a forged line is); this
//! module owns the file and the clock. Two processes write it — the service and the watchdog,
//! which may be the only one running — so a record is a single appended line, never a rewrite,
//! and the file is only rewritten when events are acknowledged and removed.

use std::path::Path;

use ia_core::fleet::{TamperCause, TamperEvent};
use ia_core::tamper::{LoadReport, TamperOutbox};

use crate::config::{file_digest, InstallManifest};
use crate::identity::Identity;

/// Load the outbox, dropping malformed and forged lines (and saying how many).
pub fn load(path: &Path, device_id: &str, public_key: &str) -> (TamperOutbox, LoadReport) {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    TamperOutbox::from_log(&text, device_id, public_key)
}

/// Append one signed event. The event is on disk before the caller tries to send it, so a
/// process that is killed between the two still reports it on the next start — which is the
/// whole point of the outbox for causes like `stopped`.
pub fn record(
    path: &Path,
    device_id: &str,
    identity: &Identity,
    cause: TamperCause,
    detail: Option<&str>,
) -> std::io::Result<TamperEvent> {
    use std::io::Write;
    let event = identity
        .sign_tamper_event(
            device_id,
            &uuid::Uuid::new_v4().to_string(),
            cause,
            &now_iso(),
            detail,
        )
        .map_err(|e| std::io::Error::other(format!("{e:?}")))?;
    let line =
        TamperOutbox::log_line(&event).map_err(|e| std::io::Error::other(format!("{e:?}")))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(line.as_bytes())?;
    f.flush()?;
    Ok(event)
}

/// Rewrite the file after an acknowledgement (the only time it is rewritten).
pub fn rewrite(path: &Path, outbox: &TamperOutbox) -> std::io::Result<()> {
    let tmp = path.with_extension("log.new");
    std::fs::write(&tmp, outbox.to_log().as_bytes())?;
    std::fs::rename(&tmp, path)
}

/// `at` in the ISO form rule 10.5 requires (UTC, milliseconds).
pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// What the §10.3 check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrityReport {
    /// Files whose sha256 no longer matches the manifest.
    pub changed: Vec<String>,
    /// Files the manifest names that are not on disk.
    pub missing: Vec<String>,
    /// Files that could not be read (locked, permissions).
    pub unreadable: Vec<String>,
}

impl IntegrityReport {
    /// Whether the service may spawn a worker (§10.3: "refuses to spawn the worker until
    /// repaired"). An unreadable file is *not* treated as tampering: a virus scanner holding a
    /// file open is a far more likely explanation than an attack, and refusing to work would
    /// be the worse failure.
    pub fn binaries_ok(&self) -> bool {
        self.changed.is_empty() && self.missing.is_empty()
    }

    pub fn summary(&self) -> String {
        format!(
            "changed: [{}], missing: [{}], unreadable: [{}]",
            self.changed.join(", "),
            self.missing.join(", "),
            self.unreadable.join(", ")
        )
    }
}

/// Compare the installed binaries against `manifest.json` (§10.3). `install_dir` is
/// `%ProgramFiles%\IndiansAssist`.
pub fn check_binaries(install_dir: &Path, manifest: &InstallManifest) -> IntegrityReport {
    let mut report = IntegrityReport {
        changed: vec![],
        missing: vec![],
        unreadable: vec![],
    };
    for f in &manifest.files {
        // Only the executables are integrity-gated; the manifest also lists data files the
        // installer placed (the watchdog task XML), whose change is a `config_changed` matter.
        let path = install_dir.join(&f.name);
        if !path.exists() {
            report.missing.push(f.name.clone());
            continue;
        }
        match file_digest(&path) {
            Err(_) => report.unreadable.push(f.name.clone()),
            Ok(d) if !d.eq_ignore_ascii_case(&f.sha256) => report.changed.push(f.name.clone()),
            Ok(_) => {}
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ManifestFile;
    use crate::identity::Identity;

    fn manifest_for(dir: &Path, files: &[(&str, &str)]) -> InstallManifest {
        InstallManifest {
            v: 1,
            version: "0.3.0".into(),
            arch: "x64".into(),
            placeholder: false,
            files: files
                .iter()
                .map(|(name, content)| {
                    let p = dir.join(name);
                    if !content.is_empty() {
                        std::fs::write(&p, content).unwrap();
                    }
                    ManifestFile {
                        name: (*name).to_string(),
                        size: content.len() as u64,
                        sha256: if content.is_empty() {
                            "00".repeat(32)
                        } else {
                            file_digest(&p).unwrap()
                        },
                    }
                })
                .collect(),
        }
    }

    #[test]
    fn an_untouched_install_passes_the_self_check() {
        let dir = tempfile::tempdir().unwrap();
        let m = manifest_for(
            dir.path(),
            &[
                ("ia-service.exe", "service bytes"),
                ("ia-desktop.exe", "worker bytes"),
            ],
        );
        let r = check_binaries(dir.path(), &m);
        assert!(r.binaries_ok(), "{}", r.summary());
    }

    #[test]
    fn a_replaced_binary_is_detected_and_blocks_the_worker() {
        let dir = tempfile::tempdir().unwrap();
        let m = manifest_for(dir.path(), &[("ia-desktop.exe", "worker bytes")]);
        std::fs::write(dir.path().join("ia-desktop.exe"), "something else entirely").unwrap();
        let r = check_binaries(dir.path(), &m);
        assert_eq!(r.changed, vec!["ia-desktop.exe".to_string()]);
        assert!(!r.binaries_ok());
    }

    #[test]
    fn a_deleted_binary_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let m = manifest_for(dir.path(), &[("ia-service.exe", "service bytes")]);
        std::fs::remove_file(dir.path().join("ia-service.exe")).unwrap();
        let r = check_binaries(dir.path(), &m);
        assert_eq!(r.missing, vec!["ia-service.exe".to_string()]);
        assert!(!r.binaries_ok());
    }

    #[test]
    fn the_outbox_survives_a_process_that_recorded_and_died() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("tamper.log");
        let id = Identity::generate();
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        // Two processes, each appending one line (the service, then the watchdog).
        record(
            &log,
            device,
            &id,
            TamperCause::Stopped,
            Some("service stopped by SYSTEM"),
        )
        .unwrap();
        record(&log, device, &id, TamperCause::WatchdogRestarted, None).unwrap();
        let (outbox, report) = load(&log, device, &id.public_key());
        assert_eq!(report.kept, 2);
        assert_eq!(report.forged, 0);
        let batch = outbox.batch();
        assert_eq!(batch[0].cause, TamperCause::Stopped);
        assert_eq!(batch[1].cause, TamperCause::WatchdogRestarted);
        assert_eq!(
            batch[0].detail.as_deref(),
            Some("service stopped by SYSTEM")
        );
    }

    #[test]
    fn an_acknowledgement_is_the_only_thing_that_shortens_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("tamper.log");
        let id = Identity::generate();
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let a = record(&log, device, &id, TamperCause::Stopped, None).unwrap();
        record(&log, device, &id, TamperCause::Disabled, None).unwrap();
        let (mut outbox, _) = load(&log, device, &id.public_key());
        assert_eq!(outbox.acknowledge(std::slice::from_ref(&a.id)), 1);
        rewrite(&log, &outbox).unwrap();
        let (again, report) = load(&log, device, &id.public_key());
        assert_eq!(report.kept, 1);
        assert_eq!(again.batch()[0].cause, TamperCause::Disabled);
    }

    #[test]
    fn a_line_forged_by_somebody_without_the_key_is_dropped_on_load() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("tamper.log");
        let id = Identity::generate();
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        record(&log, device, &id, TamperCause::Stopped, None).unwrap();
        // Somebody with write access to the file, but not the sealed key, invents an event.
        let forged = Identity::generate()
            .sign_tamper_event(
                device,
                "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901",
                TamperCause::BinaryChanged,
                "2026-11-01T10:00:00.000Z",
                Some("look over here"),
            )
            .unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        f.write_all(TamperOutbox::log_line(&forged).unwrap().as_bytes())
            .unwrap();
        let (outbox, report) = load(&log, device, &id.public_key());
        assert_eq!(report.forged, 1);
        assert_eq!(report.kept, 1);
        assert!(outbox
            .batch()
            .iter()
            .all(|e| e.cause != TamperCause::BinaryChanged));
    }

    #[test]
    fn the_recorded_instant_is_the_shape_rule_10_5_requires() {
        let at = now_iso();
        assert_eq!(at.len(), 24, "{at}");
        assert!(at.ends_with('Z') && at.contains('.'), "{at}");
    }
}
