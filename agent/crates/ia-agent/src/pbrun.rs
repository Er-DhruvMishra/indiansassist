//! The playbook runner (contract §8.4 execution, §8.5 output / timeout / cancel).
//!
//! A run is one OS thread that owns the child process:
//!
//! * the child is created `CREATE_SUSPENDED | CREATE_NO_WINDOW`, assigned to a dedicated job
//!   object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then resumed, so a timeout, a cancel or
//!   the agent exiting kills the **whole tree** (the job handle closing is enough);
//! * PowerShell gets the verified body on **stdin** (no script file ever exists); cmd gets a
//!   `<run dir>\<runId>.cmd` file created `CREATE_NEW` with an **owner-only protected DACL**
//!   (`D:P(A;;FA;;;<user SID>)`), deleted when the run ends;
//! * the environment is the agent's minus any inherited `IA_PARAM_*`, plus the validated
//!   `IA_PARAM_<NAME>` values and a Windows `PATH`; the working directory is the run dir;
//! * stdout / stderr are read on their own threads and turned into `pb.output` frames
//!   (`chunk <= 8192` UTF-8 bytes, at most one frame per 100 ms tick, pending text flushed
//!   after 200 ms), capped at `LIMITS.playbookOutputMaxBytes` (1 MiB) after which output stops
//!   and the end carries `truncated: true` (the pipes keep being drained so the child never
//!   blocks on a full pipe);
//! * `timeoutSec` reached => the job is terminated, `exit: null, error: 'timeout'`;
//!   [`RunHandle::cancel`] => `error: 'cancelled'`.
//!
//! The agent never runs a playbook elevated by accident: [`never_elevated_gate`] refuses a
//! non-elevation playbook when this process itself is elevated (the §8.4 limited-linked-token
//! launch is not implemented, so the run is refused instead of running as administrator).

use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ia_core::playbook::PlaybookError;
use ia_core::types::{limits, PlaybookInterpreter};

/// Output pacing and the cap (contract §8.5 O1). Tests shrink these.
#[derive(Debug, Clone, Copy)]
pub struct OutputLimits {
    /// Total UTF-8 bytes of `pb.output` chunks per run before `truncated`.
    pub cap_bytes: usize,
    /// Max UTF-8 bytes of one `chunk`.
    pub chunk_max: usize,
    /// At most one frame per tick (100 ms => <= 10 / s).
    pub tick: Duration,
    /// Pending text older than this is flushed even if the chunk is not full.
    pub flush_after: Duration,
}

impl Default for OutputLimits {
    fn default() -> Self {
        Self {
            cap_bytes: limits::PLAYBOOK_OUTPUT_MAX_BYTES,
            chunk_max: 8192,
            tick: Duration::from_millis(100),
            flush_after: Duration::from_millis(200),
        }
    }
}

/// Everything a run needs; the body has already passed `check_run` and the args the
/// canonical validation.
#[derive(Debug, Clone)]
pub struct RunSpec {
    pub run_id: String,
    pub interpreter: PlaybookInterpreter,
    pub body: String,
    /// `IA_PARAM_<NAME>` pairs (`ia_core::playbook::param_env`).
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
    /// Working directory and (cmd) run-file directory.
    pub run_dir: PathBuf,
    pub limits: OutputLimits,
}

/// What a run reports back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEvent {
    Output {
        stream: &'static str,
        seq: u32,
        chunk: String,
    },
    End(RunEnd),
}

/// The `pb.end` facts (the caller adds `runId`, `ranAs`, `ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunEnd {
    pub exit: Option<i32>,
    pub duration_ms: u64,
    pub truncated: bool,
    pub error: Option<PlaybookError>,
}

/// A running playbook.
pub struct RunHandle {
    cancel: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl RunHandle {
    /// `playbook.cancel`: kill the job; the run ends with `error: 'cancelled'`.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Wait for the run thread (it has sent `RunEvent::End` by then).
    pub fn join(mut self) {
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// `%LOCALAPPDATA%\IndiansAssist\run\` (the user instance's run dir, §8.4 / §11.5).
pub fn default_run_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("IndiansAssist")
        .join("run")
}

/// §8.4 "never elevated by accident": a `requiresElevation: false` playbook must run at
/// medium integrity. The limited-linked-token launch of the admin instance is not
/// implemented, so an elevated process refuses such a run (`spawn_failed`) rather than run
/// it as administrator. (`requiresElevation: true` in a user instance is refused earlier by
/// `check_run` with `elevation_required`.)
pub fn never_elevated_gate(
    requires_elevation: bool,
    process_elevated: bool,
) -> Result<(), PlaybookError> {
    if !requires_elevation && process_elevated {
        return Err(PlaybookError::SpawnFailed);
    }
    Ok(())
}

/// Whether this process token is elevated (`TokenElevation`).
pub fn process_is_elevated() -> bool {
    #[cfg(windows)]
    {
        win::process_is_elevated()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Start a run on its own thread. `sink` receives every `Output` and exactly one `End`.
pub fn start<F>(spec: RunSpec, mut sink: F) -> RunHandle
where
    F: FnMut(RunEvent) + Send + 'static,
{
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let thread = std::thread::Builder::new()
        .name("ia-playbook".into())
        .spawn(move || {
            let end = run_inner(&spec, &flag, &mut sink);
            sink(RunEvent::End(end));
        })
        .ok();
    RunHandle { cancel, thread }
}

/// Run to completion on the calling thread, collecting the events (tests).
pub fn run_collect(spec: RunSpec) -> (Vec<RunEvent>, RunEnd) {
    let (tx, rx) = mpsc::channel();
    let h = start(spec, move |e| {
        let _ = tx.send(e);
    });
    h.join();
    let events: Vec<RunEvent> = rx.try_iter().collect();
    let end = events
        .iter()
        .find_map(|e| match e {
            RunEvent::End(end) => Some(end.clone()),
            _ => None,
        })
        .expect("a run always ends");
    (events, end)
}

fn is_run_id(s: &str) -> bool {
    // `^[0-9a-f]{32}$` (contract §8.4 / security C6): lower-case hex only, so the `runId` is
    // safe as a `<runId>.cmd` path component and pairs with the console's opId.
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

enum ReaderMsg {
    Data(usize, Vec<u8>),
    Eof,
}

struct Launched {
    child: Child,
    #[cfg(windows)]
    job: Option<win::Job>,
    run_file: Option<PathBuf>,
    rx: mpsc::Receiver<ReaderMsg>,
}

impl Launched {
    fn kill(&mut self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
            return;
        }
        let _ = self.child.kill();
    }

    /// Close the job handle: `KILL_ON_JOB_CLOSE` takes any leftover grandchild with it, which
    /// also closes the pipes they inherited so the readers reach EOF.
    fn release_tree(&mut self) {
        #[cfg(windows)]
        {
            self.job = None;
        }
    }
}

fn run_inner<F: FnMut(RunEvent)>(spec: &RunSpec, cancel: &AtomicBool, sink: &mut F) -> RunEnd {
    let started = Instant::now();
    let fail = |error| RunEnd {
        exit: None,
        duration_ms: started.elapsed().as_millis() as u64,
        truncated: false,
        error: Some(error),
    };
    if !is_run_id(&spec.run_id) {
        return fail(PlaybookError::SpawnFailed);
    }
    let mut proc = match launch(spec) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("playbook launch failed: {e}");
            return fail(PlaybookError::SpawnFailed);
        }
    };
    let decoder = match spec.interpreter {
        PlaybookInterpreter::Cmd => Decoding::OemCodePage,
        _ => Decoding::Utf8,
    };
    let mut pump = OutputPump::new(spec.limits, decoder);
    let deadline = started + spec.timeout;
    let mut error: Option<PlaybookError> = None;
    let mut exit: Option<i32> = None;
    let mut exited_at: Option<Instant> = None;
    let mut eofs = 0usize;
    loop {
        match proc
            .rx
            .recv_timeout(spec.limits.tick.min(Duration::from_millis(50)))
        {
            Ok(ReaderMsg::Data(i, bytes)) => pump.push(i, &bytes, Instant::now()),
            Ok(ReaderMsg::Eof) => eofs += 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => eofs = 2,
        }
        pump.tick(Instant::now(), sink);
        if exited_at.is_none() && error.is_none() {
            if cancel.load(Ordering::SeqCst) {
                error = Some(PlaybookError::Cancelled);
                proc.kill();
            } else if Instant::now() >= deadline {
                error = Some(PlaybookError::Timeout);
                proc.kill();
            }
        }
        if exited_at.is_none() {
            if let Ok(Some(status)) = proc.child.try_wait() {
                exit = status.code();
                exited_at = Some(Instant::now());
                proc.release_tree();
            }
        }
        if let Some(at) = exited_at {
            // Both pipes closed, or a stray handle holder outlived the tree kill: stop waiting.
            if eofs >= 2 || at.elapsed() > Duration::from_secs(5) {
                break;
            }
        }
    }
    // Drain whatever the readers already queued, then flush at the paced rate.
    while let Ok(ReaderMsg::Data(i, bytes)) = proc.rx.try_recv() {
        pump.push(i, &bytes, Instant::now());
    }
    pump.flush_all(sink);
    if let Some(path) = proc.run_file.take() {
        let _ = std::fs::remove_file(path);
    }
    RunEnd {
        exit: if error.is_some() { None } else { exit },
        duration_ms: started.elapsed().as_millis() as u64,
        truncated: pump.truncated,
        error,
    }
}

// ---- launch -------------------------------------------------------------------------------

/// Reads the whole body from stdin as UTF-8 and runs it as ONE script block (plain
/// `-Command -` runs stdin line by line, dropping output after a multi-line block and losing
/// the exit code); output is switched to UTF-8 so the runner decodes it losslessly.
#[cfg(windows)]
const PS_WRAPPER: &str = "$e = New-Object System.Text.UTF8Encoding $false; \
try { [Console]::InputEncoding = $e; [Console]::OutputEncoding = $e } catch {}; \
& ([scriptblock]::Create([Console]::In.ReadToEnd()))";

#[cfg(windows)]
fn system32() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    root.join("System32")
}

#[cfg(windows)]
fn windows_path() -> String {
    let s32 = system32();
    format!(
        "{s};{w};{wbem};{ps}",
        s = s32.display(),
        w = s32.parent().unwrap_or(&s32).display(),
        wbem = s32.join("Wbem").display(),
        ps = s32.join("WindowsPowerShell").join("v1.0").display(),
    )
}

#[cfg(windows)]
fn launch(spec: &RunSpec) -> std::io::Result<Launched> {
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;

    std::fs::create_dir_all(&spec.run_dir)?;
    let s32 = system32();
    let mut run_file = None;
    let mut cmd = match spec.interpreter {
        PlaybookInterpreter::Powershell => {
            let mut c = Command::new(
                s32.join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe"),
            );
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                PS_WRAPPER,
            ]);
            c.stdin(Stdio::piped());
            c
        }
        PlaybookInterpreter::Cmd => {
            let path = spec.run_dir.join(format!("{}.cmd", spec.run_id));
            win::create_owner_only_file(&path, spec.body.as_bytes())?;
            run_file = Some(path.clone());
            let mut c = Command::new(s32.join("cmd.exe"));
            c.args(["/Q", "/c"]).arg(&path);
            c.stdin(Stdio::null());
            c
        }
        PlaybookInterpreter::Sh => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "sh is not supported on Windows",
            ))
        }
    };
    cmd.current_dir(&spec.run_dir);
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("IA_PARAM_")
        {
            cmd.env_remove(&k);
        }
    }
    cmd.env("PATH", windows_path());
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);

    let cleanup = |run_file: &Option<PathBuf>| {
        if let Some(p) = run_file {
            let _ = std::fs::remove_file(p);
        }
    };
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cleanup(&run_file);
            return Err(e);
        }
    };
    // Job first, then resume: nothing the child starts can escape the job.
    let job = match win::Job::new_kill_on_close().and_then(|job| {
        job.assign(child.as_raw_handle())?;
        win::resume_process(child.id())?;
        Ok(job)
    }) {
        Ok(j) => j,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            cleanup(&run_file);
            return Err(e);
        }
    };

    let (tx, rx) = mpsc::channel();
    if let Some(mut stdin) = child.stdin.take() {
        let body = spec.body.clone();
        std::thread::spawn(move || {
            let _ = stdin.write_all(body.as_bytes());
            // Dropping stdin closes the pipe: ReadToEnd() returns.
        });
    }
    if let Some(out) = child.stdout.take() {
        spawn_reader(0, out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_reader(1, err, tx.clone());
    }
    Ok(Launched {
        child,
        job: Some(job),
        run_file,
        rx,
    })
}

#[cfg(not(windows))]
fn launch(_spec: &RunSpec) -> std::io::Result<Launched> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "playbooks run on Windows only",
    ))
}

fn spawn_reader<R: Read + Send + 'static>(idx: usize, mut r: R, tx: mpsc::Sender<ReaderMsg>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(ReaderMsg::Data(idx, buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = tx.send(ReaderMsg::Eof);
    });
}

// ---- output pacing ------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decoding {
    Utf8,
    OemCodePage,
}

struct StreamBuf {
    name: &'static str,
    raw: Vec<u8>,
    text: VecDeque<u8>,
    since: Option<Instant>,
    started: bool,
}

/// Turns raw pipe bytes into paced, capped `pb.output` chunks.
struct OutputPump {
    limits: OutputLimits,
    decoding: Decoding,
    streams: [StreamBuf; 2],
    seq: u32,
    /// Bytes emitted plus bytes pending (both count against the cap).
    budget_used: usize,
    truncated: bool,
    last_emit: Option<Instant>,
}

impl OutputPump {
    fn new(limits: OutputLimits, decoding: Decoding) -> Self {
        let sb = |name| StreamBuf {
            name,
            raw: Vec::new(),
            text: VecDeque::new(),
            since: None,
            started: false,
        };
        Self {
            limits,
            decoding,
            streams: [sb("stdout"), sb("stderr")],
            seq: 0,
            budget_used: 0,
            truncated: false,
            last_emit: None,
        }
    }

    fn push(&mut self, idx: usize, bytes: &[u8], now: Instant) {
        if self.truncated {
            return; // output stops at the cap; the pipe is still drained by the reader
        }
        let decoding = self.decoding;
        let s = &mut self.streams[idx];
        s.raw.extend_from_slice(bytes);
        let mut text = match decoding {
            Decoding::Utf8 => take_utf8(&mut s.raw),
            Decoding::OemCodePage => take_oem_lines(&mut s.raw),
        };
        if !s.started && !text.is_empty() {
            s.started = true;
            if let Some(rest) = text.strip_prefix('\u{feff}') {
                text = rest.to_string();
            }
        }
        self.enqueue(idx, text, now);
    }

    fn enqueue(&mut self, idx: usize, text: String, now: Instant) {
        if text.is_empty() || self.truncated {
            return;
        }
        let room = self.limits.cap_bytes.saturating_sub(self.budget_used);
        let text = if text.len() > room {
            self.truncated = true;
            let mut end = room;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            text[..end].to_string()
        } else {
            text
        };
        if text.is_empty() {
            return;
        }
        self.budget_used += text.len();
        let s = &mut self.streams[idx];
        s.text.extend(text.as_bytes());
        if s.since.is_none() {
            s.since = Some(now);
        }
    }

    /// Emit at most one frame if the pacing allows and a stream is due.
    fn tick<F: FnMut(RunEvent)>(&mut self, now: Instant, sink: &mut F) {
        if self
            .last_emit
            .is_some_and(|t| now.duration_since(t) < self.limits.tick)
        {
            return;
        }
        let due = |s: &StreamBuf| {
            s.since.is_some_and(|t| {
                s.text.len() >= self.limits.chunk_max
                    || now.duration_since(t) >= self.limits.flush_after
            })
        };
        let pick = (0..2)
            .filter(|&i| due(&self.streams[i]))
            .min_by_key(|&i| self.streams[i].since);
        if let Some(i) = pick {
            self.emit(i, now, sink);
        }
    }

    fn emit<F: FnMut(RunEvent)>(&mut self, i: usize, now: Instant, sink: &mut F) {
        let max = self.limits.chunk_max;
        let s = &mut self.streams[i];
        let take = s.text.len().min(max);
        let bytes: Vec<u8> = s.text.iter().take(take).copied().collect();
        // Back off to a char boundary (the queue only ever holds whole UTF-8 text).
        let mut end = bytes.len();
        while end > 0 && std::str::from_utf8(&bytes[..end]).is_err() {
            end -= 1;
        }
        if end == 0 {
            return;
        }
        s.text.drain(..end);
        if s.text.is_empty() {
            s.since = None;
        }
        let chunk = String::from_utf8(bytes[..end].to_vec()).unwrap_or_default();
        sink(RunEvent::Output {
            stream: s.name,
            seq: self.seq,
            chunk,
        });
        self.seq += 1;
        self.last_emit = Some(now);
    }

    /// At exit: decode any tail and emit everything left, still at most one frame per tick.
    fn flush_all<F: FnMut(RunEvent)>(&mut self, sink: &mut F) {
        for i in 0..2 {
            let raw = std::mem::take(&mut self.streams[i].raw);
            if !raw.is_empty() {
                let text = match self.decoding {
                    Decoding::Utf8 => String::from_utf8_lossy(&raw).into_owned(),
                    Decoding::OemCodePage => decode_oem(&raw),
                };
                self.enqueue(i, text, Instant::now());
            }
        }
        loop {
            let pending = (0..2)
                .filter(|&i| !self.streams[i].text.is_empty())
                .min_by_key(|&i| self.streams[i].since);
            let Some(i) = pending else { break };
            if let Some(t) = self.last_emit {
                let wait = self.limits.tick.saturating_sub(t.elapsed());
                if !wait.is_zero() {
                    std::thread::sleep(wait);
                }
            }
            self.emit(i, Instant::now(), sink);
        }
    }
}

/// Take the longest valid UTF-8 prefix, keeping an incomplete trailing sequence for the
/// next read; invalid bytes become U+FFFD.
fn take_utf8(raw: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(raw) {
            Ok(s) => {
                out.push_str(s);
                raw.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                match e.error_len() {
                    None => {
                        out.push_str(&String::from_utf8_lossy(&raw[..valid]));
                        raw.drain(..valid);
                        return out;
                    }
                    Some(n) => {
                        out.push_str(&String::from_utf8_lossy(&raw[..valid + n]));
                        raw.drain(..valid + n);
                    }
                }
            }
        }
    }
}

/// OEM code page output (cmd): decode complete lines only, so a double-byte character is
/// never split across reads; the tail is decoded at exit.
fn take_oem_lines(raw: &mut Vec<u8>) -> String {
    match raw.iter().rposition(|&b| b == b'\n') {
        Some(pos) => {
            let line: Vec<u8> = raw.drain(..=pos).collect();
            decode_oem(&line)
        }
        None => String::new(),
    }
}

fn decode_oem(bytes: &[u8]) -> String {
    #[cfg(windows)]
    {
        win::decode_oem(bytes)
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

// ---- Win32 ----------------------------------------------------------------------------------

#[cfg(windows)]
pub mod win {
    //! Job object, thread resume, the owner-only run file and token queries.
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, GENERIC_WRITE, HANDLE, HLOCAL};
    use windows::Win32::Globalization::{
        MultiByteToWideChar, CP_OEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS,
    };
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        EqualSid, GetAce, GetSecurityDescriptorControl, GetTokenInformation, TokenElevation,
        TokenUser, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, WriteFile, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcessToken, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
    };

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// A job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: dropping it kills the tree.
    pub struct Job(HANDLE);

    // SAFETY: a job handle may be used and closed from any thread.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new_kill_on_close() -> io::Result<Job> {
            // SAFETY: no name, default security; the handle is owned by the returned Job.
            let h = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(io::Error::other)?;
            let job = Job(h);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: info is a valid JOBOBJECT_EXTENDED_LIMIT_INFORMATION of the given size.
            unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .map_err(io::Error::other)?;
            Ok(job)
        }

        pub fn assign(&self, process: std::os::windows::io::RawHandle) -> io::Result<()> {
            // SAFETY: `process` is the live handle of a child we own.
            unsafe { AssignProcessToJobObject(self.0, HANDLE(process)) }.map_err(io::Error::other)
        }

        pub fn terminate(&self) {
            // SAFETY: valid job handle.
            let _ = unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: we own the handle; closing it kills every process still in the job.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    /// Resume every thread of a `CREATE_SUSPENDED` child (it has exactly one).
    pub fn resume_process(pid: u32) -> io::Result<()> {
        // SAFETY: the snapshot handle is closed below; THREADENTRY32 is sized before use.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(io::Error::other)?;
            let mut te = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut resumed = 0;
            let mut ok = Thread32First(snap, &mut te).is_ok();
            while ok {
                if te.th32OwnerProcessID == pid {
                    if let Ok(t) = OpenThread(THREAD_SUSPEND_RESUME, false, te.th32ThreadID) {
                        if ResumeThread(t) != u32::MAX {
                            resumed += 1;
                        }
                        let _ = CloseHandle(t);
                    }
                }
                ok = Thread32Next(snap, &mut te).is_ok();
            }
            let _ = CloseHandle(snap);
            if resumed == 0 {
                return Err(io::Error::other("no thread of the child could be resumed"));
            }
        }
        Ok(())
    }

    struct TokenUserBuf(Vec<u8>);

    fn token_user() -> io::Result<TokenUserBuf> {
        // SAFETY: the token handle is closed; the buffer is sized by the first call.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .map_err(io::Error::other)?;
            let mut len = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
            let mut buf = vec![0u8; len as usize];
            let r = GetTokenInformation(
                token,
                TokenUser,
                Some(buf.as_mut_ptr() as *mut c_void),
                len,
                &mut len,
            );
            let _ = CloseHandle(token);
            r.map_err(io::Error::other)?;
            Ok(TokenUserBuf(buf))
        }
    }

    impl TokenUserBuf {
        fn sid(&self) -> PSID {
            // SAFETY: the buffer holds a TOKEN_USER written by GetTokenInformation.
            unsafe { (*(self.0.as_ptr() as *const TOKEN_USER)).User.Sid }
        }
    }

    /// The string SID of the process token user (`S-1-5-21-...`).
    pub fn current_user_sid() -> io::Result<String> {
        let tu = token_user()?;
        // SAFETY: the SID points into `tu`; the returned string is LocalFree'd.
        unsafe {
            let mut s = PWSTR::null();
            ConvertSidToStringSidW(tu.sid(), &mut s).map_err(io::Error::other)?;
            let out = s.to_string().map_err(io::Error::other);
            let _ = LocalFree(HLOCAL(s.0 as *mut c_void));
            out
        }
    }

    /// Create `path` with `CREATE_NEW` and a protected DACL granting full access to the
    /// current user only (`D:P(A;;FA;;;<sid>)`, §8.4 cmd user instance), then write `bytes`.
    pub fn create_owner_only_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
        let sid = current_user_sid()?;
        let sddl: Vec<u16> = format!("D:P(A;;FA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let wpath = wide(path);
        // SAFETY: SDDL/paths are NUL-terminated; the descriptor is LocalFree'd; the file
        // handle is closed on every path.
        unsafe {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
            .map_err(io::Error::other)?;
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd.0,
                bInheritHandle: false.into(),
            };
            let h = CreateFileW(
                PCWSTR(wpath.as_ptr()),
                GENERIC_WRITE.0,
                FILE_SHARE_NONE,
                Some(&sa),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                None,
            );
            let _ = LocalFree(HLOCAL(sd.0));
            let h = h.map_err(io::Error::other)?;
            let mut written = 0u32;
            let r = WriteFile(h, Some(bytes), Some(&mut written), None);
            let _ = CloseHandle(h);
            r.map_err(io::Error::other)?;
            if written as usize != bytes.len() {
                return Err(io::Error::other("short write to the run file"));
            }
        }
        Ok(())
    }

    /// Whether `path`'s DACL is protected and holds exactly one ACE, an allow ACE for the
    /// current user (the owner-only check the tests use).
    pub fn dacl_is_owner_only(path: &Path) -> io::Result<bool> {
        let tu = token_user()?;
        let wpath = wide(path);
        // SAFETY: out-pointers are valid; the descriptor is LocalFree'd.
        unsafe {
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut sd = PSECURITY_DESCRIPTOR::default();
            let r = GetNamedSecurityInfoW(
                PCWSTR(wpath.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut dacl),
                None,
                &mut sd,
            );
            if r.is_err() {
                return Err(io::Error::other(format!("GetNamedSecurityInfoW: {r:?}")));
            }
            let mut control = 0u16;
            let mut rev = 0u32;
            let _ = GetSecurityDescriptorControl(sd, &mut control, &mut rev);
            let protected = control & SE_DACL_PROTECTED.0 != 0;
            let mut ok = protected && !dacl.is_null() && (*dacl).AceCount == 1;
            if ok {
                let mut ace: *mut c_void = std::ptr::null_mut();
                ok = GetAce(dacl, 0, &mut ace).is_ok() && {
                    let a = ace as *const ACCESS_ALLOWED_ACE;
                    let ace_sid = PSID(&(*a).SidStart as *const u32 as *mut c_void);
                    (*a).Header.AceType == 0 && EqualSid(ace_sid, tu.sid()).is_ok()
                };
            }
            let _ = LocalFree(HLOCAL(sd.0));
            Ok(ok)
        }
    }

    /// `TokenElevation` of this process.
    pub fn process_is_elevated() -> bool {
        // SAFETY: the token handle is closed; TOKEN_ELEVATION is sized.
        unsafe {
            let mut token = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut e = TOKEN_ELEVATION::default();
            let mut len = 0u32;
            let r = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut e as *mut _ as *mut c_void),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            );
            let _ = CloseHandle(token);
            r.is_ok() && e.TokenIsElevated != 0
        }
    }

    /// Decode OEM code page bytes (what cmd writes to a pipe) to UTF-16 -> String.
    pub fn decode_oem(bytes: &[u8]) -> String {
        if bytes.is_empty() {
            return String::new();
        }
        // SAFETY: sizes come from the first call; the buffer is exactly that long.
        unsafe {
            let n = MultiByteToWideChar(CP_OEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), bytes, None);
            if n <= 0 {
                return String::from_utf8_lossy(bytes).into_owned();
            }
            let mut buf = vec![0u16; n as usize];
            let m = MultiByteToWideChar(
                CP_OEMCP,
                MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0),
                bytes,
                Some(&mut buf),
            );
            String::from_utf16_lossy(&buf[..m.max(0) as usize])
        }
    }
}

/// The run file path a cmd run uses (exposed for tests).
pub fn cmd_run_file(run_dir: &Path, run_id: &str) -> PathBuf {
    run_dir.join(format!("{run_id}.cmd"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(limits: OutputLimits, pushes: &[(usize, &str)]) -> (Vec<(String, String)>, bool) {
        let mut pump = OutputPump::new(limits, Decoding::Utf8);
        let mut out = Vec::new();
        let mut sink = |e: RunEvent| {
            if let RunEvent::Output { stream, chunk, .. } = e {
                out.push((stream.to_string(), chunk));
            }
        };
        for (i, s) in pushes {
            pump.push(*i, s.as_bytes(), Instant::now());
            pump.tick(Instant::now(), &mut sink);
        }
        pump.flush_all(&mut sink);
        let t = pump.truncated;
        (out, t)
    }

    fn fast() -> OutputLimits {
        OutputLimits {
            cap_bytes: 1 << 20,
            chunk_max: 8,
            tick: Duration::from_millis(1),
            flush_after: Duration::from_millis(0),
        }
    }

    #[test]
    fn chunks_respect_the_max_and_keep_order() {
        let (out, truncated) = collect(fast(), &[(0, "hello world, "), (0, "again")]);
        assert!(!truncated);
        assert!(out.iter().all(|(_, c)| c.len() <= 8));
        let joined: String = out.iter().map(|(_, c)| c.as_str()).collect();
        assert_eq!(joined, "hello world, again");
    }

    #[test]
    fn cap_truncates_and_stops_output() {
        let limits = OutputLimits {
            cap_bytes: 10,
            ..fast()
        };
        let (out, truncated) = collect(limits, &[(0, "0123456789abcdef"), (1, "more")]);
        assert!(truncated);
        let total: usize = out.iter().map(|(_, c)| c.len()).sum();
        assert_eq!(total, 10);
        assert!(out.iter().all(|(s, _)| s == "stdout"));
    }

    #[test]
    fn utf8_split_across_reads_is_reassembled() {
        let mut raw = vec![b'a', 0xC3];
        assert_eq!(take_utf8(&mut raw), "a");
        raw.push(0xA9);
        assert_eq!(take_utf8(&mut raw), "é");
        let mut bad = vec![b'x', 0xFF, b'y'];
        assert_eq!(take_utf8(&mut bad), "x\u{FFFD}y");
    }

    #[test]
    fn pacing_emits_at_most_one_frame_per_tick() {
        let limits = OutputLimits {
            tick: Duration::from_millis(100),
            ..fast()
        };
        let mut pump = OutputPump::new(limits, Decoding::Utf8);
        let mut n = 0;
        let mut sink = |_e: RunEvent| n += 1;
        let t0 = Instant::now();
        pump.push(0, b"0123456789012345678901234567890123456789", t0);
        for _ in 0..20 {
            pump.tick(t0, &mut sink);
        }
        assert_eq!(n, 1);
    }

    #[test]
    fn never_elevated_gate_refuses_unelevated_playbooks_in_an_elevated_process() {
        assert_eq!(never_elevated_gate(false, false), Ok(()));
        assert_eq!(
            never_elevated_gate(false, true),
            Err(PlaybookError::SpawnFailed)
        );
        assert_eq!(never_elevated_gate(true, true), Ok(()));
    }

    #[test]
    fn run_ids_are_strict_hex32() {
        assert!(is_run_id(&"ab".repeat(16)));
        assert!(!is_run_id("..\\..\\x"));
        assert!(!is_run_id(&"g".repeat(32)));
    }
}
