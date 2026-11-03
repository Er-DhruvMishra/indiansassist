//! Self-delete and Keep on macOS (Phase F §17.2, C §10, §3.4), as a pure plan. Applying it is
//! [`super::os::apply_self_delete`], which an automated run never reaches with the built app:
//! tests apply plans to a temporary root, and the e2e agent runs with `--no-self-delete` (A1).
//!
//! macOS lets a running app's bundle be removed, so, as on Linux, no helper stub is needed.

use std::path::{Path, PathBuf};

use super::paths::{self, MacEnv};

/// What a clean exit removes or keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfDeletePlan {
    /// Removed recursively: the support directory.
    pub remove_dirs: Vec<PathBuf>,
    /// Removed when present: the `.iaconfig` sidecar.
    pub remove_files: Vec<PathBuf>,
    /// The running app's bundle, removed last.
    pub remove_bundle: Option<PathBuf>,
    /// Keep: copy the bundle here (`ditto`, which keeps its signature) and remove nothing else.
    pub keep_copy: Option<(PathBuf, PathBuf)>,
    /// The person unticked Keep on the running kept copy (rule 3.4d): the one case
    /// `~/Applications/IndiansAssist.app` may be removed (see [`bundle_removal_allowed`]).
    pub kept_remove_after: bool,
}

/// Whether a clean exit may remove `bundle` (§10 on macOS): an absolute path without `..`, named
/// exactly `IndiansAssist.app`, and not inside `/Applications` or `~/Applications` (an installed or
/// kept copy), with one exception: exactly `~/Applications/IndiansAssist.app` when
/// `kept_remove_after` (the running kept copy whose person unticked Keep, rule 3.4d; the caller
/// also checks it is the bundle this process runs from).
pub fn bundle_removal_allowed(env: &MacEnv, bundle: &Path, kept_remove_after: bool) -> bool {
    use std::path::Component;
    if !bundle.is_absolute()
        || bundle
            .components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return false;
    }
    if bundle.file_name().and_then(|n| n.to_str()) != Some(paths::BUNDLE_NAME) {
        return false;
    }
    let kept = paths::kept_bundle(env);
    if kept_remove_after && kept.as_deref() == Some(bundle) {
        return true;
    }
    let user_apps = kept.as_deref().and_then(Path::parent);
    !bundle
        .ancestors()
        .skip(1)
        .any(|a| a == Path::new("/Applications") || user_apps == Some(a))
}

/// Whether `exe` runs from the Keep location, `~/Applications/IndiansAssist.app` (rule 3.4d).
pub fn is_kept_copy(env: &MacEnv, exe: &Path) -> bool {
    paths::bundle_of(exe).is_some_and(|b| Some(b) == paths::kept_bundle(env))
}

/// The plan for a clean exit. Received files are never in a plan (D1).
///
/// * `kept` (the person chose Keep, D5; rule 3.4c): the bundle is copied to
///   `~/Applications/IndiansAssist.app` (no administrator needed), the support directory (logs and
///   state) goes, and nothing else is removed. A kept app running again copies nothing and only
///   clears the support directory (rule 3.4d).
/// * otherwise: the support directory, the sidecar and the running bundle, when
///   [`bundle_removal_allowed`] (a kept copy only through [`removal_plan`] with
///   `kept_remove_after`).
///
/// A binary outside a bundle (a dev build) never copies or removes a bundle.
pub fn plan(env: &MacEnv, exe: &Path, kept: bool) -> SelfDeletePlan {
    if !kept {
        return removal_plan(env, exe, false);
    }
    let keep_copy = match (paths::bundle_of(exe), paths::kept_bundle(env)) {
        (Some(from), Some(to)) if from != to => Some((from, to)),
        _ => None,
    };
    SelfDeletePlan {
        remove_dirs: paths::support_dir(env).into_iter().collect(),
        remove_files: Vec::new(),
        remove_bundle: None,
        keep_copy,
        kept_remove_after: false,
    }
}

/// The self-delete plan (§10 D1/D2): the support directory, the sidecar, and the running bundle
/// when [`bundle_removal_allowed`]. `kept_remove_after` is true only for the running kept copy
/// whose person unticked Keep (rule 3.4d), and only then may `~/Applications/IndiansAssist.app`
/// go; it is ignored for any other bundle.
pub fn removal_plan(env: &MacEnv, exe: &Path, kept_remove_after: bool) -> SelfDeletePlan {
    let kept_remove_after = kept_remove_after && is_kept_copy(env, exe);
    SelfDeletePlan {
        remove_dirs: paths::support_dir(env).into_iter().collect(),
        remove_files: paths::sidecar_for(exe).into_iter().collect(),
        remove_bundle: paths::bundle_of(exe)
            .filter(|b| bundle_removal_allowed(env, b, kept_remove_after)),
        keep_copy: None,
        kept_remove_after,
    }
}

/// A plan must never reach outside the agent's own files: the directory is the support dir, the
/// file is the sidecar of this bundle, and the bundle is the one this binary runs from and is
/// named `*.app`. A defensive check the applier runs before touching anything.
pub fn plan_is_contained(plan: &SelfDeletePlan, env: &MacEnv, exe: &Path) -> bool {
    let support = paths::support_dir(env);
    let dirs_ok = plan
        .remove_dirs
        .iter()
        .all(|d| Some(d) == support.as_ref() && d.file_name().is_some_and(|n| n == paths::APP_DIR));
    let files_ok = plan
        .remove_files
        .iter()
        .all(|f| Some(f.clone()) == paths::sidecar_for(exe));
    let bundle_ok = plan.remove_bundle.as_ref().is_none_or(|b| {
        Some(b.clone()) == paths::bundle_of(exe)
            && bundle_removal_allowed(env, b, plan.kept_remove_after)
    });
    let keep_ok = plan.keep_copy.as_ref().is_none_or(|(from, to)| {
        Some(from.clone()) == paths::bundle_of(exe) && Some(to.clone()) == paths::kept_bundle(env)
    });
    dirs_ok && files_ok && bundle_ok && keep_ok
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

    const EXE: &str = "/Users/pat/Downloads/IndiansAssist.app/Contents/MacOS/IndiansAssist";

    #[test]
    fn a_clean_exit_removes_the_support_dir_the_sidecar_and_the_bundle() {
        let p = plan(&env(), Path::new(EXE), false);
        assert_eq!(
            p.remove_dirs,
            vec![PathBuf::from(
                "/Users/pat/Library/Application Support/IndiansAssist"
            )]
        );
        assert_eq!(
            p.remove_files,
            vec![PathBuf::from("/Users/pat/Downloads/IndiansAssist.iaconfig")]
        );
        assert_eq!(
            p.remove_bundle,
            Some(PathBuf::from("/Users/pat/Downloads/IndiansAssist.app"))
        );
        assert_eq!(p.keep_copy, None);
        assert!(plan_is_contained(&p, &env(), Path::new(EXE)));
    }

    #[test]
    fn keep_copies_the_bundle_to_applications_and_removes_only_the_support_dir() {
        let p = plan(&env(), Path::new(EXE), true);
        assert_eq!(
            p.remove_dirs,
            vec![PathBuf::from(
                "/Users/pat/Library/Application Support/IndiansAssist"
            )]
        );
        assert!(p.remove_files.is_empty());
        assert_eq!(p.remove_bundle, None);
        assert_eq!(
            p.keep_copy,
            Some((
                PathBuf::from("/Users/pat/Downloads/IndiansAssist.app"),
                PathBuf::from("/Users/pat/Applications/IndiansAssist.app")
            ))
        );
        assert!(plan_is_contained(&p, &env(), Path::new(EXE)));
    }

    #[test]
    fn the_kept_app_keeps_itself_without_copying_onto_itself() {
        let kept = "/Users/pat/Applications/IndiansAssist.app/Contents/MacOS/IndiansAssist";
        assert!(is_kept_copy(&env(), Path::new(kept)));
        assert!(!is_kept_copy(&env(), Path::new(EXE)));
        let p = plan(&env(), Path::new(kept), true);
        assert_eq!(p.keep_copy, None);
        assert_eq!(p.remove_bundle, None);
        assert_eq!(p.remove_dirs.len(), 1);
        // A session's exit never removes a bundle in ~/Applications: only its support dir goes.
        let p = plan(&env(), Path::new(kept), false);
        assert_eq!(p.remove_bundle, None);
        assert_eq!(p.remove_dirs.len(), 1);
        assert!(plan_is_contained(&p, &env(), Path::new(kept)));
    }

    #[test]
    fn only_a_downloaded_indiansassist_app_may_be_removed() {
        let ok = |p: &str| bundle_removal_allowed(&env(), Path::new(p), false);
        assert!(ok("/Users/pat/Downloads/IndiansAssist.app"));
        assert!(ok("/Users/pat/Desktop/support/IndiansAssist.app"));
        assert!(!ok("/Applications/IndiansAssist.app"), "installed");
        assert!(!ok("/Applications/Tools/IndiansAssist.app"));
        assert!(!ok("/Users/pat/Applications/IndiansAssist.app"), "kept");
        assert!(!ok("/Users/pat/Downloads/Other.app"), "another name");
        assert!(
            !ok("/Users/pat/Downloads/indiansassist.app"),
            "the exact name only"
        );
        assert!(!ok("Downloads/IndiansAssist.app"), "relative");
        assert!(!ok("/Users/pat/Downloads/x/../IndiansAssist.app"), "..");
        let exe = "/Applications/IndiansAssist.app/Contents/MacOS/IndiansAssist";
        let p = plan(&env(), Path::new(exe), false);
        assert_eq!(p.remove_bundle, None);
        assert!(p.remove_files.is_empty() || p.remove_files.len() == 1);
    }

    #[test]
    fn the_kept_copy_may_go_only_when_its_person_unticked_keep() {
        let kept = || Path::new("/Users/pat/Applications/IndiansAssist.app");
        let may = |b: &Path, after: bool| bundle_removal_allowed(&env(), b, after);
        assert!(may(kept(), true));
        assert!(!may(kept(), false));
        // The exception is exactly that path: never /Applications, another folder or name.
        assert!(!may(Path::new("/Applications/IndiansAssist.app"), true));
        assert!(!may(
            Path::new("/Users/pat/Applications/Tools/IndiansAssist.app"),
            true
        ));
        assert!(!may(Path::new("/Users/pat/Applications/Other.app"), true));
        assert!(!may(
            Path::new("/Users/pat/Applications/x/../IndiansAssist.app"),
            true
        ));
        // The plan asks for it only from the kept copy itself.
        let kept_exe =
            Path::new("/Users/pat/Applications/IndiansAssist.app/Contents/MacOS/IndiansAssist");
        let p = removal_plan(&env(), kept_exe, true);
        assert_eq!(p.remove_bundle.as_deref(), Some(kept()));
        assert!(plan_is_contained(&p, &env(), kept_exe));
        assert_eq!(removal_plan(&env(), kept_exe, false).remove_bundle, None);
        let installed = Path::new("/Applications/IndiansAssist.app/Contents/MacOS/IndiansAssist");
        assert_eq!(removal_plan(&env(), installed, true).remove_bundle, None);
        // A plan that names the kept copy without the flag is refused by the applier's check.
        let mut forged = removal_plan(&env(), kept_exe, false);
        forged.remove_bundle = Some(kept().to_path_buf());
        assert!(!plan_is_contained(&forged, &env(), kept_exe));
    }

    #[test]
    fn a_dev_binary_outside_a_bundle_removes_only_the_support_dir() {
        let exe = Path::new("/Users/pat/src/agent/target/debug/IndiansAssist");
        let p = plan(&env(), exe, false);
        assert_eq!(p.remove_bundle, None);
        assert!(p.remove_files.is_empty());
        assert_eq!(p.remove_dirs.len(), 1);
    }

    #[test]
    fn a_tampered_plan_is_refused() {
        let mut p = plan(&env(), Path::new(EXE), false);
        p.remove_dirs.push(PathBuf::from("/Users/pat/Documents"));
        assert!(!plan_is_contained(&p, &env(), Path::new(EXE)));
        let mut p = plan(&env(), Path::new(EXE), false);
        p.remove_bundle = Some(PathBuf::from("/Applications/Safari.app"));
        assert!(!plan_is_contained(&p, &env(), Path::new(EXE)));
    }
}
