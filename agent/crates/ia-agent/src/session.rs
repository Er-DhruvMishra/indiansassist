//! Session orchestration (contract §3) for the `media` build: resolve the signaling URL,
//! open the `/signal` socket, send `desk.hello`, then knock and poll. The consent window,
//! the `ia.sec` handshake over the data channel, the encrypted control channel, the video
//! tracks and teardown attach from here once a `session.created` arrives.
//!
//! The dev API has no P3 signaling path yet, so a live session cannot complete end to end
//! (§ task note); this drives the hello/knock/poll exchange and reports what the server
//! answered, and the in-process loopback test exercises the media + crypto path.

use std::time::Duration;

use serde_json::Value;

use crate::cli::Cli;
use crate::signal::{windows_capabilities, AgentIdentity, SignalClient};
use ia_core::join_input::TokenInput;
use ia_core::types::TokenSource;

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

const DEFAULT_SIGNAL_URL: &str = "ws://localhost:4000/signal";

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
    DEFAULT_SIGNAL_URL.to_string()
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
    }
}

/// Run the hello/knock/poll exchange, up to `budget`. Returns how it ended.
pub async fn run_signaling(
    cli: &Cli,
    token: &TokenInput,
    source: TokenSource,
    budget: Duration,
) -> Result<SignalOutcome, String> {
    let signal_url = resolve_signal_url(cli);
    let id = AgentIdentity {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os_version: "10.0".to_string(),
        arch: arch().to_string(),
    };
    tracing::info!(%signal_url, "connecting to signaling");

    let mut client = SignalClient::connect(&signal_url, &id).await?;
    // Voice is advertised only when an audio device is present (§6.3); the cpal duplex loop
    // is not yet wired, so the bring-up path reports no voice device.
    let caps = windows_capabilities(1, false, false);
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
    let out = crate::serve::run_live_session(&mut writer, &mut ws_rx, cli, &created, budget).await;
    tracing::info!(outcome = ?out, "live serve loop returned");
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
