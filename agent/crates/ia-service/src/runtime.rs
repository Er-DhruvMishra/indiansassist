//! The running service: the socket, the heartbeat, the session, the queue and the watchdog
//! registration, tied together (§3.4, §4, §9, §10).
//!
//! Everything here is the *doing*; the deciding is in the pure modules and in `ia-core`, which
//! is why this file has no policy logic of its own. Read it as a list of loops:
//!
//! | Loop | Cadence | What it does |
//! |---|---|---|
//! | the socket | reconnect with the C §3.1 ladder | `device.challenge` → `device.hello` → dispatch |
//! | the heartbeat | 30 s ± jitter | `device.heartbeat` with the current facts (§3.4) |
//! | the session watcher | on every `WTS_SESSION_*` and every 2 s | `device.interactive`, and §5.3 re-evaluation |
//! | the integrity check | at start and hourly | §10.3, recording `binary_changed` and refusing to spawn |
//! | the worker | per session | the §4.2 pipe: launch, `sign_sas`, notifications, teardown |

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use ia_core::backoff::Backoff;
use ia_core::fleet::{DeviceClientMessage, DeviceHelloClient, InteractiveState};
use ia_core::policy::UnattendedPolicy;
use ia_core::tamper::TamperOutbox;
use ia_platform::{DesktopBridge, DesktopTarget};
use ia_session0::desktop::{select_desktop, SessionFacts};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::config::{InstallManifest, ServiceConfig};
use crate::devicesock::{plan_for_frame, Step};
use crate::facts::{capabilities, CapabilityFacts};
use crate::identity::Identity;
use crate::paths::Paths;

/// Everything the loops share. The mutex is only ever held for a field read or write — never
/// across an await — so a slow socket cannot block the session watcher.
pub struct Shared {
    pub paths: Paths,
    pub config: Mutex<ServiceConfig>,
    pub identity: Identity,
    pub manifest: Option<InstallManifest>,
    pub install_dir: PathBuf,
    pub facts: Mutex<CapabilityFacts>,
    pub policy: Mutex<UnattendedPolicy>,
    pub outbox: Mutex<TamperOutbox>,
    pub interactive: Mutex<InteractiveState>,
    /// The playbook catalogue from the last `device.hello.ok` (rule 9.3: a queued run is
    /// checked against this, so a body that changed server-side cannot run under the old pin).
    pub playbooks: Mutex<Vec<ia_core::playbook::ManifestEntry>>,
    /// The live session, if any (§3.5a: at most one).
    pub session: Mutex<Option<crate::session::LiveSession>>,
    /// The desktop bridge every loop uses (the real one on Windows).
    pub bridge: Arc<dyn DesktopBridge>,
    /// Frames to send on the device socket, from any loop. The slot is replaced on each reconnect,
    /// so a loop that holds a clone of `Shared` always sends on the live socket.
    pub out: Mutex<mpsc::UnboundedSender<DeviceClientMessage>>,
    /// `--synthetic-capture` and friends, passed through to the worker in a dev run.
    pub worker_extra_args: Vec<String>,
}

impl Shared {
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
            tracing::debug!("the device socket is gone; the frame was dropped (it will be re-sent on reconnect)");
        }
    }

    /// Record a tamper event: to disk first (so a process that is killed still reports it), then
    /// to the server if the socket is up (§10.2).
    pub fn record_tamper(&self, cause: ia_core::fleet::TamperCause, detail: Option<&str>) {
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

    /// The client facts of a hello or a heartbeat.
    pub fn client_facts(&self, bridge: &dyn DesktopBridge) -> DeviceHelloClient {
        let facts = self.facts.lock().map(|f| f.clone()).unwrap_or_default();
        let cfg = self.config.lock().map(|c| c.clone()).ok();
        let org_id = cfg
            .as_ref()
            .and_then(|c| c.org_id.clone())
            .unwrap_or_default();
        let (segment, wake_mac) = crate::netstate::segment_and_mac(&org_id);
        let interactive = bridge.interactive_state().unwrap_or_else(|_| {
            self.interactive
                .lock()
                .map(|i| i.clone())
                .unwrap_or_else(|_| unknown_interactive())
        });
        DeviceHelloClient {
            service_version: crate::version().to_string(),
            agent_version: crate::version().to_string(),
            os_version: crate::win::facts::os_version(),
            arch: crate::win::facts::arch().to_string(),
            capabilities: capabilities(&facts),
            lan_segment: segment,
            wake_mac,
            amt: facts.amt.clone(),
            interactive,
            // Absent = windows (F §8.3e), so the Phase D wire is unchanged.
            os: None,
        }
    }
}

fn unknown_interactive() -> InteractiveState {
    InteractiveState {
        state: ia_core::policy::InteractiveStateName::None,
        idle_sec: None,
        at: now_ms(),
        display: None,
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Run the service until `stop` is signalled.
pub async fn run(shared: Arc<Shared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(socket_loop(shared.clone(), stop.clone()));
    tasks.spawn(heartbeat_loop(shared.clone(), stop.clone()));
    tasks.spawn(session_watch_loop(shared.clone(), stop.clone()));
    tasks.spawn(integrity_loop(shared.clone(), stop.clone()));
    let _ = stop.changed().await;
    tracing::info!("the service is stopping");
    // End a live session cleanly rather than leaving a worker with a pill on screen.
    if let Ok(mut s) = shared.session.lock() {
        if let Some(session) = s.take() {
            session.stop("service_stopping");
        }
    }
    tasks.shutdown().await;
}

/// The `/signal/device` socket (§3.4), with the C §3.1 reconnect ladder.
async fn socket_loop(shared: Arc<Shared>, mut stop: tokio::sync::watch::Receiver<bool>) {
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
                // §3.4: `device_disabled` pauses retries for an hour rather than hammering a
                // server that has told us plainly to stop.
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
    shared: &Arc<Shared>,
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
    // §3.4: an absent `Origin` is required on `/signal/device`, and no cookie is ever sent.
    req.headers_mut().remove("origin");
    req.headers_mut().remove("cookie");
    let (ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    tracing::info!(%url, "device socket open");
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<DeviceClientMessage>();
    // Replace the shared sender for this connection: frames queued while disconnected are
    // dropped by design — the server re-sends what matters in `device.hello.ok` (rule 3.6b),
    // and the tamper outbox is the one thing that must survive, which is why it is on disk.
    if let Ok(mut slot) = shared.out.lock() {
        *slot = tx;
    }
    // Anything the outbox still holds goes out right after the hello (§10.2 backfill).
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
                    Ok(Message::Text(text)) => {
                        match ia_core::fleet::parse_server_frame(&text) {
                            Ok(frame) => {
                                if let Some(d) = apply(shared, plan_for_frame(frame)).await {
                                    return Ok(d);
                                }
                            }
                            Err(e) => tracing::debug!(error = %e, "a frame this build does not know was ignored"),
                        }
                    }
                    Ok(Message::Ping(p)) => sink.send(Message::Pong(p)).await.map_err(|e| e.to_string())?,
                    Ok(Message::Close(_)) | Err(_) => return Ok(Disconnect::Clean),
                    _ => {}
                }
            }
        }
    }
}

/// Act on one [`Step`]. Returns `Some` when the connection must end.
async fn apply(shared: &Arc<Shared>, step: Step) -> Option<Disconnect> {
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
            let facts = shared.client_facts(shared.bridge.as_ref());
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
            tracing::info!(
                %device_id,
                queued = queued.len(),
                playbooks = playbooks.len(),
                rotation_armed,
                mode = ?policy.mode,
                "device.hello.ok"
            );
            if let Ok(mut p) = shared.policy.lock() {
                *p = *policy;
            }
            crate::devicesock::replace_manifest(&shared.playbooks, playbooks);
            // Rule 3.6b: whatever queued up while this device was offline. Each one runs on
            // its own task: a playbook may take minutes (its pinned `timeoutSec` is up to 900 s),
            // and the socket has a 30 s heartbeat to keep.
            for action in queued {
                let shared = shared.clone();
                tokio::spawn(async move { crate::session::run_queued(&shared, action).await });
            }
            // §10.2: the outbox goes out right after the hello, before anything else.
            if let Ok(outbox) = shared.outbox.lock() {
                if !outbox.is_empty() {
                    shared.send(DeviceClientMessage::Tamper {
                        events: outbox.batch(),
                    });
                }
            }
            if rotation_armed {
                crate::session::rotate_keys(shared);
            }
        }
        Step::OpenSession(open) => {
            // The launch blocks (the pipe accept waits up to 20 s for the worker to connect),
            // so it runs on a blocking task while the socket keeps heartbeating.
            let shared = shared.clone();
            tokio::task::spawn_blocking(move || crate::session::open_blocking(&shared, *open));
        }
        Step::WorkerCredential {
            session_id,
            gen,
            credential,
        } => crate::session::credential_arrived(shared, &session_id, gen, credential),
        Step::RunAction(req) => {
            // As above: the action is dispatched, not awaited here.
            let shared = shared.clone();
            tokio::spawn(async move { crate::session::run_action(&shared, *req).await });
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
        Step::Receipt(receipt) => crate::session::store_receipt(shared, &receipt),
        Step::TamperAcknowledged { ids } => {
            if let Ok(mut outbox) = shared.outbox.lock() {
                let removed = outbox.acknowledge(&ids);
                let _ = crate::tamperstore::rewrite(&shared.paths.tamper_log(), &outbox);
                tracing::info!(removed, "tamper events acknowledged");
            }
        }
        Step::KeyRotated { key_id } => crate::session::key_rotated(shared, &key_id),
        Step::Wake { wake_id, sealed } => {
            // A broadcast is quick, but it is still a socket call; keep it off this loop.
            let shared = shared.clone();
            tokio::task::spawn_blocking(move || crate::session::wake(&shared, &wake_id, &sealed));
        }
        Step::Amt(cmd) => {
            // An AMT host that is powered off takes the full HTTP timeout to say so (rule
            // 8.4e), which is exactly the kind of wait the device socket must not take.
            let shared = shared.clone();
            tokio::task::spawn_blocking(move || crate::session::amt(&shared, *cmd));
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
async fn heartbeat_loop(shared: Arc<Shared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        let jitter = ia_core::backoff::jitter_ms(crate::HEARTBEAT_SEC * 1000, 0.16);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(jitter)) => {}
            _ = stop.changed() => return,
        }
        let facts = shared.client_facts(shared.bridge.as_ref());
        shared.send(DeviceClientMessage::Heartbeat {
            lan_segment: Some(facts.lan_segment),
            wake_mac: facts.wake_mac,
            amt: facts.amt,
            interactive: Some(facts.interactive),
            metrics: None,
        });
    }
}

/// §4.1 / §5.3: report the interactive state within 2 s of a change, and re-evaluate which
/// desktop a live session should target.
async fn session_watch_loop(shared: Arc<Shared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    let mut last: Option<SessionFacts> = None;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(2000)) => {}
            _ = stop.changed() => return,
        }
        let facts = crate::netstate::read_facts();
        let state = ia_session0::derive_interactive(&facts);
        let changed = last
            .as_ref()
            .map(|l| ia_session0::derive_interactive(l).state != state.state)
            .unwrap_or(true);
        if changed {
            if let Ok(mut i) = shared.interactive.lock() {
                *i = state.clone();
            }
            shared.send(DeviceClientMessage::Interactive {
                interactive: state.clone(),
            });
            tracing::info!(state = ?state.state, "interactive state reported");
        }
        if let Some(previous) = &last {
            crate::session::desktop_changed(&shared, previous, &facts).await;
        }
        last = Some(facts);
    }
}

/// §10.3: at start and every hour.
async fn integrity_loop(shared: Arc<Shared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        check_integrity(&shared);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(crate::INTEGRITY_CHECK_SEC)) => {}
            _ = stop.changed() => return,
        }
    }
}

/// One §10.3 pass. A changed or missing binary records `binary_changed` and stops the worker
/// from being spawned until it is repaired (the launch verdict reads this).
pub fn check_integrity(shared: &Arc<Shared>) -> bool {
    let Some(manifest) = &shared.manifest else {
        tracing::warn!("no manifest.json: the integrity self-check cannot run on this install");
        return true;
    };
    let report = crate::tamperstore::check_binaries(&shared.install_dir, manifest);
    if !report.binaries_ok() {
        shared.record_tamper(
            ia_core::fleet::TamperCause::BinaryChanged,
            Some(&report.summary()),
        );
        return false;
    }
    if !report.unreadable.is_empty() {
        tracing::warn!(files = ?report.unreadable, "some installed files could not be read for the self-check");
    }
    true
}

/// The desktop a session's worker should be on right now (§5.3).
pub fn current_target() -> DesktopTarget {
    select_desktop(&crate::netstate::read_facts())
}
