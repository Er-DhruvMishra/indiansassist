//! §10 D1/D2 user-instance self-delete: in-process cleanup plus the detached cleanup stub.

#[allow(unused_imports)]
use super::*;

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
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
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
