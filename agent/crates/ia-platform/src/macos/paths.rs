//! The macOS agent's paths (Phase F §17.2), pure functions of `$HOME`, the per-user temporary
//! directory and the executable path.
//!
//! The portable agent is an app bundle, `IndiansAssist.app/Contents/MacOS/IndiansAssist`, unzipped
//! wherever the person put it (usually `~/Downloads`). Its signed configuration travels as the
//! sidecar `IndiansAssist.iaconfig` **beside the bundle** (C §2.4), honoured only next to a bundle
//! named exactly `IndiansAssist.app`.

use std::path::{Component, Path, PathBuf};

/// The bundle name the sidecar and Keep require.
pub const BUNDLE_NAME: &str = "IndiansAssist.app";
/// The sidecar's file name.
pub const SIDECAR_NAME: &str = "IndiansAssist.iaconfig";
/// The support directory's name under `~/Library/Application Support`.
pub const APP_DIR: &str = "IndiansAssist";

/// The facts the paths are derived from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MacEnv {
    pub home: Option<PathBuf>,
    /// `$TMPDIR`, the per-user `/var/folders/…/T/` directory (0700, owned by the user).
    pub tmpdir: Option<PathBuf>,
}

impl MacEnv {
    pub fn from_process() -> Self {
        let abs = |v: Option<std::ffi::OsString>| v.map(PathBuf::from).filter(|p| p.is_absolute());
        Self {
            home: abs(std::env::var_os("HOME")),
            tmpdir: abs(std::env::var_os("TMPDIR")),
        }
    }
}

/// `~/Library/Application Support/IndiansAssist`: state, logs, the received-file staging.
pub fn support_dir(env: &MacEnv) -> Option<PathBuf> {
    Some(
        env.home
            .as_ref()?
            .join("Library/Application Support")
            .join(APP_DIR),
    )
}

/// `~/Downloads`, where received files land (in an `IndiansAssist` folder, as on Linux).
pub fn downloads_dir(env: &MacEnv) -> Option<PathBuf> {
    Some(env.home.as_ref()?.join("Downloads"))
}

/// Received files: `~/Downloads/IndiansAssist/`.
pub fn received_dir(env: &MacEnv) -> Option<PathBuf> {
    downloads_dir(env).map(|d| d.join("IndiansAssist"))
}

/// Keep (§17.2, §3.4): `~/Applications/IndiansAssist.app`, which needs no administrator.
pub fn kept_bundle(env: &MacEnv) -> Option<PathBuf> {
    Some(env.home.as_ref()?.join("Applications").join(BUNDLE_NAME))
}

/// The single-instance socket in the per-user temporary directory (E §7.7 reasoning: a path
/// only this user can reach, checked with `getpeereid` on accept).
pub fn instance_socket(env: &MacEnv, uid: u32) -> Option<PathBuf> {
    Some(
        env.tmpdir
            .as_ref()?
            .join(format!("indiansassist-{uid}.sock")),
    )
}

/// The bundle that contains `exe`, when `exe` is `<…>/X.app/Contents/MacOS/<name>`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_app = bundle
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("app"));
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && is_app)
        .then(|| bundle.to_path_buf())
}

/// The sidecar beside the bundle, honoured only when the bundle is named `IndiansAssist.app`.
pub fn sidecar_for(exe: &Path) -> Option<PathBuf> {
    let bundle = bundle_of(exe)?;
    (bundle.file_name()? == BUNDLE_NAME).then(|| bundle.with_file_name(SIDECAR_NAME))
}

/// `IA_FILE_OFFER` (C §8.5 O1): an offered path is accepted only when it is absolute, has no
/// `..`, and lies strictly under the support directory.
pub fn file_offer_allowed(env: &MacEnv, path: &Path) -> bool {
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    support_dir(env).is_some_and(|root| path.starts_with(&root) && path != root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> MacEnv {
        MacEnv {
            home: Some("/Users/pat".into()),
            tmpdir: Some("/var/folders/ab/xyz/T".into()),
        }
    }

    #[test]
    fn the_paths_are_the_section_17_2_ones() {
        let e = env();
        assert_eq!(
            support_dir(&e).unwrap(),
            Path::new("/Users/pat/Library/Application Support/IndiansAssist")
        );
        assert_eq!(
            received_dir(&e).unwrap(),
            Path::new("/Users/pat/Downloads/IndiansAssist")
        );
        assert_eq!(
            kept_bundle(&e).unwrap(),
            Path::new("/Users/pat/Applications/IndiansAssist.app")
        );
        assert_eq!(
            instance_socket(&e, 501).unwrap(),
            Path::new("/var/folders/ab/xyz/T/indiansassist-501.sock")
        );
        assert_eq!(support_dir(&MacEnv::default()), None);
    }

    #[test]
    fn the_bundle_and_sidecar_are_found_only_for_an_indiansassist_bundle() {
        let exe = Path::new("/Users/pat/Downloads/IndiansAssist.app/Contents/MacOS/IndiansAssist");
        assert_eq!(
            bundle_of(exe).unwrap(),
            Path::new("/Users/pat/Downloads/IndiansAssist.app")
        );
        assert_eq!(
            sidecar_for(exe).unwrap(),
            Path::new("/Users/pat/Downloads/IndiansAssist.iaconfig")
        );
        let renamed = Path::new("/Users/pat/Downloads/Other.app/Contents/MacOS/IndiansAssist");
        assert!(bundle_of(renamed).is_some());
        assert_eq!(
            sidecar_for(renamed),
            None,
            "a renamed bundle has no sidecar"
        );
        assert_eq!(bundle_of(Path::new("/usr/local/bin/IndiansAssist")), None);
        assert_eq!(sidecar_for(Path::new("/tmp/IndiansAssist")), None);
    }

    #[test]
    fn file_offers_stay_inside_the_support_dir() {
        let e = env();
        let root = support_dir(&e).unwrap();
        assert!(file_offer_allowed(&e, &root.join("out/report.txt")));
        assert!(!file_offer_allowed(&e, &root));
        assert!(!file_offer_allowed(&e, &root.join("../secrets")));
        assert!(!file_offer_allowed(&e, Path::new("/etc/hosts")));
        assert!(!file_offer_allowed(&e, Path::new("relative/file")));
    }
}
