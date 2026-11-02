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
}

/// The plan for a clean exit. `kept` = the person chose Keep: the bundle is copied to
/// `~/Applications/IndiansAssist.app` and the support directory stays (it holds the settings
/// the kept app reuses). Received files are never in a plan (D1). A binary outside a bundle
/// (a dev build) removes only the support directory.
pub fn plan(env: &MacEnv, exe: &Path, kept: bool) -> SelfDeletePlan {
    let bundle = paths::bundle_of(exe);
    if kept {
        let keep_copy = match (bundle, paths::kept_bundle(env)) {
            (Some(from), Some(to)) if from != to => Some((from, to)),
            _ => None,
        };
        return SelfDeletePlan {
            remove_dirs: Vec::new(),
            remove_files: Vec::new(),
            remove_bundle: None,
            keep_copy,
        };
    }
    SelfDeletePlan {
        remove_dirs: paths::support_dir(env).into_iter().collect(),
        remove_files: paths::sidecar_for(exe).into_iter().collect(),
        remove_bundle: bundle,
        keep_copy: None,
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
    let bundle_ok = plan
        .remove_bundle
        .as_ref()
        .is_none_or(|b| Some(b.clone()) == paths::bundle_of(exe));
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
    fn keep_copies_the_bundle_to_applications_and_removes_nothing() {
        let p = plan(&env(), Path::new(EXE), true);
        assert!(p.remove_dirs.is_empty() && p.remove_files.is_empty());
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
        assert_eq!(plan(&env(), Path::new(kept), true).keep_copy, None);
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
