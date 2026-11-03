//! §10 D1/D2 user-instance self-delete: in-process cleanup plus the detached cleanup stub; and
//! Phase F §3.4 Keep (C §10 D5): the exit decision, the Windows Keep applier (pure file work
//! over an injected `%LOCALAPPDATA%`, so it is tested against a temporary directory), the Linux
//! Keep through `ia_platform::linux::selfdel::plan(.., true)`, the `ctl.event keep` frame and the
//! one-time `/join?kept=1` page.

#[allow(unused_imports)]
use super::*;

use ia_core::teardown::ProcessRole;
use std::path::{Path, PathBuf};

/// What this process does to files at a clean exit (Phase F §3.4, C §10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExitAction {
    /// No file change at all: `--no-self-delete` (rule 3.4e), a Phase D worker (its files belong
    /// to the installed package), or the handed-over user instance (D3: the child decides).
    Nothing,
    /// The D1/D2/D3 self-delete.
    SelfDelete,
    /// Keep (D5, rule 3.4c): copy to the Keep location, keep the handler, remove the logs and
    /// the run directory. `first` = newly kept now (open `/join?kept=1` once); `false` = a kept
    /// copy running again (rule 3.4d: logs and run directory only).
    Keep { first: bool },
}

/// The exit decision (Phase F §3.4). Pure: `choice` is the Desk's Keep choice as the UI left it.
pub(super) fn exit_action(
    no_self_delete: bool,
    worker: bool,
    role: ProcessRole,
    choice: ia_ui::model::KeepChoice,
) -> ExitAction {
    if no_self_delete || worker || !deletes_on_exit(role, false) {
        return ExitAction::Nothing;
    }
    if choice.running_kept {
        return if choice.remove_after {
            ExitAction::SelfDelete
        } else {
            ExitAction::Keep { first: false }
        };
    }
    if choice.keep {
        ExitAction::Keep { first: true }
    } else {
        ExitAction::SelfDelete
    }
}

/// Rule 3.4b: the `ctl.event keep` the agent sends each time the Desk's choice changes.
pub(super) fn keep_event(kept: bool, ts: i64) -> Value {
    json!({ "t": "ctl.event", "kind": "keep", "kept": kept, "ts": ts })
}

/// C L3: the page the agent opens once after Keep, `<origin>/join?kept=1`. The web app is served
/// from the region's origin (the one the agent joined through); only an http(s) origin with no
/// path, query or credentials is used.
#[cfg_attr(
    not(any(
        windows,
        all(target_os = "linux", feature = "linux-os"),
        target_os = "macos"
    )),
    allow(dead_code)
)]
pub(super) fn kept_page_url(origin: &str) -> Option<String> {
    let o = origin.trim_end_matches('/');
    let rest = o
        .strip_prefix("https://")
        .or_else(|| o.strip_prefix("http://"))?;
    let ok = !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'));
    ok.then(|| format!("{o}/join?kept=1"))
}

/// The Windows Keep location under `%LOCALAPPDATA%` (rule 3.4c).
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) const WIN_KEPT_EXE: &str = "IndiansAssist.exe";

/// What the Windows Keep applier does (rule 3.4c), derived from an injected `%LOCALAPPDATA%`.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WinKeepPlan {
    /// `%LOCALAPPDATA%\IndiansAssist`: the working directory (logs, `run\`) and the copy's home.
    pub work_dir: PathBuf,
    /// The running exe.
    pub from: PathBuf,
    /// `%LOCALAPPDATA%\IndiansAssist\IndiansAssist.exe`.
    pub copy_to: PathBuf,
}

/// The Windows Keep plan for `exe` under `local_app_data`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn win_keep_plan(local_app_data: &Path, exe: &Path) -> WinKeepPlan {
    let work_dir = local_app_data.join("IndiansAssist");
    WinKeepPlan {
        copy_to: work_dir.join(WIN_KEPT_EXE),
        work_dir,
        from: exe.to_path_buf(),
    }
}

/// Whether two Windows paths name the same file (case-insensitive, either separator).
#[cfg_attr(not(windows), allow(dead_code))]
fn same_windows_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
    norm(a) == norm(b)
}

/// Whether `exe` is the Windows Keep location (rule 3.4d).
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn is_win_kept_copy(local_app_data: &Path, exe: &Path) -> bool {
    same_windows_path(exe, &win_keep_plan(local_app_data, exe).copy_to)
}

/// What [`apply_win_keep`] did.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct WinKeepReport {
    /// The copy was written (false: this process is the copy, rule 3.4d).
    pub copied: bool,
    /// An older kept copy was replaced (through a temporary file and a rename).
    pub replaced: bool,
    /// Working-set entries removed (logs, `run\`, stale temporaries).
    pub removed: Vec<PathBuf>,
    pub failures: Vec<String>,
}

/// Rule 3.4c on Windows: copy the running exe to the Keep location with `CREATE_NEW` semantics
/// (an older kept copy is replaced only by writing a new temporary file and renaming it over the
/// old one, so the location never holds a half-written exe), then remove everything else in the
/// working directory (the logs and `run\`) but not the copy. A kept copy running again copies
/// nothing and only clears the working set. Plain file work: tested against a temporary root.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn apply_win_keep(plan: &WinKeepPlan) -> std::io::Result<WinKeepReport> {
    use std::io::Write;
    let mut report = WinKeepReport::default();
    std::fs::create_dir_all(&plan.work_dir)?;
    let copy_name = plan
        .copy_to
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !same_windows_path(&plan.from, &plan.copy_to) {
        let bytes = std::fs::read(&plan.from)?;
        let fresh = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&plan.copy_to);
        match fresh {
            Ok(mut f) => {
                f.write_all(&bytes)?;
                f.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let tmp = plan
                    .work_dir
                    .join(format!("{WIN_KEPT_EXE}.{:016x}.tmp", rand::random::<u64>()));
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&tmp)?;
                f.write_all(&bytes)?;
                f.sync_all()?;
                drop(f);
                if let Err(e) = std::fs::rename(&tmp, &plan.copy_to) {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(e);
                }
                report.replaced = true;
            }
            Err(e) => return Err(e),
        }
        report.copied = true;
    }
    for entry in std::fs::read_dir(&plan.work_dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if entry.file_name().to_string_lossy().to_lowercase() == copy_name {
            continue;
        }
        let res = if entry.file_type().is_ok_and(|t| t.is_dir()) {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        match res {
            Ok(()) => report.removed.push(path),
            Err(e) => report.failures.push(format!("{}: {e}", path.display())),
        }
    }
    Ok(report)
}

/// Whether this process runs from the Keep location (rule 3.4d).
pub(super) fn running_kept_copy() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").is_some_and(|l| is_win_kept_copy(Path::new(&l), &exe))
    }
    #[cfg(all(target_os = "linux", feature = "linux-os"))]
    {
        let env = ia_platform::linux::XdgEnv::from_process();
        ia_platform::linux::selfdel::is_kept_copy(&env, &exe)
    }
    // apple-owned: begin
    // Phase F §3.4d (macOS): the bundle this runs from is `~/Applications/IndiansAssist.app`.
    #[cfg(target_os = "macos")]
    {
        let env = ia_platform::macos::MacEnv::from_process();
        ia_platform::macos::selfdel::is_kept_copy(&env, &exe)
    }
    // apple-owned: end
    #[cfg(not(any(
        windows,
        all(target_os = "linux", feature = "linux-os"),
        target_os = "macos"
    )))]
    {
        let _ = exe;
        false
    }
}

/// Rule 3.4c (Windows): apply Keep to the real `%LOCALAPPDATA%`, point the HKCU handler at the
/// copy, and open `/join?kept=1` once when newly kept. Never reached by an automated run
/// (`--no-self-delete` means no file change at all, rule 3.4e).
#[cfg(windows)]
pub(super) fn perform_keep(first: bool) {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        tracing::warn!("keep: no %LOCALAPPDATA%; nothing kept");
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let plan = win_keep_plan(Path::new(&local), &exe);
    match apply_win_keep(&plan) {
        Ok(r) => tracing::info!(
            copied = r.copied,
            replaced = r.replaced,
            removed = r.removed.len(),
            failures = ?r.failures,
            "keep: done"
        ),
        Err(e) => {
            tracing::warn!("keep: the copy could not be made ({e})");
            return;
        }
    }
    #[cfg(feature = "winapi")]
    {
        use ia_platform::traits::ProtocolHandler;
        if let Err(e) =
            ia_platform::win::WinProtocolHandler.register(&plan.copy_to.to_string_lossy())
        {
            tracing::warn!("keep: the link handler could not be pointed at the copy: {e}");
        }
    }
    if first {
        open_kept_page();
    }
}

/// Rule 3.4c (Linux): `selfdel::plan(.., true)` (copy to `$XDG_DATA_HOME/indiansassist/
/// IndiansAssist`, mode 0755, keep the handler), then open `/join?kept=1` once when newly kept.
#[cfg(all(target_os = "linux", feature = "linux-os"))]
pub(super) fn perform_keep(first: bool) {
    use ia_platform::linux::{os, selfdel, XdgEnv};
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let env = XdgEnv::from_process();
    let plan = selfdel::plan(&env, &exe, true);
    match os::apply_self_delete(&plan, &env, &exe) {
        Ok(r) => tracing::info!(kept = ?r.kept_copy, failures = ?r.failures, "keep: done"),
        Err(e) => {
            tracing::warn!("keep: not applied ({e})");
            return;
        }
    }
    if first {
        open_kept_page();
    }
}

// apple-owned: begin
/// Rule 3.4c (macOS): `selfdel::plan(.., true)` copies the bundle to
/// `~/Applications/IndiansAssist.app` (replacing an older kept app, no administrator needed) and
/// removes the logs and state; a kept app running again only clears those (rule 3.4d). Then
/// `/join?kept=1` opens once when newly kept. Never reached by an automated run (rule 3.4e).
#[cfg(target_os = "macos")]
pub(super) fn perform_keep(first: bool) {
    use ia_platform::macos::{os, selfdel, MacEnv};
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let env = MacEnv::from_process();
    let plan = selfdel::plan(&env, &exe, true);
    match os::apply_self_delete(&plan, &env, &exe) {
        Ok(r) => tracing::info!(
            kept = ?r.kept_copy,
            removed = r.removed.len(),
            failures = ?r.failures,
            "keep: done"
        ),
        Err(e) => {
            tracing::warn!("keep: not applied ({e})");
            return;
        }
    }
    if first {
        open_kept_page();
    }
}
// apple-owned: end

#[cfg(not(any(
    windows,
    all(target_os = "linux", feature = "linux-os"),
    target_os = "macos"
)))]
pub(super) fn perform_keep(_first: bool) {}

/// C L3: open `<origin>/join?kept=1` once in the default browser (`ShellExecuteExW` / `xdg-open`
/// / `open`).
#[cfg(any(
    windows,
    all(target_os = "linux", feature = "linux-os"),
    target_os = "macos"
))]
fn open_kept_page() {
    let Some(url) = crate::session::joined().and_then(|j| kept_page_url(&j.api_origin)) else {
        tracing::info!("keep: no web origin to open");
        return;
    };
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};
        let wide = |s: &str| -> Vec<u16> {
            std::ffi::OsStr::new(s)
                .encode_wide()
                .chain(Some(0))
                .collect()
        };
        let verb = wide("open");
        let file = wide(&url);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            nShow: 1, // SW_SHOWNORMAL
            ..Default::default()
        };
        // SAFETY: both strings are NUL-terminated and outlive the call.
        match unsafe { ShellExecuteExW(&mut info) } {
            Ok(()) => tracing::info!("keep: opened the kept page"),
            Err(e) => tracing::warn!("keep: the kept page could not be opened: {e}"),
        }
    }
    #[cfg(all(target_os = "linux", feature = "linux-os"))]
    match std::process::Command::new("xdg-open")
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(_) => tracing::info!("keep: opened the kept page"),
        Err(e) => tracing::warn!("keep: xdg-open failed: {e}"),
    }
    // apple-owned: begin
    // Phase F §3.4 (macOS): Launch Services opens the http(s) URL in the default browser; the URL
    // is one argument (no shell), checked by `kept_page_url`.
    #[cfg(target_os = "macos")]
    match std::process::Command::new("/usr/bin/open")
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(_) => tracing::info!("keep: opened the kept page"),
        Err(e) => tracing::warn!("keep: open failed: {e}"),
    }
    // apple-owned: end
}

/// §10 D1/D2 user-instance self-delete: delete everything the agent can in-process (the
/// working dir, the sidecar and the HKCU handler), then write the cleanup stub with `CREATE_NEW`
/// at `%TEMP%\ia-cleanup-<32 hex>.cmd` (after checking `%TEMP%` canonicalises under
/// `%USERPROFILE%`) and spawn `cmd.exe /c <stub> <pid> <exe>` detached + breakaway from the full
/// System32 path. Best effort; failures are logged (the exe simply remains). Never run in an
/// automated test (the e2e passes `--no-self-delete`, so this is not reached there).
#[cfg(windows)]
pub(super) fn perform_self_delete() {
    use std::os::windows::process::CommandExt;

    // D1/D2: remove what the running process can before scheduling the exe delete.
    cleanup_working_set();

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = exe.to_string_lossy().to_string();
    let pid = std::process::id();

    // D2: the stub is only written when %TEMP% resolves under %USERPROFILE% (no stub from a
    // redirected temp an attacker could point elsewhere).
    let Some(profile) = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from) else {
        tracing::warn!("self-delete: no %USERPROFILE%; delete {exe} by hand");
        return;
    };
    let temp = std::env::temp_dir();
    let (ct, cp) = (
        temp.canonicalize().unwrap_or_else(|_| temp.clone()),
        profile.canonicalize().unwrap_or(profile),
    );
    if !ia_platform::selfdelete::is_under(&ct, &cp) {
        tracing::warn!("self-delete: %TEMP% is not under %USERPROFILE%; delete {exe} by hand");
        return;
    }

    let hex = format!(
        "{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    );
    let stub = temp.join(ia_platform::selfdelete::cleanup_stub_name(&hex));
    let cs =
        match ia_platform::selfdelete::generate_cleanup_stub(&stub.to_string_lossy(), pid, &exe) {
            Ok(cs) => cs,
            Err(bad) => {
                tracing::warn!("self-delete: path failed the allow-list; delete by hand: {bad}");
                return;
            }
        };
    // CREATE_NEW exclusive: refuse to reuse an existing path (no stub squatting).
    if let Err(e) = write_new_exclusive(&stub, cs.script_text.as_bytes()) {
        tracing::warn!("self-delete: could not create the stub ({e}); delete {exe} by hand");
        return;
    }
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let cmd_exe = system32_dir().join("cmd.exe");
    match std::process::Command::new(cmd_exe)
        .arg("/c")
        .arg(&stub)
        .arg(pid.to_string())
        .arg(&exe)
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
    {
        Ok(_) => tracing::info!("self-delete: cleanup stub spawned {}", stub.display()),
        Err(e) => tracing::warn!("self-delete: could not spawn the stub: {e}"),
    }
}

/// Phase E §7.7 self-delete on Linux: remove the working dirs, the sidecar and the deep-link
/// handler files (restoring the previous scheme default), the extracted archive beside the binary
/// when it is the user's own regular file of at most 64 MiB, and finally `unlink` the running
/// binary (Linux allows it; no helper stub). Received files are kept. Never run by an automated
/// test with the built binary (the e2e passes `--no-self-delete`); the plan and its application
/// are tested against a temporary XDG root in `ia_platform::linux`.
#[cfg(all(target_os = "linux", feature = "linux-os"))]
pub(super) fn perform_self_delete() {
    use ia_platform::linux::{os, selfdel, XdgEnv};
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let env = XdgEnv::from_process();
    let plan = selfdel::plan(&env, &exe, false);
    match os::apply_self_delete(&plan, &env, &exe) {
        Ok(r) if r.failures.is_empty() => {
            tracing::info!(removed = r.removed.len(), "self-delete: done")
        }
        Ok(r) => tracing::warn!(failures = ?r.failures, "self-delete: partly done"),
        Err(e) => tracing::warn!(
            "self-delete: not run ({e}); delete {} by hand",
            exe.display()
        ),
    }
}

#[cfg(not(any(windows, all(target_os = "linux", feature = "linux-os"))))]
pub(super) fn perform_self_delete() {}

/// Delete the working directory (`%LOCALAPPDATA%\IndiansAssist\`), the `.iaconfig` sidecar next
/// to the exe, and the HKCU protocol-handler key — everything the running process can remove
/// itself (§10 D1/D2). Received files in `Downloads\IndiansAssist\` are kept.
#[cfg(windows)]
pub(super) fn cleanup_working_set() {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let dir = std::path::PathBuf::from(local).join("IndiansAssist");
        // Entry by entry, so one file that cannot go yet (the running kept copy, rule 3.4d,
        // which the cleanup stub deletes after exit) does not stop the rest.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                let _ = if e.file_type().is_ok_and(|t| t.is_dir()) {
                    std::fs::remove_dir_all(&p)
                } else {
                    std::fs::remove_file(&p)
                };
            }
        }
        let _ = std::fs::remove_dir(&dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        let sidecar = exe.with_extension("iaconfig");
        if sidecar.exists() {
            let _ = std::fs::remove_file(&sidecar);
        }
    }
    #[cfg(feature = "winapi")]
    {
        use ia_platform::traits::ProtocolHandler;
        let _ = ia_platform::win::WinProtocolHandler.unregister();
    }
}

/// Create `path` with `CREATE_NEW` (fails if it already exists) and write `bytes` (§10 D2).
#[cfg(windows)]
pub(super) fn write_new_exclusive(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.write_all(bytes)
}

/// `%SystemRoot%\System32` (full path for the detached stub spawn, §10 D2).
#[cfg(windows)]
pub(super) fn system32_dir() -> std::path::PathBuf {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    root.join("System32")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ia_ui::model::KeepChoice;

    fn choice(running_kept: bool, keep: bool, remove_after: bool) -> KeepChoice {
        KeepChoice {
            available: true,
            running_kept,
            keep,
            remove_after,
        }
    }

    #[test]
    fn no_self_delete_means_no_file_change_at_all() {
        for c in [
            choice(false, false, false),
            choice(false, true, false),
            choice(true, false, false),
            choice(true, false, true),
        ] {
            assert_eq!(
                exit_action(true, false, ProcessRole::UserStandalone, c),
                ExitAction::Nothing
            );
        }
    }

    #[test]
    fn the_exit_decision() {
        let u = ProcessRole::UserStandalone;
        assert_eq!(
            exit_action(false, false, u, choice(false, false, false)),
            ExitAction::SelfDelete
        );
        assert_eq!(
            exit_action(false, false, u, choice(false, true, false)),
            ExitAction::Keep { first: true }
        );
        // A kept copy never deletes itself unless the Desk chose removal (rule 3.4d).
        assert_eq!(
            exit_action(false, false, u, choice(true, false, false)),
            ExitAction::Keep { first: false }
        );
        assert_eq!(
            exit_action(false, false, u, choice(true, false, true)),
            ExitAction::SelfDelete
        );
        // D3: the handed-over user instance changes nothing; the elevated child decides.
        assert_eq!(
            exit_action(
                false,
                false,
                ProcessRole::UserHandedOver,
                choice(false, true, false)
            ),
            ExitAction::Nothing
        );
        assert_eq!(
            exit_action(
                false,
                false,
                ProcessRole::ElevatedChild,
                choice(false, true, false)
            ),
            ExitAction::Keep { first: true }
        );
        // A Phase D worker's files belong to the installed package.
        assert_eq!(
            exit_action(false, true, u, choice(false, false, false)),
            ExitAction::Nothing
        );
    }

    #[test]
    fn the_keep_event_and_the_kept_page() {
        assert_eq!(
            keep_event(true, 42),
            json!({ "t": "ctl.event", "kind": "keep", "kept": true, "ts": 42 })
        );
        assert_eq!(
            kept_page_url("https://in.indiansassist.com/").as_deref(),
            Some("https://in.indiansassist.com/join?kept=1")
        );
        assert_eq!(
            kept_page_url("http://localhost:4000").as_deref(),
            Some("http://localhost:4000/join?kept=1")
        );
        assert_eq!(kept_page_url("file:///etc/passwd"), None);
        assert_eq!(kept_page_url("https://a.example/x?y"), None);
        assert_eq!(kept_page_url("https://user@a.example"), None);
        assert_eq!(kept_page_url("https://"), None);
    }

    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ia-keep-win-{tag}-{}-{:08x}",
            std::process::id(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Rule 3.4e: the Windows applier against a temporary `%LOCALAPPDATA%` (never the built
    /// binary): the copy is made, the logs and `run\` go, the copy stays; a kept copy running
    /// again copies nothing; a newer download replaces an older copy through a rename.
    #[test]
    fn the_windows_keep_applier_against_a_temporary_root() {
        let root = temp_root("apply");
        let local = root.join("Local");
        let downloads = root.join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let exe = downloads.join("IndiansAssist-in-mum-4821-9365-7715.exe");
        std::fs::write(&exe, b"MZ fake agent v1").unwrap();
        let work = local.join("IndiansAssist");
        std::fs::create_dir_all(work.join("run")).unwrap();
        std::fs::write(work.join("run").join("pb-1.ps1"), b"x").unwrap();
        std::fs::write(work.join("agent.log"), b"log").unwrap();

        let plan = win_keep_plan(&local, &exe);
        assert_eq!(plan.copy_to, work.join("IndiansAssist.exe"));
        assert!(!is_win_kept_copy(&local, &exe));
        let r = apply_win_keep(&plan).unwrap();
        assert!(r.copied && !r.replaced);
        assert!(r.failures.is_empty(), "{:?}", r.failures);
        assert_eq!(std::fs::read(&plan.copy_to).unwrap(), b"MZ fake agent v1");
        assert!(!work.join("run").exists());
        assert!(!work.join("agent.log").exists());
        assert!(exe.exists(), "the download itself is left as it was");

        // The kept copy runs again (rule 3.4d): nothing is copied onto itself.
        assert!(is_win_kept_copy(&local, &plan.copy_to));
        std::fs::create_dir_all(work.join("run")).unwrap();
        std::fs::write(work.join("agent.log"), b"log 2").unwrap();
        let again = apply_win_keep(&win_keep_plan(&local, &plan.copy_to)).unwrap();
        assert!(!again.copied);
        assert_eq!(std::fs::read(&plan.copy_to).unwrap(), b"MZ fake agent v1");
        assert!(!work.join("run").exists());
        assert!(!work.join("agent.log").exists());

        // A newer download kept later replaces the old copy through a temporary file.
        std::fs::write(&exe, b"MZ fake agent v2").unwrap();
        let r = apply_win_keep(&plan).unwrap();
        assert!(r.copied && r.replaced);
        assert_eq!(std::fs::read(&plan.copy_to).unwrap(), b"MZ fake agent v2");
        let left: Vec<_> = std::fs::read_dir(&work)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            left,
            vec!["IndiansAssist.exe".to_string()],
            "no temporary left behind"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_kept_location_is_matched_case_insensitively() {
        let local = Path::new(r"C:\Users\asha\AppData\Local");
        assert!(is_win_kept_copy(
            local,
            Path::new(r"c:\users\ASHA\appdata\local\IndiansAssist\indiansassist.EXE")
        ));
        assert!(!is_win_kept_copy(
            local,
            Path::new(r"C:\Users\asha\Downloads\IndiansAssist-in-mum-1-2-3.exe")
        ));
    }
}
