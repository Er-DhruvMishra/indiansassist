//! The worker's side of the D §4.2 duplex channel, generic over its transport: the Windows named
//! pipe (`ia_session0::pipe`) or the Linux inherited socketpair (`ia_session0::unix`, F §8.2).
//! The frames (`ia_session0::proto`) and everything done with them are the same on both.

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ia_agent::cli::Cli;
use ia_agent::svc::{ServiceOps, SettledConsent, WorkerContext};
use ia_session0::blob::LaunchBlob;
use ia_session0::proto::{read_frame, write_frame, ServiceFrame, WorkerFrame};

/// How long a `sign_sas` round trip may take. Rule 3.5b gives the console 10 s from the new
/// generation, so the worker's own wait is shorter than that.
const SIGN_TIMEOUT: Duration = Duration::from_secs(5);

/// What the channel reader sends back to the main thread.
enum Notice {
    /// A `sign_sas` answer (or a refusal), correlated by request id.
    Signature { re: String, sig: Option<String> },
    /// `os.sas` was performed (or refused).
    SasDone { re: String, ok: bool },
    /// The service says the session is over.
    Stop(String),
}

/// The worker's side of the channel, as the serve loop sees it ([`ServiceOps`]).
struct ChannelOps<W> {
    writer: Arc<Mutex<W>>,
    notices: Mutex<Receiver<Notice>>,
    next_id: AtomicU32,
}

impl<W: Write + Send> ChannelOps<W> {
    fn id(&self) -> String {
        format!("w{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    fn send(&self, frame: &WorkerFrame) -> bool {
        match self.writer.lock() {
            Ok(mut w) => write_frame(&mut *w, frame).is_ok(),
            Err(_) => false,
        }
    }

    /// Wait for the answer to `id`, discarding answers to older requests (which can only happen
    /// if an earlier wait timed out).
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

impl<W: Write + Send> ServiceOps for ChannelOps<W> {
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

    fn report_monitors(&self, count: u32) {
        self.send(&WorkerFrame::Monitors { count });
    }
}

/// Install the §4.3 seams from a verified blob, serve the channel on a thread, and run the C
/// serve loop. `reader` must be the reader the blob was read from (it may hold buffered frames).
pub fn serve_blob<R, W>(
    blob: LaunchBlob,
    reader: R,
    writer: W,
    args: &[String],
) -> Result<(), String>
where
    R: BufRead + Send + 'static,
    W: Write + Send + 'static,
{
    tracing::info!(
        session = %blob.session_id,
        decision = ?blob.decision,
        gen = blob.gen,
        secure_desktop = blob.secure_desktop,
        "the worker read its launch blob"
    );
    let writer = Arc::new(Mutex::new(writer));
    let (tx, rx) = channel::<Notice>();
    let ops = ChannelOps {
        writer: writer.clone(),
        notices: Mutex::new(rx),
        next_id: AtomicU32::new(1),
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

    // The reader runs for the life of the process: the service's notifications arrive on it, and
    // so do the answers to the worker's own requests.
    let reader_writer = writer.clone();
    std::thread::Builder::new()
        .name("ia-service-channel".into())
        .spawn(move || channel_reader(reader, reader_writer, tx))
        .map_err(|e| format!("the channel reader could not start: {e}"))?;

    // Tell the service we are up, with our pid: this closes the peer check the other way.
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

/// Read service frames until the channel closes, then exit: the session cannot continue without
/// the service (it signs the attestation and owns the session), and the OS releases anything the
/// worker held with the process (rule 5.4d).
fn channel_reader<R: BufRead, W: Write>(mut reader: R, writer: Arc<Mutex<W>>, tx: Sender<Notice>) {
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
                // F 8.4e: a locked Linux session is "not present" (D's definition) but stays the
                // target; input keeps working under the same consent and policy.
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
                tracing::info!(error = %e, "the service channel closed");
                break;
            }
        }
    }
    drop(writer);
    std::process::exit(0);
}
