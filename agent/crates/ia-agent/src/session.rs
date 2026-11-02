//! Session orchestration (contract §3) for the `media` build: resolve the signaling URL,
//! open the `/signal` socket, send `desk.hello`, then knock and poll. Once a
//! `session.created` arrives the live serve loop (`crate::serve`) takes over: the consent
//! window (or the dev `--auto-consent`), the `ia.sec` handshake over the data channel, the
//! encrypted channels, the video track, the indicator UI and teardown.

use std::time::Duration;

use serde_json::Value;

use crate::cli::Cli;
use crate::signal::{windows_capabilities, AgentIdentity, SignalClient};
use ia_core::join_input::TokenInput;
use ia_core::types::TokenSource;

/// What this process joined with, remembered once so the §7.3 hand-over can pass it to the
/// elevated child. It is the token the Desk already holds, not a new credential: the child
/// presents the same token plus the one-time hand-over (§7.2).
pub struct JoinedWith {
    pub token: String,
    pub source: &'static str,
    pub api_origin: String,
    pub signal_url: String,
}

static JOINED: std::sync::OnceLock<JoinedWith> = std::sync::OnceLock::new();

/// What this process joined with, or `None` before the hello (and in a worker, which joins
/// with a worker credential and can never hand over: §4.3 "elevation hand-over is not used in
/// P4", the level is raised in place instead).
pub fn joined() -> Option<&'static JoinedWith> {
    JOINED.get()
}

fn remember(token: String, source: &'static str, api_origin: String, signal_url: String) {
    let _ = JOINED.set(JoinedWith {
        token,
        source,
        api_origin,
        signal_url,
    });
}

/// How the signaling exchange ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalOutcome {
    /// `desk.hello.ok` seen; the agent is waiting for a technician (knocking/polling).
    Waiting,
    /// A `session.created` arrived (consent would open next).
    SessionCreated,
    /// The server answered `error` (e.g. invalid token on the dev API with no P3 path).
    Rejected { code: String, message: String },
    /// The socket closed or the time budget elapsed before `desk.hello.ok`.
    Closed,
}

/// The default signalling URL when neither the dev `--signal-url` nor `--api-origin` is given.
/// A **dev** build falls back to localhost for the e2e; a **release** build has no localhost
/// fallback (security C10) — it uses the compiled region origin (`IA_API_ORIGIN`) and, absent
/// one, returns an empty string so a release binary never silently dials localhost.
#[cfg(feature = "dev")]
fn compiled_default_signal_url() -> String {
    "ws://localhost:4000/signal".to_string()
}

#[cfg(not(feature = "dev"))]
fn compiled_default_signal_url() -> String {
    match option_env!("IA_API_ORIGIN") {
        Some(origin) => format!(
            "{}/signal",
            origin.replacen("http", "ws", 1).trim_end_matches('/')
        ),
        None => String::new(),
    }
}

fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

/// Resolve the signaling URL: the dev `--signal-url`, else derived from `--api-origin`
/// (`http`→`ws`, `/signal`), else the compiled default.
pub fn resolve_signal_url(cli: &Cli) -> String {
    if let Some(u) = &cli.signal_url {
        return u.clone();
    }
    if let Some(origin) = &cli.api_origin {
        let ws = origin.replacen("http", "ws", 1);
        return format!("{}/signal", ws.trim_end_matches('/'));
    }
    compiled_default_signal_url()
}

/// The API origin this build talks to: the dev override, else the compiled one derived from the
/// signalling URL (the hand-over blob carries it so the child does not re-resolve it).
fn api_host_origin(cli: &Cli) -> String {
    if let Some(o) = &cli.api_origin {
        return o.clone();
    }
    let ws = resolve_signal_url(cli);
    ws.trim_end_matches("/signal")
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1)
}

fn token_string(tok: &TokenInput) -> String {
    match tok {
        TokenInput::Compact(s) => s.clone(),
        TokenInput::ShortCode(s) => s.clone(),
    }
}

fn source_wire(src: TokenSource) -> &'static str {
    match src {
        TokenSource::Arg => "arg",
        TokenSource::Deeplink => "deeplink",
        TokenSource::Sidecar => "sidecar",
        TokenSource::Filename => "filename",
        TokenSource::Clipboard => "clipboard",
        TokenSource::Manual => "manual",
        TokenSource::Service => "service",
    }
}

/// The `desk.hello` capabilities of this Desk: C §3.1 on Windows, Phase E §7.5 on Linux (the
/// RandR monitor count in an X11 session, the no-screen set on Wayland).
fn desk_capabilities(cli: &Cli, has_voice: bool) -> ia_core::types::AgentCapabilities {
    // apple-owned: begin
    // Phase F §17.2: what TCC has granted, over the active displays (everything when synthetic).
    #[cfg(target_os = "macos")]
    {
        let _ = has_voice;
        #[cfg(feature = "macos")]
        let monitors = if cli.synthetic_capture {
            1
        } else {
            crate::desk::macos_monitors().len().max(1)
        };
        #[cfg(not(feature = "macos"))]
        let monitors = 1;
        let caps = crate::desk::macos_caps(monitors, cli.synthetic_capture);
        tracing::info!(monitors = caps.monitors, features = ?caps.features, "macos capabilities");
        return caps;
    }
    // apple-owned: end
    #[allow(unreachable_code)]
    if !cfg!(target_os = "linux") {
        return windows_capabilities(1, false, has_voice);
    }
    let mode = crate::desk::detect(cli.synthetic_capture);
    let monitors = match &mode {
        crate::desk::ScreenMode::X11 { display } => crate::desk::x11_monitors(display).len(),
        _ => 1,
    };
    let caps = crate::desk::linux_caps(&mode, monitors);
    tracing::info!(?mode, monitors = caps.monitors, features = ?caps.features, "linux capabilities");
    caps
}

/// Run the hello/knock/poll exchange, up to `budget`. Returns how it ended.
pub async fn run_signaling(
    cli: &Cli,
    token: &TokenInput,
    source: TokenSource,
    budget: Duration,
) -> Result<SignalOutcome, String> {
    // The cpal device probe takes ~2 s on some hosts: run it while the socket connects
    // (`voice_available` is a once-cell, so the later call just waits for this result).
    std::thread::spawn(crate::voice::voice_available);
    // Contract §2.1 / C10: the token is checked locally before the first network call.
    let keys = crate::tokencheck::compiled_keys();
    match crate::tokencheck::local_check(token, &keys, crate::tokencheck::now_sec()) {
        crate::tokencheck::LocalCheck::Invalid(why) => {
            tracing::warn!(why, "This code is not valid (local check); not connecting");
            return Ok(SignalOutcome::Rejected {
                code: why.to_string(),
                message: "This code is not valid".to_string(),
            });
        }
        crate::tokencheck::LocalCheck::Unsigned { tier, region } => tracing::warn!(
            %tier,
            %region,
            "token checked locally without a signature (no region key compiled into this build)"
        ),
        crate::tokencheck::LocalCheck::Verified { tier, region } => {
            tracing::info!(%tier, %region, "token verified locally against the compiled region key")
        }
        crate::tokencheck::LocalCheck::ShortCode => {
            tracing::info!("12-digit code passed the Luhn check")
        }
    }
    let signal_url = resolve_signal_url(cli);
    let id = AgentIdentity {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os_version: crate::desk::os_version(),
        arch: arch().to_string(),
    };
    tracing::info!(%signal_url, "connecting to signaling");

    remember(
        token_string(token),
        source_wire(source),
        api_host_origin(cli),
        signal_url.clone(),
    );
    let mut client = SignalClient::connect(&signal_url, &id).await?;
    // Voice is advertised only when a default capture and render device exist (§6.3).
    let has_voice = crate::voice::voice_available();
    tracing::info!(has_voice, "voice capability");
    let caps = desk_capabilities(cli, has_voice);
    client
        .desk_hello(&token_string(token), None, &id, source_wire(source), &caps)
        .await?;

    // Knock / poll until a `session.created` arrives; then split the socket and run the live
    // serve loop (consent, peer, handshake, channels, media, teardown).
    let created = match drive_until_created(&mut client, budget).await? {
        Drive::Created(v) => v,
        Drive::Outcome(o) => return Ok(o),
    };
    let (mut writer, mut ws_rx) = client.split();
    let joined_by_code = matches!(token, TokenInput::ShortCode(_));
    let out = crate::serve::run_live_session(
        &mut writer,
        &mut ws_rx,
        cli,
        &created,
        budget,
        joined_by_code,
    )
    .await;
    tracing::info!(outcome = ?out, "live serve loop returned");
    match out {
        Ok(_) => Ok(SignalOutcome::SessionCreated),
        Err(e) => Err(e),
    }
}

/// §7.3 steps 4-5: the elevated child's side of signalling. The same socket and the same
/// serve loop; what differs is that the hello carries the hand-over, there is no knock (the
/// session is live and is being taken over), and the handshake starts at the parent's
/// generation + 1 so the console accepts the rebuild (W43).
pub async fn run_handover_child_session(
    cli: &Cli,
    budget: Duration,
) -> Result<SignalOutcome, String> {
    let blob = crate::hochild::get().ok_or("run_handover_child_session needs a hand-over blob")?;
    std::thread::spawn(crate::voice::voice_available);
    let id = AgentIdentity {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os_version: "10.0".to_string(),
        arch: arch().to_string(),
    };
    tracing::info!(
        session = %blob.session_id,
        gen = blob.gen,
        offering = blob.child_gen(),
        "the elevated instance is taking the session over"
    );
    let mut client = SignalClient::connect(&blob.signal_url, &id).await?;
    let has_voice = crate::voice::voice_available();
    let caps = windows_capabilities(1, false, has_voice);
    client
        .desk_hello_handover(
            &blob.token,
            &blob.handover,
            blob.desk_label.as_deref(),
            &id,
            &blob.token_source,
            &caps,
        )
        .await?;
    let created = match drive_until_created(&mut client, budget).await? {
        Drive::Created(v) => v,
        Drive::Outcome(o) => {
            // §7.3 step 5: a child the server rejects (its hand-over was consumed or expired)
            // exits; the user instance keeps the session.
            tracing::error!(outcome = ?o, "the hand-over was refused; the elevated instance is exiting");
            return Ok(o);
        }
    };
    let (mut writer, mut ws_rx) = client.split();
    let out =
        crate::serve::run_live_session(&mut writer, &mut ws_rx, cli, &created, budget, false).await;
    tracing::info!(outcome = ?out, "the elevated instance's serve loop returned");
    match out {
        Ok(_) => Ok(SignalOutcome::SessionCreated),
        Err(e) => Err(e),
    }
}

/// §4.2 / §4.3: the worker's side of signalling. It is the same socket, the same `desk.hello`
/// shape and the same live serve loop as Phase C — only the credential differs, and there is no
/// knock or poll: the session already exists, so `session.created` follows the hello.
pub async fn run_worker_session(cli: &Cli, budget: Duration) -> Result<SignalOutcome, String> {
    let ctx = crate::svc::get().ok_or("run_worker_session needs a worker context")?;
    std::thread::spawn(crate::voice::voice_available);
    let id = AgentIdentity {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os_version: "10.0".to_string(),
        arch: arch().to_string(),
    };
    tracing::info!(
        signal_url = %ctx.signal_url,
        session = %ctx.session_id,
        decision = ?ctx.decision,
        gen = ctx.gen,
        "the worker is joining its session"
    );
    let mut client = SignalClient::connect(&ctx.signal_url, &id).await?;
    let has_voice = crate::voice::voice_available();
    let caps = windows_capabilities(1, false, has_voice);
    client
        .desk_hello_worker(ctx.credential.expose(), &id, &caps)
        .await?;
    let created = match drive_until_created(&mut client, budget).await? {
        Drive::Created(v) => v,
        Drive::Outcome(o) => {
            tracing::warn!(outcome = ?o, "the worker did not reach session.created");
            return Ok(o);
        }
    };
    let (mut writer, mut ws_rx) = client.split();
    let out =
        crate::serve::run_live_session(&mut writer, &mut ws_rx, cli, &created, budget, false).await;
    tracing::info!(outcome = ?out, "the worker's serve loop returned");
    match out {
        Ok(_) => Ok(SignalOutcome::SessionCreated),
        Err(e) => Err(e),
    }
}

enum Drive {
    Created(Value),
    Outcome(SignalOutcome),
}

async fn drive_until_created(client: &mut SignalClient, budget: Duration) -> Result<Drive, String> {
    let mut poll = tokio::time::interval(Duration::from_secs(3));
    let deadline = tokio::time::sleep(budget);
    tokio::pin!(deadline);
    let mut waiting = false;
    loop {
        tokio::select! {
            _ = &mut deadline => {
                return Ok(Drive::Outcome(if waiting { SignalOutcome::Waiting } else { SignalOutcome::Closed }));
            }
            _ = poll.tick(), if waiting => { let _ = client.poll().await; }
            msg = client.recv() => {
                let Some(v): Option<Value> = msg else { return Ok(Drive::Outcome(SignalOutcome::Closed)) };
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("desk.hello.ok") => {
                        tracing::info!("desk.hello.ok; knocking and polling");
                        client.knock(None).await?;
                        waiting = true;
                    }
                    Some("poll.status") | Some("knock.ok") | Some("knock.held") | Some("token.presence") => {
                        tracing::debug!(msg = %v, "waiting update");
                    }
                    Some("session.created") => return Ok(Drive::Created(v)),
                    Some("error") => {
                        return Ok(Drive::Outcome(SignalOutcome::Rejected {
                            code: v.get("code").and_then(|c| c.as_str()).unwrap_or("error").to_string(),
                            message: v.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string(),
                        }))
                    }
                    _ => {}
                }
            }
        }
    }
}
