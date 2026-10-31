//! IndiansAssist Windows agent entry point (contract §11.1 `ia-agent`).
//!
//! The full build (feature `media`, default on the MSVC host) has no console window and
//! drives the signaling client, the webrtc-rs peer, the VP8 encoder and the egui UI. It
//! resolves the token-source precedence (§2.1), connects to `/signal`, runs the hello /
//! knock / poll exchange, and once a `session.created` arrives hands over to the live serve
//! loop: the consent window (UI thread), the `ia.sec` handshake, the encrypted channels, the
//! media track, the indicator pill / panel / tray, and Stop + teardown.
#![cfg_attr(
    all(feature = "media", not(feature = "dev")),
    windows_subsystem = "windows"
)]

use ia_agent::cli::{Cli, CliError, HELP};
use ia_agent::tokensource::{resolve, Candidates};
use ia_core::join_input::normalise_token_input;

fn main() {
    // DLL-search hardening (contract §14 / security C10): before any thread or late-bound
    // load, restrict the loader to System32 and clear the DLL directory so a planted DLL in
    // the exe's folder (Downloads) cannot be side-loaded. Must be the first statement.
    harden_dll_search();

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

/// Restrict the DLL search path to System32 and clear the application DLL directory (§14 /
/// C10). Everything non-KnownDLL is reached through `ia_platform::sys_lib` at run time.
#[cfg(windows)]
fn harden_dll_search() {
    use windows::core::w;
    use windows::Win32::System::LibraryLoader::{
        SetDefaultDllDirectories, SetDllDirectoryW, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    // SAFETY: both calls take process-wide loader flags / a NUL-terminated wide string.
    unsafe {
        let _ = SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
        let _ = SetDllDirectoryW(w!(""));
    }
}

#[cfg(not(windows))]
fn harden_dll_search() {}

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
    // The dev session flags drive the (headless) e2e path: synthetic capture, keep-on-exit and a
    // deterministic Stop. They are logged here and consumed by the session once the serve loop
    // past `session.created` runs; `--stop-after` also sizes the signaling wait budget so an
    // automated run is not cut short before the technician accepts.
    if cli.synthetic_capture || cli.no_self_delete || cli.stop_after.is_some() {
        tracing::info!(
            synthetic_capture = cli.synthetic_capture,
            no_self_delete = cli.no_self_delete,
            stop_after = ?cli.stop_after,
            "dev session flags"
        );
    }
    // Headless dev runs wait 20 s for a technician; a run with the consent window waits up to
    // 30 minutes (the knock stays open until the technician accepts or the token expires).
    let budget = cli
        .stop_after
        .map(|s| Duration::from_secs(s.saturating_add(10)))
        .unwrap_or_else(|| Duration::from_secs(if cli.auto_consent.is_some() { 20 } else { 1800 }));
    let outcome = rt.block_on(ia_agent::session::run_signaling(
        cli, &r.token, r.source, budget,
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
