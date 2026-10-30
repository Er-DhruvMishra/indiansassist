//! IndiansAssist Windows agent entry point (contract §11.1 `ia-agent`).
//!
//! The full build (feature `media`, default on the MSVC host) has no console window and
//! drives the signaling client, the webrtc-rs peer, the VP8 encoder and the egui UI. It
//! resolves the token-source precedence (§2.1), connects to `/signal`, and runs the hello /
//! knock / poll exchange; the consent window, the `ia.sec` handshake and the media tracks
//! attach once a `session.created` arrives. The dev API has no P3 path yet, so a live
//! session cannot complete end to end — the exchange reports what the server answered and
//! the in-process loopback test covers the media + crypto path.
#![cfg_attr(
    all(feature = "media", not(feature = "dev")),
    windows_subsystem = "windows"
)]

use ia_agent::cli::{Cli, CliError, HELP};
use ia_agent::tokensource::{resolve, Candidates};
use ia_core::join_input::normalise_token_input;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let cli = match Cli::parse(&args) {
        Ok(c) => c,
        Err(CliError(msg)) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    };
    if cli.help {
        println!("{HELP}");
        return;
    }

    // Rank 1 (arg / deeplink) from the command line; the remaining carriers (sidecar,
    // filename, clipboard, manual) are resolved by the connect flow (§2.1).
    let arg = cli
        .arg
        .as_ref()
        .and_then(|(src, t)| normalise_token_input(&t.0).map(|tok| (*src, tok)));
    let candidates = Candidates {
        arg,
        ..Default::default()
    };
    let resolved = resolve(&candidates);

    println!("IndiansAssist agent {}", env!("CARGO_PKG_VERSION"));
    match &resolved {
        Some(r) => println!("token source: {:?}", r.source),
        None => println!("No support code supplied; the connect window would prompt for one."),
    }

    run(&cli, resolved);
}

#[cfg(feature = "media")]
fn run(cli: &Cli, resolved: Option<ia_agent::tokensource::Resolved>) {
    use std::time::Duration;
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    let Some(r) = resolved else {
        // No token: a release build would open the connect window here. Nothing to do
        // headless, so exit cleanly.
        return;
    };

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("runtime: {e}");
            std::process::exit(1);
        }
    };
    let outcome = rt.block_on(ia_agent::session::run_signaling(
        cli,
        &r.token,
        r.source,
        Duration::from_secs(20),
    ));
    match outcome {
        Ok(o) => println!("signaling outcome: {o:?}"),
        Err(e) => {
            eprintln!("signaling error: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(feature = "media"))]
fn run(_cli: &Cli, _resolved: Option<ia_agent::tokensource::Resolved>) {
    eprintln!(
        "This build is compiled without the `media` feature: the signaling client, the \
         webrtc peer, the encoders and the UI are not linked (the ia-core cross-check build). \
         Build with the default features on the MSVC host to run a session. See agent/README.md."
    );
}
