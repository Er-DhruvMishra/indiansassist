//! Where the service keeps things (§4.1 Logs / Config, §3.3, §10.2, rule 9.4).
//!
//! Everything lives under one root, `%ProgramData%\IndiansAssist`, whose ACL grants `SYSTEM`
//! and `Administrators` only (set by the MSI custom action, §12.2). Keeping the layout in one
//! place means the uninstall, the watchdog and the integrity check all look in the same places,
//! and a dev run can move the whole tree with `--data-dir` without any other code knowing.

use std::path::{Path, PathBuf};

/// The installed layout, rooted at `%ProgramData%\IndiansAssist` in production.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    /// The production root: `%ProgramData%\IndiansAssist`.
    pub fn program_data() -> Self {
        let root = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
            .join("IndiansAssist");
        Self { root }
    }

    /// A root given explicitly (the `--data-dir` of a dev run, or a test's temp dir).
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `config.json` (§4.1): `apiOrigin`, `signalUrl`, `deviceId`, `keyId`, the opt-outs. Never
    /// the key.
    pub fn config(&self) -> PathBuf {
        self.root.join("config.json")
    }

    /// `manifest.json` (§12.2): the installed binaries and their sha256, written by the MSI.
    pub fn manifest(&self) -> PathBuf {
        self.root.join("manifest.json")
    }

    /// The DPAPI-sealed Ed25519 identity key (§3.3).
    pub fn identity_key(&self) -> PathBuf {
        self.root.join("device.key")
    }

    /// The DPAPI-sealed X25519 sealing key (§3.3).
    pub fn sealing_key(&self) -> PathBuf {
        self.root.join("device.kex")
    }

    /// The signed tamper outbox (§10.2).
    pub fn tamper_log(&self) -> PathBuf {
        self.root.join("tamper.log")
    }

    /// `logs\service.log` (§4.1, rotating 5 × 1 MiB).
    pub fn log_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn service_log(&self) -> PathBuf {
        self.log_dir().join("service.log")
    }

    /// Where a `file_push` action writes (rule 9.4), with the C §6.1 F3 rules.
    pub fn pushes(&self) -> PathBuf {
        self.root.join("pushes")
    }

    /// Receipts stored on the device (§6.4) for the "while you were away" toast.
    pub fn receipts(&self) -> PathBuf {
        self.root.join("receipts")
    }

    /// The run directory for a privileged playbook (a high-integrity equivalent of the C
    /// `%LOCALAPPDATA%\IndiansAssist\run`).
    pub fn run_dir(&self) -> PathBuf {
        self.root.join("run")
    }

    /// Every directory the service creates at start.
    pub fn dirs(&self) -> Vec<PathBuf> {
        vec![
            self.root.clone(),
            self.log_dir(),
            self.pushes(),
            self.receipts(),
            self.run_dir(),
        ]
    }

    /// Creates the directory tree. The ACLs are the MSI's job (§12.2); a dev run inherits the
    /// parent's.
    pub fn ensure(&self) -> std::io::Result<()> {
        for d in self.dirs() {
            std::fs::create_dir_all(&d)?;
        }
        Ok(())
    }

    /// A file inside a subdirectory of the root, with the name sanitised so a server-supplied
    /// name can never escape the tree (rule 9.4 writes a technician-chosen file name). Reuses
    /// the C §6.1 F3 sanitiser, so a pushed file and a transferred one are named by the same
    /// rules; `file_id` only names the fallback when nothing survives sanitising.
    pub fn inside_with_id(&self, dir: &Path, name: &str, file_id: u64) -> Option<PathBuf> {
        let safe = ia_core::files::sanitise_file_name(name, file_id);
        if safe.is_empty() || safe == "." || safe == ".." {
            return None;
        }
        // `sanitise_file_name` already strips separators and device names; this is the belt to
        // its braces, so a future change there cannot turn into a path traversal here.
        if safe.contains('/') || safe.contains('\\') || safe.contains(':') {
            return None;
        }
        let candidate = dir.join(&safe);
        candidate.starts_with(&self.root).then_some(candidate)
    }

    /// [`Paths::inside_with_id`] with a fixed fallback id (the common case).
    pub fn inside(&self, dir: &Path, name: &str) -> Option<PathBuf> {
        self.inside_with_id(dir, name, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> Paths {
        Paths::at(r"C:\ProgramData\IndiansAssist")
    }

    #[test]
    fn every_path_is_under_the_one_root() {
        let p = p();
        for path in [
            p.config(),
            p.manifest(),
            p.identity_key(),
            p.sealing_key(),
            p.tamper_log(),
            p.service_log(),
            p.pushes(),
            p.receipts(),
            p.run_dir(),
        ] {
            assert!(
                path.starts_with(p.root()),
                "{} escapes the root",
                path.display()
            );
        }
    }

    #[test]
    fn the_key_files_are_the_contract_names() {
        assert!(p().identity_key().ends_with("device.key"));
        assert!(p().sealing_key().ends_with("device.kex"));
        assert!(p().tamper_log().ends_with("tamper.log"));
    }

    #[test]
    fn a_pushed_file_name_cannot_escape_the_pushes_folder() {
        let p = p();
        let dir = p.pushes();
        for hostile in [
            r"..\..\Windows\System32\drivers\etc\hosts",
            "../../../evil.exe",
            r"C:\Windows\notepad.exe",
            "con",
            "",
            ".",
            "..",
        ] {
            match p.inside(&dir, hostile) {
                None => {}
                Some(path) => {
                    assert!(
                        path.starts_with(&dir),
                        "{hostile} became {}",
                        path.display()
                    );
                    assert_eq!(
                        path.parent(),
                        Some(dir.as_path()),
                        "{hostile} left the folder"
                    );
                }
            }
        }
    }

    #[test]
    fn an_ordinary_name_lands_in_the_folder() {
        let p = p();
        let got = p.inside(&p.pushes(), "quarterly report.pdf").unwrap();
        assert_eq!(got, p.pushes().join("quarterly report.pdf"));
    }
}
