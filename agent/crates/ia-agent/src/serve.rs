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
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

use crate::capture::SyntheticCapturer;
use crate::channels::run_handshake;
use crate::cli::Cli;
use crate::filerecv::{self, PartFile};
use crate::live::{ControlServer, SessionEffect};
use crate::pbrun::{self, RunEvent, RunHandle, RunSpec};
use crate::peer::{AgentPeer, PeerRole};
use crate::pump::{run_pump, CaptureSource, PumpSpec, VideoCtl};
use crate::recorder::{is_recorder_frame, server_records, RecorderPeer};
use crate::signal::SignalWriter;
use crate::voice::{voice_state, Voice};
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
mod recleg;
mod secfail;
mod selfdel;
mod uiloss;
use link::*;
use meter::*;
use recleg::*;
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
    /// §7.3 step 5: the elevated child took the session over. This instance exits quietly: no
    /// `session.end` (the session is alive) and no self-delete (the child runs the same image).
    HandedOver,
    /// A frame failed to decrypt / replay / sequence, a channel was closed or a stray channel
    /// opened, or the handshake/negotiation failed: the §1.3 step-9 teardown ran and the WS
    /// `session.end` carried `note: 'sec:<reason>'`. The string is the `SecFailReason`.
    SecFailed(String),
    /// Consent was declined (window, Escape, close, deadline) or setup failed.
    Failed(String),
    /// The Desk UI failed or vanished (`serve/uiloss.rs`: no indicator, no sharing). The agent
    /// sent `stop.sharing { reason: 'indicator_failed' }` when a channel was open, then
    /// `session.end { note: 'indicator_lost' }`. The string is why the UI failed.
    IndicatorLost(String),
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

/// The inverse, for the Phase D launch blob's settled consent (§4.2). An unknown value is
/// `None` rather than a guess: the caller falls back to `control`, which is what the policy
/// authorised, instead of silently widening to `elevated`.
fn level_from_wire(level: &str) -> Option<AgentConsentLevel> {
    match level {
        "view" => Some(AgentConsentLevel::View),
        "control" => Some(AgentConsentLevel::Control),
        "elevated" => Some(AgentConsentLevel::Elevated),
        _ => None,
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

/// Phase E §7.2: XTEST input (with the rule 7.3c pre-injection guard) and the X11 clipboard in
/// an X11 session; nothing on Wayland (input and clipboard are not advertised there) or when
/// capture is synthetic.
#[cfg(all(target_os = "linux", feature = "x11"))]
fn platform_io(synthetic: bool) -> (Box<dyn InputSink>, Box<dyn ClipboardBridge>) {
    if synthetic {
        return (Box::new(NoopInput), Box::new(NoopClip));
    }
    let Some(crate::desk::ScreenMode::X11 { display }) = crate::desk::current() else {
        return (Box::new(NoopInput), Box::new(NoopClip));
    };
    let input: Box<dyn InputSink> = match ia_input_x11::X11Input::open(&display) {
        Ok(i) => Box::new(i),
        Err(e) => {
            tracing::warn!("X11 input could not start: {e}");
            Box::new(NoopInput)
        }
    };
    let clip: Box<dyn ClipboardBridge> = match ia_input_x11::X11Clipboard::new() {
        Some(c) => Box::new(c),
        None => {
            tracing::warn!("X11 clipboard could not start");
            Box::new(NoopClip)
        }
    };
    (input, clip)
}

// apple-owned: begin
/// Phase F §17.2: CGEvent input (with the pre-injection guard over the agent's own windows) and
/// the `NSPasteboard` text clipboard on macOS; no-op sinks when capture is synthetic, as on
/// Windows and Linux. Input is advertised only with the Accessibility grant (`desk.rs`), and
/// without it Quartz drops posted events, so a sink without the grant does nothing.
#[cfg(all(target_os = "macos", feature = "macos"))]
fn platform_io(synthetic: bool) -> (Box<dyn InputSink>, Box<dyn ClipboardBridge>) {
    if synthetic {
        return (Box::new(NoopInput), Box::new(NoopClip));
    }
    (
        Box::new(ia_input_mac::MacInput::new()),
        Box::new(ia_input_mac::MacClipboard::new()),
    )
}
// apple-owned: end

#[cfg(not(any(
    all(windows, feature = "winapi"),
    all(target_os = "linux", feature = "x11"),
    all(target_os = "macos", feature = "macos")
)))]
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
    // apple-owned: begin
    // Phase F §17.2: the active displays in global points (the ScreenCaptureKit list).
    #[cfg(all(target_os = "macos", feature = "macos"))]
    {
        let m = crate::desk::macos_monitors();
        if !m.is_empty() {
            return m;
        }
    }
    // apple-owned: end
    // Phase E §7.4 / §7.5: the RandR monitors of an X11 session; the one placeholder a Wayland
    // session advertises (never captured, no video track).
    match crate::desk::detect(cli.synthetic_capture) {
        crate::desk::ScreenMode::X11 { display } => {
            let m = crate::desk::x11_monitors(&display);
            if !m.is_empty() {
                return m;
            }
        }
        crate::desk::ScreenMode::Wayland | crate::desk::ScreenMode::NoSession => {
            return vec![crate::desk::wayland_placeholder_monitor()];
        }
        // Phase F §9.3: the portal reports one stream; its size is known once frames flow.
        crate::desk::ScreenMode::Portal => {
            return vec![crate::desk::portal_placeholder_monitor()];
        }
        _ => {}
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
    /// Returns the Desk's Keep choice as the UI left it (Phase F §3.4: the ended view offers Keep
    /// too, so it is read only once the view is gone).
    async fn finish(self, lines: Vec<String>) -> ia_ui::model::KeepChoice {
        self.send(UiCommand::Ended { lines });
        #[cfg(feature = "gui")]
        let choice = {
            let keep = self.handle.keep_choice();
            let h = self.handle;
            let _ =
                tokio::task::spawn_blocking(move || h.wait_closed(Duration::from_secs(30))).await;
            let choice = keep.lock().map(|k| *k).unwrap_or_default();
            choice
        };
        #[cfg(not(feature = "gui"))]
        let choice = ia_ui::model::KeepChoice::default();
        choice
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
    /// The consent window could not be shown or stopped (`serve/uiloss.rs`): not a decline,
    /// nobody answered.
    UiFailed(String),
}

/// §4.3 / §6.2: what a Phase D worker does instead of asking.
///
/// * `auto_grant` — the server already decided under the device's unattended policy. The
///   worker applies the consent it was handed and the window opens **as the pill**: nobody is
///   there to answer, but the machine still shows what is happening (P3).
/// * `local_approval` — somebody is there and the policy says ask them. The approval card is
///   the C consent window with the request's reason shown in it, which is what a person needs
///   to decide (that it is not a separate card is recorded in `agent/README.md`). When the
///   policy sets `autoAllowAfterSec`, no answer within that window allows, chained
///   `approvedBy: auto_after_timeout` (rule 6.1).
/// * `local_consent` — the C §3.3 window, unchanged.
#[allow(clippy::type_complexity)]
async fn worker_consent(
    ctx: &'static crate::svc::WorkerContext,
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    info: &CreatedInfo,
    all_monitors: &[MonitorInfo],
    dev_auto_consent: Option<AgentConsentLevel>,
) -> Result<
    (
        ConsentPayload,
        Option<DeskUi>,
        Option<mpsc::UnboundedReceiver<UiEvent>>,
    ),
    String,
> {
    use ia_core::policy::ConsentDecision;
    let monitors_of = |settled: Option<&crate::svc::SettledConsent>| -> Vec<u32> {
        let wanted: Vec<u32> = settled.map(|c| c.monitors.clone()).unwrap_or_default();
        let live: Vec<u32> = all_monitors
            .iter()
            .filter(|m| wanted.is_empty() || wanted.contains(&m.id))
            .map(|m| m.id)
            .collect();
        if live.is_empty() {
            all_monitors.iter().map(|m| m.id).collect()
        } else {
            live
        }
    };
    match ctx.decision {
        ConsentDecision::AutoGrant => {
            let settled = ctx.consent.as_ref();
            let payload = ConsentPayload {
                level: settled
                    .and_then(|c| level_from_wire(&c.level))
                    .unwrap_or(AgentConsentLevel::Control),
                monitors: monitors_of(settled),
                clipboard: settled.map(|c| c.clipboard).unwrap_or(false),
            };
            tracing::info!(
                session = %ctx.session_id,
                level = level_wire(payload.level),
                monitors = payload.monitors.len(),
                "the policy authorised this session; applying the server's consent"
            );
            let req = ConsentRequest {
                technician: info.technician.clone(),
                org: info.org.clone(),
                api_host: String::new(),
                monitors: all_monitors.to_vec(),
                recording_sentence: ia_ui::bridge::recording_sentence(&info.recording_mode, None),
                warnings: vec![],
                deadline_secs: CONSENT_SECS,
                // Straight to the pill: there is nobody to ask, and a consent form flashing on
                // an unattended machine would be worse than no form at all.
                start_live: true,
            };
            match DeskUi::spawn(req) {
                Some((ui, rx)) => Ok((payload, Some(ui), Some(rx))),
                // No GUI in this build (the headless loopback): the session still runs, and the
                // missing indicator is a build fact, not a policy decision.
                None => Ok((payload, None, None)),
            }
        }
        ConsentDecision::LocalApproval | ConsentDecision::LocalConsent
            if dev_auto_consent.is_some() =>
        {
            // The dev `--auto-consent` switch (parsed only in a `dev` build, never in a
            // release one) stands in for the person at the device, as it does for a P3 Desk:
            // the F §8.12 end to end passes it to the worker (`--worker-arg`), because nobody
            // can click the consent window on the harness display.
            let level = dev_auto_consent.unwrap_or(AgentConsentLevel::Control);
            tracing::info!(
                session = %ctx.session_id,
                level = level_wire(level),
                monitors = all_monitors.len(),
                "auto-consent granted (dev): the local consent window is skipped"
            );
            let payload = ConsentPayload {
                level,
                monitors: all_monitors.iter().map(|m| m.id).collect(),
                clipboard: false,
            };
            let req = ConsentRequest {
                technician: info.technician.clone(),
                org: info.org.clone(),
                api_host: String::new(),
                monitors: all_monitors.to_vec(),
                recording_sentence: ia_ui::bridge::recording_sentence(&info.recording_mode, None),
                warnings: vec![],
                deadline_secs: CONSENT_SECS,
                start_live: true,
            };
            match DeskUi::spawn(req) {
                Some((ui, rx)) => Ok((payload, Some(ui), Some(rx))),
                None => Ok((payload, None, None)),
            }
        }
        ConsentDecision::LocalApproval | ConsentDecision::LocalConsent => {
            let unattended_line = ctx.decision == ConsentDecision::LocalApproval;
            let mut warnings = Vec::new();
            if unattended_line {
                warnings.push(format!(
                    "{} asked to connect to this computer without you starting the session.",
                    info.technician
                ));
            }
            if cfg!(feature = "dev") {
                warnings.push("Development build: local testing switches are enabled.".into());
            }
            let req = ConsentRequest {
                technician: info.technician.clone(),
                org: info.org.clone(),
                api_host: String::new(),
                monitors: all_monitors.to_vec(),
                recording_sentence: ia_ui::bridge::recording_sentence(&info.recording_mode, None),
                warnings,
                deadline_secs: CONSENT_SECS,
                start_live: false,
            };
            let Some((ui, mut rx)) = DeskUi::spawn(req) else {
                tracing::warn!("no consent UI in this build: the session is declined");
                let _ = ws
                    .send(json!({ "t": "desk.consent", "state": "revoked" }))
                    .await;
                return Err("consent declined (no consent UI)".into());
            };
            let auto_allow = ctx.policy.auto_allow_after_sec.filter(|_| unattended_line);
            match await_consent_with_timeout(ws, ws_rx, &mut rx, auto_allow).await {
                WorkerConsent::Granted(p) => Ok((p, Some(ui), Some(rx))),
                WorkerConsent::AutoAllowed => {
                    let settled = ctx.consent.as_ref();
                    let payload = ConsentPayload {
                        level: AgentConsentLevel::Control,
                        monitors: monitors_of(settled),
                        clipboard: false,
                    };
                    tracing::info!(
                        "the approval card was not answered within autoAllowAfterSec; allowing"
                    );
                    ui.send(UiCommand::Toast(
                        "The session was allowed automatically by your organisation's policy."
                            .into(),
                    ));
                    Ok((payload, Some(ui), Some(rx)))
                }
                WorkerConsent::Declined(why) => {
                    let _ = ws
                        .send(json!({ "t": "desk.consent", "state": "revoked" }))
                        .await;
                    ui.close().await;
                    Err(format!("consent declined ({why})"))
                }
                WorkerConsent::UiFailed(why) => {
                    // No indicator, no sharing: end the session as the lost indicator it is
                    // (`serve/uiloss.rs`), never as a decline nobody made.
                    tracing::warn!(%why, "the approval card could not be shown: ending the session");
                    let _ = ws.send(uiloss::indicator_lost_end(&ctx.session_id)).await;
                    ui.close().await;
                    Err(format!("indicator failed ({why})"))
                }
            }
        }
    }
}

enum WorkerConsent {
    Granted(ConsentPayload),
    /// Rule 6.1 `autoAllowAfterSec`: nobody answered in time and the policy allows.
    AutoAllowed,
    Declined(String),
    /// The card could not be shown or stopped (`serve/uiloss.rs`).
    UiFailed(String),
}

/// [`await_consent`] with the rule 6.1 countdown. `auto_allow` of `None` is the C behaviour
/// (no answer = the server's 180 s consent deadline ends the session).
async fn await_consent_with_timeout(
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    rx: &mut mpsc::UnboundedReceiver<UiEvent>,
    auto_allow: Option<u32>,
) -> WorkerConsent {
    let answer = await_consent(ws, ws_rx, rx);
    match auto_allow {
        None => match answer.await {
            ConsentDecision::Granted(p) => WorkerConsent::Granted(p),
            ConsentDecision::Declined(why) => WorkerConsent::Declined(why),
            ConsentDecision::Ended => WorkerConsent::Declined("the session ended".into()),
            ConsentDecision::UiFailed(why) => WorkerConsent::UiFailed(why),
        },
        Some(secs) => {
            match tokio::time::timeout(Duration::from_secs(u64::from(secs)), answer).await {
                Ok(ConsentDecision::Granted(p)) => WorkerConsent::Granted(p),
                Ok(ConsentDecision::Declined(why)) => WorkerConsent::Declined(why),
                Ok(ConsentDecision::Ended) => WorkerConsent::Declined("the session ended".into()),
                // A card that failed cannot count down to an auto-allow: nobody saw it.
                Ok(ConsentDecision::UiFailed(why)) => WorkerConsent::UiFailed(why),
                Err(_) => WorkerConsent::AutoAllowed,
            }
        }
    }
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
                Some(UiEvent::Failed(e)) => return ConsentDecision::UiFailed(format!("consent window failed: {e}")),
                // Closing the window is a Decline (§3.3, sent as `ConsentDeclined` first); a UI
                // thread that is simply gone is a failure nobody answered.
                Some(UiEvent::Closed) => return ConsentDecision::Declined("consent window closed".into()),
                None => return ConsentDecision::UiFailed("the consent window's thread is gone".into()),
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
    // without a window; every other run shows the native consent window (§3.3). A Phase D
    // worker takes the server's §6.2 decision instead of asking (§4.3 "Consent source"), and
    // the indicator is drawn either way (P3).
    let (payload, ui, mut ui_rx) = if let Some(child) = crate::hochild::get() {
        // §7.3 step 4: the elevated instance inherits the consent the Desk already gave. It
        // does not ask again — the same session is continuing, the person already answered,
        // and a second window would be both worse to use and a worse record.
        let payload = ConsentPayload {
            level: child.level(),
            monitors: all_monitors
                .iter()
                .map(|m| m.id)
                .filter(|id| child.consent.monitors.contains(id))
                .collect(),
            clipboard: child.consent.clipboard,
        };
        let payload = if payload.monitors.is_empty() {
            ConsentPayload {
                monitors: all_monitors.iter().map(|m| m.id).collect(),
                ..payload
            }
        } else {
            payload
        };
        tracing::info!(
            level = level_wire(payload.level),
            monitors = payload.monitors.len(),
            "the elevated instance inherited the Desk's consent"
        );
        let req = ConsentRequest {
            technician: info.technician.clone(),
            org: info.org.clone(),
            api_host: api_host(cli),
            monitors: all_monitors.clone(),
            recording_sentence: ia_ui::bridge::recording_sentence(&info.recording_mode, None),
            warnings: vec![],
            deadline_secs: CONSENT_SECS,
            // The pill, not a form: the parent's indicator is going away and this one takes
            // its place, so the machine is never without one (§3.5, P3).
            start_live: true,
        };
        match DeskUi::spawn(req) {
            Some((ui, rx)) => (payload, Some(ui), Some(rx)),
            None => (payload, None, None),
        }
    } else if let Some(ctx) = crate::svc::get() {
        // F §8.7: tell the service how many monitors this session has (a Linux service never
        // connects to X and learns the count only from its worker).
        ctx.ops.report_monitors(all_monitors.len() as u32);
        worker_consent(ctx, ws, ws_rx, &info, &all_monitors, cli.auto_consent).await?
    } else if let Some(level) = cli.auto_consent {
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
        // Phase E §7.4: a Wayland session is told, in the consent window, that its screen
        // cannot be shared and what still works.
        if crate::desk::current().is_some_and(|m| !m.shares_screen()) {
            warnings.push(ia_platform::linux::display::WAYLAND_NOTICE.into());
            // Phase F §9.5: the portal companion is here but PipeWire is not.
            if crate::desk::pipewire_missing() {
                warnings.push(crate::desk::PIPEWIRE_MISSING_LINE.into());
            }
        }
        let req = ConsentRequest {
            technician: info.technician.clone(),
            org: info.org.clone(),
            api_host: api_host(cli),
            monitors: all_monitors.clone(),
            recording_sentence: ia_ui::bridge::recording_sentence(&info.recording_mode, None),
            warnings,
            deadline_secs: CONSENT_SECS,
            start_live: false,
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
            ConsentDecision::UiFailed(why) => {
                // No indicator, no sharing (`serve/uiloss.rs`): end the session, do not crash.
                tracing::warn!(%why, "the consent window could not be shown: ending the session");
                let _ = ws.send(uiloss::indicator_lost_end(&session_id)).await;
                ui.close().await;
                return Ok(LiveOutcome::IndicatorLost(why));
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
    // Recorder frames (`peer: 'recorder'`) that arrive before the serve loop runs are kept and
    // replayed there: the recorder may join and offer while the Assist PC is still negotiating.
    let mut pending_recorder: Vec<Value> = Vec::new();
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
                if crate::recorder::is_recorder_frame(&v) {
                    pending_recorder.push(v);
                    continue;
                }
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
        &crate::desk::video_ids(&monitor_ids),
        false,
        crate::peer::configuration(ice_servers.clone()),
    )
    .await
    .map_err(|e| format!("peer: {e}"))?;
    // Voice (§6.3): one Opus track, added muted at start when a capture + render device exists;
    // the Assist's audio track (if it sends one) is played.
    let voice = crate::voice::voice_available().then(Voice::new);
    let audio_track = voice.as_ref().map(|v| v.track.clone());
    let (remote_audio_tx, remote_audio_rx) = mpsc::unbounded_channel::<Arc<TrackRemote>>();
    if let Some(t) = &audio_track {
        peer.add_audio_track(t.clone())
            .await
            .map_err(|e| format!("audio track: {e}"))?;
    }
    wire_remote_audio(&peer, remote_audio_tx.clone());
    let chans = match wire_channels(&peer, 0, &in_tx, &fail_tx).await {
        Ok(c) => c,
        Err(e) => {
            end_ui(ui, "The connection could not be set up.").await;
            return Err(e);
        }
    };

    // 3) Offer, apply the answer, read the fingerprints. An ordinary session starts at
    // generation 0; the elevated hand-over child offers the parent's generation + 1 as a
    // rebuild, which is the only offer the console accepts for a session already live (§3.7,
    // C §7.2 W43).
    let start_gen: u16 = crate::hochild::get().map(|c| c.child_gen()).unwrap_or(0);
    let (own_fpr, remote_fpr) = match negotiate(
        &peer,
        ws,
        ws_rx,
        session_id,
        start_gen,
        start_gen > 0,
        &mut pending_recorder,
    )
    .await
    {
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
        start_gen,
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
        desk_fpr: own_fpr.clone(),
        assist_fpr: remote_fpr.clone(),
        start_gen,
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
        pending_recorder,
        voice,
        audio_track,
        remote_audio_tx,
        remote_audio_rx,
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

/// How long the rule 6.2a arrival card stays up before it is simply closed (nothing is
/// recorded then: an unanswered card is not a decision).
const ARRIVAL_CARD_SECS: u64 = 600;

/// Rule 6.2a: the arrival card, and whether the session was dropped to `view` when it was shown.
struct PendingArrival {
    dropped_to_view: bool,
    deadline: Instant,
}

/// §7.3 step 2: the elevation prompt card the Desk has to answer with a physical click.
struct PendingElevation {
    req_id: String,
    op_id: String,
    reason: String,
    deadline: Instant,
}

/// How the blocking half of §7.3 step 3 ended (the image hold, the pipe, the UAC prompt and
/// the blob write all block, so they run on a blocking task).
#[derive(Debug, Clone, PartialEq, Eq)]
// Only the Windows hand-over constructs the first two (Linux has no elevation, Phase E 7.3d).
#[cfg_attr(not(all(windows, feature = "winapi")), allow(dead_code))]
enum HandoverLaunch {
    /// The child was launched and the blob was written to it.
    Delivered { pid: u32 },
    /// The person cancelled the UAC prompt: the user instance keeps the session (§7.3 step 3).
    Cancelled,
    /// Anything else: `elevation.failed { error }`.
    Failed(&'static str),
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
    /// The org display name from `session.created`, for the rule 6.2a card's wording.
    org: String,
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
    /// §7.3 step 2: the elevation prompt card, waiting for Allow / Refuse / 60 s.
    pending_elevation: Option<PendingElevation>,
    /// §7.3 steps 3-5: where the hand-over has got to, so a late or duplicate message cannot
    /// restart it.
    elevation: crate::elevate::ElevationState,
    /// The live `ia.sec` key generation. The hand-over blob carries it so the child offers
    /// `gen + 1`, which is the only offer the console accepts (C §7.2 W43).
    sec_gen: u16,
    /// Rule 5.1c: when the current secure-surface capture window started, and which surface it
    /// is, so the window's duration can be chained when it ends.
    secure_since: Option<(Instant, &'static str)>,
    /// Rule 6.2a: the arrival card, waiting for Continue / End session.
    pending_arrival: Option<PendingArrival>,
    /// Whether somebody was present the last time the worker looked, so an arrival is a
    /// transition rather than a repeated notice.
    saw_present: bool,
    /// The outcome of the blocking launch (the UAC prompt and the pipe write happen on a
    /// blocking task; this is how it reports back).
    elev_rx: Option<tokio::sync::oneshot::Receiver<HandoverLaunch>>,
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

    /// §5.2 / §4.3 (W32): "privileged mode" in a Phase D worker. The worker already runs as
    /// `LocalSystem`, so nothing is relaunched: the session's level is raised in place and the
    /// server chains `elevation.granted { mode: 'service' }`.
    async fn raise_privileged_mode(&mut self, op_id: &str) {
        tracing::info!(op_id, "raising the session to privileged mode in place");
        self.control
            .consent
            .grant_level(AgentConsentLevel::Elevated);
        let _ = self
            .ws
            .send(json!({
                "t": "desk.consent_level", "sessionId": self.session_id,
                "level": "elevated", "requested": true, "opId": op_id,
            }))
            .await;
        // No `elevation` ctl.event here: `granted` is not one of the five states the shared
        // schema allows (`prompt_shown`, `uac_shown`, `handover`, `denied`, `failed`), and in P4
        // the grant *is* the level — the console sees it through `consent.level_changed` (from
        // the `desk.consent_level` above) and the `agent_level` event below.
        self.send_level_event().await;
    }

    /// §7.3 step 2: show the elevation prompt card. The wording is the contract's, including
    /// the publisher line — a person who is about to click **Yes** on a UAC dialog is the last
    /// line of defence, so they are told exactly what to check.
    async fn prompt_elevation(&mut self, req_id: String, op_id: String, reason: String) {
        self.emit_prompt("elevation", &req_id, "shown").await;
        let publisher = ia_platform::trust::expected_signer().unwrap_or("our publisher");
        self.ui(UiCommand::LevelPrompt {
            reason: format!(
                "{} needs administrator rights to: {}. Windows will ask you to confirm. In the \
                 Windows dialog, check that the publisher reads {} and cancel otherwise.",
                self.technician, reason, publisher
            ),
            timeout_secs: PROMPT_SECS,
        });
        let ev = json!({
            "t": "ctl.event", "kind": "elevation",
            "opId": op_id, "state": "prompt_shown", "ts": now_ms(),
        });
        self.seal("ia.control", &ev.to_string()).await;
        self.pending_elevation = Some(PendingElevation {
            req_id,
            op_id,
            reason,
            deadline: Instant::now() + Duration::from_secs(PROMPT_SECS),
        });
        self.elevation = self
            .elevation
            .apply(crate::elevate::ElevationEvent::Requested);
    }

    /// §7.3 steps 2-3: the Desk answered the elevation card. On Allow the agent asks the server
    /// to mint the one-time hand-over; on Refuse or a timeout the request is denied and the
    /// session carries on unelevated.
    async fn answer_elevation(&mut self, allow: bool, timeout: bool) {
        let Some(p) = self.pending_elevation.take() else {
            return;
        };
        self.ui(UiCommand::LevelPromptClosed);
        self.emit_prompt("elevation", &p.req_id, "answered").await;
        if allow {
            self.elevation = self
                .elevation
                .apply(crate::elevate::ElevationEvent::AllowPhysical);
            if crate::svc::is_worker() {
                // §4.3: no relaunch in P4 — the person agreed, so the level goes up in place.
                self.raise_privileged_mode(&p.op_id).await;
                return;
            }
            tracing::info!(op_id = %p.op_id, reason = %p.reason, "elevation allowed by the Desk; requesting the hand-over");
            self.pending_elevation = Some(PendingElevation {
                deadline: Instant::now() + Duration::from_secs(PROMPT_SECS),
                ..p
            });
            let op_id = self
                .pending_elevation
                .as_ref()
                .map(|p| p.op_id.clone())
                .unwrap_or_default();
            let _ = self
                .ws
                .send(json!({ "t": "desk.elevation", "sessionId": self.session_id, "opId": op_id }))
                .await;
        } else {
            let cause = if timeout { "timeout" } else { "refused" };
            self.elevation = self
                .elevation
                .apply(crate::elevate::ElevationEvent::RefuseOrTimeout(
                    if timeout {
                        crate::elevate::DenyCause::Timeout
                    } else {
                        crate::elevate::DenyCause::Refused
                    },
                ));
            self.deny_elevation(&p.op_id, cause).await;
        }
    }

    /// §7.3 steps 3-5: the launch finished. A delivered blob means the child is connecting and
    /// the server will send `session.handed_over`; a cancelled UAC prompt or a failure leaves
    /// this instance in charge, which is the contract's "the user instance keeps the session".
    async fn after_handover_launch(&mut self, result: HandoverLaunch) {
        let op_id = self
            .pending_elevation
            .as_ref()
            .map(|p| p.op_id.clone())
            .unwrap_or_default();
        match result {
            HandoverLaunch::Delivered { pid } => {
                tracing::info!(pid, %op_id, "the elevated child has the hand-over; waiting for it to take over");
                let ev = json!({
                    "t": "ctl.event", "kind": "elevation",
                    "opId": op_id, "state": "handover", "ts": now_ms(),
                });
                self.seal("ia.control", &ev.to_string()).await;
                // The deadline now covers the child's connect (§7.3 step 5: 20 s, after which
                // this instance keeps the session and reports `connect_failed`).
                if let Some(p) = self.pending_elevation.as_mut() {
                    p.deadline = Instant::now() + Duration::from_secs(20);
                }
            }
            HandoverLaunch::Cancelled => {
                self.elevation = self
                    .elevation
                    .apply(crate::elevate::ElevationEvent::UacCancelled);
                self.pending_elevation = None;
                self.deny_elevation(&op_id, "uac_cancelled").await;
            }
            HandoverLaunch::Failed(error) => {
                self.elevation = self
                    .elevation
                    .apply(crate::elevate::ElevationEvent::LaunchFailed);
                self.pending_elevation = None;
                self.fail_elevation(&op_id, error).await;
            }
        }
    }

    /// `elevation.denied { opId, cause }` on both reporters (§7.3 step 2, §7.5).
    async fn deny_elevation(&mut self, op_id: &str, cause: &str) {
        tracing::info!(op_id, cause, "elevation denied");
        let ev = json!({
            "t": "ctl.event", "kind": "elevation",
            "opId": op_id, "state": "denied", "cause": cause, "ts": now_ms(),
        });
        self.seal("ia.control", &ev.to_string()).await;
        let _ = self
            .ws
            .send(json!({
                "t": "desk.event", "sessionId": self.session_id, "action": "elevation.denied",
                "data": { "opId": op_id, "cause": cause },
            }))
            .await;
    }

    /// `elevation.failed { opId, error }` (§7.5). The user instance keeps the session.
    async fn fail_elevation(&mut self, op_id: &str, error: &str) {
        tracing::warn!(
            op_id,
            error,
            "elevation failed; the user instance keeps the session"
        );
        let ev = json!({
            "t": "ctl.event", "kind": "elevation",
            "opId": op_id, "state": "failed", "cause": "policy", "ts": now_ms(),
        });
        self.seal("ia.control", &ev.to_string()).await;
        let _ = self
            .ws
            .send(json!({
                "t": "desk.event", "sessionId": self.session_id, "action": "elevation.failed",
                "data": { "opId": op_id, "error": error },
            }))
            .await;
        self.pending_elevation = None;
    }

    /// §7.3 step 3: the server minted the hand-over. Hold our own image open with
    /// `FILE_SHARE_READ` only, hash it over that handle, create the pipe, raise the UAC prompt,
    /// and write the blob to the process it launched — each of which blocks, so the whole
    /// sequence runs on a blocking task and reports back through `elev_rx`.
    async fn start_handover(&mut self, handover: String) {
        let Some(p) = self.pending_elevation.as_ref() else {
            tracing::warn!("an elevation.handover arrived with no pending request; ignoring it");
            return;
        };
        let op_id = p.op_id.clone();
        // The child presents the same token this process joined with, plus the one-time
        // hand-over. A process that has no token (the Phase D worker, which joins with a
        // worker credential) cannot hand over at all — and does not need to: §4.3 raises the
        // level in place instead.
        let Some(joined) = crate::session::joined() else {
            self.fail_elevation(&op_id, "uac_unavailable").await;
            return;
        };
        let blob = crate::hochild::HandoverBlob {
            v: 1,
            handover,
            token: joined.token.clone(),
            api_origin: joined.api_origin.clone(),
            signal_url: joined.signal_url.clone(),
            session_id: self.session_id.clone(),
            // Filled in by the blocking task, which is where the handle is held.
            image_sha256: String::new(),
            token_source: joined.source.to_string(),
            desk_label: None,
            gen: self.sec_gen,
            consent: crate::hochild::InheritedConsent {
                level: level_wire(self.control.consent.level).to_string(),
                monitors: self.control.consent.consented_monitors.clone(),
                clipboard: self.control.consent.clipboard_active(),
            },
        };
        let ev = json!({
            "t": "ctl.event", "kind": "elevation",
            "opId": op_id, "state": "uac_shown", "ts": now_ms(),
        });
        self.seal("ia.control", &ev.to_string()).await;
        self.elevation = self
            .elevation
            .apply(crate::elevate::ElevationEvent::UacRaised);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.elev_rx = Some(rx);
        tokio::task::spawn_blocking(move || {
            let _ = tx.send(launch_handover_child(blob));
        });
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
            // An in-session run never carries vault secrets: a playbook that declares
            // `vaultRefs` runs only as a device action (rule 9.8), which the api enforces.
            secret_env: vec![],
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
                    match v.get("t").and_then(|t| t.as_str()) {
                        Some("recording.state") => {
                            let on = v
                                .get("recording")
                                .and_then(|r| r.as_bool())
                                .unwrap_or(false);
                            self.ui(UiCommand::Recording { on, server: false });
                        }
                        Some("voice.state") => {
                            let muted = v.get("muted").and_then(|m| m.as_bool()).unwrap_or(true);
                            tracing::info!(muted, "technician voice.state");
                            self.ui(UiCommand::TechnicianVoice { muted });
                        }
                        _ => {}
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
        let Some((mut response, mut effect)) =
            self.control
                .handle_text(text, &mut *self.input_sink, &mut *self.clipboard)
        else {
            return;
        };
        // F §8.7 (the E 7.3d rule): a Linux worker runs as the signed-in user and has no
        // privileged mode, so `elevation.request` answers `not_supported` and nothing is raised.
        if linux_worker_refuses_elevation(
            cfg!(target_os = "linux"),
            crate::svc::is_worker(),
            &effect,
        ) {
            response = refused_res(req.as_ref(), "not_supported");
            effect = SessionEffect::None;
        }
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
                // Phase F revision 3: a missing or unknown interpreter is refused `not_allowed`; it
                // never falls back to PowerShell.
                let Some(interpreter) = run_interpreter(args) else {
                    tracing::warn!(playbook = %playbook_id, "playbook refused: missing or unknown interpreter");
                    response = refused_res(req.as_ref(), "not_allowed");
                    emit_pb_end_error(
                        &self.pb_tx,
                        run_id,
                        playbook_id,
                        body_hash,
                        PlaybookError::NotAllowed,
                    );
                    return self
                        .finish_control(req, response, effect, false, None)
                        .await;
                };
                let run = RunRequest {
                    run_id: run_id.clone(),
                    playbook_id: playbook_id.clone(),
                    body_hash: body_hash.clone(),
                    body: body.clone(),
                    interpreter,
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
            // §5.4: the lock is only "on" if the platform actually applied it. A sink that
            // cannot block input turns the already-formed `ok` into `not_supported`, so the
            // console never shows a lock that is not in force.
            SessionEffect::InputLock { applied: false, .. } => {
                response = refused_res_with(req.as_ref(), "not_supported", "input_lock");
            }
            // `os.sas` is performed by the service; a machine without `SendSAS` answers
            // `not_supported` rather than a silent success (§5.5's honesty rule).
            SessionEffect::SendSas => {
                let sent = crate::svc::get().map(|c| c.ops.send_sas()).unwrap_or(false);
                if !sent {
                    response = refused_res_with(req.as_ref(), "not_supported", "sas");
                }
            }
            SessionEffect::PlaybookCancel { run_id } => {
                let live = self.running.as_ref().is_some_and(|r| &r.run_id == run_id);
                if let Some(result) = response.get_mut("result") {
                    *result = json!({ "cancelled": live });
                }
            }
            _ => {}
        }
        self.finish_control(req, response, effect, deferred, playbook)
            .await;
    }

    /// The tail of [`Self::on_control`]: seals the reply (unless deferred) and applies the effect.
    async fn finish_control(
        &mut self,
        req: Option<CtlReq>,
        response: Value,
        effect: SessionEffect,
        deferred: bool,
        playbook: Option<PlaybookCheck>,
    ) {
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

    /// Rule 6.2a: somebody has just sat down at a machine that was being worked on
    /// unattended. Three things happen, in this order, because the order is what makes it
    /// safe:
    ///
    /// 1. **the level drops first** when the policy says a present user must be asked
    ///    (`requireLocalApprovalWhenPresent`), together with releasing any protection with
    ///    `cause: 'level_drop'` — so the technician stops being able to type on the keyboard of
    ///    somebody who has not agreed to it *before* anything is shown;
    /// 2. **then the card**, naming the technician, the org and the reason, with **End session**
    ///    and **Continue**;
    /// 3. **then the record**, when they choose. An unanswered card writes nothing extra (the
    ///    contract's wording), because nobody decided anything.
    ///
    /// **Stop** on the pill is always there and does not wait for any of this.
    async fn local_user_arrived(&mut self) {
        if self.pending_arrival.is_some() {
            return;
        }
        let Some(ctx) = crate::svc::get() else { return };
        let drop_level = ctx.policy.require_local_approval_when_present
            && self.control.consent.level > AgentConsentLevel::View;
        if drop_level {
            self.control.consent.lower_level(AgentConsentLevel::View);
            let (lock, privacy) = self.control.release_protections(self.input_sink.as_mut());
            if lock {
                self.protection_changed(
                    "input.lock_changed",
                    json!({ "locked": false, "cause": "level_drop" }),
                )
                .await;
            }
            if privacy {
                self.protection_changed(
                    "privacy.screen_changed",
                    json!({ "on": false, "cause": "level_drop" }),
                )
                .await;
            }
            let _ = self
                .ws
                .send(json!({ "t": "desk.consent_level", "sessionId": self.session_id, "level": "view" }))
                .await;
            self.send_level_event().await;
            tracing::info!("somebody arrived at the device: the session dropped to view");
        } else {
            tracing::info!("somebody arrived at the device: the session keeps its level (the policy does not require asking)");
        }
        let reason = ctx.reason_line();
        self.ui(UiCommand::LevelPrompt {
            reason: format!(
                "{} ({}) is in a remote session on this computer, authorised by your \
                 organisation's policy.{} Choose Continue to let it carry on, or End session to \
                 stop it now.",
                self.technician,
                if self.org.is_empty() {
                    "your organisation"
                } else {
                    &self.org
                },
                reason
            ),
            // The card stays rather than deciding for them; an expiry writes nothing (rule 6.2a).
            timeout_secs: ARRIVAL_CARD_SECS,
        });
        self.pending_arrival = Some(PendingArrival {
            dropped_to_view: drop_level,
            deadline: Instant::now() + Duration::from_secs(ARRIVAL_CARD_SECS),
        });
    }

    /// Rule 6.2a: the arriving user chose. `Continue` restores the level the session had;
    /// `End session` revokes consent through the C revoke path.
    async fn answer_arrival(&mut self, keep_going: bool) -> bool {
        let Some(p) = self.pending_arrival.take() else {
            return false;
        };
        self.ui(UiCommand::LevelPromptClosed);
        let level_dropped = if p.dropped_to_view {
            json!("view")
        } else {
            Value::Null
        };
        if keep_going {
            if p.dropped_to_view {
                self.control.consent.grant_level(AgentConsentLevel::Control);
                let _ = self
                    .ws
                    .send(json!({ "t": "desk.consent_level", "sessionId": self.session_id, "level": "control", "requested": true }))
                    .await;
                self.send_level_event().await;
            }
            let _ = self
                .ws
                .send(json!({
                    "t": "desk.event", "sessionId": self.session_id,
                    "action": "session.local_user_arrived",
                    "data": { "decision": "continue", "levelDroppedTo": level_dropped },
                }))
                .await;
            tracing::info!("the arriving user chose Continue");
            false
        } else {
            let _ = self
                .ws
                .send(json!({
                    "t": "desk.event", "sessionId": self.session_id,
                    "action": "session.local_user_arrived",
                    "data": { "decision": "ended", "levelDroppedTo": level_dropped },
                }))
                .await;
            tracing::info!("the arriving user ended the session");
            true
        }
    }

    /// Rule 5.1c: `capture.secure_desktop { surface, durationMs }` — the record that the
    /// technician's view was on the logon screen, a UAC prompt or the lock screen, and for how
    /// long. It is written whether the frames were shown or held by policy: what is audited is
    /// the window, not the permission.
    async fn chain_secure_desktop(&mut self, surface: &str, duration_ms: u64) {
        tracing::info!(
            surface,
            duration_ms,
            "a secure-desktop capture window ended"
        );
        let _ = self
            .ws
            .send(json!({
                "t": "desk.event", "sessionId": self.session_id,
                "action": "capture.secure_desktop",
                "data": { "surface": surface, "durationMs": duration_ms },
            }))
            .await;
    }

    /// §5.4: chain one protection change and tell the service, so it can report the state if
    /// this process dies (rule 5.4d).
    async fn protection_changed(&mut self, action: &str, data: Value) {
        let _ = self
            .ws
            .send(json!({
                "t": "desk.event", "sessionId": self.session_id,
                "action": action, "data": data,
            }))
            .await;
        if let Some(ctx) = crate::svc::get() {
            ctx.ops
                .report_protections(self.control.input_locked, self.control.privacy_screen);
        }
    }

    async fn on_effect(
        &mut self,
        req: Option<CtlReq>,
        effect: SessionEffect,
        deferred: bool,
        playbook: Option<PlaybookCheck>,
    ) {
        match effect {
            // §5.4: the lock is on (or off). The pill and a banner say so and name the escape;
            // rule 5.4b forbids hiding the indicator behind either protection.
            SessionEffect::InputLock { locked, applied } => {
                if applied {
                    tracing::info!(locked, "the local input lock changed");
                    self.ui(UiCommand::Toast(if locked {
                        format!(
                            "Input locked by {} - press Ctrl+Alt+Del to take back control",
                            self.technician
                        )
                    } else {
                        "Your keyboard and mouse are yours again".to_string()
                    }));
                    self.protection_changed(
                        "input.lock_changed",
                        json!({ "locked": locked, "cause": "technician" }),
                    )
                    .await;
                }
            }
            SessionEffect::PrivacyScreen { on } => {
                // The branded overlay of rule 5.4b is not built, so this is only reached on a
                // build that advertises the feature; the state is still chained honestly.
                self.protection_changed(
                    "privacy.screen_changed",
                    json!({ "on": on, "cause": "technician" }),
                )
                .await;
            }
            SessionEffect::SendSas => {
                let _ = self
                    .ws
                    .send(json!({
                        "t": "desk.event", "sessionId": self.session_id,
                        "action": "input.sas_sent", "data": {},
                    }))
                    .await;
            }
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
                } else if let Some(ctx) = crate::svc::get() {
                    // §4.3 / §5.2 (W32): a Phase D worker is already `LocalSystem`. There is no
                    // relaunch and no hand-over — "privileged mode" is the level raised in
                    // place, after the policy check and (when somebody is there) their nod.
                    if !ctx.policy.allow_privileged {
                        tracing::info!(%op_id, "privileged mode refused by the device's policy");
                        self.deny_elevation(&op_id, "policy").await;
                    } else if crate::svc::present() {
                        let req_id = req.map(|r| r.id).unwrap_or_default();
                        self.prompt_elevation(req_id, op_id, reason).await;
                    } else {
                        self.raise_privileged_mode(&op_id).await;
                    }
                } else {
                    // §7.3 steps 2-5: the real hand-over. The card is shown first, and nothing
                    // is minted until the person at the machine has said yes with a physical
                    // click — a hand-over the user never agreed to would be a session a
                    // technician elevated by themselves.
                    let req_id = req.map(|r| r.id).unwrap_or_default();
                    self.prompt_elevation(req_id, op_id, reason).await;
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
        // Rule 6.2a: an unanswered arrival card is closed and writes nothing. The session
        // stays as it is — dropped to `view` if the policy asked for that, which is the safe
        // state to leave it in when nobody answered.
        if self
            .pending_arrival
            .as_ref()
            .is_some_and(|p| now >= p.deadline)
        {
            self.pending_arrival = None;
            self.ui(UiCommand::LevelPromptClosed);
            tracing::info!("the arrival card was not answered; nothing is recorded");
        }
        // §7.3 step 2: no answer in 60 s is a denial, and so is a hand-over the server never
        // minted (the same deadline covers both halves of the wait).
        if self
            .pending_elevation
            .as_ref()
            .is_some_and(|p| now >= p.deadline)
        {
            let waiting_for_mint = self.elevation == crate::elevate::ElevationState::UacShown;
            if waiting_for_mint {
                let op_id = self
                    .pending_elevation
                    .take()
                    .map(|p| p.op_id)
                    .unwrap_or_default();
                self.fail_elevation(&op_id, "connect_failed").await;
            } else {
                self.answer_elevation(false, true).await;
            }
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
                LiveOutcome::HandedOver => "Continuing with administrator rights.".to_string(),
                LiveOutcome::IndicatorLost(_) => {
                    "The on-screen indicator stopped, so sharing has stopped.".to_string()
                }
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

/// F §8.7 / E 7.3d: whether this `elevation.request` must be answered `not_supported` — on a
/// Linux service worker, which runs as the signed-in user and has no privileged mode. Pure (the
/// platform and the worker role are arguments) so it is tested on every host.
fn linux_worker_refuses_elevation(linux: bool, worker: bool, effect: &SessionEffect) -> bool {
    linux && worker && matches!(effect, SessionEffect::ElevationRequest { .. })
}

/// A refusal with a `message` (§5.1: `not_supported { message }` names what is missing).
fn refused_res_with(req: Option<&CtlReq>, code: &str, message: &str) -> Value {
    ia_core::ctl::error_response(
        req.map(|r| r.id.as_str()).unwrap_or(""),
        code,
        Some(message),
    )
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
    /// The two `sec.hello` fingerprints of this generation, which rule 3.5b's attestation
    /// signs along with the code (so a substituted fingerprint cannot be attested).
    desk_fpr: String,
    assist_fpr: String,
    /// The `ia.sec` generation this process started at: 0 ordinarily, the parent's + 1 in the
    /// elevated hand-over child (C §7.2 W43).
    start_gen: u16,
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
    /// Recorder frames received before the serve loop (replayed by it).
    pending_recorder: Vec<Value>,
    /// Voice (§6.3) when a device exists, its outgoing track, and the Assist-audio bus.
    voice: Option<Voice>,
    audio_track: Option<Arc<TrackLocalStaticSample>>,
    remote_audio_tx: mpsc::UnboundedSender<Arc<TrackRemote>>,
    remote_audio_rx: mpsc::UnboundedReceiver<Arc<TrackRemote>>,
}

/// Spawn the one-monitor VP8 pump (contract §4.1-§4.3, §9 R2), returning its join handle (None
/// if the track is missing). The pump follows the ABR decision published in `ctl` and also feeds
/// the recorder track while one is attached.
fn spawn_video(
    peer: &AgentPeer,
    viewed: u32,
    monitors: &[MonitorInfo],
    synthetic: bool,
    stop: Arc<tokio::sync::Notify>,
    path: Arc<std::sync::atomic::AtomicU8>,
    ctl: Arc<VideoCtl>,
) -> Option<tokio::task::JoinHandle<()>> {
    peer.video_track(viewed).map(|track| {
        let (w, h) = monitors
            .iter()
            .find(|m| m.id == viewed)
            .map(|m| (m.width.max(2) & !1, m.height.max(2) & !1))
            .unwrap_or((1280, 720));
        // apple-owned: begin
        // Phase F §17.2: a macOS monitor is in points, and ScreenCaptureKit captures its backing
        // pixels, so the encoder's native size is the backing size (the ABR ladder still caps it).
        #[cfg(target_os = "macos")]
        let (w, h) = match monitors.iter().find(|m| m.id == viewed) {
            Some(m) if !synthetic => {
                let px = |v: u32| ((v as f32 * m.scale.max(1.0)).round() as u32).max(2) & !1;
                (px(m.width), px(m.height))
            }
            _ => (w, h),
        };
        // apple-owned: end
        let spec = PumpSpec {
            monitor_id: viewed,
            native_w: w,
            native_h: h,
        };
        let source = CaptureSource::new(synthetic, w, h);
        tokio::spawn(run_pump(track, spec, source, ctl, stop, path))
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
        desk_fpr,
        assist_fpr,
        start_gen,
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
        mut pending_recorder,
        mut voice,
        audio_track,
        remote_audio_tx,
        mut remote_audio_rx,
    } = io;
    // §3.6 M3: each monitor carries the SDP mid of its track, so the console binds the right
    // stream when more than one monitor is shared (Phase E §7.5: an X11 Desk with two RandR
    // monitors offers two tracks; with one track the console falls back to the only stream).
    let mut monitors = monitors;
    let mids = peer.monitor_mids().await;
    for m in &mut monitors {
        if let Some(mid) = mids.get(&m.id) {
            m.mid = Some(mid.clone());
        }
    }
    let viewed = monitors
        .iter()
        .find(|m| m.primary)
        .map(|m| m.id)
        .unwrap_or(monitor_ids.first().copied().unwrap_or(1));
    let synthetic = cli.synthetic_capture;
    let mut gen: u16 = start_gen;

    // Secure channels for this generation over the channels wired in `connect_and_serve`.
    let sec = open_sec_set(&chans, session_id, start_gen, &keys)?;

    // Control server: gates every op by the live consent and applies OS input.
    let consent = LiveConsent::new(payload.level, payload.clipboard, monitor_ids.clone());
    let mut control = ControlServer::new(consent, monitors.clone(), viewed);
    if let Some(ctx) = crate::svc::get() {
        // §5.4: the service-grade ops become available, each behind its policy flag.
        control.service = Some(ctx.service_grade());
        // Rule 5.1c: a worker launched onto a secure desktop gates input from its first frame.
        control.secure_desktop = ctx.secure_desktop;
    }
    let (input_sink, mut clipboard) = platform_io(cli.synthetic_capture);
    // Only copies made after consent are shared (prime the watcher).
    let _ = clipboard.take_update();
    let (pb_tx, mut pb_rx) = mpsc::unbounded_channel::<PbMsg>();

    let mut live = Live {
        ws,
        session_id: session_id.to_string(),
        technician: info.technician.clone(),
        org: info.org.clone(),
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
        pending_elevation: None,
        elevation: crate::elevate::ElevationState::Idle,
        sec_gen: start_gen,
        secure_since: None,
        pending_arrival: None,
        saw_present: false,
        elev_rx: None,
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
    // Phase F §3.4: the Keep control the Desk UI offers (none in a Phase D worker; "Remove ...
    // after this session" in a kept copy, which reports itself kept once, rule 3.4d).
    let running_kept = running_kept_copy();
    live.ui(UiCommand::KeepMode {
        available: !crate::svc::is_worker(),
        running_kept,
    });
    if running_kept && !crate::svc::is_worker() {
        live.seal("ia.control", &keep_event(true, now_ms()).to_string())
            .await;
    }
    // Phase E §7.4: a Wayland Desk says once, as the control channel opens, that it shares no
    // screen (no video track was offered).
    if crate::desk::current().is_some_and(|m| !m.shares_screen()) {
        live.seal(
            "ia.control",
            &crate::desk::wayland_capture_event(now_ms()).to_string(),
        )
        .await;
    }
    // Rule 3.5b: when nobody answered the consent, nobody can read the security code out
    // either, so the device attests it with its identity key. The worker holds no key — it
    // asks the service over the §4.2 pipe and forwards the signature.
    if let Some(ctx) = crate::svc::get() {
        if ctx.needs_attestation() {
            match ctx.ops.sign_sas(gen, &sas, &desk_fpr, &assist_fpr) {
                Some(sig) => {
                    let ev = json!({
                        "t": "ctl.event", "kind": "device_attest",
                        "gen": gen, "sig": sig, "ts": now_ms(),
                    });
                    live.seal("ia.control", &ev.to_string()).await;
                    tracing::info!(gen, "device_attest sent for this key generation");
                }
                // The console keeps the session in `view` and says the identity could not be
                // verified. Saying nothing is the honest failure: there is no fallback that
                // would be a verification.
                None => tracing::error!(gen, "the service would not sign the attestation"),
            }
        }
    }
    if voice.is_some() {
        // Default muted (A D8): tell the console, show the pill's mic button.
        live.seal("ia.ctrl", &voice_state(true, now_ms()).to_string())
            .await;
        live.ui(UiCommand::Voice {
            available: true,
            muted: true,
        });
    }

    // Video pump + throughput meter + ABR controller fed by REMB/loss (contract §4.3, §4.4). The
    // controller's decision is published into `ctl`, which the pump makes libvpx follow.
    let mut stop = Arc::new(tokio::sync::Notify::new());
    let capture_path = Arc::new(std::sync::atomic::AtomicU8::new(CapturePath::Gdi as u8));
    let mut abr = ia_core::abr::AbrController::default();
    let ctl = Arc::new(VideoCtl::new(abr.rung(), 1500));
    let remb_kbps = Arc::new(AtomicU64::new(0));
    let loss_permille = Arc::new(AtomicU64::new(0));
    let mut video_handle = spawn_video(
        &peer,
        viewed,
        &monitors,
        synthetic,
        stop.clone(),
        capture_path.clone(),
        ctl.clone(),
    );
    let mut remb_handle = spawn_remb_reader(
        &peer,
        remb_kbps.clone(),
        loss_permille.clone(),
        ctl.clone(),
        stop.clone(),
    );
    let mut last_meter = MeterSnapshot::take(&ctl.meter);
    let mut last_rung = abr.rung();
    let mut last_target = ctl.target_kbps();
    // Phase E §7.2 / §16.2: the X11 capture path last reported in a `ctl.event capture`.
    let mut reported_path: Option<CapturePath> = None;
    // Phase F §9.3: the portal status last reported (`start`, `portal_denied`, `portal_closed`).
    let mut reported_portal: Option<ia_core::capture_decision::PortalStatus> = None;

    // The server-recorder leg (contract §9 R2): a second PC answering the recorder's offer.
    let mut rec = RecorderLegs::new(
        viewed,
        server_records(&info.recording_mode),
        audio_track.clone(),
    );
    for v in std::mem::take(&mut pending_recorder) {
        rec.on_frame(&v, live.ws, session_id, &ice_servers, &ctl)
            .await;
    }

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
                // §5.3: the service tells the worker which desktop it is on; rule 5.1c gates
                // input and capture while that is a secure one.
                if crate::svc::is_worker() {
                    // Rule 6.2a: the service reports presence; an unattended session that now
                    // has somebody at it tells them, and stops typing on their keyboard first.
                    let present = crate::svc::present();
                    if present && !live.saw_present {
                        live.saw_present = true;
                        if crate::svc::get().is_some_and(|c| c.unattended) {
                            live.local_user_arrived().await;
                        }
                    } else if !present {
                        live.saw_present = false;
                    }
                    let secure = crate::svc::secure_desktop();
                    if secure != live.control.secure_desktop {
                        tracing::info!(secure, "the worker's desktop changed");
                        live.control.secure_desktop = secure;
                        // Rule 5.1c: every capture window on a secure surface is on the record,
                        // whether or not the policy let the technician see it.
                        if secure {
                            live.secure_since = Some((
                                Instant::now(),
                                crate::svc::secure_surface().unwrap_or("uac"),
                            ));
                        } else if let Some((at, surface)) = live.secure_since.take() {
                            let ms = at.elapsed().as_millis() as u64;
                            live.chain_secure_desktop(surface, ms).await;
                        }
                    }
                }
                if let Some(preset) = live.pending_quality.take() {
                    tracing::info!(preset = ?preset, "os.quality preset applied");
                    abr.set_preset(preset);
                    ctl.set_preset(preset);
                }
                let now = MeterSnapshot::take(&ctl.meter);
                let interval = now.diff(&last_meter, ia_core::types::limits::AGENT_STATS_INTERVAL_MS);
                last_meter = now;
                let remb = remb_kbps.load(Ordering::Relaxed);
                let loss = loss_permille.load(Ordering::Relaxed);
                let decision = abr.step(ia_core::abr::AbrSample {
                    now_ms: now_ms() as u64,
                    remb_kbps: abr_estimate_kbps(remb, interval.sent_kbps, loss, last_target),
                    twcc_kbps: None,
                    fraction_lost: loss as f32 / 1000.0,
                });
                last_target = decision.target_kbps;
                ctl.set_decision(decision.rung, decision.target_kbps);
                if decision.rung != last_rung {
                    tracing::info!(from = last_rung.as_str(), to = decision.rung.as_str(), remb_kbps = remb, loss_permille = loss, target_kbps = decision.target_kbps, sent_kbps = interval.sent_kbps, "abr rung change");
                    last_rung = decision.rung;
                }
                let path_now = path_from_u8(capture_path.load(Ordering::Relaxed));
                if let Some(ev) = x11_capture_change(reported_path, path_now, viewed, now_ms()) {
                    reported_path = Some(path_now);
                    live.seal("ia.control", &ev.to_string()).await;
                }
                if let Some(ev) = crate::desk::portal_capture_event(&mut reported_portal, viewed, now_ms()) {
                    live.seal("ia.control", &ev.to_string()).await;
                }
                let s = build_stats(&monitors, viewed, path_now, &interval, &decision, ctl.has_recorder());
                live.seal("ia.ctrl", &s.to_wire().to_string()).await;
            }
            _ = prompt_iv.tick() => {
                live.expire_prompts().await;
                // §7.3 step 3: the blocking launch finished (or the person cancelled UAC).
                if let Some(rx) = live.elev_rx.as_mut() {
                    match rx.try_recv() {
                        Ok(result) => {
                            live.elev_rx = None;
                            live.after_handover_launch(result).await;
                        }
                        Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                            live.elev_rx = None;
                            let op_id = live.pending_elevation.take().map(|p| p.op_id).unwrap_or_default();
                            live.fail_elevation(&op_id, "launch_failed").await;
                        }
                        Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                    }
                }
            }
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
            ra = remote_audio_rx.recv() => {
                if let (Some(track), Some(v)) = (ra, voice.as_mut()) {
                    v.attach_remote(track);
                }
            }
            c = rec.ice_rx.recv() => {
                if let Some((leg, cand)) = c {
                    rec.send_candidate(leg, cand, live.ws, session_id).await;
                }
            }
            st = rec.state_rx.recv() => {
                if let Some((leg, state)) = st {
                    rec.on_state(leg, state, &ctl).await;
                }
            }
            ev = next_ui(ui_rx) => {
                match ev {
                    Some(UiEvent::Stop) => { tracing::info!("stop: pill / panel / tray"); break; }
                    Some(UiEvent::Revoke) => { tracing::info!("consent revoked from the panel"); outcome = LiveOutcome::Revoked; break; }
                    Some(UiEvent::SetLevel(l)) => live.desk_set_level(l).await,
                    Some(UiEvent::Clipboard(on)) => live.desk_set_clipboard(on).await,
                    Some(UiEvent::FileDecision { file_id, accept }) => live.file_decision(file_id, accept, false).await,
                    Some(UiEvent::LevelDecision { allow }) => {
                        // The arrival card is answered first: it is the one where the person in
                        // front of the machine is deciding about their own session.
                        if live.pending_arrival.is_some() {
                            if live.answer_arrival(allow).await {
                                outcome = LiveOutcome::Revoked;
                                break;
                            }
                        } else if live.pending_elevation.is_some() {
                            live.answer_elevation(allow, false).await;
                        } else {
                            live.answer_level_request(allow, false).await;
                        }
                    }
                    Some(UiEvent::ChatSend(text)) => live.send_chat(text).await,
                    // Rule 3.4b: the Desk's Keep choice, reported read-only to the console.
                    Some(UiEvent::Keep { kept }) => {
                        tracing::info!(kept, "keep: the Desk changed its choice");
                        live.seal("ia.control", &keep_event(kept, now_ms()).to_string()).await;
                    }
                    Some(UiEvent::Mic(on)) => {
                        if let Some(v) = voice.as_mut() {
                            let res = v.set_muted(!on);
                            if let Err(e) = &res {
                                tracing::warn!("microphone could not be opened: {e}");
                                live.ui(UiCommand::Toast("The microphone could not be opened.".into()));
                            }
                            let muted = v.muted();
                            tracing::info!(muted, "desk microphone");
                            live.seal("ia.ctrl", &voice_state(muted, now_ms()).to_string()).await;
                            live.ui(UiCommand::Voice { available: true, muted });
                        }
                    }
                    Some(UiEvent::ConsentGranted(_)) | Some(UiEvent::ConsentDeclined) => {}
                    Some(UiEvent::Failed(_)) | Some(UiEvent::Closed) | None => {
                        // The indicator is mandatory (§3.5): no indicator, no sharing. The
                        // session ends cleanly with the reason (`serve/uiloss.rs`).
                        let why = uiloss::indicator_gone(ev.as_ref()).unwrap_or_default();
                        tracing::warn!(%why, "indicator UI gone: ending the session");
                        *ui_rx = None;
                        live.ui = None;
                        outcome = LiveOutcome::IndicatorLost(why);
                        break;
                    }
                }
            }
            msg = ws_rx.recv() => {
                let Some(v) = msg else { outcome = LiveOutcome::EndedRemotely; break; };
                if is_recorder_frame(&v) {
                    rec.on_frame(&v, live.ws, session_id, &ice_servers, &ctl).await;
                    continue;
                }
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("webrtc.ice") => add_remote_ice(&peer, &v).await,
                    Some("ping") => { let _ = live.ws.send(json!({ "t": "pong" })).await; }
                    Some("session.ended") => { outcome = LiveOutcome::EndedRemotely; break; }
                    Some("session.handed_over") => {
                        // §7.3 step 5: the child has the session. This instance removes its
                        // pill and exits **without** `session.end` (the session continues) and
                        // without self-deleting (the child is running the same file, §10 D3).
                        tracing::info!("handed over to the elevated instance");
                        live.elevation = live.elevation.apply(crate::elevate::ElevationEvent::ChildConnected);
                        outcome = LiveOutcome::HandedOver;
                        break;
                    }
                    Some("elevation.handover") => {
                        let handover = v.get("handover").and_then(|h| h.as_str()).unwrap_or_default().to_string();
                        if handover.is_empty() {
                            tracing::warn!("elevation.handover without a hand-over");
                        } else {
                            live.start_handover(handover).await;
                        }
                    }
                    Some("session.recording") => {
                        let on = v.get("recording").and_then(|r| r.as_bool()).unwrap_or(false);
                        live.ui(UiCommand::Recording { on, server: true });
                        if !on && v.get("source").and_then(|s| s.as_str()) == Some("server") {
                            // The recorder left / stopped: drop its PC (it re-offers if re-assigned).
                            rec.close(&ctl, "server recording stopped").await;
                        }
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
            live.sec_gen = gen;
            // Tear the current generation down before building the new one.
            stop.notify_waiters();
            if let Some(h) = video_handle.take() {
                h.abort();
            }
            remb_handle.abort();
            let _ = peer.pc.close().await;
            while in_rx.try_recv().is_ok() {} // drop stale (old-gen) frames
            let mut stash = Vec::new();
            let rebuilt = rebuild_generation(
                live.ws,
                ws_rx,
                session_id,
                gen,
                &ice_servers,
                &monitor_ids,
                &in_tx,
                &fail_tx,
                &mut stash,
                audio_track.clone(),
                &remote_audio_tx,
            )
            .await;
            // Recorder frames that arrived during the re-offer: the recorder PC is independent
            // of the Assist PC and survives the rebuild (§9 R2 / §3.7).
            for v in stash {
                rec.on_frame(&v, live.ws, session_id, &ice_servers, &ctl)
                    .await;
            }
            match rebuilt {
                Ok(g) => {
                    peer = g.peer;
                    live.chans = g.chans;
                    live.sec = g.sec;
                    sec_dc = g.sec_dc;
                    sas = g.sas;
                    stop = Arc::new(tokio::sync::Notify::new());
                    remb_kbps.store(0, Ordering::Relaxed);
                    loss_permille.store(0, Ordering::Relaxed);
                    last_meter = MeterSnapshot::take(&ctl.meter);
                    video_handle = spawn_video(
                        &peer,
                        viewed,
                        &monitors,
                        synthetic,
                        stop.clone(),
                        capture_path.clone(),
                        ctl.clone(),
                    );
                    remb_handle = spawn_remb_reader(
                        &peer,
                        remb_kbps.clone(),
                        loss_permille.clone(),
                        ctl.clone(),
                        stop.clone(),
                    );
                    let (pc_tx, pc_rx) = mpsc::unbounded_channel();
                    wire_pc_state(&peer, pc_tx);
                    pc_state_rx = pc_rx;
                    disconnected_since = None;
                    live.seal("ia.control", &monitors_event.to_string()).await;
                    live.send_level_event().await;
                    if let Some(v) = &voice {
                        live.seal("ia.ctrl", &voice_state(v.muted(), now_ms()).to_string())
                            .await;
                    }
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

    // Rule 5.1c: a secure-surface window that is still open when the session ends is closed
    // on the record rather than left dangling.
    if let Some((at, surface)) = live.secure_since.take() {
        let ms = at.elapsed().as_millis() as u64;
        live.chain_secure_desktop(surface, ms).await;
    }
    // §5.4d: release anything the technician left on, with its cause, before the teardown.
    {
        let (lock, privacy) = live.control.release_protections(live.input_sink.as_mut());
        if lock {
            live.protection_changed(
                "input.lock_changed",
                json!({ "locked": false, "cause": "session_end" }),
            )
            .await;
        }
        if privacy {
            live.protection_changed(
                "privacy.screen_changed",
                json!({ "on": false, "cause": "session_end" }),
            )
            .await;
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
        LiveOutcome::IndicatorLost(_) => {
            // The console's reason for the end (`serve/uiloss.rs`), then the usual teardown.
            live.seal(
                "ia.ctrl",
                &uiloss::indicator_failed_stop(now_ms()).to_string(),
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
    // Phase F coordinator item 1: abort *and join* the pumps so their timer-holding futures are
    // dropped here, while the runtime's time driver is still alive, rather than during the
    // runtime teardown that follows (where dropping a `Sleep`/`Interval` would panic). A bounded
    // wait keeps teardown prompt even if a task ignores the first cancellation point.
    remb_handle.abort();
    let _ = tokio::time::timeout(Duration::from_secs(2), remb_handle).await;
    if let Some(h) = video_handle {
        h.abort();
        let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
    }
    if let Some(r) = live.running.take() {
        r.handle.cancel(); // the job object kills the tree
    }
    if let Some(inc) = live.incoming.take() {
        inc.part.abort();
    }
    live.sec.clear(); // SecChannel keys are dropped with the peer (zeroise step)
    rec.close(&ctl, "teardown").await; // the recorder PC goes with the main peer (§9 R2)
    if let Some(v) = voice.as_mut() {
        v.stop(); // close the microphone / speaker streams
    }
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
        LiveOutcome::IndicatorLost(why) => {
            let _ = live.ws.send(uiloss::indicator_lost_end(session_id)).await;
            tracing::info!(%why, "session.end (indicator_lost) sent");
        }
        _ => {}
    }

    let lines = live.receipt_lines(&outcome, &sas);
    let choice = match live.ui.take() {
        Some(ui) => ui.finish(lines).await,
        // No UI (headless): nobody chose Keep; a kept copy is still kept (rule 3.4d).
        None => ia_ui::model::KeepChoice {
            running_kept: running_kept_copy(),
            ..Default::default()
        },
    };

    // The exit decision (§10, Phase F §3.4). The e2e passes --no-self-delete, which means no file
    // change at exit at all (rule 3.4e): it is logged, not run. §10 D3: exactly one instance
    // deletes — the one holding the session. A handed-over user instance must not, because the
    // elevated child is running the same file.
    let role = if matches!(outcome, LiveOutcome::HandedOver) {
        ProcessRole::UserHandedOver
    } else if crate::hochild::is_child() {
        ProcessRole::ElevatedChild
    } else {
        ProcessRole::UserStandalone
    };
    let action = exit_action(cli.no_self_delete, crate::svc::is_worker(), role, choice);
    tracing::info!(?role, ?choice, ?action, "exit decision");
    match action {
        ExitAction::SelfDelete => {
            tracing::info!("exit decision: self-delete (spawning cleanup stub)");
            perform_self_delete();
        }
        ExitAction::Keep { first } => {
            tracing::info!(first, "exit decision: keep (D5)");
            perform_keep(first);
        }
        ExitAction::Nothing => {
            tracing::info!(
                "exit decision: no file change (--no-self-delete, worker or handed over)"
            )
        }
    }
    Ok(outcome)
}

/// §7.3 step 3, the blocking half: hold our own image open, hash it over that handle, create the
/// pipe, raise the UAC prompt, and write the blob to the process `ShellExecuteExW` returned.
///
/// The order is the contract's and matters:
///
/// 1. **the handle first** — opened `GENERIC_READ` with `FILE_SHARE_READ` only and held for the
///    whole sequence, so nothing can replace the file between the hash and the launch;
/// 2. **the signer check on that handle** — an unsigned development build is tolerated here and
///    fatal in the child (§2.6), so a local build can be tested without making an unsigned
///    binary elevatable in the field;
/// 3. **the pipe before the launch** — `FILE_FLAG_FIRST_PIPE_INSTANCE` then guarantees nobody
///    created the name first;
/// 4. **the pid and image check before the blob is written** — the only client that is given
///    the hand-over is the process this call launched, running this very image.
#[cfg(all(windows, feature = "winapi"))]
fn launch_handover_child(blob: crate::hochild::HandoverBlob) -> HandoverLaunch {
    use crate::hopipe::{new_suffix, HandoverServer, ImageHold, Launch};
    let Ok(exe) = std::env::current_exe() else {
        return HandoverLaunch::Failed("launch_failed");
    };
    let hold = match ImageHold::open(&exe) {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(error = %e, "the agent could not hold its own image open");
            return HandoverLaunch::Failed("launch_failed");
        }
    };
    match ia_platform::trust::verify_self() {
        ia_platform::trust::TrustVerdict::Trusted => {}
        // A development build is unsigned; the child's own check is where that becomes fatal.
        ia_platform::trust::TrustVerdict::Unsigned => {
            tracing::warn!(
                "this build is unsigned; the elevated child will refuse it in a release build"
            )
        }
        other => {
            tracing::error!(
                verdict = other.as_str(),
                "refusing to elevate an image that does not verify"
            );
            return HandoverLaunch::Failed("image_mismatch");
        }
    }
    let blob = crate::hochild::HandoverBlob {
        image_sha256: hold.sha256.clone(),
        ..blob
    };
    if let Err(e) = blob.validate() {
        tracing::error!(error = %e, "the hand-over blob this agent built is not valid");
        return HandoverLaunch::Failed("launch_failed");
    }
    let suffix = new_suffix();
    let Ok(server) = HandoverServer::create(&suffix) else {
        return HandoverLaunch::Failed("launch_failed");
    };
    let launched = match crate::hopipe::launch_elevated(&exe, &suffix) {
        Launch::Started { pid, .. } => pid,
        Launch::Cancelled => return HandoverLaunch::Cancelled,
        Launch::Failed(code) => {
            tracing::warn!(code, "ShellExecuteExW(runas) failed");
            return HandoverLaunch::Failed("launch_failed");
        }
    };
    let bytes = match serde_json::to_vec(&blob) {
        Ok(b) => b,
        Err(_) => return HandoverLaunch::Failed("launch_failed"),
    };
    match server.serve_once(launched, &bytes, Duration::from_secs(20)) {
        Ok(()) => {
            // The hold is dropped here: the child has the hash and checks it itself.
            drop(hold);
            HandoverLaunch::Delivered { pid: launched }
        }
        Err(e) => {
            tracing::warn!(error = ?e, "the elevated child did not take the blob");
            HandoverLaunch::Failed("connect_failed")
        }
    }
}

/// Without the Win32 layer there is no `runas` and no pipe, so the request fails honestly
/// rather than appearing to do something.
#[cfg(not(all(windows, feature = "winapi")))]
fn launch_handover_child(_blob: crate::hochild::HandoverBlob) -> HandoverLaunch {
    HandoverLaunch::Failed("uac_unavailable")
}

async fn seal_send(chans: &Chans, sc: &mut SecChannel, label: &str, text: &str) {
    if let Ok(frame) = sc.seal_text(text) {
        if let Some(dc) = chans.get(label) {
            let _ = dc.send(&Bytes::from(frame)).await;
        }
    }
}

/// Every wire interpreter (shared `PLAYBOOK_INTERPRETERS`), on every platform: whether this
/// platform may run it is `check_run`'s decision, never the parser's (Phase F §17.8).
fn parse_interpreter(s: &str) -> Option<PlaybookInterpreter> {
    match s {
        "powershell" => Some(PlaybookInterpreter::Powershell),
        "cmd" => Some(PlaybookInterpreter::Cmd),
        "sh" => Some(PlaybookInterpreter::Sh),
        "zsh" => Some(PlaybookInterpreter::Zsh),
        _ => None,
    }
}

/// The `interpreter` of a `playbook.run` request; `None` (refused `not_allowed`) when it is
/// missing or unknown (Phase F revision 3: it used to fall back to PowerShell).
fn run_interpreter(args: Option<&Value>) -> Option<PlaybookInterpreter> {
    args.and_then(|a| a.get("interpreter"))
        .and_then(|v| v.as_str())
        .and_then(parse_interpreter)
}

fn emit_pb_error(pb_tx: &mpsc::UnboundedSender<PbMsg>, run: &RunRequest, err: PlaybookError) {
    emit_pb_end_error(pb_tx, &run.run_id, &run.playbook_id, &run.body_hash, err);
}

/// `pb.end { error }` for a run refused before it started, so the console's run never hangs.
fn emit_pb_end_error(
    pb_tx: &mpsc::UnboundedSender<PbMsg>,
    run_id: &str,
    playbook_id: &str,
    body_hash: &str,
    err: PlaybookError,
) {
    let end = PbEnd {
        t: "pb.end".into(),
        run_id: run_id.to_string(),
        exit: None,
        duration_ms: 0,
        truncated: false,
        ran_as: "user".into(),
        error: Some(err),
        ts: now_ms(),
    };
    let _ = pb_tx.send(PbMsg::End {
        end,
        playbook_id: playbook_id.to_string(),
        body_hash: body_hash.to_string(),
    });
}

fn path_from_u8(v: u8) -> CapturePath {
    match v {
        x if x == CapturePath::Dda as u8 => CapturePath::Dda,
        x if x == CapturePath::Projection as u8 => CapturePath::Projection,
        x if x == CapturePath::Xshm as u8 => CapturePath::Xshm,
        x if x == CapturePath::Xgetimage as u8 => CapturePath::Xgetimage,
        x if x == CapturePath::None as u8 => CapturePath::None,
        x if x == CapturePath::Portal as u8 => CapturePath::Portal,
        x if x == CapturePath::Sck as u8 => CapturePath::Sck,
        _ => CapturePath::Gdi,
    }
}

/// Phase E §7.2 / §16.2 (C §5.1 `capture`): the event for an X11 capture path change, if any.
/// The first X11 path seen and every later switch (MIT-SHM to `GetImage`) are `start`; the pump
/// publishing `none` (the X connection was lost) is `x11_lost`, reported once. Windows paths are
/// never reported here (unchanged Windows behaviour).
fn x11_capture_change(
    reported: Option<CapturePath>,
    now: CapturePath,
    monitor_id: u32,
    ts: i64,
) -> Option<Value> {
    if reported == Some(now) {
        return None;
    }
    // apple-owned: begin
    // Phase F §17.2: ScreenCaptureKit starting (again) is `start`; the stream stopping (Screen
    // Recording revoked, display gone) is `sck_stopped`, reported once.
    #[cfg(target_os = "macos")]
    match now {
        CapturePath::Sck => {
            return Some(crate::desk::capture_event(monitor_id, "sck", "start", ts))
        }
        CapturePath::None if reported == Some(CapturePath::Sck) => {
            return Some(crate::desk::capture_event(
                monitor_id,
                "none",
                "sck_stopped",
                ts,
            ))
        }
        _ => {}
    }
    // apple-owned: end
    match now {
        CapturePath::Xshm => Some(crate::desk::capture_event(monitor_id, "xshm", "start", ts)),
        CapturePath::Xgetimage => Some(crate::desk::capture_event(
            monitor_id,
            "xgetimage",
            "start",
            ts,
        )),
        CapturePath::None if reported.is_some() => Some(crate::desk::capture_event(
            monitor_id, "none", "x11_lost", ts,
        )),
        _ => None,
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
    fn only_a_linux_service_worker_answers_elevation_not_supported() {
        let elevate = SessionEffect::ElevationRequest {
            reason: "install a driver".into(),
        };
        assert!(linux_worker_refuses_elevation(true, true, &elevate));
        // A Windows worker raises privileged mode in place; a portable agent keeps its own path.
        assert!(!linux_worker_refuses_elevation(false, true, &elevate));
        assert!(!linux_worker_refuses_elevation(true, false, &elevate));
        // Other ops are untouched.
        assert!(!linux_worker_refuses_elevation(
            true,
            true,
            &SessionEffect::None
        ));
    }

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
            capture_fps: 15.0,
            encode_ms: Some(6.0),
            rec_kbps: 0,
        };
        let decision = ia_core::abr::AbrDecision {
            target_kbps: 1500,
            rung: ia_core::abr::Rung::High,
            floor_mode: false,
            force_keyframe: false,
        };
        let wire =
            build_stats(&monitors, 1, CapturePath::Gdi, &interval, &decision, false).to_wire();
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

        // With a recorder PC attached: recorderKbps is the measured recorder track and
        // sentKbps sums both PCs (contract §4.4).
        let with_rec = MeterInterval {
            rec_kbps: 700,
            ..interval
        };
        let wire =
            build_stats(&monitors, 1, CapturePath::Gdi, &with_rec, &decision, true).to_wire();
        assert_eq!(wire["recorderKbps"], json!(700));
        assert_eq!(wire["sentKbps"], json!(1800));
    }

    #[test]
    fn parse_interpreter_round_trips() {
        assert_eq!(parse_interpreter("cmd"), Some(PlaybookInterpreter::Cmd));
        assert_eq!(
            parse_interpreter("powershell"),
            Some(PlaybookInterpreter::Powershell)
        );
        assert_eq!(parse_interpreter("bogus"), None);
        // Phase F revision 3: zsh parses on every platform (the macOS-only arm is gone).
        assert_eq!(parse_interpreter("zsh"), Some(PlaybookInterpreter::Zsh));
        assert_eq!(parse_interpreter("sh"), Some(PlaybookInterpreter::Sh));
    }

    #[test]
    fn a_missing_or_unknown_interpreter_is_refused_never_powershell() {
        assert_eq!(run_interpreter(None), None);
        assert_eq!(run_interpreter(Some(&json!({}))), None);
        assert_eq!(run_interpreter(Some(&json!({ "interpreter": 3 }))), None);
        assert_eq!(
            run_interpreter(Some(&json!({ "interpreter": "bash" }))),
            None
        );
        assert_eq!(
            run_interpreter(Some(&json!({ "interpreter": "powershell" }))),
            Some(PlaybookInterpreter::Powershell)
        );
        assert_eq!(
            run_interpreter(Some(&json!({ "interpreter": "zsh" }))),
            Some(PlaybookInterpreter::Zsh)
        );
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

    #[test]
    fn x11_capture_paths_are_reported_once_and_a_lost_connection_is_x11_lost() {
        let ev = x11_capture_change(None, CapturePath::Xshm, 1, 5).unwrap();
        assert_eq!(ev["kind"], "capture");
        assert_eq!(ev["path"], "xshm");
        assert_eq!(ev["cause"], "start");
        assert!(x11_capture_change(Some(CapturePath::Xshm), CapturePath::Xshm, 1, 6).is_none());
        let ev = x11_capture_change(Some(CapturePath::Xshm), CapturePath::Xgetimage, 2, 7).unwrap();
        assert_eq!(ev["path"], "xgetimage");
        assert_eq!(ev["monitorId"], 2);
        let ev = x11_capture_change(Some(CapturePath::Xgetimage), CapturePath::None, 2, 8).unwrap();
        assert_eq!(ev["cause"], "x11_lost");
        assert_eq!(ev["path"], "none");
        // Windows paths and a `none` with nothing reported before say nothing.
        assert!(x11_capture_change(None, CapturePath::Gdi, 1, 9).is_none());
        assert!(x11_capture_change(None, CapturePath::Dda, 1, 9).is_none());
        assert!(x11_capture_change(None, CapturePath::None, 1, 9).is_none());
        for p in CapturePath::ALL {
            assert_eq!(path_from_u8(p as u8), p);
        }
    }
}
