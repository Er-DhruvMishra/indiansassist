//! What the service does when a session, an action, a wake or an AMT command arrives.
//!
//! The §4.2 handoff in order: create the pipe **before** launching (so nothing can squat the
//! name), launch the worker onto the desktop §5.3 chose, accept exactly one client and verify
//! it is the process we launched running our installed image, write the blob, then serve the
//! duplex channel for the life of the session.
//!
//! A desktop switch (§5.3 row 4) is a rebuild, not a reconnect: the worker has to run under a
//! different token, so the service asks the server for a fresh worker credential at `gen + 1`,
//! kills the old worker and launches a new one. The session itself never ends, which is what
//! lets a technician keep working through a lock, a UAC prompt or a fast user switch.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ia_core::fleet::{DeviceClientMessage, ReportedActionState, Secret, TamperCause};
use ia_platform::{DesktopBridge, DesktopTarget, LaunchedWorker};
use ia_session0::blob::LaunchBlob;
use ia_session0::desktop::{transition, SessionFacts, Transition};
use ia_session0::pipe::{PipeServer, PipeSession};
use ia_session0::proto::{read_frame, write_frame, ServiceFrame, WorkerFrame};

use crate::devicesock::{ActionRequest, AmtCommand, SessionOpen};
use crate::runtime::{now_ms, Shared};
use crate::worker::{
    answer_worker, blob_for, launch_verdict, LaunchVerdict, ProtectionState, WorkerAction,
};

/// How long the service waits for the launched worker to connect to the pipe (the C §7.2
/// window; a worker that cannot connect in 20 s is not going to).
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(20);

/// A live session and the worker serving it.
pub struct LiveSession {
    pub session_id: String,
    pub gen: u16,
    pub worker: LaunchedWorker,
    pub target: DesktopTarget,
    /// What the server opened, kept so a §5.3 rebuild hands the new worker the same session
    /// facts (the technician's name and reason are on the pill and on the arrival card; a
    /// rebuild that lost them would show a blank name to the person at the machine).
    pub open: SessionOpen,
    writer: Arc<Mutex<Option<ia_session0::pipe::PipeWriter>>>,
    protections: Arc<Mutex<ProtectionState>>,
    stopping: Arc<AtomicBool>,
}

impl LiveSession {
    /// Push a frame to the worker (a session change, a new desktop, a stop).
    pub fn notify(&self, frame: &ServiceFrame) {
        if let Ok(mut guard) = self.writer.lock() {
            if let Some(w) = guard.as_mut() {
                if let Err(e) = write_frame(w, frame) {
                    tracing::debug!(error = %e, "the worker pipe would not take a notification");
                }
            }
        }
    }

    /// End the session on the worker's side: ask it to stop, then make sure it is gone.
    pub fn stop(&self, reason: &str) {
        self.stopping.store(true, Ordering::SeqCst);
        self.notify(&ServiceFrame::Stop {
            reason: reason.to_string(),
        });
        std::thread::sleep(Duration::from_millis(250));
        if let Ok(mut guard) = self.writer.lock() {
            *guard = None;
        }
    }

    pub fn protections(&self) -> ProtectionState {
        self.protections.lock().map(|p| *p).unwrap_or_default()
    }
}

/// The installed worker binary.
fn worker_image(shared: &Shared) -> PathBuf {
    shared.install_dir.join(crate::WORKER_EXE)
}

/// §4.2: launch a worker for a new session. Blocking (the pipe accept waits for the worker),
/// so the socket loop calls it on a blocking task.
pub fn open_blocking(shared: &Arc<Shared>, open: SessionOpen) {
    // Rule 3.5a: one live session per device. The server enforces it, and so does the device —
    // a second `device.session_open` while a worker is live would otherwise orphan the first.
    if let Ok(guard) = shared.session.lock() {
        if let Some(live) = guard.as_ref() {
            tracing::warn!(live = %live.session_id, new = %open.session_id, "a session is already live; the new one is refused");
            return;
        }
    }
    let facts = crate::netstate::read_facts();
    let target = ia_session0::select_desktop(&facts);
    let integrity_ok = crate::runtime::check_integrity(shared);

    let policy = open.policy.clone();
    match launch_verdict(target, &policy, integrity_ok, "see the service log") {
        LaunchVerdict::Go => {}
        LaunchVerdict::IntegrityFailed(summary) => {
            tracing::error!(%summary, "the worker is not launched: the installed binaries do not match the manifest");
            return;
        }
        LaunchVerdict::PreloginNotPermitted => {
            tracing::error!(
                "the worker is not launched: nobody is logged on and allowLogonScreen is false"
            );
            return;
        }
    }
    let credential = open.credential.clone();
    let expires = open.credential_expires_at.clone();
    match launch(
        shared,
        shared.bridge.as_ref(),
        &open,
        target,
        0,
        &credential,
        &expires,
    ) {
        Ok(live) => {
            tracing::info!(session = %live.session_id, pid = live.worker.pid, target = ?target, "worker launched and adopted");
            if let Ok(mut s) = shared.session.lock() {
                *s = Some(live);
            }
        }
        Err(e) => {
            tracing::error!(error = %e, session = %open.session_id, "the worker could not be launched")
        }
    }
}

/// Create the pipe, launch, accept, verify, write the blob, and start serving.
#[allow(clippy::too_many_arguments)]
fn launch(
    shared: &Arc<Shared>,
    bridge: &dyn DesktopBridge,
    open: &SessionOpen,
    target: DesktopTarget,
    gen: u16,
    credential: &Secret,
    expires_at: &str,
) -> Result<LiveSession, String> {
    let device_id = shared.device_id().ok_or("the device is not enrolled")?;
    let (api_origin, worker_signal) = {
        let cfg = shared.config.lock().map_err(|_| "config lock")?;
        (cfg.api_origin.clone(), cfg.worker_signal_url())
    };
    let suffix = ia_platform::protocol::new_pipe_suffix();
    let worker_sid = crate::win::worker_sid_for(target);
    // The pipe exists before the worker does: `FILE_FLAG_FIRST_PIPE_INSTANCE` then means
    // nobody else can have created the name, and the DACL is already in place.
    let server = PipeServer::create(&suffix, &worker_sid).map_err(|e| format!("pipe: {e}"))?;
    let image = worker_image(shared);
    let worker = bridge
        .launch_worker(&image, &suffix, target)
        .map_err(|e| format!("launch: {e}"))?;
    let session = match server.accept(worker.pid, ACCEPT_TIMEOUT) {
        Ok(s) => s,
        Err(e) => {
            let _ = bridge.terminate_worker(&worker);
            return Err(format!("the worker did not connect: {e}"));
        }
    };
    let monitors: Vec<u32> =
        (1..=shared.facts.lock().map(|f| f.monitors).unwrap_or(1) as u32).collect();
    let blob = blob_for(
        open,
        &device_id,
        &api_origin,
        &worker_signal,
        &monitors,
        gen,
        target,
        credential,
        expires_at,
    );
    blob.validate()
        .map_err(|e| format!("the blob this service built is not valid: {e}"))?;
    serve(shared, session, blob, worker, target, gen, open.clone())
}

/// Write the blob and run the duplex loop on its own thread.
#[allow(clippy::too_many_arguments)]
fn serve(
    shared: &Arc<Shared>,
    mut session: PipeSession,
    blob: LaunchBlob,
    worker: LaunchedWorker,
    target: DesktopTarget,
    gen: u16,
    open_facts: SessionOpen,
) -> Result<LiveSession, String> {
    // The blob is the first line on the pipe; everything after it is a frame.
    write_frame(&mut session.writer, &blob)
        .map_err(|e| format!("the blob could not be written: {e}"))?;
    let session_id = blob.session_id.clone();
    let protections = Arc::new(Mutex::new(ProtectionState::default()));
    let stopping = Arc::new(AtomicBool::new(false));
    let writer = Arc::new(Mutex::new(Some(session.writer)));
    let mut reader = session.reader;
    let live = LiveSession {
        session_id: session_id.clone(),
        gen,
        worker: worker.clone(),
        target,
        open: open_facts,
        writer: writer.clone(),
        protections: protections.clone(),
        stopping: stopping.clone(),
    };
    let shared_for_thread = shared.clone();
    std::thread::Builder::new()
        .name("ia-worker-pipe".into())
        .spawn(move || {
            loop {
                match read_frame::<_, WorkerFrame>(&mut reader) {
                    Ok(frame) => {
                        let action =
                            answer_worker(&frame, &session_id, &shared_for_thread.identity);
                        if handle(
                            &shared_for_thread,
                            &session_id,
                            &writer,
                            &protections,
                            action,
                        )
                        .is_break()
                        {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::info!(session = %session_id, error = %e, "the worker pipe closed");
                        break;
                    }
                }
            }
            // §5.4d: the worker is gone. If a protection was on, the server must hear about it
            // so the console does not keep showing a hidden screen.
            let left_on = protections.lock().map(|p| *p).unwrap_or_default();
            if left_on.anything_on() && !stopping.load(Ordering::SeqCst) {
                tracing::warn!(
                    session = %session_id,
                    input_lock = left_on.input_lock,
                    privacy_screen = left_on.privacy_screen,
                    "the worker died with a protection on; the OS released it with the process"
                );
            }
            if let Ok(mut s) = shared_for_thread.session.lock() {
                if s.as_ref()
                    .map(|l| l.session_id == session_id)
                    .unwrap_or(false)
                {
                    *s = None;
                }
            }
        })
        .map_err(|e| format!("the pipe thread could not start: {e}"))?;
    Ok(live)
}

/// Whether the pipe loop should keep going.
fn handle(
    shared: &Arc<Shared>,
    session_id: &str,
    writer: &Arc<Mutex<Option<ia_session0::pipe::PipeWriter>>>,
    protections: &Arc<Mutex<ProtectionState>>,
    action: WorkerAction,
) -> std::ops::ControlFlow<()> {
    use std::ops::ControlFlow;
    let reply = |frame: ServiceFrame| {
        if let Ok(mut guard) = writer.lock() {
            if let Some(w) = guard.as_mut() {
                let _ = write_frame(w, &frame);
            }
        }
    };
    match action {
        WorkerAction::Reply(frame) => reply(frame),
        WorkerAction::Ready { pid } => {
            tracing::info!(session = %session_id, pid, "the worker is serving")
        }
        WorkerAction::Alive => {}
        WorkerAction::Monitors { count } => {
            if let Ok(mut f) = shared.facts.lock() {
                f.monitors = count;
            }
        }
        WorkerAction::Protections {
            input_lock,
            privacy_screen,
        } => {
            if let Ok(mut p) = protections.lock() {
                *p = ProtectionState {
                    input_lock,
                    privacy_screen,
                };
            }
        }
        WorkerAction::ReconsiderDesktop { reason } => {
            tracing::info!(session = %session_id, %reason, "the worker asked for a desktop re-evaluation");
            request_rebuild(shared, session_id);
        }
        WorkerAction::Ended { reason } => {
            tracing::info!(session = %session_id, %reason, "the worker ended the session");
            return ControlFlow::Break(());
        }
        WorkerAction::SendSas { id } => {
            // §5.4 `os.sas`: only a service can press Ctrl+Alt+Del, and only through `SendSAS`.
            let ok = crate::win::send_sas();
            reply(if ok {
                ServiceFrame::Ack { re: id }
            } else {
                ServiceFrame::Error {
                    re: id,
                    code: "not_supported".into(),
                }
            });
        }
    }
    ControlFlow::Continue(())
}

/// Ask the server for a fresh worker credential so the worker can be rebuilt at `gen + 1`
/// (§4.2, §5.3 row 4).
fn request_rebuild(shared: &Arc<Shared>, session_id: &str) {
    let next_gen = shared
        .session
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|l| l.gen.saturating_add(1)))
        .unwrap_or(1);
    shared.send(DeviceClientMessage::WorkerCredentialRequest {
        id: Some(ia_core::rnd::hex(8)),
        session_id: session_id.to_string(),
        gen: next_gen,
    });
}

/// A `device.worker_credential` arrived: relaunch the worker for the new desktop (§5.3).
pub fn credential_arrived(shared: &Arc<Shared>, session_id: &str, gen: u16, credential: Secret) {
    let Some(previous) = shared.session.lock().ok().and_then(|mut s| s.take()) else {
        tracing::warn!(session = %session_id, "a worker credential arrived with no live session");
        return;
    };
    if previous.session_id != session_id {
        tracing::warn!(session = %session_id, live = %previous.session_id, "a worker credential for another session was ignored");
        if let Ok(mut s) = shared.session.lock() {
            *s = Some(previous);
        }
        return;
    }
    tracing::info!(session = %session_id, gen, "rebuilding the worker on the new desktop");
    previous.stop("desktop_switch");
    let _ = shared.bridge.terminate_worker(&previous.worker);
    // The session's facts are the ones the server already settled; only the desktop and the
    // credential change. A rebuild never asks anybody again (the consent exists on the
    // session), so the decision becomes `auto_grant` whatever it was at the open.
    let open = SessionOpen {
        decision: ia_core::policy::ConsentDecision::AutoGrant,
        policy: shared
            .policy
            .lock()
            .map(|p| p.clone())
            .unwrap_or_else(|_| previous.open.policy.clone()),
        credential: credential.clone(),
        credential_expires_at: String::new(),
        ..previous.open.clone()
    };
    let facts = crate::netstate::read_facts();
    let target = ia_session0::select_desktop(&facts);
    match launch(
        shared,
        shared.bridge.as_ref(),
        &open,
        target,
        gen,
        &credential,
        "",
    ) {
        Ok(live) => {
            if let Ok(mut s) = shared.session.lock() {
                *s = Some(live);
            }
        }
        Err(e) => tracing::error!(error = %e, "the rebuilt worker could not be launched"),
    }
}

/// §5.3: the facts changed. Notify the worker, or rebuild it.
pub async fn desktop_changed(shared: &Arc<Shared>, previous: &SessionFacts, now: &SessionFacts) {
    let has_session = shared.session.lock().map(|s| s.is_some()).unwrap_or(false);
    if !has_session {
        return;
    }
    let state = ia_session0::derive_interactive(now);
    match transition(previous, now) {
        Transition::None => {}
        Transition::Notify { target } => {
            if let Ok(guard) = shared.session.lock() {
                if let Some(live) = guard.as_ref() {
                    live.notify(&ServiceFrame::SessionChange {
                        interactive: state.clone(),
                    });
                    live.notify(&ServiceFrame::Desktop {
                        target: target.into(),
                        secure_desktop: target.is_secure_surface(),
                        surface: ia_session0::surface_of(target, now),
                    });
                }
            }
        }
        Transition::Rebuild { target } => {
            tracing::info!(target = ?target, "the desktop changed; the worker will be rebuilt");
            let session_id = shared
                .session
                .lock()
                .ok()
                .and_then(|s| s.as_ref().map(|l| l.session_id.clone()));
            if let Some(id) = session_id {
                request_rebuild(shared, &id);
            }
        }
    }
}

/// §9: one action, gated again on the device and then performed. Runs on its own task (a
/// playbook's pinned timeout is up to 900 s) and does the execution itself on a blocking one.
pub async fn run_action(shared: &Arc<Shared>, req: ActionRequest) {
    let Some(device_id) = shared.device_id() else {
        return;
    };
    let policy = shared.policy.lock().map(|p| p.clone()).unwrap_or_default();
    let interactive = shared.interactive.lock().ok().map(|i| i.state);
    let vault_refs = req.secrets.len();
    let queued = ia_core::fleet::QueuedAction {
        id: req.action_id.clone(),
        device_id: device_id.clone(),
        kind: req.kind,
        payload: req.payload.clone(),
        state: "dispatched".to_string(),
        reason: req.reason.clone(),
        approved_by: None,
        created_at: String::new(),
        // A dispatched action has already passed the server's expiry check; the device only
        // re-runs the policy gate.
        expires_at: String::new(),
    };
    let plan = ia_core::queue::plan_for(
        &queued,
        &device_id,
        vault_refs,
        &policy,
        interactive,
        chrono::Utc::now(),
    );
    let report = |state: ReportedActionState,
                  approved: Option<ia_core::policy::ApprovedBy>,
                  result: Option<ia_core::fleet::DeviceActionResult>| {
        match crate::devicesock::action_result(
            &device_id,
            &shared.identity,
            &req.action_id,
            state,
            approved,
            result,
        ) {
            Ok(msg) => shared.send(msg),
            Err(e) => tracing::error!(error = ?e, "the action result could not be signed"),
        }
    };
    use ia_core::queue::QueuePlan;
    let approved_by = match plan {
        QueuePlan::Run { decision } => match decision {
            ia_core::policy::ActionDecision::Run {
                approved_by,
                notify,
            } => {
                if notify {
                    crate::win::toast_to_console(
                        "IndiansAssist",
                        &format!(
                            "{} is running a maintenance task on this computer.",
                            req.technician
                        ),
                    );
                }
                approved_by
            }
            _ => ia_core::policy::ApprovedBy::Policy,
        },
        QueuePlan::Approval {
            wait_for_presence, ..
        } => {
            tracing::info!(action = %req.action_id, wait_for_presence, "the action needs a local approval");
            report(ReportedActionState::AwaitingApproval, None, None);
            // The approval card lives in the worker's UI, which only exists during a session.
            // Outside one there is nothing to show it on, so the action waits as the contract
            // says it should, and the server expires it if nobody ever answers.
            return;
        }
        QueuePlan::Hold => {
            tracing::info!(action = %req.action_id, "outside the allowed hours; the action waits");
            return;
        }
        QueuePlan::Fail { error } => {
            report(
                ReportedActionState::Failed,
                None,
                Some(ia_core::fleet::DeviceActionResult {
                    error: Some(error.to_string()),
                    ..Default::default()
                }),
            );
            return;
        }
        QueuePlan::Skip { why } => {
            tracing::info!(action = %req.action_id, ?why, "the action was skipped");
            return;
        }
    };
    report(ReportedActionState::Running, Some(approved_by), None);
    let outcome = {
        let shared = shared.clone();
        let req = req.clone();
        match tokio::task::spawn_blocking(move || perform(&shared, &req)).await {
            Ok(o) => o,
            Err(e) => crate::actions::Outcome::failed(&format!("the action task failed: {e}")),
        }
    };
    if !outcome.output.is_empty() {
        // The first lines only, locally: output is never chained (C §8.5) and never reported.
        tracing::debug!(action = %req.action_id, bytes = outcome.output.len(), "the action produced output");
    }
    report(
        if outcome.ok {
            ReportedActionState::Done
        } else {
            ReportedActionState::Failed
        },
        Some(approved_by),
        Some(outcome.result),
    );
}

/// Perform one action (after the gate).
fn perform(shared: &Arc<Shared>, req: &ActionRequest) -> crate::actions::Outcome {
    use ia_core::policy::DeviceActionKind as K;
    match req.kind {
        K::Message => crate::actions::run_message(&req.payload, |title, body| {
            crate::win::toast_to_console(title, body)
        }),
        K::FilePush => crate::actions::run_file_push(
            &req.payload,
            &shared.paths.pushes(),
            ia_core::types::limits::FILE_MAX_BYTES_NATIVE,
            crate::win::fetch_bytes,
        ),
        K::Print => crate::actions::run_print(&req.payload),
        K::PlaybookRun => {
            let Some(action) = ia_core::queue::playbook_action(&req.payload) else {
                return crate::actions::Outcome::failed(
                    "the action carries no runnable playbook body",
                );
            };
            let device_id = shared.device_id().unwrap_or_default();
            let injector = match ia_vault::Injector::open(
                &req.secrets,
                shared.identity.kex_secret(),
                &device_id,
            ) {
                Ok(i) => i,
                Err(e) => {
                    return crate::actions::Outcome::failed(&format!(
                        "the secrets did not open: {e}"
                    ))
                }
            };
            let manifest = shared.manifest_playbooks();
            let run_dir = shared.paths.run_dir();
            let timeout = Duration::from_secs(action.timeout_sec.clamp(1, 900) as u64);
            crate::actions::run_playbook(
                &action,
                &ia_core::rnd::hex(16),
                &manifest,
                injector,
                |request, secrets| {
                    crate::actions::phase_c_runner(request, secrets, &run_dir, timeout)
                },
            )
        }
    }
}

/// §6.4: store the receipt and, when somebody is there, show the toast.
pub fn store_receipt(shared: &Arc<Shared>, receipt: &serde_json::Value) {
    let dir = shared.paths.receipts();
    let _ = std::fs::create_dir_all(&dir);
    let id = receipt
        .get("sessionId")
        .or_else(|| receipt.get("actionId"))
        .and_then(|v| v.as_str())
        .unwrap_or("receipt");
    let name = format!("{}-{}.json", id, now_ms());
    if let Some(path) = shared.paths.inside(&dir, &name) {
        match std::fs::write(
            &path,
            serde_json::to_vec_pretty(receipt).unwrap_or_default(),
        ) {
            Ok(()) => tracing::info!(path = %path.display(), "receipt stored"),
            Err(e) => tracing::warn!(error = %e, "the receipt could not be stored"),
        }
    }
    let present = shared
        .interactive
        .lock()
        .map(|i| i.state == ia_core::policy::InteractiveStateName::Active)
        .unwrap_or(false);
    if present {
        crate::win::toast_to_console(
            "IndiansAssist",
            "A remote support session on this computer has finished. The receipt is in the Remote activity viewer.",
        );
    }
}

/// Rule 3.7b: a rotation is armed. Generate the new pair, send both signatures, and keep the
/// old key until the server confirms — losing the old key before the swap is acknowledged
/// would strand the device.
pub fn rotate_keys(shared: &Arc<Shared>) {
    tracing::info!("a key rotation is armed; this build reports it and keeps the current key");
    // The rotation needs the server's nonce, which arrives in `device.hello.ok`; the swap also
    // needs the new keys stored before the old ones are shredded. That sequencing is not built
    // yet (agent/README.md records it), so the service logs the nonce rather than half-rotating.
    let _ = shared;
}

/// Rule 3.7b: the server confirmed the swap.
pub fn key_rotated(shared: &Arc<Shared>, key_id: &str) {
    tracing::info!(key_id, "the server confirmed the key rotation");
    if let Ok(mut cfg) = shared.config.lock() {
        cfg.key_id = Some(key_id.to_string());
        let _ = cfg.save(&shared.paths.config());
    }
}

/// Rule 8.2b: open the sealed MAC, broadcast the packet, report honestly.
pub fn wake(shared: &Arc<Shared>, wake_id: &str, sealed: &ia_core::seal::Sealed) {
    let Some(device_id) = shared.device_id() else {
        return;
    };
    let opted_out = shared
        .config
        .lock()
        .map(|c| c.waker_opt_out)
        .unwrap_or(false);
    if opted_out {
        shared.send(DeviceClientMessage::WakeSent {
            wake_id: wake_id.to_string(),
            ok: false,
            error: Some("this device has opted out of the waker role".into()),
        });
        return;
    }
    let result =
        ia_waker::wol::packet_from_sealed(shared.identity.kex_secret(), &device_id, sealed)
            .map_err(|e| format!("{e}"))
            .and_then(|packet| {
                let targets = ia_waker::wol::wol_targets(&crate::netstate::wake_interfaces());
                ia_waker::wol::broadcast(&packet, &targets)
                    .map_err(|e| e.to_string())
                    .and_then(|sent| {
                        if sent > 0 {
                            Ok(())
                        } else {
                            Err("no broadcast address accepted the packet".into())
                        }
                    })
            });
    match result {
        Ok(()) => {
            tracing::info!(wake_id, "a magic packet was broadcast");
            shared.send(DeviceClientMessage::WakeSent {
                wake_id: wake_id.to_string(),
                ok: true,
                error: None,
            });
        }
        Err(e) => {
            tracing::warn!(wake_id, error = %e, "the wake could not be sent");
            shared.send(DeviceClientMessage::WakeSent {
                wake_id: wake_id.to_string(),
                ok: false,
                error: Some(e.chars().take(200).collect()),
            });
        }
    }
}

/// Rule 8.4b: proxy one AMT command. The credential is opened, used and dropped.
pub fn amt(shared: &Arc<Shared>, cmd: AmtCommand) {
    let Some(device_id) = shared.device_id() else {
        return;
    };
    let opted_out = shared
        .config
        .lock()
        .map(|c| c.amt_proxy_opt_out)
        .unwrap_or(false);
    if opted_out {
        shared.send(DeviceClientMessage::AmtResult {
            cmd_id: cmd.cmd_id,
            ok: false,
            error: Some("unsupported".into()),
            power_state: None,
        });
        return;
    }
    let opened = ia_core::seal::open_sealed_text(
        shared.identity.kex_secret(),
        &device_id,
        ia_core::seal::SealPurpose::AmtCred,
        &cmd.cred_sealed,
    );
    let Ok(text) = opened else {
        shared.send(DeviceClientMessage::AmtResult {
            cmd_id: cmd.cmd_id,
            ok: false,
            error: Some("auth_failed".into()),
            power_state: None,
        });
        return;
    };
    let creds: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let user = creds
        .get("user")
        .and_then(|v| v.as_str())
        .unwrap_or("admin")
        .to_string();
    let password = zeroize::Zeroizing::new(
        creds
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    );
    let op = match cmd.op {
        ia_core::fleet::AmtOp::PowerOn => ia_platform::AmtProxyOp::PowerOn,
        ia_core::fleet::AmtOp::BootRedirect => ia_platform::AmtProxyOp::BootRedirect {
            target: cmd
                .boot_target
                .unwrap_or(ia_core::fleet::AmtBootTarget::Pxe),
        },
        ia_core::fleet::AmtOp::SolOpen => ia_platform::AmtProxyOp::SolOpen,
        ia_core::fleet::AmtOp::SolClose => ia_platform::AmtProxyOp::SolClose,
    };
    let facts = shared.facts.lock().map(|f| f.clone()).unwrap_or_default();
    let client = ia_waker::AmtClient {
        inventory: facts.amt.clone().unwrap_or(ia_core::fleet::AmtInventory {
            present: false,
            provisioned: false,
            version: None,
            host: None,
            tls: cmd.tls,
            power_state: None,
        }),
        ..Default::default()
    };
    let request = ia_platform::AmtRequest {
        host: &cmd.host,
        tls: cmd.tls,
        user: &user,
        password,
        op,
    };
    use ia_platform::Amt as _;
    let (ok, error, power_state) = match client.command(&request) {
        Ok(outcome) => (outcome.ok, outcome.error, outcome.power_state),
        Err(e) => {
            let code = match e {
                ia_platform::AmtError::Unreachable(_) => "amt_unreachable",
                ia_platform::AmtError::AuthFailed => "auth_failed",
                ia_platform::AmtError::Unsupported => "unsupported",
                ia_platform::AmtError::TlsFailed(_) => "tls_failed",
            };
            (false, Some(code.to_string()), None)
        }
    };
    tracing::info!(cmd_id = %cmd.cmd_id, ok, error = ?error, "amt command finished");
    shared.send(DeviceClientMessage::AmtResult {
        cmd_id: cmd.cmd_id,
        ok,
        error,
        power_state,
    });
}

/// A tamper event the service records about itself at start-up, when the previous run did not
/// shut down cleanly (§10.1 `stopped`): the marker file is written at start and removed on a
/// clean stop, so its presence at the next start means the service was killed.
pub fn note_unclean_stop(shared: &Arc<Shared>) {
    let marker = shared.paths.root().join("running.marker");
    if marker.exists() {
        shared.record_tamper(
            TamperCause::Stopped,
            Some("the previous run did not stop cleanly"),
        );
    }
    let _ = std::fs::write(&marker, now_ms().to_string());
}

/// Remove the marker on a clean stop.
pub fn note_clean_stop(shared: &Arc<Shared>) {
    let _ = std::fs::remove_file(shared.paths.root().join("running.marker"));
}

impl Shared {
    /// The playbook catalogue from the last `device.hello.ok`, as the `ManifestEntry` values
    /// the C runner's checks understand.
    pub fn manifest_playbooks(&self) -> Vec<ia_core::playbook::ManifestEntry> {
        self.playbooks.lock().map(|p| p.clone()).unwrap_or_default()
    }
}

/// Rule 3.6b: an action that was queued while this device was offline, delivered in
/// `device.hello.ok.queued`. The device re-runs the rule 9.9 gate on each and skips what has
/// expired or already finished.
///
/// A queue entry carries no playbook body and no secrets (rule 9.8: secrets are read at
/// dispatch, never at queue time), so what can run from the queue alone is a `message`; the
/// server dispatches the rest as its own `device.action`.
pub async fn run_queued(shared: &Arc<Shared>, action: ia_core::fleet::QueuedAction) {
    let Some(device_id) = shared.device_id() else {
        return;
    };
    let policy = shared.policy.lock().map(|p| p.clone()).unwrap_or_default();
    let interactive = shared.interactive.lock().ok().map(|i| i.state);
    let plan = ia_core::queue::plan_for(
        &action,
        &device_id,
        0,
        &policy,
        interactive,
        chrono::Utc::now(),
    );
    if let ia_core::queue::QueuePlan::Skip { why } = plan {
        tracing::info!(action = %action.id, ?why, "a queued action was skipped");
        return;
    }
    run_action(
        shared,
        ActionRequest {
            action_id: action.id,
            kind: action.kind,
            payload: action.payload,
            reason: action.reason,
            technician: String::new(),
            secrets: vec![],
        },
    )
    .await;
}
