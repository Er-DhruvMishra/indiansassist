//! The live-session serve loop (contract §1.3, §3-§8), compiled under `media`. Runs once a
//! `session.created` arrives: consent (the native consent window, or the dev
//! `--auto-consent` switch for headless runs), build the webrtc-rs peer, offer, run the
//! `ia.sec` handshake, then serve `ia.control` / `ia.chat` / `ia.file` / `ia.playbook`, pump
//! VP8 frames and `agent.stats`, drive the indicator pill / panel / tray, and tear down on
//! Stop (§10).
//!
//! It bridges the tested pure units (`ia_core::{ctl,consent,filexfer,playbook,stats,
//! teardown,clipsync}`, `crate::{peer,channels,sechs,vp8,capture,pbrun,filerecv}`) and the
//! `ia_ui` bridge to webrtc-rs and the OS. The in-process loopback test drives the same
//! units with a fake Assist.
//!
//! **Headless vs. UI.** With `--auto-consent` (dev builds only) no window is ever created:
//! consent is granted at the given level with every monitor, file offers that pass the
//! checks are accepted and an Assist `level.request` is granted, exactly as before (the e2e
//! path). Without it (every release build) the consent window decides; while live the pill,
//! panel and tray are shown, file offers and level requests are prompted, and the Desk can
//! lower the level, toggle the clipboard, chat, revoke or Stop.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use crate::capture::SyntheticCapturer;
use crate::channels::run_handshake;
use crate::cli::Cli;
use crate::filerecv::{self, PartFile};
use crate::live::{ControlServer, SessionEffect};
use crate::pbrun::{self, RunEvent, RunHandle, RunSpec};
use crate::peer::{AgentPeer, PeerRole};
use crate::signal::SignalWriter;
use crate::vp8::Vp8Encoder;
use ia_core::clipsync::prepare_desk_text;
use ia_core::consent::{LevelRequestOutcome, LiveConsent};
use ia_core::ctl::CtlReq;
use ia_core::files::{is_executable_name, validate_save_leaf};
use ia_core::filexfer::{decode_file_chunk, AcceptedOffer, FileOffer, Receiver};
use ia_core::playbook::{
    check_run, param_env, validate_canonical_playbook_args, ManifestEntry, PbEnd, PbOutput,
    PlaybookError, RunRequest,
};
use ia_core::sec::{SessionKeys, Side};
use ia_core::secchan::{Operator, SecChannel, SecChannelSet};
use ia_core::stats::{AgentStats, StatMonitor};
use ia_core::teardown::{deletes_on_exit, stop_order, teardown_order, ProcessRole};
use ia_core::types::{
    op_id_for, AgentConsentLevel, CapturePath, ElevationLevel, MonitorInfo, PlaybookInterpreter,
    SecFailReason, VideoEncoder,
};
use ia_platform::traits::{Capturer, ClipboardBridge, InputSink};
use ia_ui::bridge::{ConsentRequest, FilePrompt, UiCommand, UiEvent};
use ia_ui::model::ConsentPayload;

type Chans = HashMap<String, Arc<RTCDataChannel>>;
type Secs = HashMap<String, SecChannel>;

mod link;
mod meter;
mod secfail;
mod selfdel;
use link::*;
use meter::*;
use secfail::*;
use selfdel::*;

/// How long the Desk has to answer a file offer or a level request (contract §3.4, §6.1 F4).
const PROMPT_SECS: u64 = 60;
/// The consent deadline (A: 180 s).
const CONSENT_SECS: u64 = 180;

/// How a live session ended (logged by the binary).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveOutcome {
    /// Stop requested (pill / panel / tray Stop, SIGINT, a dev `stop` line, `--stop-after`,
    /// or the budget); the agent sent `stop.sharing` + `session.end`.
    Stopped,
    /// The Desk revoked consent from the panel (`consent.revoked` + `desk.consent revoked`).
    Revoked,
    /// The server (or Assist) ended the session first.
    EndedRemotely,
    /// A frame failed to decrypt / replay / sequence, a channel was closed or a stray channel
    /// opened, or the handshake/negotiation failed: the §1.3 step-9 teardown ran and the WS
    /// `session.end` carried `note: 'sec:<reason>'`. The string is the `SecFailReason`.
    SecFailed(String),
    /// Consent was declined (window, Escape, close, deadline) or setup failed.
    Failed(String),
}

/// One decrypted frame routed to the serve loop by channel label.
struct Inbound {
    label: String,
    data: Vec<u8>,
}

/// Playbook output flowing from a run thread back to the serve loop (which seals and sends it).
enum PbMsg {
    Output(PbOutput),
    End {
        end: PbEnd,
        playbook_id: String,
        body_hash: String,
    },
}

fn level_wire(level: AgentConsentLevel) -> &'static str {
    match level {
        AgentConsentLevel::View => "view",
        AgentConsentLevel::Control => "control",
        AgentConsentLevel::Elevated => "elevated",
    }
}

/// The OS input/clipboard ends. Real `SendInput` + clipboard on the MSVC host; a no-op sink when
/// capture is synthetic (the synthetic monitors are not real displays, so a technician's click
/// must not land on the host's actual desktop) or on other targets.
#[cfg(all(windows, feature = "winapi"))]
fn platform_io(synthetic: bool) -> (Box<dyn InputSink>, Box<dyn ClipboardBridge>) {
    if synthetic {
        return (Box::new(NoopInput), Box::new(NoopClip));
    }
    (
        Box::new(ia_input_win::inject::WinInput),
        Box::new(ia_input_win::clipboard::WinClipboard::new()),
    )
}

#[cfg(not(all(windows, feature = "winapi")))]
fn platform_io(_synthetic: bool) -> (Box<dyn InputSink>, Box<dyn ClipboardBridge>) {
    (Box::new(NoopInput), Box::new(NoopClip))
}

struct NoopInput;
impl InputSink for NoopInput {
    fn pointer(
        &mut self,
        _m: &MonitorInfo,
        _nx: f32,
        _ny: f32,
        _a: ia_platform::traits::PointerAction,
    ) {
    }
    fn scroll(&mut self, _m: &MonitorInfo, _nx: f32, _ny: f32, _dx: i32, _dy: i32) {}
    fn key(&mut self, _c: &str, _a: ia_platform::traits::KeyAction, _m: ia_core::types::Modifiers) {
    }
    fn text(&mut self, _t: &str) {}
}
struct NoopClip;
impl ClipboardBridge for NoopClip {
    fn set_text(&mut self, _t: &str) {}
    fn take_update(&mut self) -> Option<String> {
        None
    }
}

/// The monitors the agent captures and consents to (synthetic on a headless/e2e host, else
/// the real GDI enumeration).
fn capture_monitors(cli: &Cli) -> Vec<MonitorInfo> {
    if cli.synthetic_capture {
        return SyntheticCapturer::single(1280, 720).enumerate();
    }
    #[cfg(all(windows, feature = "winapi"))]
    {
        let m = ia_capture_win::enumerate::enumerate();
        if !m.is_empty() {
            return m;
        }
    }
    SyntheticCapturer::single(1280, 720).enumerate()
}

/// Parse the pinned playbook manifest from `session.created.agent.playbooks` (§8.3).
fn parse_manifest(created: &Value) -> Vec<ManifestEntry> {
    created
        .get("agent")
        .and_then(|a| a.get("playbooks"))
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    Some(ManifestEntry {
                        id: p.get("id")?.as_str()?.to_string(),
                        body_hash: p.get("bodyHash")?.as_str()?.to_string(),
                        requires_elevation: p
                            .get("requiresElevation")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                        parameters: p
                            .get("parameters")
                            .cloned()
                            .and_then(|v| serde_json::from_value(v).ok())
                            .unwrap_or_default(),
                        timeout_sec: p.get("timeoutSec").and_then(|v| v.as_u64()).unwrap_or(120)
                            as u32,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The people / policy facts of `session.created` the UI shows.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CreatedInfo {
    technician: String,
    org: String,
    recording_mode: String,
}

fn created_info(created: &Value) -> CreatedInfo {
    let s = |v: Option<&Value>| v.and_then(|x| x.as_str()).unwrap_or("").to_string();
    let technician = s(created.get("assist").and_then(|a| a.get("name")));
    let org = s(created.get("org").and_then(|o| o.get("displayName")));
    CreatedInfo {
        technician: if technician.is_empty() {
            "Your technician".into()
        } else {
            technician
        },
        org: if org.is_empty() {
            "IndiansAssist".into()
        } else {
            org
        },
        recording_mode: s(created.get("recordingMode")),
    }
}

/// `host[:port]` of the API the agent talks to ("Connecting through <api host>", §3.3).
fn api_host(cli: &Cli) -> String {
    let url = crate::session::resolve_signal_url(cli);
    let rest = url.split("://").nth(1).unwrap_or(&url);
    rest.split('/').next().unwrap_or(rest).to_string()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- the Desk UI handle ----------------------------------------------------------------------

/// The serve loop's side of the UI thread (pill, panel, tray). Absent in headless runs.
struct DeskUi {
    #[cfg(feature = "gui")]
    handle: ia_ui::app::UiHandle,
}

impl DeskUi {
    #[cfg(feature = "gui")]
    fn spawn(req: ConsentRequest) -> Option<(DeskUi, mpsc::UnboundedReceiver<UiEvent>)> {
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = ia_ui::app::spawn(
            req,
            Box::new(move |e| {
                let _ = tx.send(e);
            }),
        );
        Some((DeskUi { handle }, rx))
    }

    #[cfg(not(feature = "gui"))]
    fn spawn(_req: ConsentRequest) -> Option<(DeskUi, mpsc::UnboundedReceiver<UiEvent>)> {
        None
    }

    fn send(&self, cmd: UiCommand) {
        #[cfg(feature = "gui")]
        self.handle.send(cmd);
        #[cfg(not(feature = "gui"))]
        let _ = cmd;
    }

    /// Show the ended view and wait (off the runtime) until the user closes it or it times out.
    async fn finish(self, lines: Vec<String>) {
        self.send(UiCommand::Ended { lines });
        #[cfg(feature = "gui")]
        {
            let h = self.handle;
            let _ =
                tokio::task::spawn_blocking(move || h.wait_closed(Duration::from_secs(30))).await;
        }
    }

    /// The consent window was declined / closed: let the UI thread wind down.
    async fn close(self) {
        #[cfg(feature = "gui")]
        {
            let h = self.handle;
            let _ =
                tokio::task::spawn_blocking(move || h.wait_closed(Duration::from_secs(5))).await;
        }
    }
}

async fn next_ui(rx: &mut Option<mpsc::UnboundedReceiver<UiEvent>>) -> Option<UiEvent> {
    match rx {
        Some(r) => r.recv().await,
        None => std::future::pending().await,
    }
}

enum ConsentDecision {
    Granted(ConsentPayload),
    Declined(String),
    Ended,
}

/// Wait for the consent window's answer, answering pings; `session.ended` aborts.
async fn await_consent(
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    ui_rx: &mut mpsc::UnboundedReceiver<UiEvent>,
) -> ConsentDecision {
    let deadline = tokio::time::sleep(Duration::from_secs(CONSENT_SECS + 5));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return ConsentDecision::Declined("consent deadline".into()),
            ev = ui_rx.recv() => match ev {
                Some(UiEvent::ConsentGranted(p)) => return ConsentDecision::Granted(p),
                Some(UiEvent::ConsentDeclined) => return ConsentDecision::Declined("declined".into()),
                Some(UiEvent::Failed(e)) => return ConsentDecision::Declined(format!("consent window failed: {e}")),
                Some(UiEvent::Closed) | None => return ConsentDecision::Declined("consent window closed".into()),
                Some(_) => {}
            },
            msg = ws_rx.recv() => {
                let Some(v) = msg else { return ConsentDecision::Ended };
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("ping") => { let _ = ws.send(json!({ "t": "pong" })).await; }
                    Some("session.ended") => return ConsentDecision::Ended,
                    _ => {}
                }
            }
        }
    }
}

// ---- the session ---------------------------------------------------------------------------

/// Run the full live session. `created` is the `session.created` frame the Desk received;
/// `joined_by_code` is whether the token was a 12-digit code (clipboard redaction, §5.6 C2).
pub async fn run_live_session(
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    cli: &Cli,
    created: &Value,
    budget: Duration,
    joined_by_code: bool,
) -> Result<LiveOutcome, String> {
    let session_id = created
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or("session.created has no sessionId")?
        .to_string();
    let manifest = parse_manifest(created);
    let info = created_info(created);
    let all_monitors = capture_monitors(cli);

    // 1) Consent. Consent is never implied: only the dev `--auto-consent` switch grants
    // without a window; every other run shows the native consent window (§3.3).
    let (payload, ui, mut ui_rx) = if let Some(level) = cli.auto_consent {
        // Give the freshly-navigated Assist console a moment to mount and subscribe to the
        // signalling stream, so the `consent.changed` the server mirrors is not delivered
        // before there is a listener (it is not buffered). The offer retry covers the rest.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        tracing::info!(
            level = level_wire(level),
            monitors = all_monitors.len(),
            "auto-consent granted"
        );
        let payload = ConsentPayload {
            level,
            monitors: all_monitors.iter().map(|m| m.id).collect(),
            clipboard: false,
        };
        (payload, None, None)
    } else {
        let mut warnings = Vec::new();
        if cfg!(feature = "dev") {
            warnings.push("Development build: local testing switches are enabled.".into());
        }
        let req = ConsentRequest {
            technician: info.technician.clone(),
            org: info.org.clone(),
            api_host: api_host(cli),
            monitors: all_monitors.clone(),
            recording_sentence: ia_ui::bridge::recording_sentence(&info.recording_mode, None),
            warnings,
            deadline_secs: CONSENT_SECS,
        };
        let Some((ui, mut rx)) = DeskUi::spawn(req) else {
            tracing::warn!("no consent UI in this build and no --auto-consent: declining");
            let _ = ws
                .send(json!({ "t": "desk.consent", "state": "revoked" }))
                .await;
            return Ok(LiveOutcome::Failed(
                "consent declined (no consent UI)".into(),
            ));
        };
        tracing::info!("consent window shown");
        match await_consent(ws, ws_rx, &mut rx).await {
            ConsentDecision::Granted(p) => {
                tracing::info!(
                    level = level_wire(p.level),
                    monitors = p.monitors.len(),
                    clipboard = p.clipboard,
                    "consent granted in the window"
                );
                (p, Some(ui), Some(rx))
            }
            ConsentDecision::Declined(why) => {
                tracing::info!(%why, "consent declined");
                let _ = ws
                    .send(json!({ "t": "desk.consent", "state": "revoked" }))
                    .await;
                ui.close().await;
                return Ok(LiveOutcome::Failed(format!("consent declined ({why})")));
            }
            ConsentDecision::Ended => {
                ui.close().await;
                return Ok(LiveOutcome::EndedRemotely);
            }
        }
    };
    let mut monitors: Vec<MonitorInfo> = all_monitors
        .iter()
        .filter(|m| payload.monitors.contains(&m.id))
        .cloned()
        .collect();
    if monitors.is_empty() {
        monitors = all_monitors.clone();
    }
    let monitor_ids: Vec<u32> = monitors.iter().map(|m| m.id).collect();
    ws.send(json!({
        "t": "desk.consent",
        "state": "granted",
        "surface": "monitor",
        "native": { "level": level_wire(payload.level), "monitors": monitor_ids, "clipboard": payload.clipboard },
    }))
    .await?;
    if let Some(ui) = &ui {
        ui.send(UiCommand::Live {
            technician: info.technician.clone(),
            org: info.org.clone(),
            level: payload.level,
            clipboard: payload.clipboard,
            monitors: monitors.clone(),
            recording: matches!(info.recording_mode.as_str(), "server" | "both"),
            recording_is_server: true,
        });
    }

    connect_and_serve(
        ws,
        ws_rx,
        cli,
        &session_id,
        &info,
        monitors,
        payload,
        manifest,
        budget,
        joined_by_code,
        ui,
        &mut ui_rx,
    )
    .await
}

async fn end_ui(ui: Option<DeskUi>, why: &str) {
    if let Some(ui) = ui {
        ui.finish(vec![why.to_string()]).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn connect_and_serve(
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    cli: &Cli,
    session_id: &str,
    info: &CreatedInfo,
    monitors: Vec<MonitorInfo>,
    payload: ConsentPayload,
    manifest: Vec<ManifestEntry>,
    budget: Duration,
    joined_by_code: bool,
    ui: Option<DeskUi>,
    ui_rx: &mut Option<mpsc::UnboundedReceiver<UiEvent>>,
) -> Result<LiveOutcome, String> {
    let monitor_ids: Vec<u32> = monitors.iter().map(|m| m.id).collect();

    // Wait for consent.ok (carries the Desk ICE servers; localhost uses host candidates).
    let ice_servers: Vec<RTCIceServer>;
    let consent_deadline = tokio::time::sleep(Duration::from_secs(15));
    tokio::pin!(consent_deadline);
    loop {
        tokio::select! {
            _ = &mut consent_deadline => {
                end_ui(ui, "The connection could not be set up.").await;
                return Err("no consent.ok before timeout".into());
            }
            msg = ws_rx.recv() => {
                let Some(v) = msg else {
                    end_ui(ui, "The session ended.").await;
                    return Ok(LiveOutcome::EndedRemotely);
                };
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("consent.ok") => {
                        // F5: parse the STUN/TURN servers into the PC configuration so a
                        // non-LAN pair can form; localhost sends none and host candidates win.
                        ice_servers = crate::peer::ice_servers_from_json(v.get("iceServers"));
                        tracing::info!(ice_servers = ice_servers.len(), "consent.ok");
                        break;
                    }
                    Some("session.ended") => {
                        end_ui(ui, "The session ended.").await;
                        return Ok(LiveOutcome::EndedRemotely);
                    }
                    Some("ping") => { let _ = ws.send(json!({ "t": "pong" })).await; }
                    Some("error") => {
                        end_ui(ui, "The server refused the consent.").await;
                        return Err(format!("consent error: {v}"));
                    }
                    _ => {}
                }
            }
        }
    }

    // The inbound-frame bus and the secure-channel failure bus are shared across key
    // generations (a §3.7 rebuild re-wires fresh channels to the same buses).
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Inbound>();
    let (fail_tx, fail_rx) = mpsc::unbounded_channel::<(u16, SecFailReason)>();

    // 2) Build the peer (gen 0), wire the six encrypted channels and the stray-channel guard
    // BEFORE the handshake (F7), then offer.
    let peer = AgentPeer::new(
        PeerRole::Desk,
        &monitor_ids,
        false,
        crate::peer::configuration(ice_servers.clone()),
    )
    .await
    .map_err(|e| format!("peer: {e}"))?;
    let chans = match wire_channels(&peer, 0, &in_tx, &fail_tx).await {
        Ok(c) => c,
        Err(e) => {
            end_ui(ui, "The connection could not be set up.").await;
            return Err(e);
        }
    };

    // 3) Offer (gen 0), apply the answer, read the fingerprints.
    let (own_fpr, remote_fpr) = match negotiate(&peer, ws, ws_rx, session_id, 0, false).await {
        NegotiateOutcome::Fingerprints(f) => f,
        NegotiateOutcome::Ended => {
            end_ui(ui, "The session ended.").await;
            return Ok(LiveOutcome::EndedRemotely);
        }
        NegotiateOutcome::NoAnswer => {
            // A negotiation that never completes is a §1.3 step-9 failure (`timeout`), not a
            // silent exit (F8): the console and the chain both learn the session ended on error.
            end_ui(ui, "The technician's console did not answer.").await;
            return Ok(teardown_sec_fail(
                ws,
                session_id,
                SecFailReason::Timeout,
                None,
                None,
                &peer,
            )
            .await);
        }
    };

    // 4) Run the §1.3 handshake over ia.sec and log the security code the harness reads.
    let sec_dc = match await_channel(&peer, "ia.sec").await {
        Some(dc) => dc,
        None => {
            end_ui(ui, "The secure connection could not be established.").await;
            return Ok(teardown_sec_fail(
                ws,
                session_id,
                SecFailReason::Timeout,
                None,
                None,
                &peer,
            )
            .await);
        }
    };
    let (keys, sas) = match run_handshake(
        sec_dc.clone(),
        Side::Desk,
        session_id,
        0,
        &own_fpr,
        &remote_fpr,
    )
    .await
    {
        Ok(k) => k,
        Err(reason) => {
            // Timeout / fingerprint / received sec.fail / mac: emit the step-9 teardown (F8).
            end_ui(ui, "The security code could not be verified.").await;
            return Ok(teardown_sec_fail(ws, session_id, reason, None, Some(&sec_dc), &peer).await);
        }
    };
    if sas.len() == 6 {
        tracing::info!("security code {} {}", &sas[0..3], &sas[3..6]);
    } else {
        tracing::info!("security code {sas}");
    }
    if let Some(ui) = &ui {
        ui.send(UiCommand::Sas(sas.clone()));
    }

    let params = ServeParams {
        cli,
        session_id,
        info,
        keys,
        monitors,
        payload,
        manifest,
        budget,
        joined_by_code,
        sas,
    };
    let io = ServeIo {
        peer,
        chans,
        sec_dc,
        in_rx,
        fail_rx,
        in_tx,
        fail_tx,
        ice_servers,
        monitor_ids,
    };
    serve(ws, ws_rx, params, io, ui, ui_rx).await
}

async fn add_remote_ice(peer: &AgentPeer, v: &Value) {
    let Some(cand) = v.get("candidate") else {
        return;
    };
    if cand.is_null() {
        return;
    }
    let init = webrtc::ice_transport::ice_candidate::RTCIceCandidateInit {
        candidate: cand
            .get("candidate")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string(),
        sdp_mid: cand
            .get("sdpMid")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string()),
        sdp_mline_index: cand
            .get("sdpMLineIndex")
            .and_then(|c| c.as_u64())
            .map(|n| n as u16),
        username_fragment: cand
            .get("usernameFragment")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string()),
    };
    let _ = peer.pc.add_ice_candidate(init).await;
}

async fn await_channel(peer: &AgentPeer, label: &str) -> Option<Arc<RTCDataChannel>> {
    for _ in 0..200 {
        if let Some(dc) = peer.channel(label).await {
            return Some(dc);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

/// Register an inbound forwarder for an encrypted channel (raw bytes to the serve loop).
fn forward(dc: &Arc<RTCDataChannel>, label: &str, tx: mpsc::UnboundedSender<Inbound>) {
    let label = label.to_string();
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let _ = tx.send(Inbound {
            label: label.clone(),
            data: msg.data.to_vec(),
        });
        Box::pin(async {})
    }));
}

/// An offer waiting for the Desk's answer in the panel (§6.1 F4).
struct PendingFile {
    offer: FileOffer,
    recv: Receiver,
    accepted: AcceptedOffer,
    deadline: Instant,
}

/// An accepted transfer streaming into its `.iapart` file.
struct Incoming {
    file_id: u32,
    recv: Receiver,
    part: PartFile,
    sha: String,
}

/// An Assist `level.request` waiting for Allow / Refuse (§3.4).
struct PendingLevel {
    req_id: String,
    op_id: String,
    deadline: Instant,
}

struct RunningPb {
    run_id: String,
    handle: RunHandle,
}

/// Counters for the Stop receipt (§3.5).
#[derive(Default)]
struct Receipt {
    clip_to_assist: u32,
    clip_to_desk: u32,
    playbooks: Vec<String>,
    files: Vec<String>,
}

type PlaybookCheck = (RunRequest, Result<RunSpec, (&'static str, PlaybookError)>);

/// Everything the serve loop mutates while live.
struct Live<'a> {
    ws: &'a mut SignalWriter,
    session_id: String,
    technician: String,
    chans: Chans,
    sec: Secs,
    control: ControlServer,
    input_sink: Box<dyn InputSink>,
    clipboard: Box<dyn ClipboardBridge>,
    joined_by_code: bool,
    manifest: Vec<ManifestEntry>,
    ui: Option<DeskUi>,
    pb_tx: mpsc::UnboundedSender<PbMsg>,
    running: Option<RunningPb>,
    pending_file: Option<PendingFile>,
    incoming: Option<Incoming>,
    in_flight: HashSet<String>,
    swept: bool,
    pending_level: Option<PendingLevel>,
    receipt: Receipt,
    started: Instant,
    /// Set when a §1.3 step-9 failure is detected, so the teardown emits the right note.
    sec_fail: Option<(SecFailReason, Option<String>)>,
    /// A pending `os.quality` preset the serve loop applies to the ABR controller (§4.3).
    pending_quality: Option<ia_core::types::QualityPreset>,
}

impl Live<'_> {
    /// Headless (`--auto-consent`): no prompts; accept / grant as the e2e expects.
    fn headless(&self) -> bool {
        self.ui.is_none()
    }

    fn ui(&self, cmd: UiCommand) {
        if let Some(ui) = &self.ui {
            ui.send(cmd);
        }
    }

    async fn seal(&mut self, label: &str, text: &str) {
        if let Some(sc) = self.sec.get_mut(label) {
            seal_send(&self.chans, sc, label, text).await;
        }
    }

    async fn send_level_event(&mut self) {
        let c = &self.control.consent;
        let ev = json!({
            "t": "ctl.event", "kind": "agent_level",
            "level": level_wire(c.level), "clipboard": c.clipboard_active(), "elevation": "user", "ts": now_ms(),
        });
        let (level, clipboard, integrity) = (c.level, c.clipboard_active(), c.integrity);
        self.seal("ia.control", &ev.to_string()).await;
        self.ui(UiCommand::Level {
            level,
            clipboard,
            integrity,
        });
    }

    // ---- level / clipboard (Desk side) -------------------------------------------------------

    /// The Desk lowered or raised the level from the panel / tray (§3.4 "Desk lowers").
    async fn desk_set_level(&mut self, level: AgentConsentLevel) {
        if level == AgentConsentLevel::Elevated || level == self.control.consent.level {
            return;
        }
        let lowering = level < self.control.consent.level;
        // Stop honouring input **before** anything is sent (§3.4).
        if lowering {
            self.control.consent.lower_level(level);
        } else {
            self.control.consent.grant_level(level);
        }
        tracing::info!(
            level = level_wire(level),
            lowering,
            "desk changed the level"
        );
        let _ = self
            .ws
            .send(json!({ "t": "desk.consent_level", "sessionId": self.session_id, "level": level_wire(level) }))
            .await;
        self.send_level_event().await;
    }

    async fn desk_set_clipboard(&mut self, on: bool) {
        let active = self.control.consent.toggle_clipboard(on);
        if active {
            // Only copies made from now on are shared (prime the watcher).
            let _ = self.clipboard.take_update();
        }
        tracing::info!(on, active, "desk clipboard switch");
        let _ = self
            .ws
            .send(json!({ "t": "desk.consent_clipboard", "sessionId": self.session_id, "clipboard": on }))
            .await;
        self.send_level_event().await;
    }

    /// Answer a pending Assist `level.request` (Allow / Refuse / timeout).
    async fn answer_level_request(&mut self, allow: bool, timeout: bool) {
        let Some(p) = self.pending_level.take() else {
            return;
        };
        self.ui(UiCommand::LevelPromptClosed);
        self.emit_prompt("level", &p.req_id, "answered").await;
        let from = level_wire(self.control.consent.level);
        if allow {
            self.control.consent.grant_level(AgentConsentLevel::Control);
            let _ = self
                .ws
                .send(json!({ "t": "desk.consent_level", "sessionId": self.session_id, "level": "control", "requested": true, "opId": p.op_id }))
                .await;
            let res = ia_core::ctl::ok_response(&p.req_id, json!({ "level": "control" }));
            self.seal("ia.control", &res.to_string()).await;
            self.send_level_event().await;
            tracing::info!("level.request allowed");
        } else {
            let code = if timeout { "timeout" } else { "refused" };
            let res = ia_core::ctl::error_response(&p.req_id, code, None);
            self.seal("ia.control", &res.to_string()).await;
            let _ = self
                .ws
                .send(json!({
                    "t": "desk.event", "sessionId": self.session_id, "action": "consent.level_refused",
                    "data": { "from": from, "requested": "control", "opId": p.op_id, "timeout": timeout },
                }))
                .await;
            tracing::info!(code, "level.request refused");
        }
    }

    // ---- files (§6.1) ------------------------------------------------------------------------

    async fn file_msg(&mut self, t: &str, file_id: u32, extra: Value) {
        let mut m = json!({ "t": t, "fileId": file_id, "ts": now_ms() });
        if let (Some(obj), Some(more)) = (m.as_object_mut(), extra.as_object()) {
            for (k, v) in more {
                obj.insert(k.clone(), v.clone());
            }
        }
        self.seal("ia.file", &m.to_string()).await;
    }

    async fn on_file_offer(&mut self, offer: FileOffer) {
        if self.incoming.is_some() || self.pending_file.is_some() {
            self.file_msg("file.reject", offer.file_id, json!({ "reason": "busy" }))
                .await;
            return;
        }
        let dir = filerecv::received_dir();
        if !self.swept {
            self.swept = true;
            let n = filerecv::sweep_stale_parts(&dir, filerecv::STALE_PART_AGE);
            if n > 0 {
                tracing::info!(n, "swept stale .iapart files");
            }
        }
        // Final name first: against the folder and the in-flight transfers (§6.1 F3).
        let taken = filerecv::taken_names(&dir, &self.in_flight);
        match Receiver::accept_streaming(&offer, &taken) {
            Err(reason) => {
                tracing::info!(reason = reason.as_str(), "file offer refused");
                self.file_msg(
                    "file.reject",
                    offer.file_id,
                    json!({ "reason": reason.as_str() }),
                )
                .await;
                self.ui(UiCommand::FileClosed {
                    file_id: offer.file_id,
                    outcome: format!("A file was refused ({}).", reason.as_str()),
                });
            }
            Ok((recv, accepted)) => {
                if self.headless() {
                    self.start_incoming(offer, recv, accepted).await;
                } else {
                    let ext = accepted
                        .final_name
                        .rsplit_once('.')
                        .map(|(_, e)| e.to_ascii_lowercase())
                        .unwrap_or_default();
                    self.ui(UiCommand::FilePrompt(FilePrompt {
                        file_id: offer.file_id,
                        name: accepted.final_name.clone(),
                        ext,
                        mime: offer.mime.clone(),
                        size: offer.size,
                        sender: self.technician.clone(),
                        executable: accepted.executable || is_executable_name(&accepted.final_name),
                        timeout_secs: PROMPT_SECS,
                    }));
                    tracing::info!(file_id = offer.file_id, "file offer prompted");
                    self.emit_prompt("file", &format!("file:{}", offer.file_id), "shown")
                        .await;
                    self.pending_file = Some(PendingFile {
                        offer,
                        recv,
                        accepted,
                        deadline: Instant::now() + Duration::from_secs(PROMPT_SECS),
                    });
                }
            }
        }
    }

    async fn start_incoming(&mut self, offer: FileOffer, recv: Receiver, accepted: AcceptedOffer) {
        let dir = filerecv::received_dir();
        let leaf = validate_save_leaf(&offer.name, offer.file_id as u64)
            .unwrap_or_else(|_| accepted.final_name.clone());
        match PartFile::create(&dir, &leaf, &accepted.final_name) {
            Ok(part) => {
                self.in_flight.insert(accepted.final_name.clone());
                self.incoming = Some(Incoming {
                    file_id: offer.file_id,
                    recv,
                    part,
                    sha: offer.sha256.to_ascii_lowercase(),
                });
                self.file_msg("file.accept", offer.file_id, json!({})).await;
            }
            Err(e) => {
                tracing::warn!("could not create the part file: {e}");
                self.file_msg(
                    "file.reject",
                    offer.file_id,
                    json!({ "reason": "declined" }),
                )
                .await;
                self.ui(UiCommand::FileClosed {
                    file_id: offer.file_id,
                    outcome: "The file could not be saved.".into(),
                });
            }
        }
    }

    async fn file_decision(&mut self, file_id: u32, accept: bool, timed_out: bool) {
        let Some(p) = self.pending_file.take() else {
            return;
        };
        if p.offer.file_id != file_id {
            self.pending_file = Some(p);
            return;
        }
        let state = "answered"; // shared prompt states: shown | answered
        self.emit_prompt("file", &format!("file:{file_id}"), state)
            .await;
        if accept {
            tracing::info!(file_id, "file offer accepted by the Desk");
            self.start_incoming(p.offer, p.recv, p.accepted).await;
        } else {
            tracing::info!(file_id, timed_out, "file offer declined");
            self.file_msg("file.reject", file_id, json!({ "reason": "declined" }))
                .await;
            self.ui(UiCommand::FileClosed {
                file_id,
                outcome: if timed_out {
                    "A file offer expired.".into()
                } else {
                    "You declined a file.".into()
                },
            });
        }
    }

    async fn on_file_chunk(&mut self, idx: u32, payload: &[u8]) {
        let Some(inc) = self.incoming.as_mut() else {
            return;
        };
        let res = inc
            .recv
            .on_chunk(idx, payload)
            .map_err(|r| r.as_str())
            .and_then(|_| inc.part.write(payload).map_err(|_| "aborted"));
        if let Err(reason) = res {
            if let Some(inc) = self.incoming.take() {
                self.in_flight.remove(inc.part.final_name());
                let fid = inc.file_id;
                inc.part.abort();
                self.file_msg("file.cancel", fid, json!({ "reason": reason }))
                    .await;
                self.ui(UiCommand::FileClosed {
                    file_id: fid,
                    outcome: "A file transfer failed.".into(),
                });
            }
        }
    }

    async fn on_file_done(&mut self) {
        let Some(inc) = self.incoming.take() else {
            return;
        };
        let fid = inc.file_id;
        let final_name = inc.part.final_name().to_string();
        let outcome = match inc.recv.finish_streaming() {
            Ok(_) => inc.part.commit(&self.in_flight).map_err(|e| {
                tracing::warn!("file commit failed: {e}");
                "aborted"
            }),
            Err(reason) => {
                inc.part.abort();
                Err(reason.as_str())
            }
        };
        self.in_flight.remove(&final_name);
        match outcome {
            Ok(path) => {
                tracing::info!("file saved {}", path.display());
                self.receipt.files.push(path.display().to_string());
                self.file_msg("file.ack", fid, json!({ "ok": true, "sha256": inc.sha }))
                    .await;
                // §3.8 / correctness F14: the Desk reporter half — the audit records the file
                // landed on disk, with its size and hash (the content never does).
                let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| final_name.clone());
                let _ = self
                    .ws
                    .send(json!({
                        "t": "desk.event", "sessionId": self.session_id, "action": "file.received",
                        "data": { "fileId": fid, "direction": "to_desk", "name": name, "bytes": bytes, "sha256": inc.sha },
                    }))
                    .await;
                self.ui(UiCommand::FileClosed {
                    file_id: fid,
                    outcome: format!("Saved {}", path.display()),
                });
            }
            Err(reason) => {
                self.file_msg("file.cancel", fid, json!({ "reason": reason }))
                    .await;
                self.ui(UiCommand::FileClosed {
                    file_id: fid,
                    outcome: "A file transfer failed.".into(),
                });
            }
        }
    }

    async fn on_file_cancel(&mut self, file_id: u32) {
        if self.incoming.as_ref().is_some_and(|i| i.file_id == file_id) {
            if let Some(inc) = self.incoming.take() {
                self.in_flight.remove(inc.part.final_name());
                inc.part.abort();
            }
        }
        if self
            .pending_file
            .as_ref()
            .is_some_and(|p| p.offer.file_id == file_id)
        {
            self.pending_file = None;
        }
        self.ui(UiCommand::FileClosed {
            file_id,
            outcome: "The technician cancelled a file.".into(),
        });
    }

    // ---- playbooks (§8.4) ----------------------------------------------------------------------

    /// The §8.4 checks; on success the run spec, else the `ctl.res` error code and the
    /// `pb.end` error.
    fn prepare_playbook(&self, run: &RunRequest) -> Result<RunSpec, (&'static str, PlaybookError)> {
        if self.running.is_some() {
            return Err(("busy", PlaybookError::Busy));
        }
        check_run(run, &self.manifest, ElevationLevel::User).map_err(|e| (ctl_code(e), e))?;
        let entry = self
            .manifest
            .iter()
            .find(|m| m.id == run.playbook_id)
            .ok_or(("not_allowed", PlaybookError::NotAllowed))?;
        let canonical =
            validate_canonical_playbook_args(&entry.parameters, &run.args, run.interpreter)
                .map_err(|e| {
                    tracing::warn!(error = %e, "playbook args refused");
                    ("bad_args", PlaybookError::NotAllowed)
                })?;
        pbrun::never_elevated_gate(run.requires_elevation, pbrun::process_is_elevated())
            .map_err(|e| ("not_allowed", e))?;
        Ok(RunSpec {
            run_id: run.run_id.clone(),
            interpreter: run.interpreter,
            body: run.body.clone(),
            env: param_env(&canonical),
            timeout: Duration::from_secs(entry.effective_timeout_sec(run.timeout_sec) as u64),
            run_dir: pbrun::default_run_dir(),
            limits: Default::default(),
        })
    }

    fn start_playbook(&mut self, run: &RunRequest, spec: RunSpec) {
        let tx = self.pb_tx.clone();
        let run_id = run.run_id.clone();
        let playbook_id = run.playbook_id.clone();
        let body_hash = run.body_hash.clone();
        tracing::info!(
            interpreter = ?run.interpreter,
            run = %run_id,
            timeout_s = spec.timeout.as_secs(),
            "playbook.run accepted; spawning"
        );
        let rid = run_id.clone();
        let handle = pbrun::start(spec, move |e| match e {
            RunEvent::Output { stream, seq, chunk } => {
                let _ = tx.send(PbMsg::Output(PbOutput {
                    t: "pb.output".into(),
                    run_id: rid.clone(),
                    stream: stream.into(),
                    seq,
                    chunk,
                    ts: now_ms(),
                }));
            }
            RunEvent::End(end) => {
                let _ = tx.send(PbMsg::End {
                    end: PbEnd {
                        t: "pb.end".into(),
                        run_id: rid.clone(),
                        exit: end.exit,
                        duration_ms: end.duration_ms,
                        truncated: end.truncated,
                        ran_as: "user".into(),
                        error: end.error,
                        ts: now_ms(),
                    },
                    playbook_id: playbook_id.clone(),
                    body_hash: body_hash.clone(),
                });
            }
        });
        self.running = Some(RunningPb { run_id, handle });
    }

    // ---- inbound frames ------------------------------------------------------------------------

    /// Open one inbound frame. A frame that fails decrypt / replay / sequence returns the
    /// `(reason, channel)` for the §1.3 step-9 teardown (contract correctness F7 / security C1);
    /// otherwise it is routed and `Ok(())` is returned.
    async fn on_inbound(&mut self, inb: Inbound) -> Result<(), (SecFailReason, String)> {
        let opened = {
            let Some(sc) = self.sec.get_mut(&inb.label) else {
                return Ok(());
            };
            match sc.open(&inb.data) {
                Ok(o) => o,
                Err(r) => {
                    tracing::warn!(label = %inb.label, reason = ?r, "frame failed to open -> sec.fail");
                    return Err((r, inb.label.clone()));
                }
            }
        };
        self.route_inbound(&inb.label, opened).await;
        Ok(())
    }

    async fn route_inbound(&mut self, label: &str, opened: ia_core::secchan::OpenedFrame) {
        match label {
            "ia.control" => {
                let Some(text) = opened.as_text() else { return };
                let text = text.to_string();
                self.on_control(&text).await;
            }
            "ia.chat" => {
                let Some(text) = opened.as_text() else { return };
                let Ok(v) = serde_json::from_str::<Value>(text) else {
                    return;
                };
                if v.get("t").and_then(|t| t.as_str()) == Some("chat") {
                    let msg_id = v
                        .get("msgId")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string();
                    let body = v
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    // Dev builds echo the text so the e2e can prove it arrived; release logs only
                    // the length (chat content stays out of logs).
                    #[cfg(feature = "dev")]
                    tracing::info!("chat message: {body}");
                    #[cfg(not(feature = "dev"))]
                    tracing::info!(chars = body.chars().count(), "chat message received");
                    let ack = json!({ "t": "chat.ack", "msgId": msg_id, "ts": now_ms() });
                    self.seal("ia.chat", &ack.to_string()).await;
                    self.ui(UiCommand::Chat {
                        from_technician: true,
                        text: body,
                    });
                }
            }
            "ia.ctrl" => {
                let Some(text) = opened.as_text() else { return };
                if let Ok(v) = serde_json::from_str::<Value>(text) {
                    if v.get("t").and_then(|t| t.as_str()) == Some("recording.state") {
                        let on = v
                            .get("recording")
                            .and_then(|r| r.as_bool())
                            .unwrap_or(false);
                        self.ui(UiCommand::Recording { on, server: false });
                    }
                }
            }
            "ia.file" => {
                if opened.text {
                    let text = opened.as_text().unwrap_or("").to_string();
                    if let Some(offer) = FileOffer::parse(&text) {
                        self.on_file_offer(offer).await;
                    } else if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        match v.get("t").and_then(|t| t.as_str()) {
                            Some("file.done") => self.on_file_done().await,
                            Some("file.cancel") => {
                                let fid =
                                    v.get("fileId").and_then(|f| f.as_u64()).unwrap_or(0) as u32;
                                self.on_file_cancel(fid).await;
                            }
                            _ => {}
                        }
                    }
                } else if let Some((_fid, idx, payload)) = decode_file_chunk(&opened.plaintext) {
                    let payload = payload.to_vec();
                    self.on_file_chunk(idx, &payload).await;
                }
            }
            _ => {}
        }
    }

    async fn on_control(&mut self, text: &str) {
        let req = CtlReq::parse(text);
        let Some((mut response, effect)) =
            self.control
                .handle_text(text, &mut *self.input_sink, &mut *self.clipboard)
        else {
            return;
        };
        // Effects whose answer depends on the Desk or on checks run before the reply.
        let mut deferred = false;
        let mut playbook: Option<PlaybookCheck> = None;
        match &effect {
            SessionEffect::LevelRequest { .. } => {
                let outcome = self
                    .control
                    .consent
                    .request_level(AgentConsentLevel::Control);
                if outcome == LevelRequestOutcome::Prompt && !self.headless() {
                    if self.pending_level.is_some() {
                        response = refused_res(req.as_ref(), "busy");
                    } else {
                        deferred = true;
                    }
                }
            }
            SessionEffect::PlaybookRun {
                run_id,
                playbook_id,
                body_hash,
                body,
                requires_elevation,
            } => {
                let args = req.as_ref().map(|r| &r.args);
                let run = RunRequest {
                    run_id: run_id.clone(),
                    playbook_id: playbook_id.clone(),
                    body_hash: body_hash.clone(),
                    body: body.clone(),
                    interpreter: args
                        .and_then(|a| a.get("interpreter"))
                        .and_then(|v| v.as_str())
                        .and_then(parse_interpreter)
                        .unwrap_or(PlaybookInterpreter::Powershell),
                    requires_elevation: *requires_elevation,
                    timeout_sec: args
                        .and_then(|a| a.get("timeoutSec"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32,
                    args: args
                        .and_then(|a| a.get("args"))
                        .and_then(|v| v.as_object())
                        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                        .unwrap_or_default(),
                };
                let checked = self.prepare_playbook(&run);
                if let Err((code, _)) = &checked {
                    response = refused_res(req.as_ref(), code);
                }
                playbook = Some((run, checked));
            }
            SessionEffect::PlaybookCancel { run_id } => {
                let live = self.running.as_ref().is_some_and(|r| &r.run_id == run_id);
                if let Some(result) = response.get_mut("result") {
                    *result = json!({ "cancelled": live });
                }
            }
            _ => {}
        }
        let ok = response
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if ok && req.as_ref().is_some_and(|r| r.op == "clipboard.set") {
            self.receipt.clip_to_desk += 1;
        }
        if !deferred {
            if let Some(r) = &req {
                tracing::info!(op = %r.op, ok, "ctl.res {}", if ok { "ok" } else { "refused" });
            }
            self.seal("ia.control", &response.to_string()).await;
        }
        self.on_effect(req, effect, deferred, playbook).await;
    }

    async fn on_effect(
        &mut self,
        req: Option<CtlReq>,
        effect: SessionEffect,
        deferred: bool,
        playbook: Option<PlaybookCheck>,
    ) {
        match effect {
            SessionEffect::ElevationRequest { reason } => {
                let op_id = req
                    .as_ref()
                    .map(|r| op_id_for(&self.session_id, &r.id))
                    .unwrap_or_default();
                if self.headless() {
                    // Dev / e2e path: the hand-over mint is exercised end to end (the console
                    // asserts `elevation.handover_minted`). A real interactive build does NOT
                    // mint (F11 / C-03): the runas relaunch + named pipe + elevated child are
                    // not wired, so minting only burns the budget and chains `handover_expired`.
                    tracing::info!(%reason, %op_id, "elevation.request; minting hand-over (headless)");
                    let _ = self
                        .ws
                        .send(json!({ "t": "desk.elevation", "sessionId": self.session_id, "opId": op_id }))
                        .await;
                } else {
                    // Stop the chain accumulating un-completable hand-overs: tell the console the
                    // request failed (policy / UAC unavailable) instead of minting (F11 / C-03).
                    tracing::warn!(%reason, %op_id, "elevation.request refused: hand-over not wired (uac_unavailable)");
                    let ev = json!({
                        "t": "ctl.event", "kind": "elevation",
                        "opId": op_id, "state": "failed", "cause": "policy", "ts": now_ms(),
                    });
                    self.seal("ia.control", &ev.to_string()).await;
                    let _ = self
                        .ws
                        .send(json!({
                            "t": "desk.event", "sessionId": self.session_id, "action": "elevation.failed",
                            "data": { "opId": op_id, "error": "uac_unavailable" },
                        }))
                        .await;
                }
            }
            SessionEffect::LevelRequest { reason } => {
                let op_id = req
                    .as_ref()
                    .map(|r| op_id_for(&self.session_id, &r.id))
                    .unwrap_or_default();
                if deferred {
                    tracing::info!("level.request; prompting the Desk");
                    let req_id = req.map(|r| r.id).unwrap_or_default();
                    self.emit_prompt("level", &req_id, "shown").await;
                    self.pending_level = Some(PendingLevel {
                        req_id,
                        op_id,
                        deadline: Instant::now() + Duration::from_secs(PROMPT_SECS),
                    });
                    self.ui(UiCommand::LevelPrompt {
                        reason,
                        timeout_secs: PROMPT_SECS,
                    });
                } else if self.control.consent.level < AgentConsentLevel::Control {
                    // Headless: grant (the e2e / dev path).
                    tracing::info!(%reason, "level.request; granting control (headless)");
                    self.control.consent.grant_level(AgentConsentLevel::Control);
                    let _ = self
                        .ws
                        .send(json!({ "t": "desk.consent_level", "sessionId": self.session_id, "level": "control", "requested": true, "opId": op_id }))
                        .await;
                    self.send_level_event().await;
                } else {
                    tracing::info!("level.request; already at control");
                }
            }
            SessionEffect::SelectMonitors(monitor_ids) => {
                let monitors_event = json!({
                    "t": "ctl.event", "kind": "monitors",
                    "monitors": self.control.monitors, "selected": monitor_ids, "ts": now_ms(),
                });
                self.seal("ia.control", &monitors_event.to_string()).await;
            }
            SessionEffect::PlaybookRun { .. } => {
                if let Some((run, checked)) = playbook {
                    match checked {
                        Ok(spec) => self.start_playbook(&run, spec),
                        Err((_, err)) => {
                            tracing::warn!(error = ?err, playbook = %run.playbook_id, "playbook refused before running");
                            emit_pb_error(&self.pb_tx, &run, err);
                        }
                    }
                }
            }
            SessionEffect::PlaybookCancel { run_id } => {
                if let Some(r) = self.running.as_ref().filter(|r| r.run_id == run_id) {
                    tracing::info!(run = %run_id, "playbook.cancel");
                    r.handle.cancel();
                }
            }
            SessionEffect::Quality(preset) => {
                // Honour os.quality (§4.3): the serve loop applies it to the ABR controller.
                self.pending_quality = Some(preset);
            }
            SessionEffect::None => {}
        }
    }

    async fn on_pb(&mut self, pb: PbMsg) {
        match pb {
            PbMsg::Output(out) => {
                if let Ok(s) = serde_json::to_string(&out) {
                    self.seal("ia.playbook", &s).await;
                }
            }
            PbMsg::End {
                end,
                playbook_id,
                body_hash,
            } => {
                if self
                    .running
                    .as_ref()
                    .is_some_and(|r| r.run_id == end.run_id)
                {
                    self.running = None;
                }
                tracing::info!(exit = ?end.exit, error = ?end.error, truncated = end.truncated, ran_as = %end.ran_as, "pb.end");
                if let Ok(s) = serde_json::to_string(&end) {
                    self.seal("ia.playbook", &s).await;
                }
                self.receipt.playbooks.push(format!(
                    "exit {}",
                    end.exit
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "none".into())
                ));
                // Audit (§8.5 O5): desk.event playbook.run on the WS with the paired opId.
                let op_id = op_id_for(&self.session_id, &end.run_id);
                let mut data = json!({
                    "playbookId": playbook_id, "bodyHash": body_hash, "runId": end.run_id,
                    "opId": op_id, "exit": end.exit, "durationMs": end.duration_ms,
                    "truncated": end.truncated, "ranAs": end.ran_as,
                });
                if let Some(e) = end.error {
                    data["error"] = serde_json::to_value(e).unwrap_or(Value::Null);
                }
                let _ = self
                    .ws
                    .send(json!({
                        "t": "desk.event", "sessionId": self.session_id, "action": "playbook.run",
                        "data": data,
                    }))
                    .await;
            }
        }
    }

    /// Desk -> Assist clipboard (§5.6 C2), polled; only while the switch is on at `control`.
    async fn poll_clipboard(&mut self) {
        if !self.control.consent.clipboard_active() {
            return;
        }
        let Some(text) = self.clipboard.take_update() else {
            return;
        };
        if text.is_empty() {
            return;
        }
        let (text, truncated) = prepare_desk_text(&text, self.joined_by_code);
        let ev = json!({ "t": "ctl.event", "kind": "clipboard", "text": text, "truncated": truncated, "ts": now_ms() });
        self.seal("ia.control", &ev.to_string()).await;
        self.receipt.clip_to_assist += 1;
        tracing::info!(truncated, "clipboard shared with the Assist"); // content never logged
        let toast = format!("Copied text was shared with {}", self.technician);
        self.ui(UiCommand::Toast(toast));
    }

    async fn expire_prompts(&mut self) {
        let now = Instant::now();
        if let Some(fid) = self
            .pending_file
            .as_ref()
            .filter(|p| now >= p.deadline)
            .map(|p| p.offer.file_id)
        {
            self.file_decision(fid, false, true).await;
        }
        if self
            .pending_level
            .as_ref()
            .is_some_and(|p| now >= p.deadline)
        {
            self.answer_level_request(false, true).await;
        }
    }

    async fn send_chat(&mut self, text: String) {
        let msg = json!({
            "t": "chat", "msgId": uuid::Uuid::new_v4().to_string(), "from": "desk",
            "text": text, "ts": now_ms(),
        });
        self.seal("ia.chat", &msg.to_string()).await;
    }

    /// Flush the §3.8 `control.input` (mode `os`) aggregate and the `input.text_burst`
    /// threshold to the WS as `desk.event`s and reset the window (correctness F14: the Desk
    /// reporter half of the two-reporter rule; flushed on the 10 s ticker and before
    /// `session.end`). Nothing is sent when the window is empty.
    async fn flush_input_report(&mut self) {
        if self.control.input.is_empty() {
            return;
        }
        let data = self.control.input.to_chain();
        let burst = self.control.input.text_burst_chain();
        let _ = self
            .ws
            .send(json!({
                "t": "desk.event", "sessionId": self.session_id, "action": "control.input", "data": data,
            }))
            .await;
        if let Some(burst) = burst {
            let _ = self
                .ws
                .send(json!({
                    "t": "desk.event", "sessionId": self.session_id, "action": "input.text_burst", "data": burst,
                }))
                .await;
        }
        self.control.input.reset();
    }

    /// Emit a §5.1 `prompt` `ctl.event` for a Desk prompt card (file / level / elevation), the
    /// event the console draws its prompt state from (correctness F14 "ctl.event prompt events
    /// the UI agent left stubbed").
    async fn emit_prompt(&mut self, prompt_kind: &str, id: &str, state: &str) {
        let op_id = op_id_for(&self.session_id, id);
        let ev = json!({
            "t": "ctl.event", "kind": "prompt",
            "id": id, "promptKind": prompt_kind, "state": state, "opId": op_id, "ts": now_ms(),
        });
        self.seal("ia.control", &ev.to_string()).await;
    }

    fn receipt_lines(&self, outcome: &LiveOutcome, sas: &str) -> Vec<String> {
        let elapsed = self.started.elapsed().as_secs();
        let mut lines = vec![
            match outcome {
                LiveOutcome::Revoked => "You revoked consent. Sharing has stopped.".to_string(),
                LiveOutcome::EndedRemotely => "The technician ended the session.".to_string(),
                _ => "Sharing has stopped.".to_string(),
            },
            format!(
                "Shared with {} for {}:{:02}.",
                self.technician,
                elapsed / 60,
                elapsed % 60
            ),
            format!(
                "Screens shared: {}. Level changes: {}.",
                self.control.consent.consented_monitors.len(),
                self.control.consent.level_changes
            ),
            format!(
                "Clipboard: {} to the technician, {} to you.",
                self.receipt.clip_to_assist, self.receipt.clip_to_desk
            ),
        ];
        if sas.len() == 6 {
            lines.push(format!("Security code: {} {}", &sas[..3], &sas[3..]));
        }
        if !self.receipt.playbooks.is_empty() {
            lines.push(format!(
                "Scripts run: {} ({}).",
                self.receipt.playbooks.len(),
                self.receipt.playbooks.join(", ")
            ));
        }
        for f in &self.receipt.files {
            lines.push(format!("Received file (kept): {f}"));
        }
        lines
    }
}

fn ctl_code(e: PlaybookError) -> &'static str {
    match e {
        PlaybookError::HashMismatch => "hash_mismatch",
        PlaybookError::ElevationRequired => "elevation_required",
        PlaybookError::Busy => "busy",
        _ => "not_allowed",
    }
}

fn refused_res(req: Option<&CtlReq>, code: &str) -> Value {
    ia_core::ctl::error_response(req.map(|r| r.id.as_str()).unwrap_or(""), code, None)
}

/// The fixed inputs of a live serve run (identity/policy facts; the per-generation peer,
/// channels and buses are in [`ServeIo`]).
struct ServeParams<'a> {
    cli: &'a Cli,
    session_id: &'a str,
    info: &'a CreatedInfo,
    keys: SessionKeys,
    monitors: Vec<MonitorInfo>,
    payload: ConsentPayload,
    manifest: Vec<ManifestEntry>,
    budget: Duration,
    joined_by_code: bool,
    sas: String,
}

/// The webrtc peer, its channels and the inbound/failure buses for the current key generation,
/// plus the inputs a §3.7 rebuild needs (the ICE servers, the monitors, and the bus senders).
struct ServeIo {
    peer: AgentPeer,
    chans: Chans,
    sec_dc: Arc<RTCDataChannel>,
    in_rx: mpsc::UnboundedReceiver<Inbound>,
    fail_rx: mpsc::UnboundedReceiver<(u16, SecFailReason)>,
    in_tx: mpsc::UnboundedSender<Inbound>,
    fail_tx: mpsc::UnboundedSender<(u16, SecFailReason)>,
    ice_servers: Vec<RTCIceServer>,
    monitor_ids: Vec<u32>,
}

/// Spawn the one-monitor VP8 pump, returning its join handle (None if the track is missing).
fn spawn_video(
    peer: &AgentPeer,
    viewed: u32,
    monitors: &[MonitorInfo],
    synthetic: bool,
    stop: Arc<tokio::sync::Notify>,
    path: Arc<std::sync::atomic::AtomicU8>,
    meter: Arc<VideoMeter>,
) -> Option<tokio::task::JoinHandle<()>> {
    peer.video_track(viewed).map(|track| {
        let (w, h) = monitors
            .iter()
            .find(|m| m.id == viewed)
            .map(|m| (m.width.max(2) & !1, m.height.max(2) & !1))
            .unwrap_or((1280, 720));
        tokio::spawn(
            async move { pump_video(track, w, h, viewed, synthetic, stop, path, meter).await },
        )
    })
}

#[allow(clippy::too_many_arguments)]
async fn serve(
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    p: ServeParams<'_>,
    io: ServeIo,
    ui: Option<DeskUi>,
    ui_rx: &mut Option<mpsc::UnboundedReceiver<UiEvent>>,
) -> Result<LiveOutcome, String> {
    let ServeParams {
        cli,
        session_id,
        info,
        keys,
        monitors,
        payload,
        manifest,
        budget,
        joined_by_code,
        mut sas,
    } = p;
    let ServeIo {
        mut peer,
        chans,
        mut sec_dc,
        mut in_rx,
        mut fail_rx,
        in_tx,
        fail_tx,
        ice_servers,
        monitor_ids,
    } = io;
    let viewed = monitors
        .iter()
        .find(|m| m.primary)
        .map(|m| m.id)
        .unwrap_or(monitor_ids.first().copied().unwrap_or(1));
    let synthetic = cli.synthetic_capture;
    let mut gen: u16 = 0;

    // Secure channels for gen 0 over the channels wired in `connect_and_serve`.
    let sec = open_sec_set(&chans, session_id, 0, &keys)?;

    // Control server: gates every op by the live consent and applies OS input.
    let consent = LiveConsent::new(payload.level, payload.clipboard, monitor_ids.clone());
    let control = ControlServer::new(consent, monitors.clone(), viewed);
    let (input_sink, mut clipboard) = platform_io(cli.synthetic_capture);
    // Only copies made after consent are shared (prime the watcher).
    let _ = clipboard.take_update();
    let (pb_tx, mut pb_rx) = mpsc::unbounded_channel::<PbMsg>();

    let mut live = Live {
        ws,
        session_id: session_id.to_string(),
        technician: info.technician.clone(),
        chans,
        sec,
        control,
        input_sink,
        clipboard,
        joined_by_code,
        manifest,
        ui,
        pb_tx,
        running: None,
        pending_file: None,
        incoming: None,
        in_flight: HashSet::new(),
        swept: false,
        pending_level: None,
        receipt: Receipt::default(),
        started: Instant::now(),
        sec_fail: None,
        pending_quality: None,
    };

    // Announce the monitor list so the console's picker populates (§3.6 M3), then the level.
    let monitors_event = json!({
        "t": "ctl.event", "kind": "monitors",
        "monitors": monitors.clone(), "selected": monitor_ids, "ts": now_ms(),
    });
    live.seal("ia.control", &monitors_event.to_string()).await;
    live.send_level_event().await;

    // Video pump + throughput meter + ABR controller fed by REMB/loss (contract §4.3, §4.4).
    let mut stop = Arc::new(tokio::sync::Notify::new());
    let capture_path = Arc::new(std::sync::atomic::AtomicU8::new(CapturePath::Gdi as u8));
    let meter = Arc::new(VideoMeter::default());
    let remb_kbps = Arc::new(AtomicU64::new(0));
    let loss_permille = Arc::new(AtomicU64::new(0));
    let mut video_handle = spawn_video(
        &peer,
        viewed,
        &monitors,
        synthetic,
        stop.clone(),
        capture_path.clone(),
        meter.clone(),
    );
    let mut remb_handle = spawn_remb_reader(
        &peer,
        remb_kbps.clone(),
        loss_permille.clone(),
        stop.clone(),
    );
    let mut abr = ia_core::abr::AbrController::default();
    let mut last_meter = MeterSnapshot::take(&meter);
    let mut last_rung = abr.rung();

    // PeerConnection connectivity (contract correctness F13): restart ICE on a sustained
    // `disconnected`, tear down with a sec note on `failed`.
    let (pc_state_tx, mut pc_state_rx) = mpsc::unbounded_channel::<RTCPeerConnectionState>();
    wire_pc_state(&peer, pc_state_tx);
    let mut disconnected_since: Option<Instant> = None;
    let mut ice_restarted = false;
    let mut want_rebuild: Option<&'static str> = None;

    // Timers + Stop triggers.
    let mut stats_iv = tokio::time::interval(Duration::from_millis(
        ia_core::types::limits::AGENT_STATS_INTERVAL_MS,
    ));
    let mut prompt_iv = tokio::time::interval(Duration::from_secs(1));
    let mut report_iv = tokio::time::interval(Duration::from_secs(10)); // §3.8 control.input flush
    report_iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut clip_iv = tokio::time::interval(Duration::from_millis(400));
    clip_iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let stop_after = cli.stop_after.map(Duration::from_secs);
    // Headless runs keep the old budget; an interactive session runs until Stop or the end.
    let deadline_dur = if live.headless() {
        budget.max(Duration::from_secs(300))
    } else {
        Duration::from_secs(24 * 3600)
    };
    let deadline = tokio::time::sleep(deadline_dur);
    tokio::pin!(deadline);
    let stop_after_fut = async {
        match stop_after {
            Some(d) => tokio::time::sleep(d).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(stop_after_fut);
    let mut stdin = dev_stop_stream();

    tracing::info!(session = session_id, "live session serving");
    let mut outcome = LiveOutcome::Stopped;

    loop {
        tokio::select! {
            _ = &mut deadline => { tracing::info!("stop: session budget elapsed"); break; }
            _ = &mut stop_after_fut => { tracing::info!("stop: --stop-after elapsed"); break; }
            _ = tokio::signal::ctrl_c() => { tracing::info!("stop: ctrl-c"); break; }
            stop_line = next_stop_line(&mut stdin) => { if stop_line { tracing::info!("stop: dev stop line"); break; } }
            _ = stats_iv.tick() => {
                if let Some(preset) = live.pending_quality.take() {
                    abr.set_preset(preset);
                }
                let now = MeterSnapshot::take(&meter);
                let interval = now.diff(&last_meter, ia_core::types::limits::AGENT_STATS_INTERVAL_MS);
                last_meter = now;
                let remb = remb_kbps.load(Ordering::Relaxed);
                let decision = abr.step(ia_core::abr::AbrSample {
                    now_ms: now_ms() as u64,
                    remb_kbps: abr_estimate_kbps(remb, interval.sent_kbps, loss_permille.load(Ordering::Relaxed)),
                    twcc_kbps: None,
                    fraction_lost: loss_permille.load(Ordering::Relaxed) as f32 / 1000.0,
                });
                if decision.rung != last_rung {
                    tracing::info!(from = last_rung.as_str(), to = decision.rung.as_str(), remb_kbps = remb, loss_permille = loss_permille.load(Ordering::Relaxed), target_kbps = decision.target_kbps, sent_kbps = interval.sent_kbps, "abr rung change");
                    last_rung = decision.rung;
                }
                let s = build_stats(&monitors, viewed, path_from_u8(capture_path.load(Ordering::Relaxed)), &interval, &decision);
                live.seal("ia.ctrl", &s.to_wire().to_string()).await;
            }
            _ = prompt_iv.tick() => live.expire_prompts().await,
            _ = report_iv.tick() => live.flush_input_report().await,
            _ = clip_iv.tick() => live.poll_clipboard().await,
            pb = pb_rx.recv() => {
                if let Some(pb) = pb { live.on_pb(pb).await; }
            }
            st = pc_state_rx.recv() => {
                match st {
                    Some(RTCPeerConnectionState::Connected) => { disconnected_since = None; ice_restarted = false; }
                    Some(RTCPeerConnectionState::Disconnected) => {
                        tracing::warn!("peer connection disconnected");
                        disconnected_since = Some(Instant::now());
                    }
                    Some(RTCPeerConnectionState::Failed) => {
                        tracing::warn!("peer connection failed: tearing down (sec:timeout)");
                        live.sec_fail = Some((SecFailReason::Timeout, None));
                        outcome = LiveOutcome::SecFailed("timeout".into());
                        break;
                    }
                    _ => {}
                }
            }
            ev = next_ui(ui_rx) => {
                match ev {
                    Some(UiEvent::Stop) => { tracing::info!("stop: pill / panel / tray"); break; }
                    Some(UiEvent::Revoke) => { tracing::info!("consent revoked from the panel"); outcome = LiveOutcome::Revoked; break; }
                    Some(UiEvent::SetLevel(l)) => live.desk_set_level(l).await,
                    Some(UiEvent::Clipboard(on)) => live.desk_set_clipboard(on).await,
                    Some(UiEvent::FileDecision { file_id, accept }) => live.file_decision(file_id, accept, false).await,
                    Some(UiEvent::LevelDecision { allow }) => live.answer_level_request(allow, false).await,
                    Some(UiEvent::ChatSend(text)) => live.send_chat(text).await,
                    Some(UiEvent::ConsentGranted(_)) | Some(UiEvent::ConsentDeclined) => {}
                    Some(UiEvent::Failed(_)) | Some(UiEvent::Closed) | None => {
                        // The indicator is mandatory (§3.5): no indicator, no sharing.
                        tracing::warn!("indicator UI gone: stopping");
                        *ui_rx = None;
                        live.ui = None;
                        break;
                    }
                }
            }
            msg = ws_rx.recv() => {
                let Some(v) = msg else { outcome = LiveOutcome::EndedRemotely; break; };
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("webrtc.ice") => add_remote_ice(&peer, &v).await,
                    Some("ping") => { let _ = live.ws.send(json!({ "t": "pong" })).await; }
                    Some("session.ended") => { outcome = LiveOutcome::EndedRemotely; break; }
                    Some("session.handed_over") => { tracing::info!("handed over to the elevated instance"); outcome = LiveOutcome::EndedRemotely; break; }
                    Some("session.recording") => {
                        let on = v.get("recording").and_then(|r| r.as_bool()).unwrap_or(false);
                        live.ui(UiCommand::Recording { on, server: true });
                    }
                    Some("consent.level_ok") => tracing::info!("consent.level_ok"),
                    // §3.7 resume / ICE refresh: the agent never reuses a PC — close it, build a
                    // fresh one, re-offer { restart: true, gen+1 } and re-run the §1.3 handshake.
                    Some("assist.reconnected") | Some("ice.refresh") => {
                        let t = v.get("t").and_then(|t| t.as_str()).unwrap_or("");
                        if t == "assist.reconnected"
                            && v.get("state").and_then(|s| s.as_str()) != Some("active")
                        {
                            continue;
                        }
                        want_rebuild = Some(if t == "ice.refresh" { "ice.refresh" } else { "assist.reconnected" });
                    }
                    _ => {}
                }
            }
            inb = in_rx.recv() => {
                let Some(inb) = inb else { continue };
                if let Err((reason, channel)) = live.on_inbound(inb).await {
                    live.sec_fail = Some((reason, Some(channel)));
                    outcome = LiveOutcome::SecFailed(sec_reason_str(reason));
                    break;
                }
            }
            f = fail_rx.recv() => {
                // A channel closed while the PC was alive, or the remote opened a stray channel
                // (contract §1.3 "Channel lifetime rule"). Ignore fails from an older generation.
                if let Some((g, reason)) = f {
                    if g == gen {
                        tracing::warn!(reason = ?reason, "secure channel lifetime violation");
                        live.sec_fail = Some((reason, None));
                        outcome = LiveOutcome::SecFailed(sec_reason_str(reason));
                        break;
                    }
                }
            }
        }
        // A sustained disconnect (> 8 s) is recovered once with a full gen+1 rebuild (contract
        // correctness F13 / §3.7). A same-PC `restart_ice` re-offer is not used: the console
        // accepts a restart offer only when `gen === lastGen + 1`, so recovery is a rebuild.
        if want_rebuild.is_none() && !ice_restarted {
            if let Some(since) = disconnected_since {
                if since.elapsed() >= Duration::from_secs(8) {
                    ice_restarted = true;
                    want_rebuild = Some("disconnected");
                }
            }
        }
        if let Some(trigger) = want_rebuild.take() {
            tracing::info!(trigger, "rebuilding the peer connection (gen+1)");
            gen = gen.wrapping_add(1);
            // Tear the current generation down before building the new one.
            stop.notify_waiters();
            if let Some(h) = video_handle.take() {
                h.abort();
            }
            remb_handle.abort();
            let _ = peer.pc.close().await;
            while in_rx.try_recv().is_ok() {} // drop stale (old-gen) frames
            match rebuild_generation(
                live.ws,
                ws_rx,
                session_id,
                gen,
                &ice_servers,
                &monitor_ids,
                &in_tx,
                &fail_tx,
            )
            .await
            {
                Ok(g) => {
                    peer = g.peer;
                    live.chans = g.chans;
                    live.sec = g.sec;
                    sec_dc = g.sec_dc;
                    sas = g.sas;
                    stop = Arc::new(tokio::sync::Notify::new());
                    remb_kbps.store(0, Ordering::Relaxed);
                    loss_permille.store(0, Ordering::Relaxed);
                    last_meter = MeterSnapshot::take(&meter);
                    video_handle = spawn_video(
                        &peer,
                        viewed,
                        &monitors,
                        synthetic,
                        stop.clone(),
                        capture_path.clone(),
                        meter.clone(),
                    );
                    remb_handle = spawn_remb_reader(
                        &peer,
                        remb_kbps.clone(),
                        loss_permille.clone(),
                        stop.clone(),
                    );
                    let (pc_tx, pc_rx) = mpsc::unbounded_channel();
                    wire_pc_state(&peer, pc_tx);
                    pc_state_rx = pc_rx;
                    disconnected_since = None;
                    live.seal("ia.control", &monitors_event.to_string()).await;
                    live.send_level_event().await;
                    if let Some(ui) = &live.ui {
                        ui.send(UiCommand::Sas(sas.clone()));
                    }
                    tracing::info!(gen, "rebuild complete");
                }
                Err(RebuildErr::Ended) => {
                    outcome = LiveOutcome::EndedRemotely;
                    break;
                }
                Err(RebuildErr::SecFail(reason)) => {
                    live.sec_fail = Some((reason, None));
                    outcome = LiveOutcome::SecFailed(sec_reason_str(reason));
                    break;
                }
            }
        }
    }

    // Flush the §3.8 aggregates before the end (attestation outbox rule, two-reporter audit).
    live.flush_input_report().await;

    // Stop / teardown (§3.5 / hard rule 2): the channel "last word" first (while the channel is
    // open), then the §1.3 step-9 / hard-rule-2 teardown in order, then the WS last word.
    tracing::info!(order = ?stop_order(), "stop message order");
    match &outcome {
        LiveOutcome::Stopped => {
            live.seal(
                "ia.ctrl",
                &json!({ "t": "stop.sharing", "ts": now_ms() }).to_string(),
            )
            .await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        LiveOutcome::Revoked => {
            live.seal(
                "ia.ctrl",
                &json!({ "t": "consent.revoked", "ts": now_ms() }).to_string(),
            )
            .await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        LiveOutcome::SecFailed(_) => {
            // §1.3 step 9: sec.fail on ia.sec (plaintext) and desk.event sec.failed, before the
            // teardown and the WS session.end { note }.
            if let Some((reason, channel)) = live.sec_fail.take() {
                let (fail, event, _end) = sec_fail_messages(session_id, reason, channel.as_deref());
                let _ = sec_dc.send_text(fail.to_string()).await;
                tokio::time::sleep(Duration::from_millis(100)).await;
                let _ = live.ws.send(event).await;
            }
        }
        _ => {}
    }
    tracing::info!(order = ?teardown_order(), "teardown order");
    live.control.consent.lower_level(AgentConsentLevel::View); // stop honouring input
    stop.notify_waiters();
    remb_handle.abort();
    if let Some(h) = video_handle {
        h.abort();
    }
    if let Some(r) = live.running.take() {
        r.handle.cancel(); // the job object kills the tree
    }
    if let Some(inc) = live.incoming.take() {
        inc.part.abort();
    }
    live.sec.clear(); // SecChannel keys are dropped with the peer (zeroise step)
    let _ = peer.pc.close().await;
    match &outcome {
        LiveOutcome::Stopped => {
            let _ = live
                .ws
                .send(json!({ "t": "session.end", "sessionId": session_id }))
                .await;
            tracing::info!("session.end sent");
        }
        LiveOutcome::Revoked => {
            let _ = live
                .ws
                .send(json!({ "t": "desk.consent", "state": "revoked" }))
                .await;
            tracing::info!("desk.consent revoked sent");
        }
        LiveOutcome::SecFailed(reason) => {
            let _ = live
                .ws
                .send(json!({ "t": "session.end", "sessionId": session_id, "note": format!("sec:{reason}") }))
                .await;
            tracing::info!(%reason, "session.end (sec) sent");
        }
        _ => {}
    }

    let lines = live.receipt_lines(&outcome, &sas);
    if let Some(ui) = live.ui.take() {
        ui.finish(lines).await;
    }

    // Self-delete decision (§10). The e2e passes --no-self-delete, so it is logged, not run.
    let kept = cli.no_self_delete;
    if deletes_on_exit(ProcessRole::UserStandalone, kept) {
        tracing::info!("self-delete decision: delete (spawning cleanup stub)");
        perform_self_delete();
    } else {
        tracing::info!("self-delete decision: skip (keep binary; --no-self-delete)");
    }
    Ok(outcome)
}

async fn seal_send(chans: &Chans, sc: &mut SecChannel, label: &str, text: &str) {
    if let Ok(frame) = sc.seal_text(text) {
        if let Some(dc) = chans.get(label) {
            let _ = dc.send(&Bytes::from(frame)).await;
        }
    }
}

fn parse_interpreter(s: &str) -> Option<PlaybookInterpreter> {
    match s {
        "powershell" => Some(PlaybookInterpreter::Powershell),
        "cmd" => Some(PlaybookInterpreter::Cmd),
        "sh" => Some(PlaybookInterpreter::Sh),
        _ => None,
    }
}

fn emit_pb_error(pb_tx: &mpsc::UnboundedSender<PbMsg>, run: &RunRequest, err: PlaybookError) {
    let end = PbEnd {
        t: "pb.end".into(),
        run_id: run.run_id.clone(),
        exit: None,
        duration_ms: 0,
        truncated: false,
        ran_as: "user".into(),
        error: Some(err),
        ts: now_ms(),
    };
    let _ = pb_tx.send(PbMsg::End {
        end,
        playbook_id: run.playbook_id.clone(),
        body_hash: run.body_hash.clone(),
    });
}

/// Continuous VP8 pump for one monitor (synthetic or GDI), keyframe every second.
#[allow(clippy::too_many_arguments)]
async fn pump_video(
    track: Arc<webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample>,
    w: u32,
    h: u32,
    monitor_id: u32,
    synthetic: bool,
    stop: Arc<tokio::sync::Notify>,
    path: Arc<std::sync::atomic::AtomicU8>,
    meter: Arc<VideoMeter>,
) {
    use webrtc::media::Sample;
    let fps = 15u32;
    let mut encoder = match Vp8Encoder::new(w, h, 1200, fps, 1) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("vp8 encoder init failed: {e}");
            return;
        }
    };
    let mut capturer = CaptureSource::new(synthetic, w, h);
    let dur = Duration::from_millis((1000 / fps) as u64);
    let mut i = 0usize;
    loop {
        tokio::select! {
            _ = stop.notified() => break,
            _ = tokio::time::sleep(dur) => {}
        }
        let frame = capturer.next_frame(monitor_id);
        path.store(
            capturer.path(monitor_id) as u8,
            std::sync::atomic::Ordering::Relaxed,
        );
        let Some(frame) = frame else {
            continue;
        };
        let force_kf = i.is_multiple_of(fps as usize);
        let t0 = Instant::now();
        let encoded = encoder.encode(&frame, force_kf);
        let encode_ns = t0.elapsed().as_nanos() as u64;
        match encoded {
            Ok(pkts) => {
                // Measured throughput for agent.stats (contract §4.4 / F13): bytes and frames
                // actually sent, and the capture-to-encoded latency.
                meter.encode_ns.fetch_add(encode_ns, Ordering::Relaxed);
                meter.encode_frames.fetch_add(1, Ordering::Relaxed);
                meter.sent_frames.fetch_add(1, Ordering::Relaxed);
                for pkt in pkts {
                    meter
                        .sent_bytes
                        .fetch_add(pkt.data.len() as u64, Ordering::Relaxed);
                    let _ = track
                        .write_sample(&Sample {
                            data: Bytes::from(pkt.data),
                            duration: dur,
                            ..Default::default()
                        })
                        .await;
                }
            }
            Err(e) => tracing::debug!("encode error: {e}"),
        }
        i += 1;
    }
}

/// The frame source: synthetic (e2e / loopback), or DXGI Desktop Duplication with the
/// per-monitor GDI fallback (§4.1).
enum CaptureSource {
    Synthetic(SyntheticCapturer),
    #[cfg(all(windows, feature = "winapi"))]
    Dxgi(Box<ia_capture_win::dxgi::DxgiCapturer>),
}

impl CaptureSource {
    fn new(synthetic: bool, w: u32, h: u32) -> Self {
        #[cfg(all(windows, feature = "winapi"))]
        if !synthetic {
            return CaptureSource::Dxgi(Box::new(ia_capture_win::dxgi::DxgiCapturer::new()));
        }
        let _ = synthetic;
        CaptureSource::Synthetic(SyntheticCapturer::single(w, h))
    }

    fn next_frame(&mut self, id: u32) -> Option<ia_platform::traits::Frame> {
        match self {
            CaptureSource::Synthetic(c) => c.next_frame(id),
            #[cfg(all(windows, feature = "winapi"))]
            CaptureSource::Dxgi(c) => c.next_frame(id),
        }
    }

    /// `agent.stats.capturePath` (the synthetic source reports `gdi`, as before).
    fn path(&self, id: u32) -> CapturePath {
        match self {
            CaptureSource::Synthetic(_) => CapturePath::Gdi,
            #[cfg(all(windows, feature = "winapi"))]
            CaptureSource::Dxgi(c) => c.path(id),
        }
    }
}

fn path_from_u8(v: u8) -> CapturePath {
    match v {
        x if x == CapturePath::Dda as u8 => CapturePath::Dda,
        x if x == CapturePath::Projection as u8 => CapturePath::Projection,
        _ => CapturePath::Gdi,
    }
}

// ---- dev Stop line on stdin (console build only) -------------------------------------

#[cfg(feature = "dev")]
type StopStream = Option<tokio::io::Lines<tokio::io::BufReader<tokio::io::Stdin>>>;
#[cfg(not(feature = "dev"))]
type StopStream = Option<()>;

#[cfg(feature = "dev")]
fn dev_stop_stream() -> StopStream {
    use tokio::io::AsyncBufReadExt;
    Some(tokio::io::BufReader::new(tokio::io::stdin()).lines())
}

#[cfg(not(feature = "dev"))]
fn dev_stop_stream() -> StopStream {
    None
}

#[cfg(feature = "dev")]
async fn next_stop_line(stream: &mut StopStream) -> bool {
    match stream {
        Some(lines) => match lines.next_line().await {
            Ok(Some(l)) => l.trim().eq_ignore_ascii_case("stop"),
            _ => std::future::pending::<bool>().await,
        },
        None => std::future::pending::<bool>().await,
    }
}

#[cfg(not(feature = "dev"))]
async fn next_stop_line(_stream: &mut StopStream) -> bool {
    std::future::pending::<bool>().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn level_wire_maps_every_level() {
        assert_eq!(level_wire(AgentConsentLevel::View), "view");
        assert_eq!(level_wire(AgentConsentLevel::Control), "control");
        assert_eq!(level_wire(AgentConsentLevel::Elevated), "elevated");
    }

    #[test]
    fn parse_manifest_reads_pinned_entries() {
        let created = json!({
            "t": "session.created",
            "sessionId": "s1",
            "agent": { "playbooks": [
                { "id": "11111111-1111-1111-1111-111111111111", "name": "Flush DNS cache", "bodyHash": "ab".repeat(32), "requiresElevation": false, "timeoutSec": 30, "parameters": [] },
                { "id": "22222222-2222-2222-2222-222222222222", "name": "Restart Print Spooler", "bodyHash": "cd".repeat(32), "requiresElevation": true,
                  "parameters": [{ "name": "host", "label": "Host", "type": "string", "required": true, "pattern": "[a-z]+" }] }
            ] }
        });
        let m = parse_manifest(&created);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "11111111-1111-1111-1111-111111111111");
        assert!(!m[0].requires_elevation);
        assert_eq!(m[0].timeout_sec, 30);
        assert!(m[1].requires_elevation);
        assert_eq!(m[1].timeout_sec, 120);
        assert_eq!(m[1].parameters.len(), 1);
    }

    #[test]
    fn parse_manifest_empty_when_absent() {
        assert!(parse_manifest(&json!({ "t": "session.created" })).is_empty());
    }

    #[test]
    fn created_info_reads_technician_org_and_recording() {
        let c = json!({ "assist": { "id": "u", "name": "Asha Tech" }, "org": { "displayName": "E2E Portable" }, "recordingMode": "server" });
        let i = created_info(&c);
        assert_eq!(i.technician, "Asha Tech");
        assert_eq!(i.org, "E2E Portable");
        assert_eq!(i.recording_mode, "server");
        let empty = created_info(&json!({}));
        assert_eq!(empty.technician, "Your technician");
    }

    #[test]
    fn build_stats_emits_the_wire_shape_the_console_parses() {
        let monitors = vec![
            MonitorInfo {
                id: 1,
                name: "SYNTHETIC1".into(),
                primary: true,
                x: 0,
                y: 0,
                width: 1280,
                height: 720,
                scale: 1.0,
                mid: None,
            },
            MonitorInfo {
                id: 2,
                name: "M2".into(),
                primary: false,
                x: 1280,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 1.0,
                mid: None,
            },
        ];
        // Measured interval + an ABR decision drive the stats (no invented constants, F13).
        let interval = MeterInterval {
            sent_kbps: 1100,
            sent_fps: 15.0,
            encode_ms: Some(6.0),
        };
        let decision = ia_core::abr::AbrDecision {
            target_kbps: 1500,
            rung: ia_core::abr::Rung::High,
            floor_mode: false,
            force_keyframe: false,
        };
        let wire = build_stats(&monitors, 1, CapturePath::Gdi, &interval, &decision).to_wire();
        assert_eq!(wire["t"], json!("agent.stats"));
        assert_eq!(wire["encoder"], json!("vp8"));
        assert_eq!(wire["capturePath"], json!("gdi"));
        assert_eq!(wire["sentKbps"], json!(1100));
        assert_eq!(wire["rung"], json!("high"));
        assert!(wire["sentFps"].as_f64().unwrap() > 0.0);
        // cpuPercent/recorderKbps are not measured here: null, not invented.
        assert_eq!(wire["cpuPercent"], Value::Null);
        assert_eq!(wire["recorderKbps"], Value::Null);
        // The viewed monitor streams; the other is paused (fps 0).
        let mons = wire["monitors"].as_array().unwrap();
        assert_eq!(mons[0]["fps"].as_u64().unwrap(), 15);
        assert_eq!(mons[1]["fps"].as_u64().unwrap(), 0);
    }

    #[test]
    fn parse_interpreter_round_trips() {
        assert_eq!(parse_interpreter("cmd"), Some(PlaybookInterpreter::Cmd));
        assert_eq!(
            parse_interpreter("powershell"),
            Some(PlaybookInterpreter::Powershell)
        );
        assert_eq!(parse_interpreter("bogus"), None);
    }

    #[test]
    fn injected_bad_frame_opens_as_decrypt_and_yields_session_end_note_sec_decrypt() {
        // Loopback (§1.3 step 9): a tampered ia.control frame fails `SecChannel::open` with
        // `decrypt`, which the serve loop turns into `session.end { note: 'sec:decrypt' }`.
        let mut desk_set = SecChannelSet::new();
        let mut assist_set = SecChannelSet::new();
        let k_d2a = [3u8; 32];
        let k_a2d = [4u8; 32];
        let mut desk = desk_set
            .open(Operator::Desk, "sess-1", "ia.control", 0, k_d2a, k_a2d)
            .unwrap();
        let mut assist = assist_set
            .open(Operator::Assist, "sess-1", "ia.control", 0, k_d2a, k_a2d)
            .unwrap();
        let mut frame = desk.seal_text(r#"{"t":"ctl.req"}"#).unwrap();
        *frame.last_mut().unwrap() ^= 0xFF; // tamper the tag
        let reason = assist.open(&frame).unwrap_err();
        assert_eq!(reason, SecFailReason::Decrypt);
        let (_fail, _ev, end) = sec_fail_messages("sess-1", reason, Some("ia.control"));
        assert_eq!(end["note"], json!("sec:decrypt"));
    }

    #[test]
    fn sec_fail_messages_carry_the_contract_note_and_reason() {
        use ia_core::types::SecFailReason;
        // A bad frame that fails to decrypt (contract §1.3 step 9): the loopback assertion.
        let (fail, ev, end) =
            sec_fail_messages("sess-1", SecFailReason::Decrypt, Some("ia.control"));
        assert_eq!(fail["t"], json!("sec.fail"));
        assert_eq!(fail["reason"], json!("decrypt"));
        assert_eq!(ev["action"], json!("sec.failed"));
        assert_eq!(ev["data"]["reason"], json!("decrypt"));
        assert_eq!(ev["data"]["channel"], json!("ia.control"));
        assert_eq!(end["t"], json!("session.end"));
        assert_eq!(end["note"], json!("sec:decrypt"));
        // A channel-close failure with no specific inbound channel.
        let (_f, ev2, end2) = sec_fail_messages("sess-1", SecFailReason::Channel, None);
        assert_eq!(end2["note"], json!("sec:channel"));
        assert!(ev2["data"].get("channel").is_none());
    }

    #[test]
    fn ctl_codes_for_playbook_refusals() {
        assert_eq!(ctl_code(PlaybookError::HashMismatch), "hash_mismatch");
        assert_eq!(
            ctl_code(PlaybookError::ElevationRequired),
            "elevation_required"
        );
        assert_eq!(ctl_code(PlaybookError::Busy), "busy");
        assert_eq!(ctl_code(PlaybookError::NotAllowed), "not_allowed");
        let r = refused_res(None, "refused");
        assert_eq!(r["ok"], json!(false));
        assert_eq!(r["error"]["code"], json!("refused"));
        assert!(r["ts"].as_u64().is_some());
    }
}
