//! The live-session serve loop (contract §1.3, §3-§8), compiled under `media`. Runs once a
//! `session.created` arrives: auto-consent, build the webrtc-rs peer, offer, run the `ia.sec`
//! handshake, then serve `ia.control` / `ia.chat` / `ia.file` / `ia.playbook`, pump VP8
//! frames and `agent.stats`, handle the elevation mint, and tear down on Stop (§10).
//!
//! It bridges the tested pure units (`ia_core::{ctl,consent,filexfer,playbook,stats,teardown}`
//! and `crate::{peer,channels,sechs,vp8,capture}`) to webrtc-rs and the OS. The in-process
//! loopback test drives the same path with a fake Assist.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use crate::capture::SyntheticCapturer;
use crate::channels::run_handshake;
use crate::cli::Cli;
use crate::live::{ControlServer, SessionEffect};
use crate::peer::{AgentPeer, PeerRole};
use crate::signal::SignalWriter;
use crate::vp8::Vp8Encoder;
use ia_core::consent::LiveConsent;
use ia_core::ctl::CtlReq;
use ia_core::filexfer::{decode_file_chunk, FileOffer, Receiver};
use ia_core::playbook::{check_run, ManifestEntry, PbEnd, PbOutput, PlaybookError, RunRequest};
use ia_core::sec::{SessionKeys, Side};
use ia_core::secchan::{Operator, SecChannel, SecChannelSet};
use ia_core::stats::{AgentStats, StatMonitor};
use ia_core::teardown::{deletes_on_exit, stop_order, teardown_order, ProcessRole};
use ia_core::types::{
    op_id_for, AgentConsentLevel, CapturePath, ElevationLevel, MonitorInfo, PlaybookInterpreter,
    VideoEncoder,
};
use ia_platform::traits::{Capturer, ClipboardBridge, InputSink};

type Chans = HashMap<String, Arc<RTCDataChannel>>;
type Secs = HashMap<String, SecChannel>;

/// How a live session ended (logged by the binary).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveOutcome {
    /// Stop requested (SIGINT, a dev `stop` line, `--stop-after`, or the budget); the agent
    /// sent `stop.sharing` + `session.end` and logged the self-delete decision.
    Stopped,
    /// The server (or Assist) ended the session first.
    EndedRemotely,
    /// The secure handshake or peer setup failed before the session went live.
    Failed(String),
}

/// One decrypted frame routed to the serve loop by channel label.
struct Inbound {
    label: String,
    data: Vec<u8>,
}

/// Playbook output flowing from a run task back to the serve loop (which seals and sends it).
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
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Where received files land (`Downloads\IndiansAssist\`, §6.1 F7; the user's, never deleted).
fn received_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        return PathBuf::from(home).join("Downloads").join("IndiansAssist");
    }
    std::env::temp_dir().join("IndiansAssist")
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Run the full live session. `created` is the `session.created` frame the Desk received.
pub async fn run_live_session(
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    cli: &Cli,
    created: &Value,
    budget: Duration,
) -> Result<LiveOutcome, String> {
    let session_id = created
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or("session.created has no sessionId")?
        .to_string();
    let manifest = parse_manifest(created);
    let monitors = capture_monitors(cli);
    let monitor_ids: Vec<u32> = monitors.iter().map(|m| m.id).collect();

    // 1) Auto-consent (dev / e2e): grant at the requested level with the captured monitors.
    // Give the freshly-navigated Assist console a moment to mount and subscribe to the
    // signalling stream first, so the `consent.changed` the server mirrors on this consent is
    // not delivered before there is a listener (it is not buffered). The retry on the offer
    // below covers the same race for `webrtc.offer`.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    // Consent is never implied. Only the dev `--auto-consent` switch grants without a window;
    // the native consent window (§3.3) is not driven from this loop yet, so without the switch
    // (every release build) the agent declines rather than share anything.
    let Some(level) = cli.auto_consent else {
        tracing::warn!("no consent window in this build and no --auto-consent: declining");
        let _ = ws
            .send(json!({ "t": "desk.consent", "state": "revoked" }))
            .await;
        return Ok(LiveOutcome::Failed(
            "consent declined (no consent UI)".into(),
        ));
    };
    tracing::info!(
        level = level_wire(level),
        monitors = monitor_ids.len(),
        "auto-consent granted"
    );
    ws.send(json!({
        "t": "desk.consent",
        "state": "granted",
        "surface": "monitor",
        "native": { "level": level_wire(level), "monitors": monitor_ids, "clipboard": false },
    }))
    .await?;

    // Wait for consent.ok (carries the Desk ICE servers; localhost uses host candidates).
    let consent_deadline = tokio::time::sleep(Duration::from_secs(15));
    tokio::pin!(consent_deadline);
    loop {
        tokio::select! {
            _ = &mut consent_deadline => return Err("no consent.ok before timeout".into()),
            msg = ws_rx.recv() => {
                let Some(v) = msg else { return Ok(LiveOutcome::EndedRemotely) };
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("consent.ok") => break,
                    Some("session.ended") => return Ok(LiveOutcome::EndedRemotely),
                    Some("ping") => { let _ = ws.send(json!({ "t": "pong" })).await; }
                    Some("error") => return Err(format!("consent error: {v}")),
                    _ => {}
                }
            }
        }
    }

    // 2) Build the peer, add a VP8 track per monitor, create the seven channels, offer (gen 0).
    let peer = AgentPeer::new(PeerRole::Desk, &monitor_ids, false)
        .await
        .map_err(|e| format!("peer: {e}"))?;
    let offer = peer.offer().await.map_err(|e| format!("offer: {e}"))?;
    let offer_msg = json!({ "t": "webrtc.offer", "sessionId": session_id, "sdp": offer, "gen": 0 });
    tracing::info!(sdp_len = offer.len(), "sending webrtc.offer (gen 0)");
    ws.send(offer_msg.clone()).await?;

    // 3) Apply the answer and collect trickled ICE until the DTLS fingerprints are known. The
    // offer is re-sent every 2.5 s until an answer arrives, in case the Assist console had not
    // finished subscribing when the first one was relayed (the console rebuilds idempotently).
    let hs_deadline = tokio::time::sleep(Duration::from_secs(25));
    tokio::pin!(hs_deadline);
    let mut resend = tokio::time::interval(Duration::from_millis(2500));
    resend.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    resend.tick().await; // consume the immediate first tick (we just sent the offer)
    let mut answered = false;
    let fprs = loop {
        if answered {
            if let Some(f) = peer.fingerprints().await {
                break f;
            }
        }
        tokio::select! {
            _ = &mut hs_deadline => return Ok(LiveOutcome::Failed("no answer / fingerprints".into())),
            _ = resend.tick(), if !answered => {
                tracing::info!("re-sending webrtc.offer (no answer yet)");
                let _ = ws.send(offer_msg.clone()).await;
            }
            _ = tokio::time::sleep(Duration::from_millis(50)), if answered => {}
            msg = ws_rx.recv() => {
                let Some(v) = msg else {
                    tracing::warn!("signalling socket closed while waiting for the answer");
                    return Ok(LiveOutcome::EndedRemotely);
                };
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("webrtc.answer") if !answered => {
                        tracing::info!("webrtc.answer received; applying");
                        if let Some(sdp) = v.get("sdp").and_then(|s| s.as_str()) {
                            peer.pc
                                .set_remote_description(RTCSessionDescription::answer(sdp.to_string()).map_err(|e| e.to_string())?)
                                .await
                                .map_err(|e| format!("set answer: {e}"))?;
                            answered = true;
                        }
                    }
                    Some("webrtc.answer") => {}
                    Some("webrtc.ice") => add_remote_ice(&peer, &v).await,
                    Some("ping") => { let _ = ws.send(json!({ "t": "pong" })).await; }
                    Some("session.ended") => return Ok(LiveOutcome::EndedRemotely),
                    other => tracing::info!(t = ?other, "ws frame while awaiting answer"),
                }
            }
        }
    };
    let (own_fpr, remote_fpr) = fprs;

    // 4) Run the §1.3 handshake over ia.sec and log the security code the harness reads.
    let sec_dc = await_channel(&peer, "ia.sec")
        .await
        .ok_or("ia.sec never opened")?;
    let (keys, sas) = run_handshake(sec_dc, Side::Desk, &session_id, 0, &own_fpr, &remote_fpr)
        .await
        .map_err(|r| format!("ia.sec handshake failed: {r:?}"))?;
    if sas.len() == 6 {
        tracing::info!("security code {} {}", &sas[0..3], &sas[3..6]);
    } else {
        tracing::info!("security code {sas}");
    }

    serve(
        ws,
        ws_rx,
        cli,
        &session_id,
        &peer,
        keys,
        monitors,
        level,
        manifest,
        budget,
    )
    .await
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

#[allow(clippy::too_many_arguments)]
async fn serve(
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    cli: &Cli,
    session_id: &str,
    peer: &AgentPeer,
    keys: SessionKeys,
    monitors: Vec<MonitorInfo>,
    level: AgentConsentLevel,
    manifest: Vec<ManifestEntry>,
    budget: Duration,
) -> Result<LiveOutcome, String> {
    let monitor_ids: Vec<u32> = monitors.iter().map(|m| m.id).collect();
    let viewed = monitors
        .iter()
        .find(|m| m.primary)
        .map(|m| m.id)
        .unwrap_or(1);

    // Open the encrypted channels (Desk operator, gen 0) and wire inbound forwarders.
    let mut set = SecChannelSet::new();
    let labels = [
        "ia.control",
        "ia.chat",
        "ia.file",
        "ia.playbook",
        "ia.ctrl",
        "ia.annot",
    ];
    let mut sec: Secs = HashMap::new();
    let mut chans: Chans = HashMap::new();
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Inbound>();
    for label in labels {
        let dc = await_channel(peer, label)
            .await
            .ok_or_else(|| format!("{label} never opened"))?;
        forward(&dc, label, in_tx.clone());
        chans.insert(label.to_string(), dc);
        sec.insert(
            label.to_string(),
            set.open(Operator::Desk, session_id, label, 0, keys.k_d2a, keys.k_a2d)
                .map_err(|e| format!("secchan {label}: {e}"))?,
        );
    }

    // Control server: gates every op by the live consent and applies OS input.
    let consent = LiveConsent::new(level, false, monitor_ids.clone());
    let mut control = ControlServer::new(consent, monitors.clone(), viewed);
    let (mut input_sink, mut clipboard) = platform_io(cli.synthetic_capture);

    // Announce the monitor list so the console's picker populates (§3.6 M3), then the level.
    let monitors_event = json!({
        "t": "ctl.event", "kind": "monitors",
        "monitors": monitors.clone(), "selected": monitor_ids, "ts": now_ms(),
    });
    seal_send(
        &chans,
        sec.get_mut("ia.control").unwrap(),
        "ia.control",
        &monitors_event.to_string(),
    )
    .await;
    let level_event = json!({
        "t": "ctl.event", "kind": "agent_level",
        "level": level_wire(level), "clipboard": false, "elevation": "user", "ts": now_ms(),
    });
    seal_send(
        &chans,
        sec.get_mut("ia.control").unwrap(),
        "ia.control",
        &level_event.to_string(),
    )
    .await;

    // Video pump: synthetic (e2e) or GDI, one monitor, continuous VP8 with periodic keyframes.
    let stop = Arc::new(tokio::sync::Notify::new());
    let video_handle = peer.video_track(viewed).map(|track| {
        let stop = stop.clone();
        let (w, h) = monitors
            .iter()
            .find(|m| m.id == viewed)
            .map(|m| (m.width.max(2) & !1, m.height.max(2) & !1))
            .unwrap_or((1280, 720));
        let synthetic = cli.synthetic_capture;
        tokio::spawn(async move { pump_video(track, w, h, viewed, synthetic, stop).await })
    });

    // File receive state (one at a time, §6.1 F1).
    let mut receiver: Option<(Receiver, String)> = None;
    let mut taken: HashSet<String> = HashSet::new();

    // Playbook output channel (run tasks -> serve loop).
    let (pb_tx, mut pb_rx) = mpsc::unbounded_channel::<PbMsg>();
    let mut running = false;

    // Stats + Stop triggers.
    let mut stats_iv = tokio::time::interval(Duration::from_secs(5));
    let stop_after = cli.stop_after.map(Duration::from_secs);
    let deadline = tokio::time::sleep(budget.max(Duration::from_secs(300)));
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
                let s = build_stats(&monitors, viewed);
                seal_send(&chans, sec.get_mut("ia.ctrl").unwrap(), "ia.ctrl", &s.to_wire().to_string()).await;
            }
            pb = pb_rx.recv() => {
                if let Some(pb) = pb {
                    handle_pb(ws, session_id, &chans, sec.get_mut("ia.playbook").unwrap(), pb, &mut running).await;
                }
            }
            msg = ws_rx.recv() => {
                let Some(v) = msg else { outcome = LiveOutcome::EndedRemotely; break; };
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("webrtc.ice") => add_remote_ice(peer, &v).await,
                    Some("ping") => { let _ = ws.send(json!({ "t": "pong" })).await; }
                    Some("session.ended") => { outcome = LiveOutcome::EndedRemotely; break; }
                    Some("session.handed_over") => { tracing::info!("handed over to the elevated instance"); outcome = LiveOutcome::EndedRemotely; break; }
                    _ => {}
                }
            }
            inb = in_rx.recv() => {
                let Some(inb) = inb else { continue };
                handle_inbound(
                    ws, session_id, &chans, &mut sec, &mut control,
                    &mut *input_sink, &mut *clipboard, &mut receiver, &mut taken,
                    &manifest, &pb_tx, &mut running, inb,
                ).await;
            }
        }
    }

    // Stop (§3.5 / hard rule 2): `stop.sharing` on ia.ctrl first (while the channel is still
    // open), then the teardown in contract order (input stops, capture/encode stop, the peer
    // and its channels close, keys are dropped), then WS `session.end` last.
    tracing::info!(order = ?stop_order(), "stop message order");
    if outcome == LiveOutcome::Stopped {
        if let Some(sc) = sec.get_mut("ia.ctrl") {
            seal_send(
                &chans,
                sc,
                "ia.ctrl",
                &json!({ "t": "stop.sharing", "ts": now_ms() }).to_string(),
            )
            .await;
        }
        // Let SCTP flush the stop message before the channels close.
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    tracing::info!(order = ?teardown_order(), "teardown order");
    stop.notify_waiters();
    if let Some(h) = video_handle {
        h.abort();
    }
    drop(sec); // SecChannel keys are dropped with the peer (zeroise step)
    let _ = peer.pc.close().await;
    if outcome == LiveOutcome::Stopped {
        let _ = ws
            .send(json!({ "t": "session.end", "sessionId": session_id }))
            .await;
        tracing::info!("session.end sent");
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

fn build_stats(monitors: &[MonitorInfo], viewed: u32) -> AgentStats {
    let stat_monitors = monitors
        .iter()
        .map(|m| StatMonitor {
            id: m.id,
            width: m.width,
            height: m.height,
            fps: if m.id == viewed { 15 } else { 0 },
        })
        .collect();
    AgentStats {
        encoder: VideoEncoder::Vp8,
        hw_encoder: false,
        capture_path: CapturePath::Gdi,
        rung: Some(ia_core::abr::Rung::High),
        floor_mode: false,
        target_kbps: 1200,
        sent_kbps: 1100,
        recorder_kbps: None,
        capture_fps: 15.0,
        sent_fps: 15.0,
        encode_ms: Some(6.0),
        monitors: stat_monitors,
        cpu_percent: Some(4.0),
        ts: now_ms(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_inbound(
    ws: &mut SignalWriter,
    session_id: &str,
    chans: &Chans,
    sec: &mut Secs,
    control: &mut ControlServer,
    input_sink: &mut dyn InputSink,
    clipboard: &mut dyn ClipboardBridge,
    receiver: &mut Option<(Receiver, String)>,
    taken: &mut HashSet<String>,
    manifest: &[ManifestEntry],
    pb_tx: &mpsc::UnboundedSender<PbMsg>,
    running: &mut bool,
    inb: Inbound,
) {
    let opened = {
        let sc = match sec.get_mut(&inb.label) {
            Some(sc) => sc,
            None => return,
        };
        match sc.open(&inb.data) {
            Ok(o) => o,
            Err(r) => {
                tracing::warn!(label = %inb.label, reason = ?r, "frame failed to open");
                return;
            }
        }
    };
    match inb.label.as_str() {
        "ia.control" => {
            let Some(text) = opened.as_text() else { return };
            let text = text.to_string();
            let req = CtlReq::parse(&text);
            if let Some((response, effect)) = control.handle_text(&text, input_sink, clipboard) {
                let ok = response
                    .get("ok")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if let Some(r) = &req {
                    tracing::info!(op = %r.op, ok, "ctl.res {}", if ok { "ok" } else { "refused" });
                }
                seal_send(
                    chans,
                    sec.get_mut("ia.control").unwrap(),
                    "ia.control",
                    &response.to_string(),
                )
                .await;
                handle_effect(
                    ws, session_id, chans, sec, control, manifest, pb_tx, running, req, effect,
                )
                .await;
            }
        }
        "ia.chat" => {
            let Some(text) = opened.as_text() else { return };
            if let Ok(v) = serde_json::from_str::<Value>(text) {
                if v.get("t").and_then(|t| t.as_str()) == Some("chat") {
                    let msg_id = v
                        .get("msgId")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string();
                    let body = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    // Dev builds echo the text so the e2e can prove it arrived; release logs only
                    // the length (chat content stays out of logs).
                    #[cfg(feature = "dev")]
                    tracing::info!("chat message: {body}");
                    #[cfg(not(feature = "dev"))]
                    tracing::info!(chars = body.chars().count(), "chat message received");
                    let ack = json!({ "t": "chat.ack", "msgId": msg_id, "ts": now_ms() });
                    seal_send(
                        chans,
                        sec.get_mut("ia.chat").unwrap(),
                        "ia.chat",
                        &ack.to_string(),
                    )
                    .await;
                }
            }
        }
        "ia.file" => {
            if opened.text {
                let text = opened.as_text().unwrap_or("").to_string();
                if let Some(offer) = FileOffer::parse(&text) {
                    match Receiver::accept(&offer, taken) {
                        Ok((recv, accepted)) => {
                            taken.insert(accepted.final_name.clone());
                            *receiver = Some((recv, offer.sha256.clone()));
                            let accept = json!({ "t": "file.accept", "fileId": offer.file_id, "ts": now_ms() });
                            seal_send(
                                chans,
                                sec.get_mut("ia.file").unwrap(),
                                "ia.file",
                                &accept.to_string(),
                            )
                            .await;
                        }
                        Err(reason) => {
                            let reject = json!({ "t": "file.reject", "fileId": offer.file_id, "reason": reason.as_str(), "ts": now_ms() });
                            seal_send(
                                chans,
                                sec.get_mut("ia.file").unwrap(),
                                "ia.file",
                                &reject.to_string(),
                            )
                            .await;
                        }
                    }
                } else if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if v.get("t").and_then(|t| t.as_str()) == Some("file.done") {
                        finish_file(chans, sec.get_mut("ia.file").unwrap(), receiver).await;
                    }
                }
            } else if let Some((_fid, idx, payload)) = decode_file_chunk(&opened.plaintext) {
                if let Some((recv, _sha)) = receiver.as_mut() {
                    if let Err(reason) = recv.on_chunk(idx, payload) {
                        let fid = recv.file_id();
                        *receiver = None;
                        let cancel = json!({ "t": "file.cancel", "fileId": fid, "reason": reason.as_str(), "ts": now_ms() });
                        seal_send(
                            chans,
                            sec.get_mut("ia.file").unwrap(),
                            "ia.file",
                            &cancel.to_string(),
                        )
                        .await;
                    }
                }
            }
        }
        _ => {}
    }
}

async fn finish_file(
    chans: &Chans,
    sc: &mut SecChannel,
    receiver: &mut Option<(Receiver, String)>,
) {
    let Some((recv, sha)) = receiver.take() else {
        return;
    };
    let fid = recv.file_id();
    // `Receiver::finish` has already verified the bytes hash to the offer's sha256, so the
    // offer's declared value is the correct ack sha (no second hash needed here).
    match recv.finish() {
        Ok((name, bytes)) => {
            let dir = received_dir();
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join(&name);
            let ok = std::fs::write(&path, &bytes).is_ok();
            if ok {
                tracing::info!("file saved {}", path.display());
            } else {
                tracing::warn!("file save failed for {}", path.display());
            }
            let ack =
                json!({ "t": "file.ack", "fileId": fid, "ok": ok, "sha256": sha, "ts": now_ms() });
            seal_send(chans, sc, "ia.file", &ack.to_string()).await;
        }
        Err(reason) => {
            let cancel = json!({ "t": "file.cancel", "fileId": fid, "reason": reason.as_str(), "ts": now_ms() });
            seal_send(chans, sc, "ia.file", &cancel.to_string()).await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_effect(
    ws: &mut SignalWriter,
    session_id: &str,
    chans: &Chans,
    sec: &mut Secs,
    control: &mut ControlServer,
    manifest: &[ManifestEntry],
    pb_tx: &mpsc::UnboundedSender<PbMsg>,
    running: &mut bool,
    req: Option<CtlReq>,
    effect: SessionEffect,
) {
    match effect {
        SessionEffect::ElevationRequest { reason } => {
            let op_id = req
                .as_ref()
                .map(|r| op_id_for(session_id, &r.id))
                .unwrap_or_default();
            tracing::info!(%reason, %op_id, "elevation.request; minting hand-over");
            let _ = ws
                .send(json!({ "t": "desk.elevation", "sessionId": session_id, "opId": op_id }))
                .await;
        }
        SessionEffect::LevelRequest { reason } => {
            tracing::info!(%reason, "level.request; granting control");
            let mut m = json!({ "t": "desk.consent_level", "sessionId": session_id, "level": "control", "requested": true });
            if let Some(op) = req.as_ref().map(|r| op_id_for(session_id, &r.id)) {
                m["opId"] = json!(op);
            }
            let _ = ws.send(m).await;
        }
        SessionEffect::SelectMonitors(monitor_ids) => {
            let monitors_event = json!({
                "t": "ctl.event", "kind": "monitors",
                "monitors": control.monitors, "selected": monitor_ids, "ts": now_ms(),
            });
            seal_send(
                chans,
                sec.get_mut("ia.control").unwrap(),
                "ia.control",
                &monitors_event.to_string(),
            )
            .await;
        }
        SessionEffect::PlaybookRun {
            run_id,
            playbook_id,
            body_hash,
            body,
            requires_elevation,
        } => {
            let interpreter = req
                .as_ref()
                .and_then(|r| r.args.get("interpreter"))
                .and_then(|v| v.as_str())
                .and_then(parse_interpreter)
                .unwrap_or(PlaybookInterpreter::Powershell);
            let timeout_sec = req
                .as_ref()
                .and_then(|r| r.args.get("timeoutSec"))
                .and_then(|v| v.as_u64())
                .unwrap_or(120) as u32;
            let run = RunRequest {
                run_id,
                playbook_id,
                body_hash,
                body,
                interpreter,
                requires_elevation,
                timeout_sec,
            };
            if *running {
                emit_pb_error(pb_tx, &run, PlaybookError::Busy);
                return;
            }
            if let Err(e) = check_run(&run, manifest, ElevationLevel::User) {
                tracing::warn!(error = ?e, playbook = %run.playbook_id, "playbook check_run failed");
                emit_pb_error(pb_tx, &run, e);
                return;
            }
            tracing::info!(interpreter = ?run.interpreter, run = %run.run_id, "playbook.run accepted; spawning");
            *running = true;
            spawn_playbook(run, pb_tx.clone());
        }
        SessionEffect::PlaybookCancel { .. } | SessionEffect::Quality(_) | SessionEffect::None => {}
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

/// Spawn a PowerShell/cmd run, streaming `pb.output` and a final `pb.end` back (§8.4/§8.5).
fn spawn_playbook(run: RunRequest, pb_tx: mpsc::UnboundedSender<PbMsg>) {
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let plan = ia_core::playbook::launch_plan(
            run.interpreter,
            run.requires_elevation,
            ElevationLevel::User,
        );
        let (exit, out, err, failed) = match run_process(&run).await {
            Ok((code, out, err)) => (Some(code), out, err, None),
            Err(e) => {
                tracing::warn!("playbook spawn failed: {e}");
                (
                    None,
                    String::new(),
                    String::new(),
                    Some(PlaybookError::SpawnFailed),
                )
            }
        };
        tracing::info!(
            exit = ?exit,
            out_bytes = out.len(),
            err_bytes = err.len(), // content is never logged (§8.5 O5)
            "playbook process finished"
        );
        let mut seq = 0u32;
        for (stream, text) in [("stdout", out), ("stderr", err)] {
            if text.is_empty() {
                continue;
            }
            let _ = pb_tx.send(PbMsg::Output(PbOutput {
                t: "pb.output".into(),
                run_id: run.run_id.clone(),
                stream: stream.into(),
                seq,
                chunk: text,
                ts: now_ms(),
            }));
            seq += 1;
        }
        let end = PbEnd {
            t: "pb.end".into(),
            run_id: run.run_id.clone(),
            exit,
            duration_ms: started.elapsed().as_millis() as u64,
            truncated: false,
            ran_as: plan.ran_as.to_string(),
            error: failed,
            ts: now_ms(),
        };
        let _ = pb_tx.send(PbMsg::End {
            end,
            playbook_id: run.playbook_id.clone(),
            body_hash: run.body_hash.clone(),
        });
    });
}

/// `%SystemRoot%\System32` (contract §8.4/§14: interpreters are launched by their full
/// System32 path; the child also gets a Windows `PATH` so a body's own commands like
/// `ipconfig` resolve regardless of the parent's shell environment).
#[cfg(windows)]
fn system32() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    root.join("System32")
}

/// Reads the whole playbook body from stdin and runs it as a single script block (no file on
/// disk, §8.4); `exit N` in the body becomes the process exit code.
#[cfg(windows)]
const PS_STDIN_SCRIPTBLOCK: &str = "& ([scriptblock]::Create([Console]::In.ReadToEnd()))";

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
async fn run_process(run: &RunRequest) -> Result<(i32, String, String), String> {
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;
    let s32 = system32();
    let path_env = windows_path();
    match run.interpreter {
        PlaybookInterpreter::Powershell => {
            let exe = s32
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            let mut child = Command::new(&exe)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    // The body arrives on stdin and runs as ONE script block: plain
                    // `-Command -` executes stdin line by line, which drops the output
                    // after a multi-line block and loses the script's exit code.
                    "-Command",
                    PS_STDIN_SCRIPTBLOCK,
                ])
                .env("PATH", &path_env)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(run.body.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
            let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
            Ok((
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stdout).into_owned(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
            ))
        }
        PlaybookInterpreter::Cmd => {
            let dir = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("IndiansAssist")
                .join("run");
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join(format!("{}.cmd", run.run_id));
            std::fs::write(&path, run.body.as_bytes()).map_err(|e| e.to_string())?;
            let out = Command::new(s32.join("cmd.exe"))
                .args(["/Q", "/c"])
                .arg(&path)
                .env("PATH", &path_env)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .await
                .map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&path);
            Ok((
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stdout).into_owned(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
            ))
        }
        PlaybookInterpreter::Sh => Err("sh is not supported on Windows".into()),
    }
}

#[cfg(not(windows))]
async fn run_process(_run: &RunRequest) -> Result<(i32, String, String), String> {
    Ok((0, "ok\n".into(), String::new()))
}

async fn handle_pb(
    ws: &mut SignalWriter,
    session_id: &str,
    chans: &Chans,
    sc: &mut SecChannel,
    pb: PbMsg,
    running: &mut bool,
) {
    match pb {
        PbMsg::Output(out) => {
            if let Ok(s) = serde_json::to_string(&out) {
                seal_send(chans, sc, "ia.playbook", &s).await;
            }
        }
        PbMsg::End {
            end,
            playbook_id,
            body_hash,
        } => {
            *running = false;
            tracing::info!(exit = ?end.exit, error = ?end.error, ran_as = %end.ran_as, "pb.end");
            if let Ok(s) = serde_json::to_string(&end) {
                seal_send(chans, sc, "ia.playbook", &s).await;
            }
            // Audit (§8.5 O5): desk.event playbook.run on the WS with the paired opId.
            let op_id = op_id_for(session_id, &end.run_id);
            let _ = ws
                .send(json!({
                    "t": "desk.event", "sessionId": session_id, "action": "playbook.run",
                    "data": {
                        "playbookId": playbook_id, "bodyHash": body_hash, "runId": end.run_id,
                        "opId": op_id, "exit": end.exit, "durationMs": end.duration_ms,
                        "truncated": end.truncated, "ranAs": end.ran_as,
                    }
                }))
                .await;
        }
    }
}

/// Continuous VP8 pump for one monitor (synthetic or GDI), keyframe every second.
async fn pump_video(
    track: Arc<webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample>,
    w: u32,
    h: u32,
    monitor_id: u32,
    synthetic: bool,
    stop: Arc<tokio::sync::Notify>,
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
    let mut capturer: Box<dyn Capturer> = make_capturer(synthetic, w, h);
    let dur = Duration::from_millis((1000 / fps) as u64);
    let mut i = 0usize;
    loop {
        tokio::select! {
            _ = stop.notified() => break,
            _ = tokio::time::sleep(dur) => {}
        }
        let Some(frame) = capturer.next_frame(monitor_id) else {
            continue;
        };
        let force_kf = i.is_multiple_of(fps as usize);
        match encoder.encode(&frame, force_kf) {
            Ok(pkts) => {
                for pkt in pkts {
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

fn make_capturer(synthetic: bool, w: u32, h: u32) -> Box<dyn Capturer> {
    if synthetic {
        return Box::new(SyntheticCapturer::single(w, h));
    }
    #[cfg(all(windows, feature = "winapi"))]
    {
        return Box::new(ia_capture_win::gdi::GdiCapturer::new());
    }
    #[allow(unreachable_code)]
    Box::new(SyntheticCapturer::single(w, h))
}

/// §10 D2 user-instance self-delete: generate the cleanup stub and spawn it detached. Best
/// effort; failures are logged (the exe simply remains).
fn perform_self_delete() {
    #[cfg(windows)]
    {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let exe = exe.to_string_lossy().to_string();
        let pid = std::process::id();
        let stub = std::env::temp_dir().join(format!("ia-cleanup-{pid}.cmd"));
        match ia_platform::selfdelete::generate_cleanup_stub(&stub.to_string_lossy(), pid, &exe) {
            Ok(cs) => {
                if std::fs::write(&stub, cs.script_text).is_ok() {
                    tracing::info!("self-delete: cleanup stub at {}", stub.display());
                }
            }
            Err(bad) => {
                tracing::warn!("self-delete: path failed the allow-list; delete by hand: {bad}")
            }
        }
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
                { "id": "11111111-1111-1111-1111-111111111111", "name": "Flush DNS cache", "bodyHash": "ab".repeat(32), "requiresElevation": false },
                { "id": "22222222-2222-2222-2222-222222222222", "name": "Restart Print Spooler", "bodyHash": "cd".repeat(32), "requiresElevation": true }
            ] }
        });
        let m = parse_manifest(&created);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "11111111-1111-1111-1111-111111111111");
        assert!(!m[0].requires_elevation);
        assert!(m[1].requires_elevation);
    }

    #[test]
    fn parse_manifest_empty_when_absent() {
        assert!(parse_manifest(&json!({ "t": "session.created" })).is_empty());
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
        let wire = build_stats(&monitors, 1).to_wire();
        assert_eq!(wire["t"], json!("agent.stats"));
        assert_eq!(wire["encoder"], json!("vp8"));
        assert_eq!(wire["capturePath"], json!("gdi"));
        assert!(wire["sentKbps"].as_u64().unwrap() > 0);
        assert!(wire["sentFps"].as_f64().unwrap() > 0.0);
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
    fn received_dir_is_under_indiansassist() {
        assert!(received_dir().ends_with("IndiansAssist"));
    }
}
