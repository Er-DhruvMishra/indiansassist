//! The running Linux service (F §8): the D §3.4 device socket, the heartbeat, logind, the
//! integrity check and the systemd watchdog, tied together. Read it as a list of loops:
//!
//! | Loop | Cadence | What it does |
//! |---|---|---|
//! | the socket | reconnect with the C §3.1 ladder | `device.challenge` → `device.hello` (`os: 'linux'`) → dispatch |
//! | the heartbeat | 30 s ± jitter | `device.heartbeat` with the current facts (§3.4) |
//! | logind | on every logind signal and every 2 s | `device.interactive` (with `display`), the worker's `interactive` frame, and ending the worker on a session switch (§8.4) |
//! | the integrity check | at start and hourly | `binary_changed` / `config_changed` against the installed file list, when the package ships one (§8.8) |
//! | the watchdog | every 20 s | `WATCHDOG=1` (§8.8) |
//!
//! Every decision is in a pure module (`ia_core`, `crate::devicesock`, `crate::worker`,
//! `ia_platform::linux::service`); this file only carries them out, as the Windows runtime does.

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use ia_core::backoff::Backoff;
use ia_core::fleet::{
    DeviceClientMessage, DeviceHelloClient, InteractiveState, LanSegment, ReportedActionState,
    TamperCause,
};
use ia_core::policy::{InteractiveStateName, UnattendedPolicy};
use ia_core::tamper::TamperOutbox;
use ia_platform::linux::service::{logind_facts, sys, LogindSession, NOTIFY_STOPPING};
use ia_session0::proto::ServiceFrame;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use super::paths::LinuxLayout;
use super::spawn::{DevOverrides, LiveWorker};
use crate::config::{InstallManifest, ServiceConfig};
use crate::devicesock::{plan_for_frame, ActionRequest, SessionOpen, Step};
use crate::facts::CapabilityFacts;
use crate::identity::Identity;
use crate::paths::Paths;

/// How often logind is re-read when no signal arrived (the belt to the signals' braces).
const LOGIND_POLL: Duration = Duration::from_secs(2);
/// The marker gateway of a network that could not be read (rule 8.2a; as on Windows).
const UNKNOWN_GATEWAY: &str = "00:00:00:00:00:00";

/// Everything the loops share. A mutex is only ever held for a field read or write, never across
/// an await.
pub struct LinuxShared {
    pub layout: LinuxLayout,
    pub paths: Paths,
    pub config: Mutex<ServiceConfig>,
    pub identity: Identity,
    pub manifest: Option<InstallManifest>,
    pub facts: Mutex<CapabilityFacts>,
    pub policy: Mutex<UnattendedPolicy>,
    pub outbox: Mutex<TamperOutbox>,
    pub interactive: Mutex<InteractiveState>,
    /// The last logind reading of seat0's active session.
    pub logind: Mutex<Option<LogindSession>>,
    pub playbooks: Mutex<Vec<ia_core::playbook::ManifestEntry>>,
    /// The live session's worker (rule 3.5a: at most one).
    pub session: Mutex<Option<LiveWorker>>,
    pub out: Mutex<mpsc::UnboundedSender<DeviceClientMessage>>,
    /// Arguments passed through to the worker (dev `--worker-arg`).
    pub worker_extra_args: Vec<String>,
    pub dev: DevOverrides,
    /// Dev `--console` mode: the current user, no uid change, nothing of the real system named.
    pub dev_console: bool,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The state reported before logind has been read (and whenever it cannot be).
pub fn nobody() -> InteractiveState {
    InteractiveState {
        state: InteractiveStateName::None,
        idle_sec: None,
        at: now_ms(),
        display: None,
    }
}

/// The segment of a machine whose network could not be read: org-salted and stable.
fn empty_segment(org_id: &str) -> LanSegment {
    ia_waker::segment::lan_segment(
        org_id,
        std::net::Ipv4Addr::new(0, 0, 0, 0),
        UNKNOWN_GATEWAY,
        None,
    )
    .expect("the marker gateway is a valid MAC")
}

/// Rule 8.2a: the org-salted segment hashes and this device's own wake MAC.
pub fn segment_and_mac(org_id: &str) -> (LanSegment, Option<String>) {
    let interfaces = sys::ipv4_interfaces();
    let gateway = sys::gateway();
    let primary = gateway
        .as_ref()
        .and_then(|(name, _, _)| interfaces.iter().find(|i| &i.name == name))
        .or_else(|| interfaces.first());
    let Some(iface) = primary else {
        return (empty_segment(org_id), None);
    };
    let gateway_mac = gateway
        .and_then(|(_, _, mac)| mac)
        .unwrap_or_else(|| UNKNOWN_GATEWAY.to_string());
    let segment = ia_waker::segment::lan_segment(org_id, iface.addr, &gateway_mac, None)
        .unwrap_or_else(|| empty_segment(org_id));
    (segment, iface.mac.as_ref().map(|m| m.replace(':', "")))
}

impl LinuxShared {
    pub fn device_id(&self) -> Option<String> {
        self.config.lock().ok().and_then(|c| c.device_id.clone())
    }

    pub fn send(&self, msg: DeviceClientMessage) {
        let sent = self
            .out
            .lock()
            .map(|tx| tx.send(msg).is_ok())
            .unwrap_or(false);
        if !sent {
            tracing::debug!("the device socket is gone; the frame was dropped");
        }
    }

    /// Record a tamper event: to disk first, then to the server if the socket is up (§10.2).
    pub fn record_tamper(&self, cause: TamperCause, detail: Option<&str>) {
        let Some(device_id) = self.device_id() else {
            tracing::warn!(
                cause = cause.as_str(),
                "a tamper event before enrollment is only logged"
            );
            return;
        };
        match crate::tamperstore::record(
            &self.paths.tamper_log(),
            &device_id,
            &self.identity,
            cause,
            detail,
        ) {
            Ok(event) => {
                if let Ok(mut outbox) = self.outbox.lock() {
                    outbox.push(event);
                    self.send(DeviceClientMessage::Tamper {
                        events: outbox.batch(),
                    });
                }
                tracing::warn!(cause = cause.as_str(), detail = ?detail, "tamper event recorded");
            }
            Err(e) => {
                tracing::error!(error = %e, cause = cause.as_str(), "the tamper event could not be written")
            }
        }
    }

    /// The client facts of a hello or a heartbeat (§3.4 with the §8.3e `os` and `display`).
    pub fn client_facts(&self) -> DeviceHelloClient {
        let facts = self.facts.lock().map(|f| f.clone()).unwrap_or_default();
        let (org_id, waker_opt_out) = self
            .config
            .lock()
            .map(|c| (c.org_id.clone().unwrap_or_default(), c.waker_opt_out))
            .unwrap_or_default();
        let (segment, wake_mac) = segment_and_mac(&org_id);
        let interactive = self
            .interactive
            .lock()
            .map(|i| i.clone())
            .unwrap_or_else(|_| nobody());
        DeviceHelloClient {
            service_version: crate::version().to_string(),
            agent_version: crate::version().to_string(),
            os_version: super::facts::os_version(),
            arch: super::facts::arch().to_string(),
            capabilities: super::facts::capabilities(
                facts.monitors,
                waker_opt_out,
                crate::version(),
            ),
            lan_segment: segment,
            wake_mac,
            amt: None,
            interactive,
            os: Some("linux".to_string()),
        }
    }

    pub fn manifest_playbooks(&self) -> Vec<ia_core::playbook::ManifestEntry> {
        self.playbooks.lock().map(|p| p.clone()).unwrap_or_default()
    }
}

/// Run the service until `stop` is signalled.
pub async fn run(shared: Arc<LinuxShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    {
        let shared = shared.clone();
        let _ = tokio::task::spawn_blocking(move || note_restarts(&shared)).await;
    }
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(socket_loop(shared.clone(), stop.clone()));
    tasks.spawn(heartbeat_loop(shared.clone(), stop.clone()));
    tasks.spawn(logind_loop(shared.clone(), stop.clone()));
    tasks.spawn(integrity_loop(shared.clone(), stop.clone()));
    tasks.spawn(super::sdnotify::watchdog_loop(stop.clone()));
    let _ = stop.changed().await;
    tracing::info!("the service is stopping");
    let _ = sys::sd_notify(NOTIFY_STOPPING);
    // End a live session cleanly rather than leaving a worker with a pill on screen (§8.5).
    let live = shared.session.lock().ok().and_then(|mut s| s.take());
    if let Some(live) = live {
        let _ = tokio::task::spawn_blocking(move || live.stop("service_stopping")).await;
    }
    tasks.shutdown().await;
}

/// §8.8: `watchdog_restarted` when systemd's `NRestarts` for our unit grew since the last run.
fn note_restarts(shared: &Arc<LinuxShared>) {
    if shared.dev_console {
        return;
    }
    use ia_platform::linux::service::SystemdUnits as _;
    match super::sdnotify::SystemdBus::default()
        .n_restarts(&format!("{}.service", crate::SERVICE_NAME))
    {
        Ok(n) => {
            if super::sdnotify::note_restarts(&shared.layout.restarts_seen(), n) {
                shared.record_tamper(
                    TamperCause::WatchdogRestarted,
                    Some(&format!("systemd restarted the service (NRestarts {n})")),
                );
            }
        }
        Err(e) => tracing::debug!(error = %e, "NRestarts could not be read"),
    }
}

/// The `/signal/device` socket (§3.4), with the C §3.1 reconnect ladder.
async fn socket_loop(shared: Arc<LinuxShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    let mut backoff = Backoff::default();
    loop {
        if *stop.borrow() {
            return;
        }
        let url = shared
            .config
            .lock()
            .map(|c| c.signal_url.clone())
            .unwrap_or_default();
        match one_connection(&shared, &url, &mut stop).await {
            Ok(Disconnect::Clean) => {
                backoff.reset();
                tracing::info!("the device socket closed; reconnecting");
            }
            Ok(Disconnect::Fatal { code }) => {
                tracing::error!(code, "the server refused this device; pausing for an hour");
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(3600)) => {}
                    _ = stop.changed() => return,
                }
                backoff.reset();
            }
            Err(e) => {
                let wait = backoff.next_delay();
                tracing::warn!(error = %e, secs = wait.as_secs_f32(), "the device socket failed; backing off");
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = stop.changed() => return,
                }
            }
        }
    }
}

enum Disconnect {
    Clean,
    Fatal { code: String },
}

async fn one_connection(
    shared: &Arc<LinuxShared>,
    url: &str,
    stop: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Disconnect, String> {
    let mut req = url
        .into_client_request()
        .map_err(|e| format!("bad signal url: {e}"))?;
    req.headers_mut().insert(
        "user-agent",
        HeaderValue::from_str(&crate::user_agent()).map_err(|e| e.to_string())?,
    );
    // §3.4: an absent `Origin` on `/signal/device`, and never a cookie.
    req.headers_mut().remove("origin");
    req.headers_mut().remove("cookie");
    // wss: is verified by the operating system (`ia_platform::tls`, licence audit F1).
    let connector = match req.uri().scheme_str() {
        Some("wss") => Some(tokio_tungstenite::Connector::Rustls(
            ia_platform::tls::client_config()?,
        )),
        _ => None,
    };
    let (ws, _) = tokio_tungstenite::connect_async_tls_with_config(req, None, false, connector)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    tracing::info!(%url, "device socket open");
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<DeviceClientMessage>();
    if let Ok(mut slot) = shared.out.lock() {
        *slot = tx;
    }
    loop {
        tokio::select! {
            _ = stop.changed() => return Ok(Disconnect::Clean),
            out = rx.recv() => {
                let Some(msg) = out else { return Ok(Disconnect::Clean) };
                let text = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
                sink.send(Message::Text(text)).await.map_err(|e| format!("send: {e}"))?;
            }
            inbound = stream.next() => {
                let Some(msg) = inbound else { return Ok(Disconnect::Clean) };
                match msg {
                    Ok(Message::Text(text)) => match ia_core::fleet::parse_server_frame(&text) {
                        Ok(frame) => {
                            if let Some(d) = apply(shared, plan_for_frame(frame)).await {
                                return Ok(d);
                            }
                        }
                        Err(e) => tracing::debug!(error = %e, "a frame this build does not know was ignored"),
                    },
                    Ok(Message::Ping(p)) => sink.send(Message::Pong(p)).await.map_err(|e| e.to_string())?,
                    Ok(Message::Close(_)) | Err(_) => return Ok(Disconnect::Clean),
                    _ => {}
                }
            }
        }
    }
}

/// Act on one [`Step`]. Returns `Some` when the connection must end.
async fn apply(shared: &Arc<LinuxShared>, step: Step) -> Option<Disconnect> {
    match step {
        Step::Hello { server_challenge } => {
            let (Some(device_id), Some(key_id)) = (
                shared.device_id(),
                shared.config.lock().ok().and_then(|c| c.key_id.clone()),
            ) else {
                tracing::error!("a challenge arrived before this device was enrolled");
                return Some(Disconnect::Fatal {
                    code: "not_enrolled".into(),
                });
            };
            let facts = shared.client_facts();
            match crate::devicesock::hello_for(
                &device_id,
                &key_id,
                &server_challenge,
                &shared.identity,
                facts,
            ) {
                Ok(hello) => shared.send(hello),
                Err(e) => tracing::error!(error = ?e, "the hello could not be signed"),
            }
        }
        Step::Ready {
            device_id,
            policy,
            queued,
            playbooks,
            rotation_armed,
        } => {
            tracing::info!(%device_id, queued = queued.len(), playbooks = playbooks.len(), mode = ?policy.mode, "device.hello.ok");
            if let Ok(mut p) = shared.policy.lock() {
                *p = *policy;
            }
            crate::devicesock::replace_manifest(&shared.playbooks, playbooks);
            for action in queued {
                let shared = shared.clone();
                tokio::spawn(async move { run_queued(&shared, action).await });
            }
            if let Ok(outbox) = shared.outbox.lock() {
                if !outbox.is_empty() {
                    shared.send(DeviceClientMessage::Tamper {
                        events: outbox.batch(),
                    });
                }
            }
            if rotation_armed {
                tracing::info!(
                    "a key rotation is armed; this build reports it and keeps the current key"
                );
            }
        }
        Step::OpenSession(open) => {
            let shared = shared.clone();
            tokio::task::spawn_blocking(move || open_session(&shared, *open));
        }
        Step::WorkerCredential {
            session_id,
            gen,
            credential,
        } => {
            let shared = shared.clone();
            tokio::task::spawn_blocking(move || {
                credential_arrived(&shared, &session_id, gen, credential)
            });
        }
        Step::RunAction(req) => {
            let shared = shared.clone();
            tokio::spawn(async move { run_action(&shared, *req).await });
        }
        Step::Policy(policy) => {
            tracing::info!(mode = ?policy.mode, "the effective policy changed");
            if let Ok(mut p) = shared.policy.lock() {
                *p = *policy;
            }
        }
        Step::Playbooks(playbooks) => {
            let n = crate::devicesock::replace_manifest(&shared.playbooks, playbooks);
            tracing::info!(playbooks = n, "the playbook catalogue changed");
        }
        Step::Receipt(receipt) => store_receipt(shared, &receipt),
        Step::TamperAcknowledged { ids } => {
            if let Ok(mut outbox) = shared.outbox.lock() {
                let removed = outbox.acknowledge(&ids);
                let _ = crate::tamperstore::rewrite(&shared.paths.tamper_log(), &outbox);
                tracing::info!(removed, "tamper events acknowledged");
            }
        }
        Step::KeyRotated { key_id } => {
            if let Ok(mut cfg) = shared.config.lock() {
                cfg.key_id = Some(key_id);
                let _ = cfg.save(&shared.paths.config());
            }
        }
        Step::Wake { wake_id, sealed } => {
            let shared = shared.clone();
            tokio::task::spawn_blocking(move || wake(&shared, &wake_id, &sealed));
        }
        Step::Amt(cmd) => {
            // §8.2 / §8.7: no AMT on Linux in Phase F; `amt_proxy` is not advertised, so this
            // only answers a server that sent it anyway.
            shared.send(DeviceClientMessage::AmtResult {
                cmd_id: cmd.cmd_id,
                ok: false,
                error: Some("unsupported".into()),
                power_state: None,
            });
        }
        Step::ServerError { code, fatal } => {
            tracing::warn!(code, fatal, "the server answered with an error");
            if fatal {
                return Some(Disconnect::Fatal { code });
            }
        }
        Step::Pong => shared.send(DeviceClientMessage::Pong { re: None }),
        Step::Ignore => {}
    }
    None
}

/// §3.4: every 30 s ± 5 s.
async fn heartbeat_loop(shared: Arc<LinuxShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        let jitter = ia_core::backoff::jitter_ms(crate::HEARTBEAT_SEC * 1000, 0.16);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(jitter)) => {}
            _ = stop.changed() => return,
        }
        let facts = shared.client_facts();
        shared.send(DeviceClientMessage::Heartbeat {
            lan_segment: Some(facts.lan_segment),
            wake_mac: facts.wake_mac,
            amt: facts.amt,
            interactive: Some(facts.interactive),
            metrics: None,
        });
    }
}

/// The logind bus to use: the system bus in production, the `--system-bus` of a dev run, and
/// **none** for a dev run without one (it never names the real system bus, S3).
fn logind_bus(shared: &LinuxShared) -> Option<Option<String>> {
    if shared.dev_console {
        shared.dev.system_bus.clone().map(Some)
    } else {
        Some(None)
    }
}

/// §8.4: read seat0's active session on every logind signal (and every 2 s), report the
/// interactive state, and end the worker when its session is no longer the target.
async fn logind_loop(shared: Arc<LinuxShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    let Some(address) = logind_bus(&shared) else {
        tracing::warn!(
            "dev mode without --system-bus: logind is not consulted and nobody is signed in"
        );
        evaluate(&shared, None);
        let _ = stop.changed().await;
        return;
    };
    loop {
        match super::logind::connect(address.as_deref()).await {
            Ok(conn) => {
                let mut watch = super::logind::Watch::new(&conn).await.ok();
                loop {
                    match super::logind::active_session(&conn).await {
                        Ok(s) => evaluate(&shared, s),
                        Err(e) => {
                            tracing::warn!(error = %e, "logind could not be read");
                            break;
                        }
                    }
                    let alive = match watch.as_mut() {
                        Some(w) => tokio::select! {
                            more = w.changed(LOGIND_POLL) => more,
                            _ = stop.changed() => return,
                        },
                        None => tokio::select! {
                            _ = tokio::time::sleep(LOGIND_POLL) => true,
                            _ = stop.changed() => return,
                        },
                    };
                    if !alive {
                        break;
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "the logind bus could not be reached"),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            _ = stop.changed() => return,
        }
    }
}

/// What a fresh logind reading means for the live worker (pure; tested).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerFate {
    /// No worker, or nothing it needs to hear.
    Keep,
    /// Tell it the new interactive state (a lock or an unlock, 8.4e).
    Notify,
    /// Its session is no longer the target (a switch, a log-out, a greeter): end it (§8.5).
    End,
}

pub fn worker_fate(
    live_logind_id: Option<&str>,
    session: Option<&LogindSession>,
    state_changed: bool,
) -> WorkerFate {
    let Some(live) = live_logind_id else {
        return WorkerFate::Keep;
    };
    let verdict = logind_facts(session);
    let same = verdict.is_target && session.is_some_and(|s| s.id == live);
    if !same {
        WorkerFate::End
    } else if state_changed {
        WorkerFate::Notify
    } else {
        WorkerFate::Keep
    }
}

fn evaluate(shared: &Arc<LinuxShared>, session: Option<LogindSession>) {
    let verdict = logind_facts(session.as_ref());
    let state = verdict.interactive_state(now_ms());
    let changed = shared
        .interactive
        .lock()
        .map(|i| i.state != state.state || i.display != state.display)
        .unwrap_or(true);
    if let Ok(mut l) = shared.logind.lock() {
        *l = session.clone();
    }
    if changed {
        if let Ok(mut i) = shared.interactive.lock() {
            *i = state.clone();
        }
        shared.send(DeviceClientMessage::Interactive {
            interactive: state.clone(),
        });
        tracing::info!(state = ?state.state, display = ?state.display, "interactive state reported");
    } else if let Ok(mut i) = shared.interactive.lock() {
        i.idle_sec = state.idle_sec;
        i.at = state.at;
    }
    let live_id = shared
        .session
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|l| l.logind_id.clone()));
    match worker_fate(live_id.as_deref(), session.as_ref(), changed) {
        WorkerFate::Keep => {}
        WorkerFate::Notify => {
            if let Ok(guard) = shared.session.lock() {
                if let Some(live) = guard.as_ref() {
                    live.notify(&ServiceFrame::Interactive { interactive: state });
                }
            }
        }
        WorkerFate::End => {
            let live = shared.session.lock().ok().and_then(|mut s| s.take());
            if let Some(live) = live {
                tracing::info!(session = %live.session_id, "the worker's session is no longer the target; ending it");
                std::thread::spawn(move || live.stop("session_switch"));
            }
        }
    }
}

/// §8.8: at start and every hour.
async fn integrity_loop(shared: Arc<LinuxShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        check_integrity(&shared);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(crate::INTEGRITY_CHECK_SEC)) => {}
            _ = stop.changed() => return,
        }
    }
}

/// One §8.8 pass against the installed file list. Without one (a dev build, a package that ships
/// none) it is skipped quietly. A changed binary records `binary_changed` and stops the worker
/// from being launched; a changed list records `config_changed`.
pub fn check_integrity(shared: &LinuxShared) -> bool {
    let Some(manifest) = &shared.manifest else {
        return true;
    };
    let digest = manifest.digest();
    let seen_file = shared.layout.manifest_seen();
    let seen = std::fs::read_to_string(&seen_file).ok();
    if seen.as_deref().is_some_and(|s| s.trim() != digest) {
        shared.record_tamper(
            TamperCause::ConfigChanged,
            Some("the installed file list changed"),
        );
    }
    let _ = std::fs::write(&seen_file, &digest);
    let report = crate::tamperstore::check_binaries(&shared.layout.install, manifest);
    if !report.binaries_ok() {
        shared.record_tamper(TamperCause::BinaryChanged, Some(&report.summary()));
        return false;
    }
    true
}

/// §4.2 / §8.5: launch a worker for a new session. Blocking.
fn open_session(shared: &Arc<LinuxShared>, open: SessionOpen) {
    if let Ok(guard) = shared.session.lock() {
        if let Some(live) = guard.as_ref() {
            tracing::warn!(live = %live.session_id, new = %open.session_id, "a session is already live; the new one is refused");
            return;
        }
    }
    let session = shared.logind.lock().ok().and_then(|s| s.clone());
    let verdict = logind_facts(session.as_ref());
    let Some(session) = session.filter(|_| verdict.is_target) else {
        // 8.4f: the server refuses a session to a Linux device whose state is `none`
        // (`prelogin_unsupported`); this is the device's own second line.
        tracing::error!(session = %open.session_id, "nobody is signed in to a graphical session; the worker is not launched");
        return;
    };
    if !check_integrity(shared) {
        tracing::error!(
            "the worker is not launched: the installed binaries do not match the file list"
        );
        return;
    }
    match super::spawn::launch(shared, &session, &open, 0) {
        Ok(live) => {
            tracing::info!(session = %live.session_id, pid = live.pid, logind = %live.logind_id, "worker launched");
            if let Ok(mut s) = shared.session.lock() {
                *s = Some(live);
            }
        }
        Err(e) => {
            tracing::error!(error = %e, session = %open.session_id, "the worker could not be launched")
        }
    }
}

/// A fresh worker credential (rule 3.6d): relaunch the worker at the new generation. A rebuild
/// never asks anybody again, so the decision becomes `auto_grant` (as on Windows).
fn credential_arrived(
    shared: &Arc<LinuxShared>,
    session_id: &str,
    gen: u16,
    credential: ia_core::fleet::Secret,
) {
    let previous = shared.session.lock().ok().and_then(|mut s| s.take());
    let Some(previous) = previous else {
        tracing::warn!(session = %session_id, "a worker credential arrived with no live session");
        return;
    };
    if previous.session_id != session_id {
        if let Ok(mut s) = shared.session.lock() {
            *s = Some(previous);
        }
        return;
    }
    previous.stop("rebuild");
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
    let session = shared.logind.lock().ok().and_then(|s| s.clone());
    let Some(session) = session.filter(|s| logind_facts(Some(s)).is_target) else {
        tracing::warn!("the rebuild found no target session");
        return;
    };
    match super::spawn::launch(shared, &session, &open, gen) {
        Ok(live) => {
            if let Ok(mut s) = shared.session.lock() {
                *s = Some(live);
            }
        }
        Err(e) => tracing::error!(error = %e, "the rebuilt worker could not be launched"),
    }
}

/// §9 / §8.6: one action, gated again on the device and then performed **as root** by the
/// service (`ranAs: 'admin'`).
pub async fn run_action(shared: &Arc<LinuxShared>, req: ActionRequest) {
    let Some(device_id) = shared.device_id() else {
        return;
    };
    let policy = shared.policy.lock().map(|p| p.clone()).unwrap_or_default();
    let interactive = shared.interactive.lock().ok().map(|i| i.state);
    let queued = ia_core::fleet::QueuedAction {
        id: req.action_id.clone(),
        device_id: device_id.clone(),
        kind: req.kind,
        payload: req.payload.clone(),
        state: "dispatched".to_string(),
        reason: req.reason.clone(),
        approved_by: None,
        created_at: String::new(),
        expires_at: String::new(),
    };
    let plan = ia_core::queue::plan_for(
        &queued,
        &device_id,
        req.secrets.len(),
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
            ia_core::policy::ActionDecision::Run { approved_by, .. } => approved_by,
            _ => ia_core::policy::ApprovedBy::Policy,
        },
        QueuePlan::Approval { .. } => {
            report(ReportedActionState::AwaitingApproval, None, None);
            return;
        }
        QueuePlan::Hold => return,
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

/// Rule 3.6b: an action queued while this device was offline.
async fn run_queued(shared: &Arc<LinuxShared>, action: ia_core::fleet::QueuedAction) {
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

/// Fetch a `file_push` body (rule 9.4), bounded by the native file limit.
fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let max = ia_core::types::limits::FILE_MAX_BYTES_NATIVE;
    let resp = ia_waker::https::agent(Duration::from_secs(120))
        .get(url)
        .set("user-agent", &crate::user_agent())
        .call()
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(max + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() as u64 > max {
        return Err("the file is larger than this device accepts".into());
    }
    Ok(buf)
}

/// Perform one action after the gate.
fn perform(shared: &Arc<LinuxShared>, req: &ActionRequest) -> crate::actions::Outcome {
    use ia_core::policy::DeviceActionKind as K;
    match req.kind {
        // A root service shows no UI in anybody's session; the message is reported honestly as
        // not shown (rule 9.6), and a technician who needs a person uses a session's chat.
        K::Message => crate::actions::run_message(&req.payload, |_, _| false),
        K::FilePush => crate::actions::run_file_push(
            &req.payload,
            &shared.paths.pushes(),
            ia_core::types::limits::FILE_MAX_BYTES_NATIVE,
            fetch_bytes,
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
            // §8.6: an `sh` device action runs in the service as root, with the E §7.8 runner
            // rules (body on fd 3, stdin /dev/null, IA_PARAM_*, process-group kill).
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

/// §6.4: store the receipt on the device.
fn store_receipt(shared: &Arc<LinuxShared>, receipt: &serde_json::Value) {
    let dir = shared.paths.receipts();
    let _ = std::fs::create_dir_all(&dir);
    let id = receipt
        .get("sessionId")
        .or_else(|| receipt.get("actionId"))
        .and_then(|v| v.as_str())
        .unwrap_or("receipt");
    if let Some(path) = shared
        .paths
        .inside(&dir, &format!("{}-{}.json", id, now_ms()))
    {
        match std::fs::write(
            &path,
            serde_json::to_vec_pretty(receipt).unwrap_or_default(),
        ) {
            Ok(()) => tracing::info!(path = %path.display(), "receipt stored"),
            Err(e) => tracing::warn!(error = %e, "the receipt could not be stored"),
        }
    }
}

/// Rule 8.2b: open the sealed MAC and broadcast the packet (`ia-waker`'s UDP broadcast).
fn wake(shared: &Arc<LinuxShared>, wake_id: &str, sealed: &ia_core::seal::Sealed) {
    let Some(device_id) = shared.device_id() else {
        return;
    };
    let opted_out = shared
        .config
        .lock()
        .map(|c| c.waker_opt_out)
        .unwrap_or(false);
    let result = if opted_out {
        Err("this device has opted out of the waker role".to_string())
    } else {
        ia_waker::wol::packet_from_sealed(shared.identity.kex_secret(), &device_id, sealed)
            .map_err(|e| format!("{e}"))
            .and_then(|packet| {
                let ifaces: Vec<_> = sys::ipv4_interfaces()
                    .into_iter()
                    .map(|i| (i.addr, i.prefix_len))
                    .collect();
                let targets = ia_waker::wol::wol_targets(&ifaces);
                match ia_waker::wol::broadcast(&packet, &targets) {
                    Ok(n) if n > 0 => Ok(()),
                    Ok(_) => Err("no broadcast address accepted the packet".into()),
                    Err(e) => Err(e.to_string()),
                }
            })
    };
    shared.send(DeviceClientMessage::WakeSent {
        wake_id: wake_id.to_string(),
        ok: result.is_ok(),
        error: result.err().map(|e| e.chars().take(200).collect()),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, locked: bool, class: &str) -> LogindSession {
        LogindSession {
            id: id.into(),
            uid: 1000,
            class: class.into(),
            type_: "x11".into(),
            active: true,
            remote: false,
            locked_hint: locked,
            idle_sec: Some(0),
            display: ":0".into(),
        }
    }

    #[test]
    fn a_worker_is_ended_when_its_session_stops_being_the_target() {
        // No worker: nothing to do.
        assert_eq!(
            worker_fate(None, Some(&s("2", false, "user")), true),
            WorkerFate::Keep
        );
        // Same session, unchanged: keep; locked: tell the worker (8.4e).
        assert_eq!(
            worker_fate(Some("2"), Some(&s("2", false, "user")), false),
            WorkerFate::Keep
        );
        assert_eq!(
            worker_fate(Some("2"), Some(&s("2", true, "user")), true),
            WorkerFate::Notify
        );
        // A fast user switch, a greeter, a log-out: end it (§8.5).
        assert_eq!(
            worker_fate(Some("2"), Some(&s("3", false, "user")), true),
            WorkerFate::End
        );
        assert_eq!(
            worker_fate(Some("2"), Some(&s("2", false, "greeter")), true),
            WorkerFate::End
        );
        assert_eq!(worker_fate(Some("2"), None, true), WorkerFate::End);
    }

    #[test]
    fn nobody_signed_in_reports_none_without_a_display() {
        let n = nobody();
        assert_eq!(n.state, InteractiveStateName::None);
        assert_eq!(n.display, None);
    }

    #[test]
    fn an_unreadable_network_still_has_an_org_salted_segment() {
        let a = empty_segment("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b");
        let b = empty_segment("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
        assert_ne!(a.subnet_hash, b.subnet_hash);
    }
}
