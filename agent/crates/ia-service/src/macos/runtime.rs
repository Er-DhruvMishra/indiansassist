//! The running macOS daemon (Phase F §17.3): the D §3.4 device socket, the heartbeat, the console
//! watch, the integrity check and the worker socket, tied together. Read it as a list of loops:
//!
//! | Loop | Cadence | What it does |
//! |---|---|---|
//! | the socket | reconnect with the C §3.1 ladder | `device.challenge` → `device.hello` (`os: 'macos'`) → dispatch |
//! | the heartbeat | 30 s ± jitter | `device.heartbeat` with the current facts (§3.4) |
//! | the console | every 2 s, and on every lock report | `device.interactive`, the worker's `interactive` frame, and ending the session when the console user changes |
//! | the integrity check | at start and hourly | `binary_changed` / `config_changed` against the installed file list, when the package ships one |
//! | the run marker | at start and at a clean stop | `watchdog_restarted` after a death in this boot ([`super::runmarker`]) |
//! | the worker socket | on every connection | the handshake of [`super::workersock`]; an admitted worker waits here for a session |
//!
//! **The workers come to the daemon.** launchd starts the LaunchAgent `ia-desktop` in every GUI
//! login session; it connects, is admitted, and waits. A session is handed to the console user's
//! waiting worker by writing the launch blob down its connection; the worker serves that one
//! session and exits, and launchd starts a fresh one that connects again. Before a session the
//! worker reports its screen lock (`DesktopSwitch { reason: "screen_locked" | "screen_unlocked" }`)
//! and its monitor count, so the interactive state is known without a session.
//!
//! **Fast user switching:** only the console user's worker is ever handed a session. When the
//! console user changes (a switch, a log-out, the login window), the live session is ended, as on
//! Windows when the session switches, and the state is `none` while the login window is up.
//!
//! Every decision is in a pure module (`ia_core`, `crate::devicesock`, `crate::worker`,
//! `ia_platform::macos::service`); this file only carries them out, as the Linux runtime does.

use std::io::{BufReader, Read};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use ia_core::backoff::Backoff;
use ia_core::fleet::{
    DeviceClientMessage, DeviceHelloClient, InteractiveState, LanSegment, ReportedActionState,
    TamperCause,
};
use ia_core::policy::UnattendedPolicy;
use ia_core::tamper::TamperOutbox;
use ia_platform::macos::service::{interactive_state, lock_report, net, worker_fate, WorkerFate};
use ia_platform::DesktopTarget;
use ia_session0::proto::{read_frame, write_frame, ServiceFrame, WorkerFrame};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use super::paths::MacLayout;
use super::workersock::{self, Admission, AdmittedWorker};
use super::{facts_nobody as nobody, now_ms};
use crate::config::{InstallManifest, ServiceConfig};
use crate::devicesock::{plan_for_frame, ActionRequest, SessionOpen, Step};
use crate::facts::CapabilityFacts;
use crate::identity::Identity;
use crate::paths::Paths;
use crate::worker::{answer_worker, blob_for, WorkerAction};

/// How often the console user is re-read.
const CONSOLE_POLL: Duration = Duration::from_secs(2);
/// How long a session waits for the console user's worker to be connected (it may be restarting
/// after the previous session).
const WORKER_WAIT: Duration = Duration::from_secs(15);
/// The marker gateway of a network that could not be read (rule 8.2a; as on Windows and Linux).
const UNKNOWN_GATEWAY: &str = "00:00:00:00:00:00";

/// One connection's writer. Frames are single newline-terminated `write_all`s, so a lock per frame
/// keeps them whole.
type SharedWriter = Arc<Mutex<UnixStream>>;

fn send_frame(w: &SharedWriter, frame: &ServiceFrame) -> std::io::Result<()> {
    let mut s = w.lock().map_err(|_| std::io::Error::other("writer lock"))?;
    write_frame(&mut *s, frame).map_err(|e| std::io::Error::other(e.to_string()))
}

/// An admitted worker connection.
pub struct Conn {
    /// Admission order: a larger id connected later.
    pub id: u64,
    pub uid: u32,
    pub pid: i32,
    /// The screen lock this worker last reported.
    pub locked: bool,
    writer: SharedWriter,
}

/// The live session: the connection its blob went down.
pub struct LiveSession {
    pub session_id: String,
    pub gen: u16,
    pub uid: u32,
    pub pid: i32,
    pub conn_id: u64,
    pub open: SessionOpen,
    writer: SharedWriter,
}

impl LiveSession {
    pub fn notify(&self, frame: &ServiceFrame) {
        if let Err(e) = send_frame(&self.writer, frame) {
            tracing::debug!(error = %e, "the worker would not take a notification");
        }
    }

    /// Ask the worker to stop, then close its connection (the worker exits when its channel
    /// closes, and launchd starts a fresh one). Blocking; call it off the async threads.
    pub fn stop(&self, reason: &str) {
        self.notify(&ServiceFrame::Stop {
            reason: reason.to_string(),
        });
        std::thread::sleep(Duration::from_millis(250));
        if let Ok(s) = self.writer.lock() {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }
}

type ConsoleFn = Arc<dyn Fn() -> Option<u32> + Send + Sync>;
type ImageFn = Arc<dyn Fn(i32) -> Option<String> + Send + Sync>;

/// Everything the loops share. A mutex is only ever held for a field read or write, never across
/// an await.
pub struct MacShared {
    pub layout: MacLayout,
    pub paths: Paths,
    pub config: Mutex<ServiceConfig>,
    pub identity: Identity,
    pub manifest: Option<InstallManifest>,
    pub facts: Mutex<CapabilityFacts>,
    pub policy: Mutex<UnattendedPolicy>,
    pub outbox: Mutex<TamperOutbox>,
    pub interactive: Mutex<InteractiveState>,
    pub playbooks: Mutex<Vec<ia_core::playbook::ManifestEntry>>,
    /// The admitted worker connections, oldest first.
    pub workers: Mutex<Vec<Conn>>,
    /// Rule 3.5a: at most one live session.
    pub session: Mutex<Option<LiveSession>>,
    pub out: Mutex<mpsc::UnboundedSender<DeviceClientMessage>>,
    /// The console user a session may be served to (`console_target` of the system's console
    /// user; injected so the tests can switch users).
    pub console: ConsoleFn,
    /// A peer's image when its signature satisfies this daemon's signer.
    pub image_of: ImageFn,
    /// Dev `--console` mode: the current user, everything under a temporary root.
    pub dev_console: bool,
    next_conn: AtomicU64,
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
    let interfaces = net::ipv4_interfaces();
    let gateway = net::gateway();
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

impl MacShared {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        layout: MacLayout,
        config: ServiceConfig,
        identity: Identity,
        facts: CapabilityFacts,
        outbox: TamperOutbox,
        console: ConsoleFn,
        image_of: ImageFn,
        dev_console: bool,
    ) -> Self {
        let (tx, _rx) = mpsc::unbounded_channel();
        Self {
            paths: layout.paths(),
            manifest: InstallManifest::load(&layout.manifest()).ok(),
            layout,
            config: Mutex::new(config),
            identity,
            facts: Mutex::new(facts),
            policy: Mutex::new(Default::default()),
            outbox: Mutex::new(outbox),
            interactive: Mutex::new(nobody()),
            playbooks: Mutex::new(Vec::new()),
            workers: Mutex::new(Vec::new()),
            session: Mutex::new(None),
            out: Mutex::new(tx),
            console,
            image_of,
            dev_console,
            next_conn: AtomicU64::new(1),
        }
    }

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

    /// The client facts of a hello or a heartbeat (§3.4, `os: 'macos'`).
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
            os: Some("macos".to_string()),
        }
    }

    pub fn manifest_playbooks(&self) -> Vec<ia_core::playbook::ManifestEntry> {
        self.playbooks.lock().map(|p| p.clone()).unwrap_or_default()
    }

    /// The live session's connection id, if any.
    fn live_conn(&self) -> Option<(u64, String)> {
        self.session
            .lock()
            .ok()
            .and_then(|s| s.as_ref().map(|l| (l.conn_id, l.session_id.clone())))
    }

    /// The newest connection of `uid` admitted after `after`, as `(id, pid, writer)`.
    fn worker_of(&self, uid: u32, after: u64) -> Option<(u64, i32, SharedWriter)> {
        self.workers.lock().ok().and_then(|w| {
            w.iter()
                .rev()
                .find(|c| c.uid == uid && c.id > after)
                .map(|c| (c.id, c.pid, c.writer.clone()))
        })
    }
}

/// The worker socket's admission for this daemon: the console user, the installed worker's
/// canonical path, this daemon's signer.
pub fn admission(shared: &Arc<MacShared>) -> Admission {
    let image = shared.layout.worker_image();
    let installed = std::fs::canonicalize(&image)
        .unwrap_or(image)
        .to_string_lossy()
        .into_owned();
    Admission {
        console: shared.console.clone(),
        installed,
        image_of: shared.image_of.clone(),
    }
}

/// Start the worker socket. Its threads hold `shared` for the life of the process.
pub fn start_worker_socket(shared: &Arc<MacShared>) -> std::io::Result<()> {
    let on_admitted = {
        let shared = shared.clone();
        Arc::new(move |w: AdmittedWorker| admitted(&shared, w))
    };
    workersock::listen(
        &shared.layout.socket(),
        admission(shared),
        on_admitted,
        Arc::new(|_| {}),
    )
    .map(|_| ())
}

/// A worker passed the handshake: keep it, and read its frames on its own thread.
fn admitted(shared: &Arc<MacShared>, w: AdmittedWorker) {
    let id = shared.next_conn.fetch_add(1, Ordering::SeqCst);
    let (reader, writer) = match (w.stream.try_clone(), w.stream) {
        (Ok(r), s) => (r, s),
        (Err(e), _) => {
            tracing::warn!(error = %e, "an admitted worker's stream could not be shared");
            return;
        }
    };
    if let Ok(mut workers) = shared.workers.lock() {
        workers.push(Conn {
            id,
            uid: w.uid,
            pid: w.pid,
            locked: false,
            writer: Arc::new(Mutex::new(writer)),
        });
    }
    tracing::info!(
        conn = id,
        uid = w.uid,
        pid = w.pid,
        "a worker is connected and waiting"
    );
    let shared = shared.clone();
    let spawned = std::thread::Builder::new()
        .name("ia-worker-conn".into())
        .spawn(move || serve_conn(&shared, id, BufReader::new(reader)));
    if spawned.is_err() {
        tracing::error!("the worker connection thread could not start");
    }
}

/// Read one connection's frames until it closes: idle reports while it waits, the session's
/// frames once its blob went down.
fn serve_conn(shared: &Arc<MacShared>, id: u64, mut reader: BufReader<UnixStream>) {
    while let Ok(frame) = read_frame::<_, WorkerFrame>(&mut reader) {
        let live = shared.live_conn().filter(|(c, _)| *c == id);
        match live {
            Some((_, session_id)) => {
                if !session_frame(shared, id, &session_id, &frame) {
                    break;
                }
            }
            None => idle_frame(shared, id, &frame),
        }
    }
    if let Ok(mut w) = shared.workers.lock() {
        w.retain(|c| c.id != id);
    }
    let ended = shared
        .session
        .lock()
        .ok()
        .and_then(|mut s| s.take_if(|l| l.conn_id == id));
    if let Some(l) = ended {
        tracing::info!(session = %l.session_id, pid = l.pid, "the session's worker channel closed");
    }
    tracing::debug!(conn = id, "a worker connection closed");
}

fn set_locked(shared: &Arc<MacShared>, id: u64, locked: bool) {
    if let Ok(mut w) = shared.workers.lock() {
        if let Some(c) = w.iter_mut().find(|c| c.id == id) {
            c.locked = locked;
        }
    }
    evaluate(shared);
}

/// A waiting worker's frames: its lock and its monitors; anything else is not for an idle
/// worker and is ignored (no signature is made without a session).
fn idle_frame(shared: &Arc<MacShared>, id: u64, frame: &WorkerFrame) {
    match frame {
        WorkerFrame::DesktopSwitch { reason, .. } => {
            if let Some(locked) = lock_report(reason) {
                set_locked(shared, id, locked);
            }
        }
        WorkerFrame::Monitors { count } => {
            if let Ok(mut f) = shared.facts.lock() {
                f.monitors = (*count).clamp(1, 16) as u8;
            }
        }
        WorkerFrame::Alive => {}
        other => {
            tracing::debug!(conn = id, frame = ?std::mem::discriminant(other), "an idle worker's frame was ignored")
        }
    }
}

/// The live session's frames. Returns `false` when the session ended on the worker's side.
fn session_frame(shared: &Arc<MacShared>, id: u64, session_id: &str, frame: &WorkerFrame) -> bool {
    let reply = |f: ServiceFrame| {
        if let Some(w) = shared
            .workers
            .lock()
            .ok()
            .and_then(|w| w.iter().find(|c| c.id == id).map(|c| c.writer.clone()))
        {
            let _ = send_frame(&w, &f);
        }
    };
    match answer_worker(frame, session_id, &shared.identity) {
        WorkerAction::Reply(f) => reply(f),
        // The socket's handshake already matched the ready pid to the peer.
        WorkerAction::Ready { .. } | WorkerAction::Alive => {}
        WorkerAction::Monitors { count } => {
            if let Ok(mut f) = shared.facts.lock() {
                f.monitors = count;
            }
        }
        // No input lock or privacy screen on macOS in Phase F: nothing to remember.
        WorkerAction::Protections { .. } => {}
        WorkerAction::ReconsiderDesktop { reason } => match lock_report(&reason) {
            Some(locked) => set_locked(shared, id, locked),
            None => {
                tracing::debug!(%reason, "a desktop re-evaluation request (nothing to switch on macOS)")
            }
        },
        WorkerAction::SendSas { id: re } => reply(ServiceFrame::Error {
            re,
            code: "not_supported".into(),
        }),
        WorkerAction::Ended { reason } => {
            tracing::info!(session = %session_id, %reason, "the worker ended the session");
            if let Ok(mut s) = shared.session.lock() {
                s.take_if(|l| l.conn_id == id);
            }
            return false;
        }
    }
    true
}

/// Run the daemon until `stop` is signalled.
pub async fn run(shared: Arc<MacShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    {
        let shared = shared.clone();
        let _ = tokio::task::spawn_blocking(move || note_restart(&shared)).await;
    }
    if let Err(e) = start_worker_socket(&shared) {
        tracing::error!(error = %e, socket = %shared.layout.socket().display(), "the worker socket could not be opened; no session can be served");
    }
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(socket_loop(shared.clone(), stop.clone()));
    tasks.spawn(heartbeat_loop(shared.clone(), stop.clone()));
    tasks.spawn(console_loop(shared.clone(), stop.clone()));
    tasks.spawn(integrity_loop(shared.clone(), stop.clone()));
    let _ = stop.changed().await;
    tracing::info!("the daemon is stopping");
    // End a live session cleanly rather than leaving a worker with a pill on screen.
    let live = shared.session.lock().ok().and_then(|mut s| s.take());
    if let Some(live) = live {
        let _ = tokio::task::spawn_blocking(move || live.stop("service_stopping")).await;
    }
    tasks.shutdown().await;
    // A clean stop: the next start is not a restart.
    super::runmarker::on_clean_stop(&shared.layout.state, std::process::id() as i32);
}

/// `watchdog_restarted` when the last run of this daemon died in this boot and launchd started it
/// again ([`super::runmarker`]).
fn note_restart(shared: &Arc<MacShared>) {
    use super::runmarker::{on_start, sys};
    let image = std::env::current_exe().unwrap_or_else(|_| shared.layout.service_image());
    if on_start(
        &shared.layout.state,
        &sys::boot_session(),
        std::process::id() as i32,
        |pid| sys::running_as(pid, &image),
    ) {
        shared.record_tamper(
            TamperCause::WatchdogRestarted,
            Some("the daemon stopped without a clean shutdown and launchd started it again"),
        );
    }
}

/// The `/signal/device` socket (§3.4), with the C §3.1 reconnect ladder.
async fn socket_loop(shared: Arc<MacShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
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
    shared: &Arc<MacShared>,
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
    let (ws, _) = tokio_tungstenite::connect_async(req)
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
async fn apply(shared: &Arc<MacShared>, step: Step) -> Option<Disconnect> {
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
            // The hello carries the current console state, not a stale one.
            {
                let shared = shared.clone();
                let _ = tokio::task::spawn_blocking(move || evaluate(&shared)).await;
            }
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
            if let Ok(mut c) = shared.playbooks.lock() {
                *c = playbooks;
            }
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
            // No AMT on a Mac; `amt_proxy` is not advertised, so this only answers a server that
            // sent it anyway.
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
async fn heartbeat_loop(shared: Arc<MacShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        let jitter = ia_core::backoff::jitter_ms(crate::HEARTBEAT_SEC * 1000, 0.16);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(jitter)) => {}
            _ = stop.changed() => return,
        }
        // The network facts shell out to `route` and `arp`: off the async threads.
        let shared = shared.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let facts = shared.client_facts();
            shared.send(DeviceClientMessage::Heartbeat {
                lan_segment: Some(facts.lan_segment),
                wake_mac: facts.wake_mac,
                amt: facts.amt,
                interactive: Some(facts.interactive),
                metrics: None,
            });
        })
        .await;
    }
}

/// Read the console user every 2 s (lock reports re-evaluate at once, from the worker threads).
async fn console_loop(shared: Arc<MacShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        {
            let shared = shared.clone();
            let _ = tokio::task::spawn_blocking(move || evaluate(&shared)).await;
        }
        tokio::select! {
            _ = tokio::time::sleep(CONSOLE_POLL) => {}
            _ = stop.changed() => return,
        }
    }
}

/// One evaluation: the console user and its worker's lock give the interactive state; a change is
/// reported; the live session is told of a lock change, and ended when its user is no longer at
/// the console.
pub fn evaluate(shared: &Arc<MacShared>) {
    let console = (shared.console)();
    let locked = console
        .and_then(|uid| {
            shared
                .workers
                .lock()
                .ok()
                .and_then(|w| w.iter().rev().find(|c| c.uid == uid).map(|c| c.locked))
        })
        .unwrap_or(false);
    let state = interactive_state(console, locked, now_ms());
    let changed = shared
        .interactive
        .lock()
        .map(|i| i.state != state.state)
        .unwrap_or(true);
    if changed {
        if let Ok(mut i) = shared.interactive.lock() {
            *i = state.clone();
        }
        shared.send(DeviceClientMessage::Interactive {
            interactive: state.clone(),
        });
        tracing::info!(state = ?state.state, console = ?console, "interactive state reported");
    } else if let Ok(mut i) = shared.interactive.lock() {
        i.at = state.at;
    }
    let live_uid = shared
        .session
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|l| l.uid));
    match worker_fate(live_uid, console, changed) {
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
                tracing::info!(session = %live.session_id, uid = live.uid, console = ?console, "the session's user is no longer at the console; ending it");
                std::thread::spawn(move || live.stop("session_switch"));
            }
        }
    }
}

/// At start and every hour.
async fn integrity_loop(shared: Arc<MacShared>, mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        {
            let shared = shared.clone();
            let _ = tokio::task::spawn_blocking(move || check_integrity(&shared)).await;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(crate::INTEGRITY_CHECK_SEC)) => {}
            _ = stop.changed() => return,
        }
    }
}

/// One pass against the installed file list. Without one (a dev build, a package that ships none)
/// it is skipped quietly. A changed binary records `binary_changed` and stops sessions from being
/// handed out; a changed list records `config_changed`.
pub fn check_integrity(shared: &MacShared) -> bool {
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

/// Hand `open` at generation `gen` to the console user's worker connected after `after` (waiting
/// up to [`WORKER_WAIT`] for one). Blocking.
fn deliver(
    shared: &Arc<MacShared>,
    open: &SessionOpen,
    gen: u16,
    after: u64,
) -> Result<(), String> {
    let device_id = shared.device_id().ok_or("the device is not enrolled")?;
    let deadline = Instant::now() + WORKER_WAIT;
    let (uid, (conn_id, pid, writer)) = loop {
        let uid = (shared.console)().ok_or(
            "nobody is logged in at the console; a session is never served to the login window",
        )?;
        if let Some(w) = shared.worker_of(uid, after) {
            break (uid, w);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the console user's worker (uid {uid}) is not connected"
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let (api_origin, worker_signal) = {
        let cfg = shared.config.lock().map_err(|_| "config lock")?;
        (cfg.api_origin.clone(), cfg.worker_signal_url())
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
        DesktopTarget::ConsoleDefault { session_id: 0 },
        &open.credential,
        &open.credential_expires_at,
    );
    blob.validate()
        .map_err(|e| format!("the blob this daemon built is not valid: {e}"))?;
    {
        let mut slot = shared.session.lock().map_err(|_| "session lock")?;
        if let Some(live) = slot.as_ref() {
            return Err(format!("a session is already live ({})", live.session_id));
        }
        // The session is bound before the blob goes down, so the worker's first frames are read
        // as the session's.
        *slot = Some(LiveSession {
            session_id: open.session_id.clone(),
            gen,
            uid,
            pid,
            conn_id,
            open: open.clone(),
            writer: writer.clone(),
        });
    }
    let written = writer
        .lock()
        .map_err(|_| std::io::Error::other("writer lock"))
        .and_then(|mut s| {
            write_frame(&mut *s, &blob).map_err(|e| std::io::Error::other(e.to_string()))
        });
    if let Err(e) = written {
        if let Ok(mut s) = shared.session.lock() {
            s.take_if(|l| l.conn_id == conn_id);
        }
        if let Ok(s) = writer.lock() {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
        return Err(format!("the blob could not be written: {e}"));
    }
    tracing::info!(session = %open.session_id, gen, uid, pid, conn = conn_id, "the session was handed to the console user's worker");
    Ok(())
}

/// §4.2: hand a new session to the console user's worker. Blocking.
fn open_session(shared: &Arc<MacShared>, open: SessionOpen) {
    if let Some((_, live)) = shared.live_conn() {
        tracing::warn!(%live, new = %open.session_id, "a session is already live; the new one is refused");
        return;
    }
    if !check_integrity(shared) {
        tracing::error!("no session is served: the installed binaries do not match the file list");
        return;
    }
    if let Err(e) = deliver(shared, &open, 0, 0) {
        tracing::error!(error = %e, session = %open.session_id, "the session could not be served");
    }
}

/// A fresh worker credential (rule 3.6d): the live worker is stopped, and the session goes to the
/// worker launchd starts in its place, at the new generation. A rebuild never asks anybody again,
/// so the decision becomes `auto_grant` (as on Windows and Linux).
fn credential_arrived(
    shared: &Arc<MacShared>,
    session_id: &str,
    gen: u16,
    credential: ia_core::fleet::Secret,
) {
    let previous = shared
        .session
        .lock()
        .ok()
        .and_then(|mut s| s.take_if(|l| l.session_id == session_id));
    let Some(previous) = previous else {
        tracing::warn!(session = %session_id, "a worker credential arrived with no matching live session");
        return;
    };
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
    if let Err(e) = deliver(shared, &open, gen, previous.conn_id) {
        tracing::error!(error = %e, session = %session_id, "the rebuilt session could not be served");
    }
}

/// §9: one action, gated again on the device and then performed **as root** by the daemon
/// (`ranAs: 'admin'`).
pub async fn run_action(shared: &Arc<MacShared>, req: ActionRequest) {
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
    // Rule 9.7: the output is never reported to the server. Its size is logged; a dev `--console`
    // run also logs the (masked) text, so the end-to-end check can see the run happened here.
    if !outcome.output.is_empty() {
        tracing::info!(action = %req.action_id, bytes = outcome.output.len(), "the action produced output");
        if shared.dev_console {
            tracing::info!(action = %req.action_id, output = %outcome.output, "dev: the action's output");
        }
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

/// Rule 3.6b: an action queued while this device was offline.
async fn run_queued(shared: &Arc<MacShared>, action: ia_core::fleet::QueuedAction) {
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
    let resp = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(120))
        .build()
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
fn perform(shared: &Arc<MacShared>, req: &ActionRequest) -> crate::actions::Outcome {
    use ia_core::policy::DeviceActionKind as K;
    match req.kind {
        // A root daemon shows no UI in anybody's session; the message is reported honestly as not
        // shown (rule 9.6), and a technician who needs a person uses a session's chat.
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
            // A `zsh` or `sh` device action runs in the daemon as root, with the E §7.8 runner
            // rules (body on fd 3, stdin /dev/null, IA_PARAM_*, process-group kill), as on Linux.
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
fn store_receipt(shared: &Arc<MacShared>, receipt: &serde_json::Value) {
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
fn wake(shared: &Arc<MacShared>, wake_id: &str, sealed: &ia_core::seal::Sealed) {
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
                let ifaces: Vec<_> = net::ipv4_interfaces()
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
    use ia_core::policy::InteractiveStateName;

    #[test]
    fn an_unreadable_network_still_has_an_org_salted_segment() {
        let a = empty_segment("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b");
        let b = empty_segment("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
        assert_ne!(a.subnet_hash, b.subnet_hash);
    }

    use std::io::{BufRead, Write};
    use std::sync::atomic::AtomicU32;

    fn me_uid() -> u32 {
        // SAFETY: getuid has no preconditions.
        unsafe { libc::getuid() }
    }

    /// A daemon whose "installed worker" is this test binary (a symlink in its install directory)
    /// and whose console user is whatever `console` holds (0: the login window).
    fn daemon(tag: &str, console: Arc<AtomicU32>) -> (Arc<MacShared>, std::path::PathBuf) {
        // The socket path must fit in 104 bytes: a short directory under /tmp, removed by the test.
        let root = std::path::PathBuf::from(format!("/tmp/iart-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let install = root.join("bin");
        std::fs::create_dir_all(&install).unwrap();
        std::os::unix::fs::symlink(std::env::current_exe().unwrap(), install.join("ia-desktop"))
            .unwrap();
        let layout = MacLayout::under(&root, &install);
        layout.ensure().unwrap();
        let config = ServiceConfig {
            v: 1,
            api_origin: "https://in.example".into(),
            signal_url: "wss://in.example/signal/device".into(),
            device_id: Some("0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a".into()),
            key_id: Some("k1".into()),
            region: Some("in".into()),
            org_id: Some("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b".into()),
            waker_opt_out: false,
            amt_proxy_opt_out: true,
        };
        let shared = Arc::new(MacShared::new(
            layout,
            config,
            Identity::generate(),
            CapabilityFacts {
                monitors: 1,
                ..Default::default()
            },
            TamperOutbox::default(),
            Arc::new(move || match console.load(Ordering::SeqCst) {
                0 => None,
                u => Some(u),
            }),
            Arc::new(|pid| {
                ia_platform::macos::codesign::same_signer_image(pid)
                    .map(|p| p.to_string_lossy().into_owned())
            }),
            true,
        ));
        start_worker_socket(&shared).unwrap();
        (shared, root)
    }

    fn line(frame: &impl serde::Serialize) -> Vec<u8> {
        format!("{}\n", serde_json::to_string(frame).unwrap()).into_bytes()
    }

    /// The worker side: connect, say `ready`, and wait to be admitted.
    fn worker(shared: &Arc<MacShared>) -> (UnixStream, BufReader<UnixStream>) {
        let mut s = UnixStream::connect(shared.layout.socket()).unwrap();
        s.write_all(&line(&WorkerFrame::Ready {
            pid: std::process::id(),
        }))
        .unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        while shared.workers.lock().unwrap().is_empty() {
            assert!(Instant::now() < until, "the worker was not admitted");
            std::thread::sleep(Duration::from_millis(20));
        }
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let r = BufReader::new(s.try_clone().unwrap());
        (s, r)
    }

    fn open() -> SessionOpen {
        SessionOpen {
            session_id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d".into(),
            assist_name: "Asha".into(),
            reason: Some("disk check".into()),
            unattended: true,
            decision: ia_core::policy::ConsentDecision::AutoGrant,
            policy: UnattendedPolicy {
                mode: ia_core::policy::UnattendedMode::Allow,
                ..Default::default()
            },
            recording_mode: "server".into(),
            credential: ia_core::fleet::Secret::new("A".repeat(43)),
            credential_expires_at: "2026-11-01T10:02:00.000Z".into(),
        }
    }

    fn state(shared: &MacShared) -> InteractiveStateName {
        shared.interactive.lock().unwrap().state
    }

    fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn the_console_users_worker_gets_the_session_and_a_user_switch_ends_it() {
        let console = Arc::new(AtomicU32::new(me_uid()));
        let (shared, root) = daemon("switch", console.clone());
        let (mut w, mut r) = worker(&shared);

        // An idle worker's lock report moves the state to `locked` and back.
        evaluate(&shared);
        assert_eq!(state(&shared), InteractiveStateName::Active);
        w.write_all(&line(&WorkerFrame::DesktopSwitch {
            id: "1".into(),
            reason: "screen_locked".into(),
        }))
        .unwrap();
        wait_for("locked", || state(&shared) == InteractiveStateName::Locked);
        w.write_all(&line(&WorkerFrame::DesktopSwitch {
            id: "2".into(),
            reason: "screen_unlocked".into(),
        }))
        .unwrap();
        wait_for("unlocked", || {
            state(&shared) == InteractiveStateName::Active
        });

        // The session goes down this worker's connection as the launch blob.
        open_session(&shared, open());
        let mut blob = String::new();
        r.read_line(&mut blob).unwrap();
        let blob: serde_json::Value = serde_json::from_str(&blob).unwrap();
        assert_eq!(blob["sessionId"], "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
        assert!(shared.live_conn().is_some());

        // A second session is refused while this one is live.
        open_session(
            &shared,
            SessionOpen {
                session_id: "11111111-2222-4333-8444-555555555555".into(),
                ..open()
            },
        );
        assert_eq!(
            shared.live_conn().unwrap().1,
            "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
        );

        // Fast user switching: another user at the console ends the session with a `stop`, and
        // the connection is closed.
        console.store(me_uid() + 1, Ordering::SeqCst);
        evaluate(&shared);
        assert!(shared.live_conn().is_none());
        let mut stop = String::new();
        r.read_line(&mut stop).unwrap();
        assert!(stop.contains("session_switch"), "{stop}");
        let mut rest = String::new();
        assert_eq!(r.read_line(&mut rest).unwrap_or(0), 0, "the channel closes");

        // The login window: `none`, and no session is served.
        console.store(0, Ordering::SeqCst);
        evaluate(&shared);
        assert_eq!(state(&shared), InteractiveStateName::None);
        open_session(&shared, open());
        assert!(shared.live_conn().is_none());
        drop(w);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_session_never_goes_to_another_users_worker() {
        // The console user is someone else: this process's worker is never admitted, so a session
        // finds no worker to hand to.
        let console = Arc::new(AtomicU32::new(me_uid() + 1));
        let (shared, root) = daemon("other", console);
        let mut s = UnixStream::connect(shared.layout.socket()).unwrap();
        let _ = s.write_all(&line(&WorkerFrame::Ready {
            pid: std::process::id(),
        }));
        std::thread::sleep(Duration::from_millis(300));
        assert!(shared.workers.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_login_window_reports_none() {
        assert_eq!(
            interactive_state(None, false, 1).state,
            InteractiveStateName::None
        );
        assert_eq!(nobody().state, InteractiveStateName::None);
    }
}
