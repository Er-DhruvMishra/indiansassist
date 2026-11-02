//! IndiansAssist agent entry point (contract §11.1 `ia-agent`; Windows, and Linux X11 since
//! Phase E §7).
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
    // Physical-pixel monitor geometry before anything enumerates monitors or opens a window
    // (Windows only; Phase E §7.2).
    #[cfg(all(windows, feature = "winapi"))]
    ia_capture_win::enumerate::ensure_per_monitor_dpi_awareness();

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

    // §7.3 step 4: this process is the elevated hand-over child. It takes its whole context
    // from the pipe its parent is holding — not from the command line, which any process of
    // this user can read — and refuses to run if the image it is running is not the one the
    // parent hashed.
    if let Some(suffix) = cli.handover_pipe.clone() {
        run_handover_child(&cli, &suffix);
        return;
    }

    // Rank 1 (arg / deeplink) from the command line; the remaining carriers (sidecar,
    // filename, clipboard, manual) are resolved by the connect flow (§2.1).
    let arg = cli
        .arg
        .as_ref()
        .and_then(|(src, t)| normalise_token_input(&t.0).map(|tok| (*src, tok)));
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut candidates = Candidates {
        arg,
        ..Default::default()
    };
    // Phase E §7.6 / §7.7 (Linux): the start-up checks, the filename and clipboard carriers,
    // the deep-link handler and the single instance.
    #[cfg(target_os = "linux")]
    linux_start(&cli, &mut candidates);
    // apple-owned: begin
    // Phase F §17.2: the macOS start-up (the `.iaconfig` sidecar beside `IndiansAssist.app`, the
    // `CFBundleURLTypes` deep link, the single instance); empty until the apple stream fills it.
    #[cfg(target_os = "macos")]
    macos_start(&cli, &mut candidates);
    // apple-owned: end
    let resolved = resolve(&candidates);

    println!("IndiansAssist agent {}", env!("CARGO_PKG_VERSION"));
    match &resolved {
        Some(r) => println!("token source: {:?}", r.source),
        None => println!("No support code supplied; the connect window would prompt for one."),
    }

    run(&cli, resolved);
}

// apple-owned: begin
/// Phase F §17.2: the macOS start-up. Never as root; the signed `IndiansAssist.iaconfig` sidecar
/// beside `IndiansAssist.app` (the macOS carrier: the zip's name is gone after extraction); the
/// `indiansassist://` link of a Launch Services launch, which arrives as a `GetURL` Apple Event
/// rather than an argument; and the single instance over the per-user socket.
#[cfg(target_os = "macos")]
fn macos_start(cli: &Cli, candidates: &mut Candidates) {
    use ia_platform::macos::{deeplink, os, paths, MacEnv};
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("Run IndiansAssist as your normal user account");
        std::process::exit(1);
    }
    let exe = std::env::current_exe().ok();
    if let Some(path) = exe.as_deref().and_then(paths::sidecar_for) {
        match std::fs::read(&path) {
            Ok(bytes) => {
                let keys = option_env!("IA_TOKEN_PUBKEYS").unwrap_or("");
                match ia_agent::desk::macos_sidecar(&bytes, keys) {
                    Ok(ia_agent::desk::MacSidecar::Verified(tok)) => {
                        candidates.sidecar_code = Some(tok)
                    }
                    Ok(ia_agent::desk::MacSidecar::Unsigned(tok)) => {
                        eprintln!(
                            "the sidecar is unsigned (no region key in this build); using it"
                        );
                        candidates.sidecar_code = Some(tok);
                    }
                    Ok(ia_agent::desk::MacSidecar::NoCode) => {}
                    Err(e) => eprintln!("the sidecar beside the app was ignored: {e}"),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("the sidecar beside the app could not be read: {e}"),
        }
    }
    let bundled = exe.as_deref().and_then(paths::bundle_of).is_some();
    if bundled && candidates.arg.is_none() && candidates.sidecar_code.is_none() {
        if let Some(url) = deeplink::catch_launch_url(std::time::Duration::from_millis(1000)) {
            match normalise_token_input(&url) {
                Some(tok) => candidates.arg = Some((ia_core::types::TokenSource::Deeplink, tok)),
                None => eprintln!("the link that opened IndiansAssist is not a join link"),
            }
        }
    }
    let env = MacEnv::from_process();
    let forward = cli
        .arg
        .as_ref()
        .map(|(_, t)| t.0.clone())
        .unwrap_or_else(|| "focus".to_string());
    match os::acquire_single_instance(&env, &forward) {
        Ok(os::InstanceOutcome::First(server)) => {
            let _ = server.spawn(|line| {
                // A second start while this one runs is never acted on as a command; the
                // running session continues (C §11.5).
                eprintln!(
                    "Another start of IndiansAssist was ignored ({} bytes); this session continues.",
                    line.len()
                );
            });
        }
        Ok(os::InstanceOutcome::Forwarded) => {
            println!("IndiansAssist is already running.");
            std::process::exit(0);
        }
        Err(e) => eprintln!("single instance unavailable: {e}"),
    }
}
// apple-owned: end

/// Phase E rule 7.3d: never as root. §7.4: a graphical session is required (a synthetic dev run
/// needs none). §7.6 carriers: rank 3 the extension-less filename (`IndiansAssist-<region>-<dddd>-
/// <dddd>-<dddd>`), rank 4 the clipboard (read once, cleared only while it still holds the value
/// read). §7.7: the deep-link handler is registered under the XDG roots, and a second start of
/// this image forwards its link to the running instance and exits.
#[cfg(target_os = "linux")]
fn linux_start(cli: &Cli, candidates: &mut Candidates) {
    use ia_platform::linux::display::NO_SESSION_MESSAGE;
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("Run IndiansAssist as your normal user account");
        std::process::exit(1);
    }
    let mode = ia_agent::desk::detect(cli.synthetic_capture);
    if mode == ia_agent::desk::ScreenMode::NoSession {
        eprintln!("{NO_SESSION_MESSAGE}");
        std::process::exit(1);
    }
    let exe = std::env::current_exe().ok();
    if candidates.arg.is_none() {
        if let Some(name) = exe
            .as_ref()
            .and_then(|e| e.file_name())
            .and_then(|n| n.to_str())
        {
            if let Some(p) = ia_core::download::parse_linux_filename(name, ia_core::token::REGIONS)
            {
                candidates.filename_code = Some(ia_core::join_input::TokenInput::ShortCode(p.code));
            }
        }
    }
    #[cfg(feature = "x11")]
    if candidates.arg.is_none() && candidates.filename_code.is_none() {
        if let ia_agent::desk::ScreenMode::X11 { .. } = mode {
            if let Some(text) = ia_input_x11::clipboard_read_once() {
                if let Some(tok) = normalise_token_input(text.trim()) {
                    let _ = ia_input_x11::clipboard_clear_if_unchanged(&text);
                    candidates.clipboard = Some(tok);
                }
            }
        }
    }
    #[cfg(feature = "linux-os")]
    {
        use ia_platform::linux::{os, XdgEnv};
        use ia_platform::traits::ProtocolHandler;
        let env = XdgEnv::from_process();
        let forward = cli
            .arg
            .as_ref()
            .map(|(_, t)| t.0.clone())
            .unwrap_or_default();
        match os::acquire_single_instance(&env, &forward) {
            Ok(os::InstanceOutcome::Primary(server)) => {
                let _ = server.spawn(|line| {
                    // A second start while this one runs: never acted on as a command; the
                    // running session continues (C §11.5).
                    eprintln!(
                        "Another start of IndiansAssist was ignored ({} bytes); this session continues.",
                        line.len()
                    );
                });
            }
            Ok(os::InstanceOutcome::Forwarded) => {
                println!("IndiansAssist is already running.");
                std::process::exit(0);
            }
            Ok(os::InstanceOutcome::Squatted(why)) => {
                eprintln!("single instance: {why}; continuing on our own")
            }
            Err(e) => eprintln!("single instance unavailable: {e}"),
        }
        if let Some(exe) = &exe {
            if let Err(e) = (os::LinuxProtocolHandler { env }).register(&exe.to_string_lossy()) {
                eprintln!("the indiansassist:// link handler could not be registered: {e}");
            }
        }
    }
}

/// §7.3 step 4: read the blob, check this image is the one the parent hashed and that it is
/// signed by the publisher this build expects, then take the session over.
///
/// Both checks are **fatal here** and only warnings in the parent (§2.6): the parent is already
/// running, while the child is about to run as administrator, so this is the last place an
/// unexpected image can be stopped.
#[cfg(all(feature = "media", windows, feature = "winapi"))]
fn run_handover_child(cli: &ia_agent::cli::Cli, suffix: &str) {
    use std::time::Duration;
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();
    let Some(parent) = ia_agent::hopipe::parent_pid() else {
        eprintln!("the elevated instance could not identify its parent");
        std::process::exit(1);
    };
    let bytes = match ia_agent::hopipe::read_blob(suffix, parent, Duration::from_secs(20)) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("the hand-over blob could not be read: {e:?}");
            std::process::exit(1);
        }
    };
    let blob = match ia_agent::hochild::HandoverBlob::parse(&bytes) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("the hand-over blob is not usable: {e}");
            std::process::exit(1);
        }
    };
    // The image the parent hashed, over a handle it held open the whole time.
    match std::env::current_exe().and_then(|exe| ia_agent::hopipe::ImageHold::open(&exe)) {
        Ok(hold) if hold.sha256.eq_ignore_ascii_case(&blob.image_sha256) => {}
        Ok(hold) => {
            eprintln!(
                "image_mismatch: this instance is {} but the parent hashed {}",
                &hold.sha256[..16],
                &blob.image_sha256[..16]
            );
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("image_mismatch: this instance could not hash itself: {e}");
            std::process::exit(1);
        }
    }
    match ia_platform::trust::verify_self() {
        ia_platform::trust::TrustVerdict::Trusted => {}
        ia_platform::trust::TrustVerdict::Unsigned if cfg!(feature = "dev") => {
            tracing::warn!(
                "this development build is unsigned; a release build would refuse to elevate"
            )
        }
        other => {
            eprintln!(
                "image_mismatch: this instance is not signed by the expected publisher ({})",
                other.as_str()
            );
            std::process::exit(1);
        }
    }
    if let Err(e) = ia_agent::hochild::set(blob) {
        eprintln!("{e}");
        std::process::exit(1);
    }
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
    let outcome = rt.block_on(ia_agent::session::run_handover_child_session(
        cli,
        Duration::from_secs(24 * 3600),
    ));
    match outcome {
        Ok(o) => tracing::info!(outcome = ?o, "the elevated instance finished"),
        Err(e) => {
            eprintln!("the elevated instance stopped: {e}");
            std::process::exit(1);
        }
    }
}

/// Without the media stack or the Win32 layer there is no hand-over to take over.
#[cfg(not(all(feature = "media", windows, feature = "winapi")))]
fn run_handover_child(_cli: &ia_agent::cli::Cli, _suffix: &str) {
    eprintln!(
        "This build has no signalling or Win32 layer, so it cannot take over an elevated          hand-over. See agent/README.md."
    );
    std::process::exit(2);
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

/// The startup `WinVerifyTrust` self-check (contract §11.3 / §14, C10). The user instance only
/// logs the verdict (every local / dev build is unsigned); the elevated hand-over child is
/// where an untrusted image becomes fatal (§7.3 step 4).
#[cfg(all(feature = "media", windows, feature = "winapi"))]
fn self_trust_check() {
    let verdict = ia_platform::trust::verify_self();
    match verdict {
        ia_platform::trust::TrustVerdict::Trusted => {
            tracing::info!("self-check: the executable's Authenticode signature is valid")
        }
        other => tracing::warn!(
            verdict = other.as_str(),
            "self-check: the executable is not validly signed (log-only in the user instance)"
        ),
    }
}

#[cfg(all(feature = "media", not(all(windows, feature = "winapi"))))]
fn self_trust_check() {}

#[cfg(feature = "media")]
fn run(cli: &Cli, resolved: Option<ia_agent::tokensource::Resolved>) {
    use std::time::Duration;
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    self_trust_check();

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
