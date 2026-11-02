//! Self-delete on Linux (Phase E §7.7, C §10): the plan is derived purely from the XDG
//! environment and the executable path, so the derivation and the archive-sibling rule are tested
//! on every host. Applying it is [`super::os::apply_self_delete`] (Linux, `linux-os`), which an
//! automated run never reaches with the built binary: tests apply plans to files in a temporary
//! directory, and the e2e agent runs with `--no-self-delete`.
//!
//! Linux allows unlinking a running executable, so no helper stub is needed (unlike C §10 D2).

use std::path::{Path, PathBuf};

use super::paths::{self, XdgEnv};

/// The extracted archive beside the binary is removed only when it is at most this big (§7.7).
pub const ARCHIVE_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// What a clean exit removes or keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfDeletePlan {
    /// Working directories removed recursively (the runtime dir, the state dir with the log).
    pub remove_dirs: Vec<PathBuf>,
    /// Single files removed when present (the `.iaconfig` sidecar, the handler `.desktop`).
    pub remove_files: Vec<PathBuf>,
    /// `<exe name>.tar.gz` beside the binary: removed only if [`archive_removable`] holds.
    pub archive: Option<PathBuf>,
    /// Restore the previous `x-scheme-handler/indiansassist` default in `mimeapps.list`.
    pub restore_mimeapps: bool,
    /// The running binary, unlinked last.
    pub unlink_exe: Option<PathBuf>,
    /// Keep (C §10 D5): copy the binary here and keep the handler, pointed at the copy.
    pub keep_copy: Option<(PathBuf, PathBuf)>,
}

/// `<dir>/<exe file name>.tar.gz`: the archive the binary was extracted from (§7.7).
pub fn archive_sibling(exe: &Path) -> Option<PathBuf> {
    let name = exe.file_name()?.to_str()?;
    Some(exe.with_file_name(format!("{name}.tar.gz")))
}

/// The facts about the archive sibling that decide whether it may be removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveFacts {
    /// A regular file (not a symlink, directory, socket or device), read with `lstat`.
    pub regular_file: bool,
    pub owner_uid: u32,
    pub size: u64,
}

/// §7.7: the archive is removed only when it is a regular file owned by the user and no larger
/// than 64 MiB; nothing else is touched.
pub fn archive_removable(facts: &ArchiveFacts, my_uid: u32) -> bool {
    facts.regular_file && facts.owner_uid == my_uid && facts.size <= ARCHIVE_MAX_BYTES
}

/// The plan for a clean exit. `kept` = the user chose Keep (D5): the binary is copied to
/// `$XDG_DATA_HOME/indiansassist/IndiansAssist`, the handler stays (pointed at the copy) and
/// nothing of the user's is unlinked; only the runtime dir goes. Received files are never in a
/// plan (D1).
pub fn plan(env: &XdgEnv, exe: &Path, kept: bool) -> SelfDeletePlan {
    let runtime = paths::runtime_dir(env);
    if kept {
        return SelfDeletePlan {
            remove_dirs: runtime.into_iter().collect(),
            remove_files: Vec::new(),
            archive: None,
            restore_mimeapps: false,
            unlink_exe: None,
            keep_copy: paths::kept_binary(env).map(|to| (exe.to_path_buf(), to)),
        };
    }
    let mut remove_dirs: Vec<PathBuf> = Vec::new();
    for d in [runtime, paths::state_dir(env)].into_iter().flatten() {
        if !remove_dirs.contains(&d) {
            remove_dirs.push(d);
        }
    }
    let mut remove_files = Vec::new();
    if let Some(name) = exe.file_name().and_then(|n| n.to_str()) {
        remove_files.push(exe.with_file_name(format!("{name}.iaconfig")));
    }
    if let Some(d) = paths::desktop_file(env) {
        remove_files.push(d);
    }
    SelfDeletePlan {
        remove_dirs,
        remove_files,
        archive: archive_sibling(exe),
        restore_mimeapps: true,
        unlink_exe: Some(exe.to_path_buf()),
        keep_copy: None,
    }
}

/// A plan must never reach outside the agent's own files: every directory it removes ends in
/// `indiansassist`, every file is the sidecar, the handler or the archive of this binary. A
/// defensive check the applier runs before touching anything.
pub fn plan_is_contained(plan: &SelfDeletePlan, exe: &Path) -> bool {
    let dirs_ok = plan
        .remove_dirs
        .iter()
        .all(|d| d.file_name().and_then(|n| n.to_str()) == Some(paths::APP_DIR));
    let exe_name = exe.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let files_ok = plan.remove_files.iter().all(|f| {
        let name = f.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name == super::desktop::DESKTOP_FILE_NAME
            || (!exe_name.is_empty() && name == format!("{exe_name}.iaconfig"))
    });
    let archive_ok = plan
        .archive
        .as_ref()
        .is_none_or(|a| Some(a.clone()) == archive_sibling(exe));
    let exe_ok = plan.unlink_exe.as_deref().is_none_or(|e| e == exe);
    dirs_ok && files_ok && archive_ok && exe_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> XdgEnv {
        XdgEnv {
            home: Some("/home/asha".into()),
            runtime_dir: Some("/run/user/1000".into()),
            ..Default::default()
        }
    }

    const EXE: &str = "/home/asha/Downloads/IndiansAssist-in-mum-4821-9365-7715";

    #[test]
    fn a_clean_exit_removes_the_working_set_and_the_binary() {
        let p = plan(&env(), Path::new(EXE), false);
        assert_eq!(
            p.remove_dirs,
            vec![
                PathBuf::from("/run/user/1000/indiansassist"),
                PathBuf::from("/home/asha/.local/state/indiansassist"),
            ]
        );
        assert_eq!(
            p.remove_files,
            vec![
                PathBuf::from(format!("{EXE}.iaconfig")),
                PathBuf::from("/home/asha/.local/share/applications/indiansassist-handler.desktop"),
            ]
        );
        assert_eq!(p.archive, Some(PathBuf::from(format!("{EXE}.tar.gz"))));
        assert!(p.restore_mimeapps);
        assert_eq!(p.unlink_exe, Some(PathBuf::from(EXE)));
        assert_eq!(p.keep_copy, None);
        assert!(plan_is_contained(&p, Path::new(EXE)));
        // Received files are never part of a plan (C §10 D1).
        let all: Vec<String> = p
            .remove_dirs
            .iter()
            .chain(&p.remove_files)
            .map(|x| x.to_string_lossy().to_string())
            .collect();
        assert!(all.iter().all(|x| !x.contains("Downloads/IndiansAssist/")));
    }

    #[test]
    fn keep_copies_the_binary_and_unlinks_nothing_of_the_users() {
        let p = plan(&env(), Path::new(EXE), true);
        assert_eq!(p.unlink_exe, None);
        assert_eq!(p.archive, None);
        assert!(!p.restore_mimeapps);
        assert!(p.remove_files.is_empty());
        assert_eq!(
            p.keep_copy,
            Some((
                PathBuf::from(EXE),
                PathBuf::from("/home/asha/.local/share/indiansassist/IndiansAssist")
            ))
        );
        assert!(plan_is_contained(&p, Path::new(EXE)));
    }

    #[test]
    fn the_archive_sibling_rule() {
        assert_eq!(
            archive_sibling(Path::new(EXE)),
            Some(PathBuf::from(format!("{EXE}.tar.gz")))
        );
        let ok = ArchiveFacts {
            regular_file: true,
            owner_uid: 1000,
            size: 9 * 1024 * 1024,
        };
        assert!(archive_removable(&ok, 1000));
        assert!(archive_removable(
            &ArchiveFacts {
                size: ARCHIVE_MAX_BYTES,
                ..ok
            },
            1000
        ));
        assert!(!archive_removable(
            &ArchiveFacts {
                size: ARCHIVE_MAX_BYTES + 1,
                ..ok
            },
            1000
        ));
        assert!(!archive_removable(&ok, 1001), "someone else's file");
        assert!(!archive_removable(
            &ArchiveFacts {
                regular_file: false,
                ..ok
            },
            1000
        ));
    }

    #[test]
    fn a_tampered_plan_is_not_contained() {
        let mut p = plan(&env(), Path::new(EXE), false);
        p.remove_dirs.push("/home/asha".into());
        assert!(!plan_is_contained(&p, Path::new(EXE)));
        let mut p = plan(&env(), Path::new(EXE), false);
        p.remove_files.push("/home/asha/.bashrc".into());
        assert!(!plan_is_contained(&p, Path::new(EXE)));
    }
}
