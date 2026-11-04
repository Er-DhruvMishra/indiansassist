//! The §8.3a layout.
//!
//! | Use | Production | Dev `--console` |
//! |---|---|---|
//! | binaries | `/usr/lib/indiansassist/{ia-service,ia-desktop}` | beside the running `ia-service` |
//! | state (0700 root): `config.json`, `device.key`, `device.kex`, `tamper.log`, pushes, receipts, the `sh` run dir | `/var/lib/indiansassist/` (`StateDirectory=`) | `<root>/state` |
//! | config drop (0750 root): `enroll.iaconfig` | `/etc/indiansassist/` (`ConfigurationDirectory=`) | `<root>/etc` |
//! | runtime | `/run/indiansassist/` (`RuntimeDirectory=`) | `<root>/run` |
//!
//! Logs go to the journal (stdout and stderr), so there is no log directory to manage. The state
//! tree reuses [`crate::paths::Paths`], so the config, key, outbox and receipt names are the ones
//! the Windows service uses.

use std::path::{Path, PathBuf};

use crate::paths::Paths;

/// The worker binary installed beside the service.
pub const WORKER_BIN: &str = "ia-desktop";
/// The enrollment drop file (§8.3c).
pub const ENROLL_FILE: &str = "enroll.iaconfig";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxLayout {
    pub state: PathBuf,
    pub config: PathBuf,
    pub runtime: PathBuf,
    pub install: PathBuf,
}

impl LinuxLayout {
    /// The production layout of §8.3a.
    pub fn system() -> Self {
        Self {
            state: PathBuf::from("/var/lib/indiansassist"),
            config: PathBuf::from("/etc/indiansassist"),
            runtime: PathBuf::from("/run/indiansassist"),
            install: PathBuf::from("/usr/lib/indiansassist"),
        }
    }

    /// The dev `--console` layout: every directory under `root`, the binaries in `install`.
    pub fn under(root: &Path, install: &Path) -> Self {
        Self {
            state: root.join("state"),
            config: root.join("etc"),
            runtime: root.join("run"),
            install: install.to_path_buf(),
        }
    }

    /// The state tree as the shared [`Paths`].
    pub fn paths(&self) -> Paths {
        Paths::at(&self.state)
    }

    /// `/etc/indiansassist/enroll.iaconfig` (§8.3c).
    pub fn enroll_config(&self) -> PathBuf {
        self.config.join(ENROLL_FILE)
    }

    /// `/usr/lib/indiansassist/ia-desktop`.
    pub fn worker_image(&self) -> PathBuf {
        self.install.join(WORKER_BIN)
    }

    /// The installed file list the §8.8 integrity check compares against, when the package
    /// ships one; without it the check is skipped quietly.
    pub fn manifest(&self) -> PathBuf {
        self.install.join("manifest.json")
    }

    /// The manifest digest last seen, so a changed list is a `config_changed` (§10.4).
    pub fn manifest_seen(&self) -> PathBuf {
        self.state.join("manifest.sha256")
    }

    /// The unit's `NRestarts` last seen, so a restart by systemd is a `watchdog_restarted` (§8.8).
    pub fn restarts_seen(&self) -> PathBuf {
        self.state.join("nrestarts")
    }

    /// Create the tree: state 0700, config 0750 (only when this process creates it: the package
    /// and systemd own it in production), runtime 0700.
    #[cfg(unix)]
    pub fn ensure(&self) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        for (dir, mode, always) in [
            (&self.state, 0o700, true),
            (&self.config, 0o750, false),
            (&self.runtime, 0o700, true),
        ] {
            let existed = dir.exists();
            std::fs::create_dir_all(dir)?;
            if always || !existed {
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode))?;
            }
        }
        self.paths().ensure()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_production_layout_is_section_8_3a() {
        let l = LinuxLayout::system();
        assert_eq!(
            l.paths().config(),
            Path::new("/var/lib/indiansassist/config.json")
        );
        assert_eq!(
            l.paths().identity_key(),
            Path::new("/var/lib/indiansassist/device.key")
        );
        assert_eq!(
            l.paths().sealing_key(),
            Path::new("/var/lib/indiansassist/device.kex")
        );
        assert_eq!(
            l.enroll_config(),
            Path::new("/etc/indiansassist/enroll.iaconfig")
        );
        assert_eq!(
            l.worker_image(),
            Path::new("/usr/lib/indiansassist/ia-desktop")
        );
        assert_eq!(l.runtime, Path::new("/run/indiansassist"));
    }

    #[test]
    fn the_dev_layout_never_names_a_system_directory() {
        let l = LinuxLayout::under(Path::new("/tmp/ia-e2e"), Path::new("/tmp/bin"));
        for p in [&l.state, &l.config, &l.runtime] {
            assert!(p.starts_with("/tmp/ia-e2e"), "{}", p.display());
        }
        assert_eq!(l.worker_image(), Path::new("/tmp/bin/ia-desktop"));
    }

    #[test]
    fn the_tree_is_created_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "ia-layout-{}-{}",
            std::process::id(),
            ia_core::rnd::hex(4)
        ));
        let l = LinuxLayout::under(&root, &root);
        l.ensure().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&l.state), 0o700);
        assert_eq!(mode(&l.config), 0o750);
        assert_eq!(mode(&l.runtime), 0o700);
        assert!(l.paths().pushes().is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }
}
