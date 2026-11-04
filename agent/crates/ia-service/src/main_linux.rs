//! `ia-service` on Linux (F §8.2): the systemd entry point.
//!
//! * **no arguments**: the service, run by systemd as root (`indiansassist-agent.service`,
//!   `Type=notify`). It loads (or creates) the device keys, enrolls once if
//!   `/etc/indiansassist/enroll.iaconfig` is there (§8.3c), sends `READY=1`, and runs the loops.
//!   An unenrolled service with no enrollment file waits for one, pinging the watchdog, rather
//!   than failing and being restarted every five seconds;
//! * **`--enroll <file>`**: run the D §3.1 sequence with that file now, shred it, and exit;
//! * **`--deregister`**: the signed deregister of D §4.1 bounded to 10 s, then shred the keys.
//!   It always exits 0: an offline host, an unreachable api or an unenrolled device must never fail
//!   a package removal (§8.9);
//! * **`--console`** (`dev` feature only, never in a release build): the same service in the
//!   foreground as the **current user**, everything under `--data-dir`, with `--runtime-dir`,
//!   `--session-bus <address|none>`, `--system-bus <address>` (the logind fake) and
//!   `--display <:n>` (the harness display), and `--home <dir>` (the worker's `HOME` and working
//!   directory), so an end-to-end run names no real runtime directory, session bus, system bus,
//!   display or home (S3). `--worker-arg <arg>` (repeatable) is
//!   passed to the worker (`--synthetic-capture`, `--no-self-delete`);
//! * `--version`, `--help`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ia_platform::linux::service::{sys, NOTIFY_READY, NOTIFY_WATCHDOG};
use ia_service::config::{InstallManifest, ServiceConfig};
use ia_service::identity::Identity;
use ia_service::linux::paths::LinuxLayout;
use ia_service::linux::runtime::{nobody, LinuxShared};
use ia_service::linux::sealer::{load_identity, store_identity, SealerContext};
use ia_service::linux::spawn::DevOverrides;

const HELP: &str = "\
ia-service - the IndiansAssist agent service for Linux (indiansassist-agent.service)

Run with no arguments by systemd, as root. Other entry points:
  --enroll <file>   enroll this device now with a signed enroll.iaconfig, then shred the file
  --deregister      deregister this device with its identity key, then shred the keys
  --version         print the version
  --help            this text

The enrollment file may also be placed at /etc/indiansassist/enroll.iaconfig (mode 0600);
the service enrolls with it at its next start and removes it.
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
    let dev_console = args.iter().any(|a| a == "--console");
    if dev_console {
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
    let layout = LinuxLayout::system();
    if args.iter().any(|a| a == "--deregister") {
        deregister(&layout, &SealerContext::current(false));
        return;
    }
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } != 0 {
        eprintln!(
            "ia-service runs as root under systemd (indiansassist-agent.service); \
             use `systemctl start indiansassist-agent`."
        );
        std::process::exit(1);
    }
    let options = Options {
        enroll_file: value(&args, "--enroll").map(PathBuf::from),
        dev_console: false,
        dev: DevOverrides::default(),
        worker_args: Vec::new(),
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

/// The journal reads stdout and stderr; no colours, no file (§8.3a).
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

#[cfg(feature = "dev")]
fn values(args: &[String], flag: &str) -> Vec<String> {
    args.windows(2)
        .filter(|w| w[0] == flag)
        .map(|w| w[1].clone())
        .collect()
}

struct Options {
    enroll_file: Option<PathBuf>,
    dev_console: bool,
    dev: DevOverrides,
    worker_args: Vec<String>,
}

enum PrepareError {
    /// Not enrolled and no enrollment file: wait for one.
    NotEnrolled,
    Fatal(String),
}

/// The device keys: loaded under the §8.3b checks, or generated once and stored 0600.
fn identity(layout: &LinuxLayout, ctx: &SealerContext) -> Result<Identity, String> {
    let paths = layout.paths();
    match load_identity(ctx, &paths.identity_key(), &paths.sealing_key())
        .map_err(|e| format!("the device keys could not be opened: {e}"))?
    {
        Some(id) => Ok(id),
        None => {
            let fresh = Identity::generate();
            store_identity(&fresh, &paths.identity_key(), &paths.sealing_key())
                .map_err(|e| format!("the device keys could not be stored: {e}"))?;
            tracing::info!(key_id = %fresh.key_id(), "a device identity was generated");
            Ok(fresh)
        }
    }
}

fn enroll_candidates(layout: &LinuxLayout, options: &Options) -> Vec<PathBuf> {
    let mut c = Vec::new();
    if let Some(f) = &options.enroll_file {
        c.push(f.clone());
    }
    c.push(layout.enroll_config());
    c
}

/// §8.3c: enroll with the first enrollment file found; on success the file is overwritten with
/// zeros and removed (`enroll_now` does it) and `config.json` is written from the reply.
fn enroll(
    layout: &LinuxLayout,
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
    let machine = ia_service::linux::facts::machine(
        &ia_service::linux::facts::hostname(),
        &ia_service::linux::facts::os_version(),
        &ia_service::linux::facts::hw_fingerprint(
            &ia_service::linux::facts::machine_id(),
            &ia_service::linux::facts::hostname(),
            ia_service::linux::facts::arch(),
        ),
        ia_service::linux::facts::capabilities(1, false, ia_service::version()),
        None,
        nobody(),
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
        amt_proxy_opt_out: false,
    };
    config
        .validate()
        .map_err(|e| PrepareError::Fatal(format!("the enroll reply is not usable: {e}")))?;
    config
        .save(&layout.paths().config())
        .map_err(|e| PrepareError::Fatal(format!("the config could not be saved: {e}")))?;
    Ok(config)
}

fn enroll_once(layout: &LinuxLayout, options: &Options) -> Result<(), String> {
    layout
        .ensure()
        .map_err(|e| format!("the state directory could not be created: {e}"))?;
    let ctx = SealerContext::current(options.dev_console);
    let identity = identity(layout, &ctx)?;
    if ServiceConfig::load(&layout.paths().config()).is_ok_and(|c| c.is_enrolled()) {
        drop_new_enrollment_files(layout, options);
        return Err("this device is already enrolled (re-enrollment is the D §3.7 path)".into());
    }
    match enroll(layout, options, &identity) {
        Ok(_) => Ok(()),
        Err(PrepareError::NotEnrolled) => Err("the enrollment file was not found".into()),
        Err(PrepareError::Fatal(e)) => Err(e),
    }
}

/// §8.3c: an enrolled service ignores a new enrollment file and removes it after saying so.
fn drop_new_enrollment_files(layout: &LinuxLayout, options: &Options) {
    for p in enroll_candidates(layout, options) {
        if p.exists() {
            tracing::warn!(file = %p.display(), "already enrolled; the new enrollment file is removed (re-enrollment is the D §3.7 path)");
            ia_service::enrollclient::shred_config(&p);
        }
    }
}

/// Build the shared state: layout, keys, enrollment, config, outbox, facts.
fn prepare(
    layout: &LinuxLayout,
    options: &Options,
) -> Result<(Arc<LinuxShared>, tokio::sync::watch::Sender<bool>), PrepareError> {
    layout.ensure().map_err(|e| {
        PrepareError::Fatal(format!("the state directory could not be created: {e}"))
    })?;
    let ctx = SealerContext::current(options.dev_console);
    let identity = identity(layout, &ctx).map_err(PrepareError::Fatal)?;
    tracing::info!(
        protection = "file-mode-0600",
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
    let facts = ia_service::facts::CapabilityFacts {
        monitors: 1,
        waker_opt_out: config.waker_opt_out,
        amt_proxy_opt_out: true,
        amt: None,
        amt_client_built: false,
        input_lock_built: false,
        privacy_screen_built: false,
        ..Default::default()
    };
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (stop_tx, _) = tokio::sync::watch::channel(false);
    let shared = Arc::new(LinuxShared {
        layout: layout.clone(),
        paths,
        config: Mutex::new(config),
        identity,
        manifest: InstallManifest::load(&layout.manifest()).ok(),
        facts: Mutex::new(facts),
        policy: Mutex::new(Default::default()),
        outbox: Mutex::new(outbox),
        interactive: Mutex::new(nobody()),
        logind: Mutex::new(None),
        playbooks: Mutex::new(Vec::new()),
        session: Mutex::new(None),
        out: Mutex::new(tx),
        worker_extra_args: options.worker_args.clone(),
        dev: options.dev.clone(),
        dev_console: options.dev_console,
    });
    Ok((shared, stop_tx))
}

/// Run the service until SIGTERM / SIGINT. Returns the process exit code: 0 on a stop request
/// in any state (waiting unenrolled, enrolling, running), so systemd's stop is a clean exit.
fn serve(layout: LinuxLayout, options: Options) -> i32 {
    // Before anything that can block: a SIGTERM while waiting unenrolled used to kill the
    // process with the default action (exit status 143).
    if let Err(e) = ia_service::linux::stop::install() {
        tracing::warn!(error = %e, "the stop-signal handler could not be installed");
    }
    let mut waiting_said = false;
    let (shared, stop) = loop {
        if ia_service::linux::stop::requested() {
            tracing::info!(
                signal = ia_service::linux::stop::signal_name(),
                "stopping before the service ran"
            );
            let _ = sys::sd_notify("STOPPING=1");
            return 0;
        }
        match prepare(&layout, &options) {
            Ok(v) => break v,
            Err(PrepareError::NotEnrolled) => {
                if !waiting_said {
                    tracing::warn!(file = %layout.enroll_config().display(), "this device is not enrolled; waiting for the enrollment file");
                    let _ = sys::sd_notify(NOTIFY_READY);
                    let _ = sys::sd_notify(&format!(
                        "STATUS=Waiting for {}",
                        layout.enroll_config().display()
                    ));
                    waiting_said = true;
                }
                let _ = sys::sd_notify(NOTIFY_WATCHDOG);
                // Wakes within 100 ms of a stop request; the loop head then exits 0.
                ia_service::linux::stop::sleep_or_stop(
                    Duration::from_secs(10),
                    Duration::from_millis(100),
                );
            }
            Err(PrepareError::Fatal(e)) => {
                tracing::error!(error = %e, "the service cannot start");
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
    // §8.8: READY=1 once the enrollment state is loaded.
    let _ = sys::sd_notify(NOTIFY_READY);
    let _ = sys::sd_notify("STATUS=Running");
    let stop_rx = stop.subscribe();
    rt.spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).ok();
        let mut int = signal(SignalKind::interrupt()).ok();
        // A stop that arrived after `prepare` but before these streams existed was caught by
        // the early handler; poll it too, so neither path can lose a request.
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                _ = async { term.as_mut()?.recv().await }, if term.is_some() => {
                    tracing::info!("stopping on SIGTERM");
                    break;
                }
                _ = async { int.as_mut()?.recv().await }, if int.is_some() => {
                    tracing::info!("stopping on SIGINT");
                    break;
                }
                _ = tick.tick() => {
                    if ia_service::linux::stop::requested() {
                        tracing::info!(signal = ia_service::linux::stop::signal_name(), "stopping");
                        break;
                    }
                }
            }
        }
        let _ = sys::sd_notify("STOPPING=1");
        let _ = stop.send(true);
    });
    rt.block_on(ia_service::linux::runtime::run(shared, stop_rx));
    // Every loop has returned; give stragglers a bounded moment rather than racing teardown.
    rt.shutdown_timeout(Duration::from_secs(5));
    0
}

/// D §4.1 / F §8.9: the signed deregister (bounded, best effort), then the keys are shredded.
/// Never fails a removal.
fn deregister(layout: &LinuxLayout, ctx: &SealerContext) {
    let paths = layout.paths();
    let config = ServiceConfig::load(&paths.config()).ok();
    let identity = load_identity(ctx, &paths.identity_key(), &paths.sealing_key())
        .ok()
        .flatten();
    if let (Some(cfg), Some(id)) = (config.as_ref(), identity.as_ref()) {
        if let Some(device_id) = cfg.device_id.as_deref() {
            match ia_service::devicesock::deregister_body(
                device_id,
                id,
                ia_service::linux::runtime::now_ms(),
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
        tracing::info!("this device is not enrolled; nothing to deregister");
    }
    let _ = Identity::shred(&paths.identity_key(), &paths.sealing_key());
    let _ = std::fs::remove_file(paths.config());
    tracing::info!("the device keys have been shredded");
}

#[cfg(feature = "dev")]
fn run_console(args: &[String]) {
    let Some(root) = value(args, "--data-dir") else {
        eprintln!(
            "--console needs --data-dir <dir> (everything the dev service writes goes there)"
        );
        std::process::exit(2);
    };
    let install = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let layout = LinuxLayout::under(std::path::Path::new(&root), &install);
    let options = Options {
        enroll_file: value(args, "--enroll").map(PathBuf::from),
        dev_console: true,
        dev: DevOverrides {
            runtime_dir: value(args, "--runtime-dir").map(PathBuf::from),
            session_bus: value(args, "--session-bus"),
            system_bus: value(args, "--system-bus"),
            display: value(args, "--display"),
            home: value(args, "--home").map(PathBuf::from),
        },
        worker_args: values(args, "--worker-arg"),
    };
    if args.iter().any(|a| a == "--deregister") {
        deregister(&layout, &SealerContext::current(true));
        return;
    }
    tracing::info!(root = %root, system_bus = ?options.dev.system_bus, display = ?options.dev.display, "dev console service");
    std::process::exit(serve(layout, options));
}
