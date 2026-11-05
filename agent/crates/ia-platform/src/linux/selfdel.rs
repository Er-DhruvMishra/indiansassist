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
    /// Phase F §9.5: the Wayland portal companion `.ia-portal` beside the binary, removed with it
    /// (only when it is the user's own regular file). The pair is one program.
    pub companion: Option<PathBuf>,
    /// Phase F §9.5: Keep copies the companion beside the kept binary too.
    pub keep_companion: Option<(PathBuf, PathBuf)>,
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

/// Whether `exe` is the Keep location `$XDG_DATA_HOME/indiansassist/IndiansAssist` (Phase F
/// rule 3.4d: a kept copy treats Keep as chosen and never deletes itself unless the Desk chose
/// "Remove IndiansAssist from this computer after this session").
pub fn is_kept_copy(env: &XdgEnv, exe: &Path) -> bool {
    paths::kept_binary(env).is_some_and(|k| k == exe)
}

/// The plan for a clean exit. Received files are never in a plan (D1).
///
/// * `kept` (the user chose Keep, D5; Phase F rule 3.4c): the binary is copied to
///   `$XDG_DATA_HOME/indiansassist/IndiansAssist`, the handler stays (pointed at the copy) and
///   nothing of the user's is unlinked; the runtime dir and the log dir go. A kept copy running
///   again (rule 3.4d) is not copied onto itself: it only removes its runtime and log dirs.
/// * not `kept`, from the Keep location ("Remove ... after this session", rule 3.4d): the normal
///   D1 self-delete of the kept copy, whose directory goes with it.
pub fn plan(env: &XdgEnv, exe: &Path, kept: bool) -> SelfDeletePlan {
    let runtime = paths::runtime_dir(env);
    let mut remove_dirs: Vec<PathBuf> = Vec::new();
    for d in [runtime, paths::state_dir(env)].into_iter().flatten() {
        if !remove_dirs.contains(&d) {
            remove_dirs.push(d);
        }
    }
    let kept_copy = is_kept_copy(env, exe);
    if kept {
        return SelfDeletePlan {
            remove_dirs,
            remove_files: Vec::new(),
            archive: None,
            restore_mimeapps: false,
            unlink_exe: None,
            keep_copy: if kept_copy {
                None
            } else {
                paths::kept_binary(env).map(|to| (exe.to_path_buf(), to))
            },
            companion: None,
            keep_companion: None,
        };
    }
    if kept_copy {
        // The kept copy's own directory holds only the copy (and its sidecar): removing it is
        // the unlink, so nothing is left behind.
        if let Some(dir) = exe.parent() {
            remove_dirs.push(dir.to_path_buf());
        }
        let mut remove_files = Vec::new();
        if let Some(d) = paths::desktop_file(env) {
            remove_files.push(d);
        }
        return SelfDeletePlan {
            remove_dirs,
            remove_files,
            archive: None,
            restore_mimeapps: true,
            unlink_exe: None,
            keep_copy: None,
            companion: None,
            keep_companion: None,
        };
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
        companion: None,
        keep_companion: None,
    }
}

/// Phase F §9.5: the file name of the Wayland portal companion inside the Linux download.
pub const COMPANION_NAME: &str = ".ia-portal";

/// `<dir of main>/.ia-portal`.
pub fn companion_of(main: &Path) -> PathBuf {
    main.with_file_name(COMPANION_NAME)
}

/// Phase F §9.5: the plan when the X11 binary `main` and its portal companion are one program.
/// Whichever of the two runs at exit applies it (the portal binary knows `main` from
/// `--handed-from`): the plan is [`plan`] of `main` (its sidecar, its archive, its Keep copy),
/// plus the companion removed with it, or copied beside the kept binary on Keep. Apply it with
/// `main` as the executable.
pub fn plan_pair(env: &XdgEnv, main: &Path, kept: bool) -> SelfDeletePlan {
    let mut p = plan(env, main, kept);
    if is_kept_copy(env, main) {
        // The kept copy's directory holds the pair: removing it removes both; Keep keeps both.
        return p;
    }
    if kept {
        p.keep_companion =
            paths::kept_binary(env).map(|to| (companion_of(main), companion_of(&to)));
    } else {
        p.companion = Some(companion_of(main));
    }
    p
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
    // Phase F §9.5: the companion is `.ia-portal` beside this binary, and its Keep copy goes
    // beside the kept binary.
    let companion_ok = plan
        .companion
        .as_ref()
        .is_none_or(|c| *c == companion_of(exe));
    let keep_companion_ok = plan.keep_companion.as_ref().is_none_or(|(from, to)| {
        *from == companion_of(exe)
            && plan
                .keep_copy
                .as_ref()
                .is_some_and(|(_, kept)| *to == companion_of(kept))
    });
    dirs_ok && files_ok && archive_ok && exe_ok && companion_ok && keep_companion_ok
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

    const KEPT: &str = "/home/asha/.local/share/indiansassist/IndiansAssist";

    #[test]
    fn keep_also_clears_the_log_dir() {
        let p = plan(&env(), Path::new(EXE), true);
        assert_eq!(
            p.remove_dirs,
            vec![
                PathBuf::from("/run/user/1000/indiansassist"),
                PathBuf::from("/home/asha/.local/state/indiansassist"),
            ]
        );
    }

    #[test]
    fn a_kept_copy_running_again_is_not_copied_onto_itself() {
        let e = env();
        assert!(is_kept_copy(&e, Path::new(KEPT)));
        assert!(!is_kept_copy(&e, Path::new(EXE)));
        let p = plan(&e, Path::new(KEPT), true);
        assert_eq!(p.keep_copy, None);
        assert_eq!(p.unlink_exe, None);
        assert!(
            !p.restore_mimeapps,
            "the handler stays, pointed at the copy"
        );
        assert!(p.remove_files.is_empty());
        assert_eq!(p.remove_dirs.len(), 2, "only the runtime and log dirs");
        assert!(plan_is_contained(&p, Path::new(KEPT)));
    }

    #[test]
    fn remove_after_this_session_deletes_the_kept_copy() {
        let e = env();
        let p = plan(&e, Path::new(KEPT), false);
        assert!(p
            .remove_dirs
            .contains(&PathBuf::from("/home/asha/.local/share/indiansassist")));
        assert!(p.restore_mimeapps);
        assert_eq!(
            p.remove_files,
            vec![PathBuf::from(
                "/home/asha/.local/share/applications/indiansassist-handler.desktop"
            )]
        );
        assert_eq!(p.archive, None);
        assert_eq!(p.keep_copy, None);
        assert!(plan_is_contained(&p, Path::new(KEPT)));
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
    fn the_pair_is_one_program() {
        let main = Path::new(EXE);
        let p = plan_pair(&env(), main, false);
        assert_eq!(
            p.companion,
            Some(PathBuf::from("/home/asha/Downloads/.ia-portal"))
        );
        assert_eq!(p.unlink_exe, Some(PathBuf::from(EXE)));
        assert_eq!(p.archive, Some(PathBuf::from(format!("{EXE}.tar.gz"))));
        assert_eq!(p.keep_companion, None);
        assert!(plan_is_contained(&p, main));

        let k = plan_pair(&env(), main, true);
        assert_eq!(k.companion, None);
        assert_eq!(k.unlink_exe, None);
        assert_eq!(
            k.keep_companion,
            Some((
                PathBuf::from("/home/asha/Downloads/.ia-portal"),
                PathBuf::from("/home/asha/.local/share/indiansassist/.ia-portal")
            ))
        );
        assert!(plan_is_contained(&k, main));

        // The kept pair's directory holds both: no extra entries.
        let kept = plan_pair(&env(), Path::new(KEPT), false);
        assert_eq!(kept.companion, None);
        assert!(kept
            .remove_dirs
            .contains(&PathBuf::from("/home/asha/.local/share/indiansassist")));

        // A companion anywhere else is refused.
        let mut bad = plan_pair(&env(), main, false);
        bad.companion = Some("/home/asha/.ia-portal".into());
        assert!(!plan_is_contained(&bad, main));
        let mut bad = plan_pair(&env(), main, true);
        bad.keep_companion = Some((companion_of(main), "/usr/bin/.ia-portal".into()));
        assert!(!plan_is_contained(&bad, main));
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

/// Phase F rule 3.4e: the Keep plans applied to files under a temporary XDG root (never the
/// built binary, never the user's real directories).
#[cfg(all(test, target_os = "linux", feature = "linux-os"))]
mod applied {
    use super::super::os::apply_self_delete;
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ia-keep-{tag}-{}-{}",
            std::process::id(),
            ia_core::rnd::hex(4)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn env_in(root: &Path) -> XdgEnv {
        XdgEnv {
            home: Some(root.join("home")),
            data_home: Some(root.join("data")),
            config_home: Some(root.join("config")),
            state_home: Some(root.join("state")),
            runtime_dir: Some(root.join("runtime")),
        }
    }

    fn working_set(env: &XdgEnv) {
        fs::create_dir_all(paths::runtime_dir(env).unwrap().join("run")).unwrap();
        fs::create_dir_all(paths::state_dir(env).unwrap()).unwrap();
        fs::write(paths::log_file(env).unwrap(), b"log").unwrap();
    }

    #[test]
    fn keep_copies_the_binary_keeps_the_handler_and_clears_the_working_set() {
        let root = temp_root("keep");
        let env = env_in(&root);
        let dl = root.join("home/Downloads");
        fs::create_dir_all(&dl).unwrap();
        let exe = dl.join("IndiansAssist-in-mum-4821-9365-7715");
        fs::write(&exe, b"\x7fELF fake agent").unwrap();
        working_set(&env);

        let report = apply_self_delete(&plan(&env, &exe, true), &env, &exe).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        let kept = paths::kept_binary(&env).unwrap();
        assert_eq!(report.kept_copy.as_deref(), Some(kept.as_path()));
        assert_eq!(fs::read(&kept).unwrap(), b"\x7fELF fake agent");
        assert_eq!(
            fs::metadata(&kept).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(exe.exists(), "Keep unlinks nothing of the user's");
        assert!(!paths::runtime_dir(&env).unwrap().exists());
        assert!(!paths::state_dir(&env).unwrap().exists());
        let desktop = fs::read_to_string(paths::desktop_file(&env).unwrap()).unwrap();
        assert!(
            desktop.contains(&*kept.to_string_lossy()),
            "the handler points at the copy"
        );

        // The kept copy runs again (rule 3.4d): Keep is implied, nothing is copied onto itself,
        // only its runtime and log dirs go.
        working_set(&env);
        assert!(is_kept_copy(&env, &kept));
        let report = apply_self_delete(&plan(&env, &kept, true), &env, &kept).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.kept_copy, None);
        assert_eq!(fs::read(&kept).unwrap(), b"\x7fELF fake agent");
        assert!(paths::desktop_file(&env).unwrap().exists());
        assert!(!paths::state_dir(&env).unwrap().exists());

        // "Remove IndiansAssist from this computer after this session": the kept copy goes.
        working_set(&env);
        let report = apply_self_delete(&plan(&env, &kept, false), &env, &kept).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert!(!kept.exists());
        assert!(!kept.parent().unwrap().exists());
        assert!(!paths::desktop_file(&env).unwrap().exists());
        assert!(!paths::state_dir(&env).unwrap().exists());
        assert!(
            exe.exists(),
            "the downloaded file is not the kept copy's to remove"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// Phase F §9.5: the pair under a temporary root: Keep copies both, the clean exit removes
    /// both and the archive; another user's or a non-regular `.ia-portal` is left alone.
    #[test]
    fn the_pair_is_kept_and_removed_together() {
        let root = temp_root("pair");
        let env = env_in(&root);
        let dl = root.join("home/Downloads");
        fs::create_dir_all(&dl).unwrap();
        let main = dl.join("IndiansAssist-in-mum-4821-9365-7715");
        fs::write(&main, b"\x7fELF x11").unwrap();
        fs::write(companion_of(&main), b"\x7fELF portal").unwrap();
        fs::write(dl.join("IndiansAssist-in-mum-4821-9365-7715.tar.gz"), b"gz").unwrap();
        working_set(&env);

        let report = apply_self_delete(&plan_pair(&env, &main, true), &env, &main).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        let kept = paths::kept_binary(&env).unwrap();
        assert_eq!(fs::read(companion_of(&kept)).unwrap(), b"\x7fELF portal");
        assert_eq!(
            fs::metadata(companion_of(&kept))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert!(main.exists() && companion_of(&main).exists());

        working_set(&env);
        let report = apply_self_delete(&plan_pair(&env, &main, false), &env, &main).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert!(!main.exists());
        assert!(!companion_of(&main).exists());
        assert!(!dl
            .join("IndiansAssist-in-mum-4821-9365-7715.tar.gz")
            .exists());

        // A `.ia-portal` that is a directory is not the companion: it stays.
        fs::write(&main, b"\x7fELF x11").unwrap();
        fs::create_dir_all(companion_of(&main)).unwrap();
        let report = apply_self_delete(&plan_pair(&env, &main, false), &env, &main).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert!(companion_of(&main).is_dir());
        let _ = fs::remove_dir_all(&root);
    }
}
