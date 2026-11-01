//! The §4.2 pipe itself: `\\.\pipe\IndiansAssist.svc.<32 hex>`, created by the service with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE | PIPE_REJECT_REMOTE_CLIENTS` and a DACL granting `SYSTEM`
//! and the launched worker's user SID only, and the peer checks on both ends.
//!
//! The authentication is **not** the pipe name — that is handed to the worker on its command
//! line. It is the same family of checks as C §7.2:
//!
//! * the service verifies that the connected client's pid is the process it launched, and that
//!   the client runs the image in its own `%ProgramFiles%` install directory;
//! * the worker verifies that the pipe's server pid is its parent and runs that same install
//!   image, and opens the pipe with `SECURITY_IDENTIFICATION` (never impersonation);
//! * `FILE_FLAG_FIRST_PIPE_INSTANCE` means a squatter cannot have created the name first, and
//!   one instance means nobody else can connect after the worker does.
//!
//! The decision half of all that is [`peer_verdict`], which is pure and tested; the Win32 half
//! is in [`win`] behind the `winapi` feature.

use ia_platform::protocol::same_image;

/// Why a pipe peer was refused. Each is a hard failure: the service kills the worker and the
/// worker exits, rather than talking to something it cannot identify.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerRefusal {
    /// The pid on the other end is not the process we launched (service side) or not our
    /// parent (worker side).
    WrongPid,
    /// The other end's image is not the installed binary.
    WrongImage,
    /// The other end's image could not be read at all.
    UnknownImage,
}

/// What this side expects of the other.
#[derive(Debug, Clone)]
pub struct PeerExpectation<'a> {
    pub pid: u32,
    /// The installed image path both processes must be running from.
    pub image: &'a str,
}

/// The pid and image actually observed (`GetNamedPipe{Client,Server}ProcessId` plus
/// `QueryFullProcessImageNameW`); `image` is `None` when it could not be read.
#[derive(Debug, Clone)]
pub struct PeerObservation<'a> {
    pub pid: u32,
    pub image: Option<&'a str>,
}

/// The §4.2 / C §7.2 peer check, as a decision.
pub fn peer_verdict(
    expected: &PeerExpectation<'_>,
    observed: &PeerObservation<'_>,
) -> Result<(), PeerRefusal> {
    if observed.pid != expected.pid || expected.pid == 0 {
        return Err(PeerRefusal::WrongPid);
    }
    match observed.image {
        None => Err(PeerRefusal::UnknownImage),
        Some(got) if same_image(got, expected.image) => Ok(()),
        Some(_) => Err(PeerRefusal::WrongImage),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PipeError {
    #[error("the pipe could not be created (the name was taken)")]
    Create,
    #[error("no worker connected within the window")]
    Timeout,
    #[error("the peer was refused: {0:?}")]
    Peer(PeerRefusal),
    #[error("the pipe closed")]
    Closed,
    #[error("io: {0}")]
    Io(String),
}

#[cfg(all(windows, feature = "winapi"))]
pub use win::{
    own_image, parent_pid, process_image, PipeClient, PipeReader, PipeServer, PipeSession,
    PipeWriter,
};

#[cfg(all(windows, feature = "winapi"))]
mod win {
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND,
        ERROR_IO_PENDING, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED,
        GENERIC_READ, GENERIC_WRITE, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL,
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_SHARE_MODE, OPEN_EXISTING,
        PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
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
        CreateEventW, GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, ResetEvent,
        WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::IO::{CancelIo, GetOverlappedResult, OVERLAPPED};

    use super::{peer_verdict, PeerExpectation, PeerObservation, PipeError};
    use crate::proto::FRAME_MAX;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// The full Win32 image path of a process.
    pub fn process_image(pid: u32) -> Option<String> {
        // SAFETY: the handle is closed on every path; the buffer is sized and its length passed.
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

    /// The parent pid of this process (Toolhelp; the worker checks its pipe server against it).
    pub fn parent_pid() -> Option<u32> {
        // SAFETY: the snapshot handle is closed; the entry is sized before use.
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

    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                // SAFETY: the handle is owned and unused after drop.
                let _ = unsafe { CloseHandle(self.0) };
            }
        }
    }

    // SAFETY: a kernel handle is process-wide and valid from any thread; `Owned` hands out no
    // interior references, and every operation on it takes its own OVERLAPPED.
    unsafe impl Send for Owned {}
    unsafe impl Sync for Owned {}

    /// One direction of an overlapped pipe: the shared handle plus this direction's event.
    struct Half {
        pipe: Arc<Owned>,
        event: Owned,
    }

    impl Half {
        fn new(pipe: Arc<Owned>) -> Result<Self, PipeError> {
            // SAFETY: an auto-reset-free (manual) event with no name; closed on drop.
            let event = unsafe { CreateEventW(None, true, false, None) }
                .map_err(|e| PipeError::Io(e.to_string()))?;
            Ok(Self {
                pipe,
                event: Owned(event),
            })
        }

        /// One overlapped operation, waited to completion (the pipe is local, so a blocking
        /// wait with no deadline is the right shape for a reader thread).
        fn run<F>(&self, op: F) -> std::io::Result<u32>
        where
            F: FnOnce(HANDLE, &mut OVERLAPPED) -> windows::core::Result<()>,
        {
            // SAFETY: `ov` lives until the operation is complete (the wait below), and the
            // event is this half's own, so two directions never share one.
            unsafe {
                let _ = ResetEvent(self.event.0);
                let mut ov = OVERLAPPED {
                    hEvent: self.event.0,
                    ..Default::default()
                };
                let started = op(self.pipe.0, &mut ov);
                if let Err(e) = started {
                    let last = GetLastError();
                    if last != ERROR_IO_PENDING {
                        if matches!(last, ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED) {
                            return Ok(0);
                        }
                        return Err(std::io::Error::other(e.to_string()));
                    }
                }
                let mut n = 0u32;
                match GetOverlappedResult(self.pipe.0, &ov, &mut n, true) {
                    Ok(()) => Ok(n),
                    Err(e) => {
                        if matches!(GetLastError(), ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED) {
                            Ok(0)
                        } else {
                            Err(std::io::Error::other(e.to_string()))
                        }
                    }
                }
            }
        }
    }

    /// The read half. `Read` returning `Ok(0)` is the peer closing, which the frame codec
    /// reports as [`crate::proto::FrameError::Closed`].
    pub struct PipeReader(Half);

    impl Read for PipeReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if buf.is_empty() {
                return Ok(0);
            }
            let len = buf.len().min(FRAME_MAX) as u32;
            let ptr = buf.as_mut_ptr();
            // SAFETY: `ptr`/`len` describe `buf`, which outlives the waited operation.
            let n = self.0.run(|h, ov| unsafe {
                ReadFile(
                    h,
                    Some(std::slice::from_raw_parts_mut(ptr, len as usize)),
                    None,
                    Some(ov),
                )
            })?;
            Ok(n as usize)
        }
    }

    /// The write half, behind a mutex so the service can notify the worker from any task.
    pub struct PipeWriter(Mutex<Half>);

    impl Write for PipeWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let half = self
                .0
                .lock()
                .map_err(|_| std::io::Error::other("pipe writer poisoned"))?;
            let n = half.run(|h, ov| unsafe { WriteFile(h, Some(buf), None, Some(ov)) })?;
            if n == 0 && !buf.is_empty() {
                return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
            }
            Ok(n as usize)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            let half = self
                .0
                .lock()
                .map_err(|_| std::io::Error::other("pipe writer poisoned"))?;
            // SAFETY: the handle is owned and live.
            let _ = unsafe { FlushFileBuffers(half.pipe.0) };
            Ok(())
        }
    }

    /// A verified pipe peer, split into the two halves the caller usually wants on different
    /// threads (a reader loop and a writer the rest of the process shares).
    pub struct PipeSession {
        pub reader: std::io::BufReader<PipeReader>,
        pub writer: PipeWriter,
        pipe: Arc<Owned>,
    }

    impl PipeSession {
        fn new(pipe: Arc<Owned>) -> Result<Self, PipeError> {
            Ok(Self {
                reader: std::io::BufReader::new(PipeReader(Half::new(pipe.clone())?)),
                writer: PipeWriter(Mutex::new(Half::new(pipe.clone())?)),
                pipe,
            })
        }

        /// Drop the connection (the worker is being replaced, or the session ended).
        pub fn disconnect(&self) {
            // SAFETY: the handle is owned and live until this struct drops.
            let _ = unsafe { DisconnectNamedPipe(self.pipe.0) };
        }
    }

    /// The service's side: the single pipe instance, created before the worker is launched.
    pub struct PipeServer {
        pipe: Arc<Owned>,
        connect_event: Owned,
    }

    impl PipeServer {
        /// Create the pipe for a worker that will run as `worker_sid` (`"SY"` for a
        /// `LocalSystem` worker on a secure desktop). Must be called **before** the launch, so
        /// the worker cannot race a squatter to the name.
        pub fn create(suffix: &str, worker_sid: &str) -> Result<Self, PipeError> {
            let sddl = wide(&ia_platform::protocol::service_worker_pipe_dacl(worker_sid));
            let name = wide(&ia_platform::protocol::service_worker_pipe(suffix));
            // SAFETY: both strings are NUL-terminated; the security descriptor is freed once
            // the kernel has copied it; every handle is owned.
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
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    FRAME_MAX as u32,
                    FRAME_MAX as u32,
                    0,
                    Some(&sa),
                );
                let _ = LocalFree(HLOCAL(sd.0));
                if pipe.is_invalid() || pipe == INVALID_HANDLE_VALUE {
                    return Err(PipeError::Create);
                }
                let connect_event =
                    CreateEventW(None, true, false, None).map_err(|_| PipeError::Create)?;
                Ok(Self {
                    pipe: Arc::new(Owned(pipe)),
                    connect_event: Owned(connect_event),
                })
            }
        }

        /// Accept the one client, within `timeout`, and verify it is the process we launched
        /// running our installed image. Any other client is disconnected and refused.
        pub fn accept(
            &self,
            expected_pid: u32,
            timeout: Duration,
        ) -> Result<PipeSession, PipeError> {
            // SAFETY: `ov` outlives the operation (completed, waited, or cancelled below).
            unsafe {
                let mut ov = OVERLAPPED {
                    hEvent: self.connect_event.0,
                    ..Default::default()
                };
                let connected = match ConnectNamedPipe(self.pipe.0, Some(&mut ov)) {
                    Ok(()) => true,
                    Err(_) => {
                        let e = GetLastError();
                        if e == ERROR_PIPE_CONNECTED {
                            true
                        } else if e == ERROR_IO_PENDING {
                            let ms = timeout.as_millis().min(u32::MAX as u128) as u32;
                            if WaitForSingleObject(self.connect_event.0, ms) == WAIT_OBJECT_0 {
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
                    return Err(PipeError::Io("ConnectNamedPipe failed".into()));
                }
                let mut pid = 0u32;
                let got_pid = GetNamedPipeClientProcessId(self.pipe.0, &mut pid).is_ok();
                let image = if got_pid { process_image(pid) } else { None };
                let own = own_image().unwrap_or_default();
                let verdict = peer_verdict(
                    &PeerExpectation {
                        pid: expected_pid,
                        image: &own,
                    },
                    &PeerObservation {
                        pid: if got_pid { pid } else { 0 },
                        image: image.as_deref(),
                    },
                );
                if let Err(refusal) = verdict {
                    let _ = DisconnectNamedPipe(self.pipe.0);
                    return Err(PipeError::Peer(refusal));
                }
            }
            PipeSession::new(self.pipe.clone())
        }
    }

    /// The worker's side.
    pub struct PipeClient;

    impl PipeClient {
        /// Open the service's pipe for **identification only** (never impersonation) and
        /// verify the server is our parent running our image.
        pub fn connect(
            suffix: &str,
            expected_server_pid: u32,
            timeout: Duration,
        ) -> Result<PipeSession, PipeError> {
            let name = wide(&ia_platform::protocol::service_worker_pipe(suffix));
            let deadline = Instant::now() + timeout;
            // SAFETY: the name is NUL-terminated; the handle is owned from here on.
            let pipe = unsafe {
                loop {
                    match CreateFileW(
                        PCWSTR(name.as_ptr()),
                        GENERIC_READ.0 | GENERIC_WRITE.0,
                        FILE_SHARE_MODE(0),
                        None,
                        OPEN_EXISTING,
                        FILE_ATTRIBUTE_NORMAL
                            | FILE_FLAG_OVERLAPPED
                            | SECURITY_SQOS_PRESENT
                            | SECURITY_IDENTIFICATION,
                        None,
                    ) {
                        Ok(h) => break Owned(h),
                        Err(_) => {
                            let e = GetLastError();
                            if (e == ERROR_PIPE_BUSY || e == ERROR_FILE_NOT_FOUND)
                                && Instant::now() < deadline
                            {
                                std::thread::sleep(Duration::from_millis(25));
                                continue;
                            }
                            return Err(if Instant::now() >= deadline {
                                PipeError::Timeout
                            } else {
                                PipeError::Io("the service pipe could not be opened".into())
                            });
                        }
                    }
                }
            };
            // SAFETY: the handle is live for the duration of the checks.
            unsafe {
                let mut pid = 0u32;
                let got_pid = GetNamedPipeServerProcessId(pipe.0, &mut pid).is_ok();
                let image = if got_pid { process_image(pid) } else { None };
                let own = own_image().unwrap_or_default();
                peer_verdict(
                    &PeerExpectation {
                        pid: expected_server_pid,
                        image: &own,
                    },
                    &PeerObservation {
                        pid: if got_pid { pid } else { 0 },
                        image: image.as_deref(),
                    },
                )
                .map_err(PipeError::Peer)?;
            }
            PipeSession::new(Arc::new(pipe))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IMAGE: &str = r"C:\Program Files\IndiansAssist\ia-desktop.exe";

    #[test]
    fn the_launched_process_running_the_installed_image_is_accepted() {
        assert_eq!(
            peer_verdict(
                &PeerExpectation {
                    pid: 1234,
                    image: IMAGE
                },
                &PeerObservation {
                    pid: 1234,
                    image: Some(r"\\?\c:\program files\indiansassist\IA-DESKTOP.EXE")
                },
            ),
            Ok(())
        );
    }

    #[test]
    fn another_process_is_refused_even_when_it_runs_the_right_image() {
        assert_eq!(
            peer_verdict(
                &PeerExpectation {
                    pid: 1234,
                    image: IMAGE
                },
                &PeerObservation {
                    pid: 9999,
                    image: Some(IMAGE)
                },
            ),
            Err(PeerRefusal::WrongPid)
        );
    }

    #[test]
    fn the_right_process_running_another_image_is_refused() {
        assert_eq!(
            peer_verdict(
                &PeerExpectation {
                    pid: 1234,
                    image: IMAGE
                },
                &PeerObservation {
                    pid: 1234,
                    image: Some(r"C:\Users\x\Downloads\ia-desktop.exe")
                },
            ),
            Err(PeerRefusal::WrongImage)
        );
    }

    #[test]
    fn an_unreadable_image_or_pid_is_refused_rather_than_assumed_fine() {
        assert_eq!(
            peer_verdict(
                &PeerExpectation {
                    pid: 1234,
                    image: IMAGE
                },
                &PeerObservation {
                    pid: 1234,
                    image: None
                },
            ),
            Err(PeerRefusal::UnknownImage)
        );
        assert_eq!(
            peer_verdict(
                &PeerExpectation {
                    pid: 0,
                    image: IMAGE
                },
                &PeerObservation {
                    pid: 0,
                    image: Some(IMAGE)
                },
            ),
            Err(PeerRefusal::WrongPid),
            "pid 0 is never a peer"
        );
    }
}
