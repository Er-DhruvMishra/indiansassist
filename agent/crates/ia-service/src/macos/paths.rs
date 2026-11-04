//! The macOS layout (Phase F §17.3).
//!
//! | Use | Production | Dev `--console` |
//! |---|---|---|
//! | the daemon | `/Library/IndiansAssist/ia-service` | the running `ia-service` |
//! | the worker (a bundle, so its TCC grants have a name) | `/Library/IndiansAssist/IndiansAssist Desktop.app/Contents/MacOS/ia-desktop` | `ia-desktop` beside the running `ia-service` |
//! | state (0700 root): `config.json`, `tamper.log`, pushes, receipts, the run dir | `/Library/Application Support/IndiansAssist/` | `<root>/state` |
//! | enrollment drop (root 0600): `enroll.iaconfig` | the state directory (§17.3) | `<root>/state` |
//! | the worker socket | `/var/run/indiansassist/worker.sock` | `<root>/run/worker.sock` (or `--socket`) |
//! | the device keys | the System keychain | `<root>/state/dev.keychain-db` |
//!
//! Logs go to stderr, which the LaunchDaemon plist sends to `/Library/Logs/IndiansAssist/`. The
//! state tree reuses [`crate::paths::Paths`], so the config, outbox and receipt names are the ones
//! Windows and Linux use.

use std::path::{Path, PathBuf};

use crate::paths::Paths;

/// The worker binary's name.
pub const WORKER_BIN: &str = "ia-desktop";
/// The worker's place in the production install: inside its own app bundle, so System Settings
/// shows "IndiansAssist Desktop" for its Screen Recording and Accessibility grants.
pub const WORKER_IN_BUNDLE: &str = "IndiansAssist Desktop.app/Contents/MacOS/ia-desktop";
/// The daemon binary.
pub const SERVICE_BIN: &str = "ia-service";
/// The enrollment drop file (§17.3).
pub const ENROLL_FILE: &str = "enroll.iaconfig";
/// The worker socket's file name.
pub const SOCKET_FILE: &str = "worker.sock";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacLayout {
    pub state: PathBuf,
    pub runtime: PathBuf,
    pub install: PathBuf,
    /// The worker, relative to `install`.
    pub worker: PathBuf,
    /// `Some` in a dev run: the file keychain that stands in for the System keychain.
    pub dev_keychain: Option<PathBuf>,
}

impl MacLayout {
    /// The production layout.
    pub fn system() -> Self {
        Self {
            state: PathBuf::from("/Library/Application Support/IndiansAssist"),
            runtime: PathBuf::from("/var/run/indiansassist"),
            install: PathBuf::from("/Library/IndiansAssist"),
            worker: PathBuf::from(WORKER_IN_BUNDLE),
            dev_keychain: None,
        }
    }

    /// The dev `--console` layout: every directory under `root`, the binaries in `install`, the
    /// keys in a file keychain under `root`. Nothing of the real system is named.
    pub fn under(root: &Path, install: &Path) -> Self {
        let state = root.join("state");
        Self {
            dev_keychain: Some(state.join("dev.keychain-db")),
            state,
            runtime: root.join("run"),
            install: install.to_path_buf(),
            worker: PathBuf::from(WORKER_BIN),
        }
    }

    pub fn paths(&self) -> Paths {
        Paths::at(&self.state)
    }

    pub fn enroll_config(&self) -> PathBuf {
        self.state.join(ENROLL_FILE)
    }

    pub fn worker_image(&self) -> PathBuf {
        self.install.join(&self.worker)
    }

    pub fn service_image(&self) -> PathBuf {
        self.install.join(SERVICE_BIN)
    }

    pub fn socket(&self) -> PathBuf {
        self.runtime.join(SOCKET_FILE)
    }

    /// The installed file list the integrity check compares against, when the package ships one.
    pub fn manifest(&self) -> PathBuf {
        self.install.join("manifest.json")
    }

    /// The manifest digest last seen, so a changed list is a `config_changed` (§10.4).
    pub fn manifest_seen(&self) -> PathBuf {
        self.state.join("manifest.sha256")
    }

    /// Create the tree: state 0700; the runtime directory 0755 (the worker, another user, must
    /// reach the socket inside it; the socket's peer check is the gate, §17.3).
    pub fn ensure(&self) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        for (dir, mode) in [(&self.state, 0o700), (&self.runtime, 0o755)] {
            std::fs::create_dir_all(dir)?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode))?;
        }
        self.paths().ensure()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_production_layout_is_section_17_3() {
        let l = MacLayout::system();
        assert_eq!(
            l.paths().config(),
            Path::new("/Library/Application Support/IndiansAssist/config.json")
        );
        assert_eq!(
            l.enroll_config(),
            Path::new("/Library/Application Support/IndiansAssist/enroll.iaconfig")
        );
        assert_eq!(
            l.worker_image(),
            Path::new("/Library/IndiansAssist/IndiansAssist Desktop.app/Contents/MacOS/ia-desktop")
        );
        assert_eq!(
            l.service_image(),
            Path::new("/Library/IndiansAssist/ia-service")
        );
        assert_eq!(l.socket(), Path::new("/var/run/indiansassist/worker.sock"));
        assert_eq!(
            l.dev_keychain, None,
            "production keys live in the System keychain"
        );
    }

    #[test]
    fn the_dev_layout_never_names_a_system_directory() {
        let l = MacLayout::under(Path::new("/tmp/ia-e2e"), Path::new("/tmp/bin"));
        for p in [&l.state, &l.runtime, l.dev_keychain.as_ref().unwrap()] {
            assert!(p.starts_with("/tmp/ia-e2e"), "{}", p.display());
        }
        assert!(l.socket().starts_with("/tmp/ia-e2e"));
        assert_eq!(l.worker_image(), Path::new("/tmp/bin/ia-desktop"));
    }

    #[test]
    fn the_tree_is_created_with_a_private_state_and_a_reachable_runtime() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "ia-mac-layout-{}-{}",
            std::process::id(),
            ia_core::rnd::hex(4)
        ));
        let l = MacLayout::under(&root, &root);
        l.ensure().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&l.state), 0o700);
        assert_eq!(mode(&l.runtime), 0o755);
        assert!(l.paths().pushes().is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }
}
