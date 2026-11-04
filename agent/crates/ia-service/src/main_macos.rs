//! `ia-service` on macOS (Phase F §17.3): the LaunchDaemon entry point.
//!
//! * **no arguments**: the daemon, run by launchd as root (`com.indiansassist.agent`). It loads
//!   (or creates) the device keys in the System keychain, enrolls once if
//!   `/Library/Application Support/IndiansAssist/enroll.iaconfig` is there, opens the worker
//!   socket and runs the loops. An unenrolled daemon with no enrollment file waits for one rather
//!   than exiting and being restarted by launchd;
//! * **`--enroll <file>`**: run the D §3.1 sequence with that file now, shred it, and exit;
//! * **`--deregister`**: the signed deregister of D §4.1 bounded to 10 s, then shred the keys. It
//!   always exits 0: an offline Mac, an unreachable api or an unenrolled device must never fail an
//!   uninstall;
//! * **`--console`** (`dev` feature only, never in a release build): the same daemon in the
//!   foreground as the **current user**, everything under `--data-dir` (the state, the worker
//!   socket, and a file keychain instead of the System keychain), so a dev run touches no launchd
//!   job, no System keychain, no TCC row and nothing under `/var/run` or `/Library`;
//! * `--version`, `--help`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ia_platform::macos::service::{console_target, sys};
use ia_service::config::ServiceConfig;
use ia_service::identity::Identity;
use ia_service::macos::facts;
use ia_service::macos::keychain::KeyStore;
use ia_service::macos::paths::MacLayout;
use ia_service::macos::runtime::MacShared;

const HELP: &str = "\
ia-service - the IndiansAssist agent daemon for macOS (com.indiansassist.agent)

Run with no arguments by launchd, as root. Other entry points:
  --enroll <file>   enroll this Mac now with a signed enroll.iaconfig, then shred the file
  --deregister      deregister this Mac with its identity key, then shred the keys
  --version         print the version
  --help            this text

The enrollment file may also be placed at
/Library/Application Support/IndiansAssist/enroll.iaconfig (owner root, mode 0600);
the daemon enrolls with it at its next start and removes it.
";

pub fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `--help` and `--version` answer and leave: they create no directory and write nothing.
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("ia-service {}", ia_service::version());
        return;
    }
    init_tracing();
    if args.iter().any(|a| a == "--console") {
        #[cfg(feature = "dev")]
        {
            run_console(&args);
            return;
        }
        #[cfg(not(feature = "dev"))]
        {
            eprintln!("--console exists only in a dev build");
            std::process::exit(2);
        }
    }
    let layout = MacLayout::system();
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } != 0 {
        eprintln!(
            "ia-service runs as root under launchd (com.indiansassist.agent); \
             use `sudo launchctl kickstart system/com.indiansassist.agent`."
        );
        std::process::exit(if args.iter().any(|a| a == "--deregister") {
            0
        } else {
            1
        });
    }
    if args.iter().any(|a| a == "--deregister") {
        deregister(&layout);
        return;
    }
    let options = Options {
        enroll_file: value(&args, "--enroll").map(PathBuf::from),
        dev_console: false,
    };
    if options.enroll_file.is_some() {
        std::process::exit(match enroll_once(&layout, &options) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        });
    }
    std::process::exit(serve(layout, options));
}

/// launchd sends stdout and stderr to the plist's log files; no colours.
fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .try_init();
}

fn value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

struct Options {
    enroll_file: Option<PathBuf>,
    dev_console: bool,
}

enum PrepareError {
    /// Not enrolled and no enrollment file: wait for one.
    NotEnrolled,
    Fatal(String),
}

/// The keychain of this layout: the System keychain, or the dev file keychain.
fn keystore(layout: &MacLayout) -> Result<KeyStore, String> {
    match &layout.dev_keychain {
        Some(path) => KeyStore::dev(path),
        None => KeyStore::system(),
    }
    .map_err(|e| format!("the keychain could not be opened: {e}"))
}

/// The device keys: loaded from the keychain, or generated once and stored there.
fn identity(layout: &MacLayout) -> Result<Identity, String> {
    let store = keystore(layout)?;
    match store
        .load()
        .map_err(|e| format!("the device keys could not be read: {e}"))?
    {
        Some(id) => Ok(id),
        None => {
            let fresh = Identity::generate();
            store
                .store(&fresh)
                .map_err(|e| format!("the device keys could not be stored: {e}"))?;
            tracing::info!(key_id = %fresh.key_id(), "a device identity was generated");
            Ok(fresh)
        }
    }
}

fn enroll_candidates(layout: &MacLayout, options: &Options) -> Vec<PathBuf> {
    let mut c = Vec::new();
    if let Some(f) = &options.enroll_file {
        c.push(f.clone());
    }
    c.push(layout.enroll_config());
    c
}

/// Enroll with the first enrollment file found; on success the file is overwritten with zeros and
/// removed (`enroll_now` does it) and `config.json` is written from the reply.
fn enroll(
    layout: &MacLayout,
    options: &Options,
    identity: &Identity,
) -> Result<ServiceConfig, PrepareError> {
    let keys = ia_agent::tokencheck::compiled_keys();
    let (path, text, cfg) =
        match ia_service::enrollclient::read_config(&enroll_candidates(layout, options), &keys) {
            Ok(v) => v,
            Err(ia_service::enrollclient::EnrollError::NoConfig) => {
                return Err(PrepareError::NotEnrolled)
            }
            Err(e) => return Err(PrepareError::Fatal(format!("{e}"))),
        };
    let host = facts::hostname();
    let machine = facts::machine(
        &host,
        &facts::os_version(),
        &facts::hw_fingerprint(&facts::platform_uuid(), &host, facts::arch()),
        facts::capabilities(1, false, ia_service::version()),
        None,
        ia_service::macos::facts_nobody(),
    );
    let reply = ia_service::enrollclient::enroll_now(
        &cfg.api_origin,
        identity,
        &path,
        &text,
        &cfg,
        machine,
    )
    .map_err(|e| PrepareError::Fatal(format!("{e}")))?;
    let config = ServiceConfig {
        v: 1,
        api_origin: reply.api_origin.clone(),
        signal_url: reply.signal_url.clone(),
        device_id: Some(reply.device_id.clone()),
        key_id: Some(reply.key_id.clone()),
        region: Some(reply.region.clone()),
        org_id: Some(reply.org_id.clone()),
        waker_opt_out: false,
        amt_proxy_opt_out: true,
    };
    config
        .validate()
        .map_err(|e| PrepareError::Fatal(format!("the enroll reply is not usable: {e}")))?;
    config
        .save(&layout.paths().config())
        .map_err(|e| PrepareError::Fatal(format!("the config could not be saved: {e}")))?;
    Ok(config)
}

fn enroll_once(layout: &MacLayout, options: &Options) -> Result<(), String> {
    layout
        .ensure()
        .map_err(|e| format!("the state directory could not be created: {e}"))?;
    let identity = identity(layout)?;
    if ServiceConfig::load(&layout.paths().config()).is_ok_and(|c| c.is_enrolled()) {
        drop_new_enrollment_files(layout, options);
        return Err("this Mac is already enrolled (re-enrollment is the D §3.7 path)".into());
    }
    match enroll(layout, options, &identity) {
        Ok(_) => Ok(()),
        Err(PrepareError::NotEnrolled) => Err("the enrollment file was not found".into()),
        Err(PrepareError::Fatal(e)) => Err(e),
    }
}

/// An enrolled daemon ignores a new enrollment file and removes it after saying so.
fn drop_new_enrollment_files(layout: &MacLayout, options: &Options) {
    for p in enroll_candidates(layout, options) {
        if p.exists() {
            tracing::warn!(file = %p.display(), "already enrolled; the new enrollment file is removed (re-enrollment is the D §3.7 path)");
            ia_service::enrollclient::shred_config(&p);
        }
    }
}

/// Build the shared state: layout, keys, enrollment, config, outbox, facts.
fn prepare(layout: &MacLayout, options: &Options) -> Result<Arc<MacShared>, PrepareError> {
    layout.ensure().map_err(|e| {
        PrepareError::Fatal(format!("the state directory could not be created: {e}"))
    })?;
    let identity = identity(layout).map_err(PrepareError::Fatal)?;
    tracing::info!(
        protection = if layout.dev_keychain.is_some() {
            "dev-file-keychain"
        } else {
            "system-keychain"
        },
        "the device key protection in force"
    );
    let paths = layout.paths();
    let config = match ServiceConfig::load(&paths.config()) {
        Ok(c) if c.is_enrolled() => {
            drop_new_enrollment_files(layout, options);
            c
        }
        _ => enroll(layout, options, &identity)?,
    };
    let device_id = config.device_id.clone().unwrap_or_default();
    let (outbox, report) =
        ia_service::tamperstore::load(&paths.tamper_log(), &device_id, &identity.public_key());
    if report.kept > 0 || report.forged > 0 {
        tracing::warn!(
            kept = report.kept,
            forged = report.forged,
            "tamper events were waiting to be reported"
        );
    }
    let caps = ia_service::facts::CapabilityFacts {
        monitors: 1,
        waker_opt_out: config.waker_opt_out,
        amt_proxy_opt_out: true,
        amt: None,
        amt_client_built: false,
        input_lock_built: false,
        privacy_screen_built: false,
        ..Default::default()
    };
    Ok(Arc::new(MacShared::new(
        layout.clone(),
        config,
        identity,
        caps,
        outbox,
        Arc::new(|| console_target(sys::console_user().as_ref())),
        Arc::new(|pid| {
            ia_platform::macos::codesign::same_signer_image(pid)
                .map(|p| p.to_string_lossy().into_owned())
        }),
        options.dev_console,
    )))
}

/// Run the daemon until SIGTERM / SIGINT. Returns the process exit code.
fn serve(layout: MacLayout, options: Options) -> i32 {
    let mut waiting_said = false;
    let shared = loop {
        match prepare(&layout, &options) {
            Ok(v) => break v,
            Err(PrepareError::NotEnrolled) => {
                if !waiting_said {
                    tracing::warn!(file = %layout.enroll_config().display(), "this Mac is not enrolled; waiting for the enrollment file");
                    waiting_said = true;
                }
                std::thread::sleep(Duration::from_secs(10));
            }
            Err(PrepareError::Fatal(e)) => {
                tracing::error!(error = %e, "the daemon cannot start");
                eprintln!("{e}");
                return 1;
            }
        }
    };
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!(error = %e, "the runtime could not start");
            return 1;
        }
    };
    let (stop, stop_rx) = tokio::sync::watch::channel(false);
    rt.spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => return,
        };
        tokio::select! {
            _ = term.recv() => tracing::info!("stopping on SIGTERM"),
            _ = tokio::signal::ctrl_c() => tracing::info!("stopping on SIGINT"),
        }
        let _ = stop.send(true);
    });
    tracing::info!(socket = %layout.socket().display(), dev = options.dev_console, "the daemon is running");
    rt.block_on(ia_service::macos::runtime::run(shared, stop_rx));
    // Every loop has returned; give stragglers a bounded moment rather than racing teardown.
    rt.shutdown_timeout(Duration::from_secs(5));
    let _ = std::fs::remove_file(layout.socket());
    0
}

/// D §4.1: the signed deregister (bounded, best effort), then the keys are shredded. Never fails
/// an uninstall.
fn deregister(layout: &MacLayout) {
    let paths = layout.paths();
    let config = ServiceConfig::load(&paths.config()).ok();
    let store = keystore(layout).ok();
    let identity = store.as_ref().and_then(|s| s.load().ok().flatten());
    if let (Some(cfg), Some(id)) = (config.as_ref(), identity.as_ref()) {
        if let Some(device_id) = cfg.device_id.as_deref() {
            match ia_service::devicesock::deregister_body(
                device_id,
                id,
                ia_service::macos::now_ms(),
            ) {
                Ok(body) => {
                    let url = format!(
                        "{}/api/v1/devices/{device_id}/deregister",
                        cfg.api_origin.trim_end_matches('/')
                    );
                    let outcome = ureq::AgentBuilder::new()
                        .timeout(Duration::from_secs(10))
                        .build()
                        .post(&url)
                        .set("content-type", "application/json")
                        .set("x-requested-with", "IndiansAssist")
                        .set("user-agent", &ia_service::user_agent())
                        .send_string(&body.to_string());
                    match outcome {
                        Ok(_) => tracing::info!(device_id, "the device was deregistered"),
                        Err(e) => {
                            tracing::warn!(device_id, error = %e, "the deregister call did not land; the fleet view will show this device as silent")
                        }
                    }
                }
                Err(e) => tracing::warn!(error = ?e, "the deregister body could not be signed"),
            }
        }
    } else {
        tracing::info!("this Mac is not enrolled; nothing to deregister");
    }
    if let Some(store) = store {
        let _ = store.shred();
    }
    let _ = std::fs::remove_file(paths.config());
    tracing::info!("the device keys have been shredded");
}

#[cfg(feature = "dev")]
fn run_console(args: &[String]) {
    let Some(root) = value(args, "--data-dir") else {
        eprintln!(
            "--console needs --data-dir <dir> (everything the dev daemon writes goes there; \
             keep it short: the worker socket's path must fit in 104 bytes)"
        );
        std::process::exit(2);
    };
    let install = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let layout = MacLayout::under(std::path::Path::new(&root), &install);
    if args.iter().any(|a| a == "--deregister") {
        deregister(&layout);
        return;
    }
    let options = Options {
        enroll_file: value(args, "--enroll").map(PathBuf::from),
        dev_console: true,
    };
    tracing::info!(root = %root, "dev console daemon");
    std::process::exit(serve(layout, options));
}
