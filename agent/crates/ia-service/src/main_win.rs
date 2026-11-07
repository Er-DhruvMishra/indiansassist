//! `ia-service.exe`: the SCM entry point (§4.1). Moved here unchanged from `main.rs` when the
//! binary gained its Linux entry (F §8.2); `main.rs` now only picks the platform's.
//!
//! Three ways in, and no others:
//!
//! * **as a service** (no arguments): the SCM dispatch, the control handler
//!   (`STOP`/`SHUTDOWN`/`SESSIONCHANGE`), the failure actions, then the runtime;
//! * **`--msi-uninstall`**: the signed deregister of §4.1, bounded, then exit — what the MSI
//!   runs before it deletes the files (`packaging/README.md` owed this);
//! * **`--console`** (dev builds): the same runtime in the foreground, so a session can be
//!   driven from a terminal against a local api.
//!
//! The first statement of `main` is the DLL-search hardening of C §14: before any thread or
//! late-bound load, the loader is restricted to System32. A service started from
//! `%ProgramFiles%` is much less exposed than a portable exe in Downloads, but the rule is
//! cheap and applies to all three binaries (§11.3).

use std::sync::{Arc, Mutex};

use ia_service::config::{InstallManifest, ServiceConfig};
use ia_service::identity::{BlobSealer, DpapiSealer, Identity};
use ia_service::paths::Paths;
use ia_service::runtime::Shared;

pub fn main() {
    harden_dll_search();
    let args: Vec<String> = std::env::args().skip(1).collect();

    // `--help` and `--version` answer and leave: they create no directory and write no log, so
    // asking an installed binary what it is cannot change the machine.
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("ia-service {}", ia_service::version());
        return;
    }
    init_tracing();
    if args.iter().any(|a| a == "--msi-uninstall") {
        uninstall();
        return;
    }
    #[cfg(feature = "dev")]
    if args.iter().any(|a| a == "--console") {
        run_console(&args);
        return;
    }
    // No arguments: the SCM is starting us.
    if let Err(e) = service::run() {
        tracing::error!(error = %e, "the service dispatcher failed");
        std::process::exit(1);
    }
}

const HELP: &str = "\
ia-service.exe - the IndiansAssist installed agent (Phase D)

Run with no arguments by the service control manager. Other entry points:
  --msi-uninstall   deregister this device with its identity key, then shred the keys
  --version         print the version
  --help            this text
";

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

/// §4.1: a rotating file log under `%ProgramData%`, with the C §6 redaction rules (nothing
/// sensitive is ever formatted into a log line in the first place — see the `Secret` type).
fn init_tracing() {
    let paths = Paths::program_data();
    let _ = std::fs::create_dir_all(paths.log_dir());
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .try_init();
}

/// Build the shared state: paths, config, identity, manifest, facts. Enrolls if needed.
fn prepare(
    data_dir: Option<&str>,
) -> Result<(Arc<Shared>, tokio::sync::watch::Sender<bool>), String> {
    let paths = match data_dir {
        Some(d) => Paths::at(d),
        None => Paths::program_data(),
    };
    paths
        .ensure()
        .map_err(|e| format!("the data directory could not be created: {e}"))?;
    let mut config = ServiceConfig::load(&paths.config()).map_err(|e| e.to_string())?;
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| paths.root().to_path_buf());
    let manifest = InstallManifest::load(&paths.manifest()).ok();

    let entropy = ia_service::win::registry::entropy().unwrap_or_default();
    let sealer: Box<dyn BlobSealer> = Box::new(DpapiSealer::new(entropy));
    tracing::info!(
        protection = sealer.kind(),
        "the device key protection in force"
    );
    let identity =
        match Identity::load(sealer.as_ref(), &paths.identity_key(), &paths.sealing_key())
            .map_err(|e| format!("the device keys could not be opened on this machine: {e}"))?
        {
            Some(id) => id,
            None => {
                let fresh = Identity::generate();
                fresh
                    .store(sealer.as_ref(), &paths.identity_key(), &paths.sealing_key())
                    .map_err(|e| format!("the device keys could not be stored: {e}"))?;
                tracing::info!(key_id = %fresh.key_id(), "a device identity was generated");
                fresh
            }
        };

    let facts = ia_service::facts::CapabilityFacts {
        monitors: 1,
        waker_opt_out: config.waker_opt_out,
        amt_proxy_opt_out: config.amt_proxy_opt_out,
        amt: None,
        ..Default::default()
    };

    if !config.is_enrolled() {
        let candidates = ia_service::enrollclient::config_candidates(&install_dir, paths.root());
        let keys = ia_agent::tokencheck::compiled_keys();
        let (path, text, cfg) = ia_service::enrollclient::read_config(&candidates, &keys)
            .map_err(|e| format!("{e}"))?;
        let machine = ia_service::enrollclient::machine_facts(
            &ia_service::win::facts::computer_name(),
            &ia_service::win::facts::os_version(),
            ia_service::win::facts::arch(),
            &ia_service::win::facts::hw_fingerprint(),
            &facts,
            ia_service::netstate::segment_and_mac("").1,
            ia_session0::derive_interactive(&ia_service::netstate::read_facts()),
        );
        let reply = ia_service::enrollclient::enroll_now(
            &cfg.api_origin,
            &identity,
            &path,
            &text,
            &cfg,
            machine,
        )
        .map_err(|e| format!("{e}"))?;
        config.device_id = Some(reply.device_id.clone());
        config.key_id = Some(reply.key_id.clone());
        config.region = Some(reply.region.clone());
        config.org_id = Some(reply.org_id.clone());
        config
            .save(&paths.config())
            .map_err(|e| format!("the config could not be saved: {e}"))?;
    }

    let interactive = ia_session0::derive_interactive(&ia_service::netstate::read_facts());
    let (outbox, report) = match config.device_id.as_deref() {
        Some(id) => ia_service::tamperstore::load(&paths.tamper_log(), id, &identity.public_key()),
        None => Default::default(),
    };
    if report.kept > 0 || report.forged > 0 {
        tracing::warn!(
            kept = report.kept,
            forged = report.forged,
            malformed = report.malformed,
            "tamper events were waiting to be reported"
        );
    }
    let bridge: Arc<dyn ia_platform::DesktopBridge> = Arc::new(
        ia_session0::win::Session0Bridge::new(install_dir.join(ia_service::WORKER_EXE)),
    );
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (stop_tx, _) = tokio::sync::watch::channel(false);
    let shared = Arc::new(Shared {
        paths,
        config: Mutex::new(config),
        identity,
        manifest,
        install_dir,
        facts: Mutex::new(facts),
        policy: Mutex::new(Default::default()),
        outbox: Mutex::new(outbox),
        interactive: Mutex::new(interactive),
        playbooks: Mutex::new(Vec::new()),
        session: Mutex::new(None),
        bridge,
        out: Mutex::new(tx),
        worker_extra_args: Vec::new(),
    });
    Ok((shared, stop_tx))
}

/// §4.1 uninstall: the signed deregister, then the key blobs.
fn uninstall() {
    let paths = Paths::program_data();
    let config = ServiceConfig::load(&paths.config()).ok();
    let entropy = ia_service::win::registry::entropy().unwrap_or_default();
    let sealer = DpapiSealer::new(entropy);
    let identity = Identity::load(&sealer, &paths.identity_key(), &paths.sealing_key())
        .ok()
        .flatten();
    if let (Some(cfg), Some(id)) = (config.as_ref(), identity.as_ref()) {
        if let Some(device_id) = cfg.device_id.as_deref() {
            match ia_service::devicesock::deregister_body(
                device_id,
                id,
                ia_service::runtime::now_ms(),
            ) {
                Ok(body) => {
                    let url = format!(
                        "{}/api/v1/devices/{device_id}/deregister",
                        cfg.api_origin.trim_end_matches('/')
                    );
                    // Best effort and bounded: an uninstall must not hang because the server is
                    // unreachable. §10.2's silent-past-grace rule means the fleet still shows
                    // the machine honestly if this call never lands.
                    let outcome = ia_waker::https::agent(std::time::Duration::from_secs(10))
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
    }
    let _ = Identity::shred(&paths.identity_key(), &paths.sealing_key());
    tracing::info!("the device keys have been shredded");
}

#[cfg(feature = "dev")]
fn run_console(args: &[String]) {
    let data_dir = args
        .iter()
        .position(|a| a == "--data-dir")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let (shared, stop) = match prepare(data_dir.as_deref()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    ia_service::session::note_unclean_stop(&shared);
    let stop_rx = stop.subscribe();
    let shared_for_ctrlc = shared.clone();
    rt.spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("stopping on Ctrl+C");
        let _ = stop.send(true);
        ia_service::session::note_clean_stop(&shared_for_ctrlc);
    });
    rt.block_on(ia_service::runtime::run(shared, stop_rx));
}

/// The SCM side (§4.1).
mod service {
    use std::ffi::OsString;
    use std::sync::Arc;
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceState, ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    use ia_service::win::scm::WinServiceHost;
    use ia_service::SERVICE_NAME;

    define_windows_service!(ffi_service_main, service_main);

    pub fn run() -> Result<(), String> {
        service_dispatcher::start(SERVICE_NAME, ffi_service_main).map_err(|e| e.to_string())
    }

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = serve() {
            tracing::error!(error = %e, "the service stopped with an error");
        }
    }

    fn serve() -> Result<(), String> {
        // §4.1: the service accepts stop, shutdown and session changes. `SESSIONCHANGE` is what
        // drives §5.3 (and the 2 s poll is the belt to its braces).
        let accepted = ServiceControlAccept::STOP
            | ServiceControlAccept::SHUTDOWN
            | ServiceControlAccept::SESSION_CHANGE;
        let host = Arc::new(WinServiceHost::new(accepted));
        let (shared, stop) = super::prepare(None)?;
        let stop_for_handler = stop.clone();
        let handler = move |control| -> ServiceControlHandlerResult {
            match control {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    let _ = stop_for_handler.send(true);
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::SessionChange(_) => {
                    // The session watcher re-reads the facts within two seconds either way; the
                    // notification just makes it prompt.
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };
        let status_handle = service_control_handler::register(SERVICE_NAME, handler)
            .map_err(|e| format!("the control handler could not be registered: {e}"))?;
        host.set_status_handle(status_handle);
        let report = |state: ServiceState, exit: u32| {
            let _ = status_handle.set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: state,
                controls_accepted: if state == ServiceState::Running {
                    accepted
                } else {
                    ServiceControlAccept::empty()
                },
                exit_code: windows_service::service::ServiceExitCode::Win32(exit),
                checkpoint: 0,
                wait_hint: Duration::from_secs(10),
                process_id: None,
            });
        };
        report(ServiceState::Running, 0);
        ia_service::win::scm::apply_failure_actions(host.as_ref());
        ia_service::session::note_unclean_stop(&shared);

        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        rt.block_on(ia_service::runtime::run(shared.clone(), stop.subscribe()));
        ia_service::session::note_clean_stop(&shared);
        report(ServiceState::Stopped, 0);
        Ok(())
    }
}
