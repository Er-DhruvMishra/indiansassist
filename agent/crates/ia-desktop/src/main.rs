//! `ia-desktop.exe`: the Phase D desktop worker (§4.2, §4.3).
//!
//! It is deliberately thin. Everything about capture, input, consent, the `ia.sec` handshake,
//! the channels, the pill and the teardown is the Phase C `ia-agent` serve loop, unchanged.
//! What this binary does is:
//!
//! 1. open the service's pipe named on its command line, verifying that the server end is its
//!    parent running the installed image (§4.2);
//! 2. read the launch blob, and refuse to start if it is not one this build understands;
//! 3. serve the duplex channel on a thread — `sign_sas` (rule 3.5b), `os.sas` (§5.4) and the
//!    desktop/`SESSIONCHANGE` notifications (§5.3) — so the serve loop can stay unaware that
//!    it is talking to a service at all;
//! 4. run the C serve loop with the §4.3 seams installed.
//!
//! It holds **no device key and no token**. Everything privileged is a request to the service.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ia_agent::cli::Cli;
use ia_agent::svc::{ServiceOps, SettledConsent, WorkerContext};
use ia_session0::blob::LaunchBlob;
use ia_session0::pipe::{PipeClient, PipeWriter};
use ia_session0::proto::{read_frame, write_frame, ServiceFrame, WorkerFrame};

/// How long the worker waits for the service's pipe (the service accepts within 20 s, §4.2).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a `sign_sas` round trip may take. Rule 3.5b gives the console 10 s from the new
/// generation, so the worker's own wait is shorter than that.
const SIGN_TIMEOUT: Duration = Duration::from_secs(5);

fn main() {
    harden_dll_search();
    // The DPI awareness the capture path needs is set by the serve loop's own start-up (the C
    // agent does it right after this same hardening), so there is nothing to repeat here.

    let args: Vec<String> = std::env::args().skip(1).collect();
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_ansi(false)
        .try_init();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "ia-desktop.exe - the IndiansAssist desktop worker (Phase D section 4.2)\n\n\
             Launched by the IndiansAssist service, never by hand:\n\
             \x20 --service-pipe <32 hex>   the pipe to read the launch blob from\n\
             \x20 --version                 print the version\n"
        );
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("ia-desktop {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    // apple-owned: begin
    // Phase F §17.3: the macOS LaunchAgent worker reaches the daemon over its Unix socket
    // (`/var/run/indiansassist/worker.sock`) rather than `--service-pipe`; the apple stream
    // fills `macos_entry` (empty until then, so the pipe path below runs unchanged).
    #[cfg(target_os = "macos")]
    macos_entry(&args);
    // apple-owned: end

    let Some(suffix) = pipe_suffix(&args) else {
        eprintln!(
            "ia-desktop is launched by the IndiansAssist service with --service-pipe <32 hex>; \
             it is not something to run by hand."
        );
        std::process::exit(2);
    };
    if let Err(e) = run(&suffix, &args) {
        tracing::error!(error = %e, "the worker stopped");
        std::process::exit(1);
    }
}

/// `--service-pipe <32 lower-case hex>`; anything else is refused before a pipe is opened.
fn pipe_suffix(args: &[String]) -> Option<String> {
    let value = args
        .iter()
        .position(|a| a == "--service-pipe")
        .and_then(|i| args.get(i + 1))?;
    ia_platform::protocol::valid_pipe_suffix(value).then(|| value.clone())
}

#[cfg(windows)]
fn harden_dll_search() {
    use windows_sys_min::*;
    // SAFETY: process-wide loader flags (C §14): System32 only, and no application directory.
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
        SetDllDirectoryW([0u16].as_ptr());
    }
}

#[cfg(not(windows))]
fn harden_dll_search() {}

// apple-owned: begin
/// Phase F §17.3: the macOS worker entry (apple stream). Empty until then.
#[cfg(target_os = "macos")]
fn macos_entry(_args: &[String]) {}
// apple-owned: end

/// The two loader calls, declared here rather than pulling the whole `windows` crate into a
/// binary whose only other Win32 use is through its dependencies.
#[cfg(windows)]
mod windows_sys_min {
    pub const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;
    #[link(name = "kernel32")]
    extern "system" {
        pub fn SetDefaultDllDirectories(directory_flags: u32) -> i32;
        pub fn SetDllDirectoryW(path: *const u16) -> i32;
    }
}

/// What the pipe thread sends back to the main thread.
enum Notice {
    /// A `sign_sas` answer (or a refusal), correlated by request id.
    Signature { re: String, sig: Option<String> },
    /// `os.sas` was performed (or refused).
    SasDone { re: String, ok: bool },
    /// The service says the session is over.
    Stop(String),
}

/// The worker's side of the §4.2 duplex channel.
struct PipeOps {
    writer: Arc<Mutex<PipeWriter>>,
    notices: Mutex<Receiver<Notice>>,
    next_id: std::sync::atomic::AtomicU32,
}

impl PipeOps {
    fn id(&self) -> String {
        let n = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("w{n}")
    }

    fn send(&self, frame: &WorkerFrame) -> bool {
        match self.writer.lock() {
            Ok(mut w) => write_frame(&mut *w, frame).is_ok(),
            Err(_) => false,
        }
    }

    /// Send a request and wait for its answer, discarding answers to older requests (which can
    /// only happen if an earlier wait timed out).
    fn wait_for(&self, id: &str, timeout: Duration) -> Option<Notice> {
        let deadline = std::time::Instant::now() + timeout;
        let rx = self.notices.lock().ok()?;
        loop {
            let left = deadline.checked_duration_since(std::time::Instant::now())?;
            match rx.recv_timeout(left) {
                Ok(Notice::Signature { re, sig }) if re == id => {
                    return Some(Notice::Signature { re, sig })
                }
                Ok(Notice::SasDone { re, ok }) if re == id => {
                    return Some(Notice::SasDone { re, ok })
                }
                Ok(Notice::Stop(reason)) => return Some(Notice::Stop(reason)),
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    }
}

impl ServiceOps for PipeOps {
    fn sign_sas(&self, gen: u16, sas: &str, desk_fpr: &str, assist_fpr: &str) -> Option<String> {
        let id = self.id();
        if !self.send(&WorkerFrame::SignSas {
            id: id.clone(),
            gen,
            sas: sas.to_string(),
            desk_fpr: desk_fpr.to_string(),
            assist_fpr: assist_fpr.to_string(),
        }) {
            return None;
        }
        match self.wait_for(&id, SIGN_TIMEOUT) {
            Some(Notice::Signature { sig, .. }) => sig,
            _ => None,
        }
    }

    fn send_sas(&self) -> bool {
        let id = self.id();
        if !self.send(&WorkerFrame::SendSas { id: id.clone() }) {
            return false;
        }
        matches!(
            self.wait_for(&id, SIGN_TIMEOUT),
            Some(Notice::SasDone { ok: true, .. })
        )
    }

    fn report_protections(&self, input_lock: bool, privacy_screen: bool) {
        self.send(&WorkerFrame::Protections {
            input_lock,
            privacy_screen,
        });
    }

    fn request_desktop_switch(&self, reason: &str) {
        self.send(&WorkerFrame::DesktopSwitch {
            id: self.id(),
            reason: reason.to_string(),
        });
    }
}

fn run(suffix: &str, args: &[String]) -> Result<(), String> {
    // The server end must be our parent, running the image we are running (§4.2). A pipe
    // served by anything else is not the service, whatever it has to say.
    let parent =
        ia_session0::pipe::parent_pid().ok_or("the parent process could not be identified")?;
    let mut session = PipeClient::connect(suffix, parent, CONNECT_TIMEOUT)
        .map_err(|e| format!("the service pipe could not be opened: {e}"))?;
    // The blob is the first line; everything after it is a frame.
    let blob: LaunchBlob = read_frame(&mut session.reader)
        .map_err(|e| format!("the launch blob could not be read: {e}"))?;
    blob.validate()
        .map_err(|e| format!("the launch blob is not usable: {e}"))?;
    tracing::info!(
        session = %blob.session_id,
        decision = ?blob.decision,
        gen = blob.gen,
        secure_desktop = blob.secure_desktop,
        "the worker read its launch blob"
    );

    let writer = Arc::new(Mutex::new(session.writer));
    let (tx, rx) = channel::<Notice>();
    let ops = PipeOps {
        writer: writer.clone(),
        notices: Mutex::new(rx),
        next_id: std::sync::atomic::AtomicU32::new(1),
    };
    let context = WorkerContext {
        session_id: blob.session_id.clone(),
        device_id: blob.device_id.clone(),
        api_origin: blob.api_origin.clone(),
        signal_url: blob.signal_url.clone(),
        assist_name: blob.assist.name.clone(),
        reason: blob.reason.clone(),
        unattended: blob.unattended,
        decision: blob.decision,
        policy: blob.policy.clone(),
        consent: blob.consent.as_ref().map(|c| SettledConsent {
            level: c.level.clone(),
            monitors: c.monitors.clone(),
            clipboard: c.clipboard,
        }),
        recording_mode: blob.recording_mode.clone(),
        gen: blob.gen,
        secure_desktop: blob.secure_desktop,
        credential: blob.worker_credential.clone(),
        ops: Box::new(ops),
    };
    ia_agent::svc::set(context).map_err(|e| e.to_string())?;

    // The pipe reader runs for the life of the process: the service's notifications arrive on
    // it, and so do the answers to the worker's own requests.
    let reader_writer = writer.clone();
    std::thread::Builder::new()
        .name("ia-service-pipe".into())
        .spawn(move || pipe_reader(session.reader, reader_writer, tx))
        .map_err(|e| format!("the pipe reader could not start: {e}"))?;

    // Tell the service we are up, with our pid: it verified the pipe client, and this closes
    // the loop the other way.
    if let Ok(mut w) = writer.lock() {
        let _ = write_frame(
            &mut *w,
            &WorkerFrame::Ready {
                pid: std::process::id(),
            },
        );
    }

    let cli = Cli::parse(args).map_err(|e| e.0)?;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    // An unattended session has no human to end it; the server's own limits
    // (`maxUnattendedMinutes`, the consent deadline) are what bound it, so the worker's budget
    // is generous and the session ends when the session ends.
    let budget = Duration::from_secs(24 * 3600);
    let outcome = rt.block_on(ia_agent::session::run_worker_session(&cli, budget));
    if let Ok(mut w) = writer.lock() {
        let reason = match &outcome {
            Ok(o) => format!("{o:?}"),
            Err(e) => format!("error: {e}"),
        };
        let _ = write_frame(&mut *w, &WorkerFrame::Ended { reason });
    }
    outcome.map(|_| ())
}

/// Read service frames until the pipe closes.
fn pipe_reader(
    reader: std::io::BufReader<ia_session0::pipe::PipeReader>,
    writer: Arc<Mutex<PipeWriter>>,
    tx: Sender<Notice>,
) {
    let mut reader = reader;
    loop {
        match read_frame::<_, ServiceFrame>(&mut reader) {
            Ok(ServiceFrame::SasSig { re, sig }) => {
                let _ = tx.send(Notice::Signature { re, sig: Some(sig) });
            }
            Ok(ServiceFrame::Ack { re }) => {
                let _ = tx.send(Notice::SasDone { re, ok: true });
            }
            Ok(ServiceFrame::Error { re, code }) => {
                tracing::warn!(re = %re, code = %code, "the service refused a request");
                // Answer both waits: whichever is waiting on this id gets its refusal.
                let _ = tx.send(Notice::Signature {
                    re: re.clone(),
                    sig: None,
                });
                let _ = tx.send(Notice::SasDone { re, ok: false });
            }
            Ok(ServiceFrame::SessionChange { interactive })
            | Ok(ServiceFrame::Interactive { interactive }) => {
                tracing::info!(state = ?interactive.state, "the service reported a session change");
                ia_agent::svc::set_present(matches!(
                    interactive.state,
                    ia_core::policy::InteractiveStateName::Active
                ));
            }
            Ok(ServiceFrame::Desktop {
                target,
                secure_desktop,
                surface,
            }) => {
                tracing::info!(target = ?target, secure_desktop, ?surface, "the service moved this worker's desktop");
                // The name is `'static` so the serve loop can hold it without allocating on a
                // path that runs while frames are being encoded.
                let name = surface.map(|s| match s {
                    ia_session0::SecureSurface::Logon => "logon",
                    ia_session0::SecureSurface::Uac => "uac",
                    ia_session0::SecureSurface::Lock => "lock",
                });
                ia_agent::svc::set_secure_desktop(secure_desktop, name);
            }
            Ok(ServiceFrame::WorkerCredential { gen, .. }) => {
                // A fresh credential means the service wants a rebuild; it relaunches the
                // worker itself (§5.3), so nothing to do here but note it.
                tracing::info!(gen, "the service minted a new worker credential");
            }
            Ok(ServiceFrame::Stop { reason }) => {
                tracing::info!(%reason, "the service asked this worker to stop");
                let _ = tx.send(Notice::Stop(reason));
                break;
            }
            Err(e) => {
                tracing::info!(error = %e, "the service pipe closed");
                break;
            }
        }
    }
    // The pipe is gone: the session cannot continue without the service (it signs the
    // attestation and owns the desktop), so the worker exits and the OS releases `BlockInput`
    // and any overlay with the process (rule 5.4d).
    drop(writer);
    std::process::exit(0);
}
