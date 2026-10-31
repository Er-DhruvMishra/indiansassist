//! The §7.2 parent -> elevated-child hand-over transport (Windows), the building blocks of the
//! §7.3 relaunch: the named pipe `\\.\pipe\IndiansAssist.ho.<32 hex>` the user instance opens
//! **before** launching (one instance, `FILE_FLAG_FIRST_PIPE_INSTANCE | PIPE_REJECT_REMOTE_CLIENTS`,
//! a protected DACL granting only the current user and `BUILTIN\Administrators`), the
//! client-pid / image checks before the blob is written, the child's `SECURITY_IDENTIFICATION`
//! open with the server-pid / image checks, the `FILE_SHARE_READ`-only hold on the parent's own
//! image with its sha256, and the `ShellExecuteExW(runas)` launcher.
//!
//! **Not wired into the serve loop yet**: interactive builds still answer `elevation.request`
//! with `elevation failed` (agent/README.md). Everything here except the `runas` launch is
//! exercised by `tests/hopipe.rs` (which spawns the test binary itself as the "child" with
//! `CreateProcess`, so no UAC prompt is ever raised by an automated run).

/// Why a hand-over transport step failed (each maps to `elevation.failed { error:
/// 'launch_failed' }` on the parent, `image_mismatch` / refusal on the child, §7.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeError {
    /// The pipe could not be created (name taken: `FILE_FLAG_FIRST_PIPE_INSTANCE`).
    Create,
    /// No client within the window (20 s in the flow).
    Timeout,
    /// The connected client is not the launched process (pid) or not our image.
    WrongClient,
    /// The pipe server is not the expected parent (pid) or not our image.
    WrongServer,
    /// Any other I/O failure, or a blob above the size cap.
    Io,
}

/// The largest blob either side accepts (the §7.2 JSON is well under 4 KiB).
pub const BLOB_MAX: usize = 16 * 1024;

/// A fresh, non-secret pipe suffix (32 lower-case hex; the checks, not the name, authenticate).
pub fn new_suffix() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Whether two image paths name the same file (case-insensitive, `\\?\` prefix ignored).
pub fn same_image(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_lowercase()
    };
    !a.is_empty() && norm(a) == norm(b)
}

/// The `--handover-pipe <hex>` suffix is exactly 32 lower-case hex characters.
pub fn valid_suffix(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use super::{same_image, PipeError, BLOB_MAX};
    use std::io;
    use std::path::Path;
    use std::time::{Duration, Instant};

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND,
        ERROR_IO_PENDING, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED,
        GENERIC_READ, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL,
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, OPEN_EXISTING,
        PIPE_ACCESS_OUTBOUND, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
        GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows::Win32::System::Threading::{
        CreateEventW, GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW,
        WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::IO::{CancelIo, GetOverlappedResult, OVERLAPPED};
    use zeroize::Zeroizing;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn pipe_path(suffix: &str) -> String {
        ia_platform::protocol::handover_pipe(suffix)
    }

    /// The full Win32 image path of a process (`QueryFullProcessImageNameW`).
    pub fn process_image(pid: u32) -> Option<String> {
        // SAFETY: the handle is closed; the buffer is sized and its length passed.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = vec![0u16; 32_768];
            let mut len = buf.len() as u32;
            let r = QueryFullProcessImageNameW(
                h,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            );
            let _ = CloseHandle(h);
            r.ok()?;
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    /// This process's own image path.
    pub fn own_image() -> Option<String> {
        // SAFETY: trivially safe.
        process_image(unsafe { GetCurrentProcessId() })
    }

    /// The parent pid of this process (`CreateToolhelp32Snapshot`).
    pub fn parent_pid() -> Option<u32> {
        // SAFETY: the snapshot handle is closed; the entry is sized.
        unsafe {
            let me = GetCurrentProcessId();
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
            let mut e = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut found = None;
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    if e.th32ProcessID == me {
                        found = Some(e.th32ParentProcessID);
                        break;
                    }
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            found
        }
    }

    /// An owned kernel handle closed on drop.
    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                // SAFETY: the handle is owned and not used after drop.
                let _ = unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// The parent's side: one pipe instance waiting for the launched child.
    pub struct HandoverServer {
        pipe: Owned,
        event: Owned,
    }

    // SAFETY: kernel handles are process-wide; the server is used by one thread at a time
    // (it is moved, never shared), so moving it to the thread that waits is sound.
    unsafe impl Send for HandoverServer {}

    impl HandoverServer {
        /// Create the pipe (first and only instance; current user + Administrators; local
        /// clients only). A creation failure aborts the elevation (`launch_failed`).
        pub fn create(suffix: &str) -> Result<Self, PipeError> {
            let sid = crate::pbrun::win::current_user_sid().map_err(|_| PipeError::Create)?;
            let sddl = wide(&format!("D:P(A;;GA;;;{sid})(A;;GA;;;BA)"));
            let name = wide(&pipe_path(suffix));
            // SAFETY: SDDL / name are NUL-terminated; the descriptor is LocalFree'd after the
            // pipe is created (the kernel copies it); every handle is owned.
            unsafe {
                let mut sd = PSECURITY_DESCRIPTOR::default();
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(sddl.as_ptr()),
                    SDDL_REVISION_1,
                    &mut sd,
                    None,
                )
                .map_err(|_| PipeError::Create)?;
                let sa = SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: sd.0,
                    bInheritHandle: false.into(),
                };
                let pipe = CreateNamedPipeW(
                    PCWSTR(name.as_ptr()),
                    PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    BLOB_MAX as u32,
                    0,
                    0,
                    Some(&sa),
                );
                let _ = LocalFree(HLOCAL(sd.0));
                if pipe.is_invalid() || pipe == INVALID_HANDLE_VALUE {
                    return Err(PipeError::Create);
                }
                let pipe = Owned(pipe);
                let event =
                    Owned(CreateEventW(None, true, false, None).map_err(|_| PipeError::Create)?);
                Ok(Self { pipe, event })
            }
        }

        /// Accept exactly one client within `timeout`; it must be `expected_pid` running this
        /// very image, else it is disconnected (`WrongClient`). Then write `blob` and close.
        pub fn serve_once(
            &self,
            expected_pid: u32,
            blob: &[u8],
            timeout: Duration,
        ) -> Result<(), PipeError> {
            if blob.len() > BLOB_MAX {
                return Err(PipeError::Io);
            }
            let mut ov = OVERLAPPED {
                hEvent: self.event.0,
                ..Default::default()
            };
            // SAFETY: the pipe and event are live; `ov` outlives the overlapped operation
            // (it is either complete, waited for, or cancelled before returning).
            unsafe {
                let connected = match ConnectNamedPipe(self.pipe.0, Some(&mut ov)) {
                    Ok(()) => true,
                    Err(_) => {
                        let e = GetLastError();
                        if e == ERROR_PIPE_CONNECTED {
                            true
                        } else if e == ERROR_IO_PENDING {
                            let ms = timeout.as_millis().min(u32::MAX as u128) as u32;
                            if WaitForSingleObject(self.event.0, ms) == WAIT_OBJECT_0 {
                                let mut n = 0u32;
                                GetOverlappedResult(self.pipe.0, &ov, &mut n, false).is_ok()
                            } else {
                                let _ = CancelIo(self.pipe.0);
                                let mut n = 0u32;
                                let _ = GetOverlappedResult(self.pipe.0, &ov, &mut n, true);
                                return Err(PipeError::Timeout);
                            }
                        } else {
                            false
                        }
                    }
                };
                if !connected {
                    return Err(PipeError::Io);
                }
                let mut pid = 0u32;
                let pid_ok = GetNamedPipeClientProcessId(self.pipe.0, &mut pid).is_ok()
                    && pid == expected_pid;
                let image_ok = pid_ok
                    && matches!(
                        (process_image(pid), super::win::own_image()),
                        (Some(a), Some(b)) if same_image(&a, &b)
                    );
                if !image_ok {
                    let _ = DisconnectNamedPipe(self.pipe.0);
                    return Err(PipeError::WrongClient);
                }
                let _ = windows::Win32::System::Threading::ResetEvent(self.event.0);
                let mut wov = OVERLAPPED {
                    hEvent: self.event.0,
                    ..Default::default()
                };
                let mut written = 0u32;
                let w = WriteFile(self.pipe.0, Some(blob), None, Some(&mut wov));
                let ok = match w {
                    Ok(()) => true,
                    Err(_) if GetLastError() == ERROR_IO_PENDING => true,
                    Err(_) => false,
                } && GetOverlappedResult(self.pipe.0, &wov, &mut written, true).is_ok()
                    && written as usize == blob.len();
                let _ = FlushFileBuffers(self.pipe.0);
                let _ = DisconnectNamedPipe(self.pipe.0);
                if ok {
                    Ok(())
                } else {
                    Err(PipeError::Io)
                }
            }
        }
    }

    /// The child's side: open the parent's pipe for identification only, verify the server is
    /// `expected_server_pid` running this image, read the blob (zeroised on drop).
    pub fn read_blob(
        suffix: &str,
        expected_server_pid: u32,
        timeout: Duration,
    ) -> Result<Zeroizing<Vec<u8>>, PipeError> {
        let name = wide(&pipe_path(suffix));
        let deadline = Instant::now() + timeout;
        // SAFETY: the name is NUL-terminated; the handle is owned; the read buffer is sized.
        unsafe {
            let h = loop {
                match CreateFileW(
                    PCWSTR(name.as_ptr()),
                    GENERIC_READ.0,
                    FILE_SHARE_READ,
                    None,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    None,
                ) {
                    Ok(h) => break Owned(h),
                    Err(_) => {
                        let e = GetLastError();
                        if (e == ERROR_PIPE_BUSY || e == ERROR_FILE_NOT_FOUND)
                            && Instant::now() < deadline
                        {
                            std::thread::sleep(Duration::from_millis(50));
                            continue;
                        }
                        return Err(if Instant::now() >= deadline {
                            PipeError::Timeout
                        } else {
                            PipeError::Io
                        });
                    }
                }
            };
            let mut pid = 0u32;
            let pid_ok =
                GetNamedPipeServerProcessId(h.0, &mut pid).is_ok() && pid == expected_server_pid;
            let image_ok = pid_ok
                && matches!(
                    (process_image(pid), own_image()),
                    (Some(a), Some(b)) if same_image(&a, &b)
                );
            if !image_ok {
                return Err(PipeError::WrongServer);
            }
            let mut out = Zeroizing::new(Vec::new());
            let mut buf = Zeroizing::new(vec![0u8; 4096]);
            loop {
                let mut n = 0u32;
                let r = ReadFile(h.0, Some(&mut buf[..]), Some(&mut n), None);
                if n > 0 {
                    out.extend_from_slice(&buf[..n as usize]);
                    if out.len() > BLOB_MAX {
                        return Err(PipeError::Io);
                    }
                }
                match r {
                    Ok(()) if n == 0 => break,
                    Ok(()) => continue,
                    // The server flushed, then closed / disconnected: end of the blob.
                    Err(_)
                        if matches!(
                            GetLastError(),
                            ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED
                        ) =>
                    {
                        break
                    }
                    Err(_) => return Err(PipeError::Io),
                }
            }
            Ok(out)
        }
    }

    /// The parent's hold on its own image through the UAC prompt (§7.3 step 3): opened with
    /// `GENERIC_READ` and `FILE_SHARE_READ` **only**, so nobody can open it for writing (a
    /// swap-by-replace is blocked) while held; `sha256` is computed over that handle.
    pub struct ImageHold {
        file: std::fs::File,
        pub sha256: String,
    }

    impl ImageHold {
        pub fn open(path: &Path) -> io::Result<Self> {
            use sha2::{Digest, Sha256};
            use std::io::Read;
            use std::os::windows::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ.0)
                .open(path)?;
            let mut h = Sha256::new();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = file.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(Self {
                file,
                sha256: hex::encode(h.finalize()),
            })
        }

        /// The held handle (for `WinVerifyTrust` over the same file).
        pub fn file(&self) -> &std::fs::File {
            &self.file
        }
    }

    /// The outcome of `ShellExecuteExW(runas)`.
    #[derive(Debug)]
    pub enum Launch {
        /// The elevated child is starting: its pid and process handle.
        Started { pid: u32, process: HANDLE },
        /// The user cancelled the UAC prompt (`ERROR_CANCELLED`): `elevation.denied
        /// { cause: 'uac_cancelled' }`, the user instance keeps the session.
        Cancelled,
        /// Any other failure: `elevation.failed { error: 'launch_failed' }`.
        Failed(u32),
    }

    /// Relaunch `exe` elevated with `--handover-pipe <suffix>` (§7.3 step 3). **Raises a real
    /// UAC prompt**: never called by an automated test.
    pub fn launch_elevated(exe: &Path, suffix: &str) -> Launch {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::UI::Shell::{
            ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
        };
        if !super::valid_suffix(suffix) {
            return Launch::Failed(0);
        }
        let file: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
        let verb = wide("runas");
        let params = wide(&format!("--handover-pipe {suffix}"));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: 0,
            ..Default::default()
        };
        // SAFETY: every string is NUL-terminated and outlives the call.
        unsafe {
            match ShellExecuteExW(&mut info) {
                Ok(()) if !info.hProcess.is_invalid() => {
                    let pid = windows::Win32::System::Threading::GetProcessId(info.hProcess);
                    Launch::Started {
                        pid,
                        process: info.hProcess,
                    }
                }
                Ok(()) => Launch::Failed(0),
                Err(_) => {
                    let e = GetLastError();
                    if e == windows::Win32::Foundation::ERROR_CANCELLED {
                        Launch::Cancelled
                    } else {
                        Launch::Failed(e.0)
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffixes_are_32_lower_hex_and_fresh() {
        let a = new_suffix();
        assert!(valid_suffix(&a), "{a}");
        assert_ne!(a, new_suffix());
        assert!(!valid_suffix("ABCDEF0123456789abcdef0123456789"));
        assert!(!valid_suffix("abc"));
        assert!(!valid_suffix("0123456789abcdef0123456789abcdeg"));
    }

    #[test]
    fn image_paths_compare_case_insensitively() {
        assert!(same_image(
            r"C:\Users\x\Downloads\IndiansAssist.exe",
            r"\\?\c:\users\X\downloads\indiansassist.EXE"
        ));
        assert!(!same_image(r"C:\a.exe", r"C:\b.exe"));
        assert!(!same_image("", ""));
    }
}
