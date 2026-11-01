//! The Win32 half of the session-0 bridge (§4.2, §5.3), compiled only under the `winapi`
//! feature. It fills in [`crate::desktop::SessionFacts`] and performs what
//! [`crate::desktop::select_desktop`] decided; every rule lives in the pure modules.
//!
//! Two conventions from the C contract carry over:
//!
//! * **§11.3 import table.** `wtsapi32.dll` and `userenv.dll` are not KnownDLLs, so they are
//!   reached through `ia_platform::sys_lib` (System32 only) rather than linked, keeping the
//!   binary's load-time imports to KnownDLLs. `WTSGetActiveConsoleSessionId` is a `kernel32`
//!   export, so it is a plain import.
//! * **No test calls any of this** (§15.2). `CreateProcessAsUser`, `WTSQueryUserToken` and
//!   `SendSAS` need `LocalSystem` and a real console session; they are exercised by the manual
//!   checks in `docs/release.md`.
//!
//! Honest limit, worth stating where it is implemented rather than only in the contract:
//! `GetLastInputInfo` is per-session, so a service in session 0 cannot read it. The service
//! reports `idleSec: null` (which §3.4 allows) and the number is filled in by a live worker,
//! which does run in the user's session. The fleet view shows it; no policy decision uses it.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID, WAIT_OBJECT_0};
use windows::Win32::Security::{
    DuplicateTokenEx, GetTokenInformation, LookupPrivilegeValueW, SecurityIdentification,
    TokenPrimary, TokenUser, TOKEN_ADJUST_PRIVILEGES, TOKEN_ALL_ACCESS, TOKEN_PRIVILEGES,
    TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTSINFOEXW, WTS_CONNECTSTATE_CLASS, WTS_CURRENT_SERVER_HANDLE,
    WTS_INFO_CLASS,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, OpenProcess, TerminateProcess, WaitForSingleObject,
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, STARTUPINFOW,
};

use ia_core::fleet::InteractiveState;
use ia_platform::{DesktopBridge, DesktopError, DesktopTarget, LaunchedWorker};

use crate::desktop::{derive_interactive, SessionFacts};

/// `WTS_INFO_CLASS::WTSSessionInfoEx`.
const WTS_SESSION_INFO_EX: i32 = 25;
/// `WTS_SESSIONSTATE_LOCK` / `WTS_SESSIONSTATE_UNLOCK` (Windows 8 and later; Phase D targets 11).
const WTS_SESSIONSTATE_LOCK: i32 = 0;
/// `WTSActive` of `WTS_CONNECTSTATE_CLASS`.
const WTS_ACTIVE: i32 = 0;
/// No active console session (`WTSGetActiveConsoleSessionId` on a fast-user-switch transition).
const NO_SESSION: u32 = 0xFFFF_FFFF;

type FnQuerySessionInformationW =
    unsafe extern "system" fn(HANDLE, u32, i32, *mut PWSTR, *mut u32) -> i32;
type FnFreeMemory = unsafe extern "system" fn(*const c_void);
type FnQueryUserToken = unsafe extern "system" fn(u32, *mut HANDLE) -> i32;
type FnCreateEnvironmentBlock = unsafe extern "system" fn(*mut *mut c_void, HANDLE, i32) -> i32;
type FnDestroyEnvironmentBlock = unsafe extern "system" fn(*const c_void) -> i32;

struct LateBound {
    query_session_information: Option<FnQuerySessionInformationW>,
    free_memory: Option<FnFreeMemory>,
    query_user_token: Option<FnQueryUserToken>,
    create_environment_block: Option<FnCreateEnvironmentBlock>,
    destroy_environment_block: Option<FnDestroyEnvironmentBlock>,
    // The libraries stay loaded for the life of the process.
    _wts: Option<ia_platform::win::SysLib>,
    _userenv: Option<ia_platform::win::SysLib>,
}

fn late() -> &'static LateBound {
    static LATE: OnceLock<LateBound> = OnceLock::new();
    LATE.get_or_init(|| {
        let wts = ia_platform::sys_lib("wtsapi32.dll").ok();
        let userenv = ia_platform::sys_lib("userenv.dll").ok();
        // SAFETY: each cast matches the documented signature of the named export.
        unsafe {
            LateBound {
                query_session_information: wts
                    .as_ref()
                    .and_then(|l| l.proc("WTSQuerySessionInformationW"))
                    .map(|p| std::mem::transmute::<*const c_void, FnQuerySessionInformationW>(p)),
                free_memory: wts
                    .as_ref()
                    .and_then(|l| l.proc("WTSFreeMemory"))
                    .map(|p| std::mem::transmute::<*const c_void, FnFreeMemory>(p)),
                query_user_token: wts
                    .as_ref()
                    .and_then(|l| l.proc("WTSQueryUserToken"))
                    .map(|p| std::mem::transmute::<*const c_void, FnQueryUserToken>(p)),
                create_environment_block: userenv
                    .as_ref()
                    .and_then(|l| l.proc("CreateEnvironmentBlock"))
                    .map(|p| std::mem::transmute::<*const c_void, FnCreateEnvironmentBlock>(p)),
                destroy_environment_block: userenv
                    .as_ref()
                    .and_then(|l| l.proc("DestroyEnvironmentBlock"))
                    .map(|p| std::mem::transmute::<*const c_void, FnDestroyEnvironmentBlock>(p)),
                _wts: wts,
                _userenv: userenv,
            }
        }
    })
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: the handle is owned and unused after drop.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

/// `WTSGetActiveConsoleSessionId`, or `None` when there is no console session.
pub fn active_console_session_id() -> Option<u32> {
    // SAFETY: a kernel32 export with no arguments.
    let id = unsafe { windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId() };
    (id != NO_SESSION).then_some(id)
}

/// The console session's `WTSINFOEXW` lock and connect state.
fn session_states(session_id: u32) -> Option<(bool, bool)> {
    let f = late().query_session_information?;
    let free = late().free_memory?;
    // SAFETY: the buffer is allocated by WTS and freed with WTSFreeMemory; the size is
    // checked before the struct is read.
    unsafe {
        let mut buf = PWSTR::null();
        let mut bytes = 0u32;
        let ok = f(
            WTS_CURRENT_SERVER_HANDLE,
            session_id,
            WTS_SESSION_INFO_EX,
            &mut buf,
            &mut bytes,
        );
        if ok == 0 || buf.is_null() || (bytes as usize) < std::mem::size_of::<WTSINFOEXW>() {
            if !buf.is_null() {
                free(buf.0 as *const c_void);
            }
            return None;
        }
        let info = &*(buf.0 as *const WTSINFOEXW);
        let level1 = &info.Data.WTSInfoExLevel1;
        let locked = level1.SessionFlags == WTS_SESSIONSTATE_LOCK;
        let connected = level1.SessionState == WTS_CONNECTSTATE_CLASS(WTS_ACTIVE);
        free(buf.0 as *const c_void);
        Some((locked, connected))
    }
}

/// Whether a user is logged on to `session_id` (a user token can be obtained for it). The call
/// needs `SE_TCB_NAME`, which `LocalSystem` has; from any other account it fails and the
/// answer is "cannot tell", which [`read_facts`] treats as nobody logged on.
fn has_user_token(session_id: u32) -> bool {
    let Some(f) = late().query_user_token else {
        return false;
    };
    // SAFETY: the out handle is closed immediately.
    unsafe {
        let mut h = HANDLE::default();
        if f(session_id, &mut h) == 0 {
            return false;
        }
        let _ = CloseHandle(h);
        true
    }
}

/// The name of the current input desktop (`Default`, `Winlogon`, `Screen-saver`), or `None`
/// when it cannot be opened (which happens when the secure desktop is up and this process
/// lacks the right, so the caller treats `None` as "a desktop we are not on").
pub fn input_desktop_name() -> Option<String> {
    // SAFETY: the desktop handle is closed; the buffer is sized and its length passed.
    unsafe {
        let desk = OpenInputDesktop(
            windows::Win32::System::StationsAndDesktops::DESKTOP_CONTROL_FLAGS(0),
            false,
            windows::Win32::System::StationsAndDesktops::DESKTOP_READOBJECTS,
        )
        .ok()?;
        let mut buf = [0u16; 256];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(desk.0),
            UOI_NAME,
            Some(buf.as_mut_ptr() as *mut c_void),
            (buf.len() * 2) as u32,
            Some(&mut needed),
        );
        let _ = CloseDesktop(desk);
        ok.ok()?;
        let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]))
    }
}

/// Read the §5.3 facts from the machine.
pub fn read_facts() -> SessionFacts {
    let console = active_console_session_id();
    let (locked, connected) = console.and_then(session_states).unwrap_or((false, true));
    let logged_on = console.map(has_user_token).unwrap_or(false);
    let secure_desktop_input = input_desktop_name()
        .map(|n| !n.eq_ignore_ascii_case("Default"))
        .unwrap_or(true);
    SessionFacts {
        console_session_id: console,
        logged_on,
        locked,
        connected,
        secure_desktop_input,
        // Per-session; see the module note.
        idle_sec: None,
        at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    }
}

/// The string SID of a token's user (used for the §4.2 pipe DACL).
fn token_user_sid(token: HANDLE) -> Option<String> {
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    // SAFETY: the buffer is sized by the first call; the returned string is LocalFree'd.
    unsafe {
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut c_void),
            needed,
            &mut needed,
        )
        .ok()?;
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut s = PWSTR::null();
        ConvertSidToStringSidW(tu.User.Sid, &mut s).ok()?;
        let out = s.to_string().ok();
        let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(
            s.0 as *mut c_void,
        ));
        out
    }
}

/// The SID the §4.2 pipe DACL must grant for a worker on `target`: the console user for a
/// user-desktop worker, `SYSTEM` for one on a secure desktop.
pub fn worker_sid_for(target: DesktopTarget) -> String {
    match target {
        DesktopTarget::ConsoleDefault { session_id } => {
            let Some(f) = late().query_user_token else {
                return ia_platform::protocol::SDDL_SYSTEM.to_string();
            };
            // SAFETY: the token is closed by `Owned`.
            unsafe {
                let mut h = HANDLE::default();
                if f(session_id, &mut h) == 0 {
                    return ia_platform::protocol::SDDL_SYSTEM.to_string();
                }
                let token = Owned(h);
                token_user_sid(token.0)
                    .unwrap_or_else(|| ia_platform::protocol::SDDL_SYSTEM.to_string())
            }
        }
        DesktopTarget::SecureDesktop | DesktopTarget::LogonScreen => {
            ia_platform::protocol::SDDL_SYSTEM.to_string()
        }
    }
}

/// Enables a privilege on this process's token (`SE_TCB_NAME` for `WTSQueryUserToken`,
/// `SE_INCREASE_QUOTA_NAME` and `SE_ASSIGNPRIMARYTOKEN_NAME` for `CreateProcessAsUser`).
/// `LocalSystem` holds all three; the call is a no-op where they are already enabled.
pub fn enable_privilege(name: &str) -> bool {
    use windows::Win32::Security::{AdjustTokenPrivileges, SE_PRIVILEGE_ENABLED};
    use windows::Win32::System::Threading::OpenProcessToken;
    let wname = wide(name);
    // SAFETY: every handle is owned; the privileges struct is a single-entry array.
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
        .is_err()
        {
            return false;
        }
        let token = Owned(token);
        let mut luid = LUID::default();
        if LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(wname.as_ptr()), &mut luid).is_err() {
            return false;
        }
        let mut tp = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            ..Default::default()
        };
        tp.Privileges[0].Luid = luid;
        tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
        AdjustTokenPrivileges(token.0, false, Some(&tp), 0, None, None).is_ok()
    }
}

/// The session-0 bridge: the real [`DesktopBridge`].
pub struct Session0Bridge {
    /// The installed worker image (`%ProgramFiles%\IndiansAssist\ia-desktop.exe`).
    pub worker_image: PathBuf,
    /// Extra arguments every worker gets (`--synthetic-capture` in a test run, nothing in
    /// production).
    pub extra_args: Vec<String>,
}

impl Session0Bridge {
    pub fn new(worker_image: impl Into<PathBuf>) -> Self {
        // `WTSQueryUserToken` and `CreateProcessAsUser` need these; asking once at construction
        // keeps the launch path free of surprises.
        for p in [
            "SeTcbPrivilege",
            "SeIncreaseQuotaPrivilege",
            "SeAssignPrimaryTokenPrivilege",
        ] {
            let _ = enable_privilege(p);
        }
        Self {
            worker_image: worker_image.into(),
            extra_args: Vec::new(),
        }
    }

    fn command_line(&self, pipe_suffix: &str) -> String {
        let mut parts = vec![
            format!("\"{}\"", self.worker_image.display()),
            "--service-pipe".to_string(),
            pipe_suffix.to_string(),
        ];
        parts.extend(self.extra_args.iter().cloned());
        parts.join(" ")
    }
}

impl DesktopBridge for Session0Bridge {
    fn interactive_state(&self) -> Result<InteractiveState, DesktopError> {
        Ok(derive_interactive(&read_facts()))
    }

    fn console_session_id(&self) -> Option<u32> {
        active_console_session_id()
    }

    fn secure_desktop_is_input(&self) -> bool {
        read_facts().secure_desktop_input
    }

    fn launch_worker(
        &self,
        image: &Path,
        pipe_suffix: &str,
        target: DesktopTarget,
    ) -> Result<LaunchedWorker, DesktopError> {
        let session_id = match target {
            DesktopTarget::ConsoleDefault { session_id } => session_id,
            DesktopTarget::SecureDesktop | DesktopTarget::LogonScreen => {
                active_console_session_id().ok_or(DesktopError::NoConsoleSession)?
            }
        };
        let desktop = format!("WinSta0\\{}", target.desktop_name());
        let mut cmdline = wide(&self.command_line(pipe_suffix));
        let mut wdesktop = wide(&desktop);
        let f = late().query_user_token.ok_or(DesktopError::NoUserToken)?;
        // SAFETY: every handle and buffer is owned; `cmdline` is mutable as
        // `CreateProcessAsUserW` requires, and the environment block is destroyed after use.
        unsafe {
            let mut raw = HANDLE::default();
            if f(session_id, &mut raw) == 0 {
                return Err(DesktopError::NoUserToken);
            }
            let user = Owned(raw);
            let mut dup = HANDLE::default();
            DuplicateTokenEx(
                user.0,
                TOKEN_ALL_ACCESS,
                None,
                SecurityIdentification,
                TokenPrimary,
                &mut dup,
            )
            .map_err(|e| DesktopError::Os(e.to_string()))?;
            let dup = Owned(dup);
            let mut env: *mut c_void = std::ptr::null_mut();
            let have_env = late()
                .create_environment_block
                .map(|c| c(&mut env, dup.0, 0) != 0)
                .unwrap_or(false);
            let si = STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOW>() as u32,
                lpDesktop: PWSTR(wdesktop.as_mut_ptr()),
                ..Default::default()
            };
            let mut pi = PROCESS_INFORMATION::default();
            let flags = CREATE_NO_WINDOW
                | if have_env {
                    CREATE_UNICODE_ENVIRONMENT
                } else {
                    PROCESS_CREATION_FLAGS(0)
                };
            let started = CreateProcessAsUserW(
                dup.0,
                PCWSTR::null(),
                PWSTR(cmdline.as_mut_ptr()),
                None,
                None,
                false,
                flags,
                if have_env {
                    Some(env as *const c_void)
                } else {
                    None
                },
                PCWSTR::null(),
                &si,
                &mut pi,
            );
            if have_env {
                if let Some(d) = late().destroy_environment_block {
                    d(env);
                }
            }
            // `wdesktop` and `cmdline` outlive the call above, which is all Win32 needs.
            started.map_err(|e| DesktopError::Launch(e.to_string()))?;
            // The process handle is not kept: the service supervises by pid through the pipe.
            let _ = CloseHandle(pi.hThread);
            let _ = CloseHandle(pi.hProcess);
            Ok(LaunchedWorker {
                pid: pi.dwProcessId,
                session_id,
                target,
                image: image.to_path_buf(),
            })
        }
    }

    fn terminate_worker(&self, worker: &LaunchedWorker) -> Result<(), DesktopError> {
        // SAFETY: the handle is owned; terminating a process we launched is the documented way
        // to end a worker that will not leave.
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, worker.pid) else {
                return Ok(()); // already gone
            };
            let h = Owned(h);
            TerminateProcess(h.0, 1).map_err(|e| DesktopError::Os(e.to_string()))
        }
    }

    fn worker_alive(&self, worker: &LaunchedWorker) -> bool {
        // SAFETY: the handle is owned and closed by `Owned`.
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, worker.pid) else {
                return false;
            };
            let h = Owned(h);
            // A still-running process does not signal; a finished one does.
            WaitForSingleObject(h.0, 0) != WAIT_OBJECT_0
        }
    }
}

/// The session a pid belongs to (the service checks a worker is where it put it).
pub fn session_of_pid(pid: u32) -> Option<u32> {
    // SAFETY: the out parameter is a stack u32.
    unsafe {
        let mut id = 0u32;
        ProcessIdToSessionId(pid, &mut id).ok()?;
        Some(id)
    }
}

/// `WTS_INFO_CLASS` for callers that want to query other classes through the same late binding.
pub fn wts_info_class(value: i32) -> WTS_INFO_CLASS {
    WTS_INFO_CLASS(value)
}
