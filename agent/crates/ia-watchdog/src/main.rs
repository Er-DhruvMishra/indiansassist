//! `ia-watchdog.exe` (§10.1): the second service, and the one-shot the scheduled task runs.
//!
//! Both do the same thing, which is the point of having two: look at `IndiansAssistAgent`,
//! decide with [`ia_watchdog::decide`], act, and record a signed tamper event. If an attacker
//! stops the service, the watchdog restarts it and records why; if they stop the watchdog too,
//! the scheduled task runs the same check five minutes later; if they remove that as well, the
//! service re-registers it. Each of those is a visible event on the device's tamper chain.
//!
//! What it will not do is restart a binary that no longer matches the installed manifest
//! (§10.3): that would be the watchdog helpfully running somebody else's code.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use ia_platform::{ServiceHost, ServiceState};
use ia_service::config::InstallManifest;
use ia_service::identity::{DpapiSealer, Identity};
use ia_service::paths::Paths;
use ia_watchdog::{decide, restarted_cause, Observation, Verdict, AGENT_SERVICE, WATCHDOG_TASK};

fn main() {
    harden_dll_search();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_ansi(false)
        .try_init();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "ia-watchdog.exe - the IndiansAssist watchdog (Phase D section 10.1)\n\n\
             Run with no arguments by the service control manager, or:\n\
             \x20 --task     one check, as the scheduled task runs it\n\
             \x20 --version  print the version\n"
        );
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("ia-watchdog {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|a| a == "--task") {
        let verdict = check_once();
        tracing::info!(?verdict, "the scheduled check finished");
        return;
    }
    if let Err(e) = service::run() {
        tracing::error!(error = %e, "the watchdog service dispatcher failed");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn harden_dll_search() {
    use windows::core::w;
    use windows::Win32::System::LibraryLoader::{
        SetDefaultDllDirectories, SetDllDirectoryW, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    // SAFETY: process-wide loader flags and a NUL-terminated wide string (C §14).
    unsafe {
        let _ = SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
        let _ = SetDllDirectoryW(w!(""));
    }
}

#[cfg(not(windows))]
fn harden_dll_search() {}

/// The restart budget, kept beside the service's own state so both processes see the same
/// history (§10.1: at most three attempts in half an hour, then it is a person's problem).
mod budget {
    use super::*;

    fn path(paths: &Paths) -> PathBuf {
        paths.root().join("watchdog.json")
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// Restart attempts inside the window.
    pub fn attempts(paths: &Paths) -> u32 {
        let Ok(text) = std::fs::read_to_string(path(paths)) else {
            return 0;
        };
        let stamps: Vec<u64> = serde_json::from_str(&text).unwrap_or_default();
        let cutoff = now().saturating_sub(ia_watchdog::RESTART_WINDOW_SEC);
        stamps.into_iter().filter(|t| *t >= cutoff).count() as u32
    }

    /// Record one attempt.
    pub fn note(paths: &Paths) {
        let p = path(paths);
        let mut stamps: Vec<u64> = std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let cutoff = now().saturating_sub(ia_watchdog::RESTART_WINDOW_SEC);
        stamps.retain(|t| *t >= cutoff);
        stamps.push(now());
        let _ = std::fs::write(&p, serde_json::to_string(&stamps).unwrap_or_default());
    }
}

/// One check: observe, decide, act, record.
fn check_once() -> Verdict {
    let paths = Paths::program_data();
    let host = ia_service::win::scm::WinServiceHost::new(
        windows_service::service::ServiceControlAccept::STOP
            | windows_service::service::ServiceControlAccept::SHUTDOWN,
    );
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| paths.root().to_path_buf());
    let manifest = InstallManifest::load(&paths.manifest()).ok();
    let (binaries_ok, summary) = match &manifest {
        Some(m) => {
            let report = ia_service::tamperstore::check_binaries(&install_dir, m);
            (report.binaries_ok(), report.summary())
        }
        // No manifest means a development run or a broken install; the watchdog says so and
        // does not claim tampering it cannot see.
        None => (true, "no manifest.json".to_string()),
    };
    let config_ok = manifest
        .as_ref()
        .map(|m| config_unchanged(&paths, m))
        .unwrap_or(true);
    let observation = Observation {
        agent: host
            .query_state(AGENT_SERVICE)
            .unwrap_or(ServiceState::Missing),
        binaries_ok,
        config_ok,
        task_registered: host.task_exists(WATCHDOG_TASK).unwrap_or(true),
        restarts_in_window: budget::attempts(&paths),
    };
    let verdict = decide(&observation);
    tracing::info!(?observation, ?verdict, "watchdog check");
    act(&paths, &host, &install_dir, &verdict, &summary);
    verdict
}

/// §10.4: `config.json` and the manifest hash against what was last seen. The record is kept
/// beside them, so an edited config is noticed even if the service never started afterwards.
fn config_unchanged(paths: &Paths, manifest: &InstallManifest) -> bool {
    let stamp = paths.root().join("state.sha256");
    let current = {
        let config = ia_service::config::file_digest(&paths.config()).unwrap_or_default();
        format!("{}:{}", config, manifest.digest())
    };
    match std::fs::read_to_string(&stamp) {
        Ok(previous) if previous.trim() == current => true,
        Ok(_) => {
            let _ = std::fs::write(&stamp, &current);
            false
        }
        // First run: record what is there now rather than crying tamper about a fresh install.
        Err(_) => {
            let _ = std::fs::write(&stamp, &current);
            true
        }
    }
}

fn act(
    paths: &Paths,
    host: &dyn ServiceHost,
    install_dir: &std::path::Path,
    verdict: &Verdict,
    summary: &str,
) {
    let _ = install_dir;
    match verdict {
        Verdict::Healthy => {}
        Verdict::RegisterTask => {
            let xml = install_dir.join("watchdog-task.xml");
            match host.register_task(WATCHDOG_TASK, &xml) {
                Ok(()) => tracing::info!("the scheduled task was re-registered"),
                Err(e) => {
                    tracing::warn!(error = %e, "the scheduled task could not be re-registered")
                }
            }
        }
        Verdict::RecordOnly { cause, why } => {
            tracing::warn!(cause = cause.as_str(), why, %summary, "recording without restarting");
            record(paths, *cause, Some(&format!("{why}; {summary}")));
        }
        Verdict::Restart { cause }
        | Verdict::EnableThenRestart { cause }
        | Verdict::Reregister { cause } => {
            record(paths, *cause, Some(&format!("{verdict:?}")));
            if matches!(verdict, Verdict::EnableThenRestart { .. }) {
                match host.set_auto_start(AGENT_SERVICE) {
                    Ok(()) => tracing::info!("the service start type was set back to automatic"),
                    Err(e) => tracing::warn!(error = %e, "the start type could not be changed"),
                }
            }
            if matches!(verdict, Verdict::Reregister { .. }) {
                // Re-registering a removed service needs the MSI's own cache; the watchdog
                // records the deletion and asks Windows Installer to repair, which is the
                // documented way back (§10.1 "re-register from the preserved MSI cache").
                tracing::warn!(
                    "the service registration is gone; a repair of the installed package is needed"
                );
            }
            budget::note(paths);
            match host.start(AGENT_SERVICE) {
                Ok(()) => {
                    tracing::info!("the service was restarted");
                    record(
                        paths,
                        restarted_cause(),
                        Some("the watchdog restarted the service"),
                    );
                }
                Err(e) => tracing::warn!(error = %e, "the service could not be restarted"),
            }
        }
    }
}

/// Record a signed tamper event, if this install has an identity to sign with.
fn record(paths: &Paths, cause: ia_core::fleet::TamperCause, detail: Option<&str>) {
    let Some(config) = ia_service::config::ServiceConfig::load(&paths.config()).ok() else {
        tracing::warn!(
            cause = cause.as_str(),
            "no config: the event is only logged"
        );
        return;
    };
    let Some(device_id) = config.device_id else {
        tracing::warn!(
            cause = cause.as_str(),
            "this device has not enrolled: the event is only logged"
        );
        return;
    };
    let entropy = ia_service::win::registry::entropy().unwrap_or_default();
    let sealer = DpapiSealer::new(entropy);
    match Identity::load(&sealer, &paths.identity_key(), &paths.sealing_key()) {
        Ok(Some(identity)) => {
            match ia_service::tamperstore::record(
                &paths.tamper_log(),
                &device_id,
                &identity,
                cause,
                detail,
            ) {
                Ok(e) => {
                    tracing::info!(id = %e.id, cause = cause.as_str(), "tamper event recorded for backfill")
                }
                Err(e) => tracing::error!(error = %e, "the tamper event could not be written"),
            }
        }
        Ok(None) => tracing::warn!("no device key: the event is only logged"),
        Err(e) => {
            tracing::error!(error = %e, "the device key could not be opened; the event is only logged")
        }
    }
}

/// The SCM side of the watchdog.
mod service {
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    use ia_watchdog::{CHECK_INTERVAL_SEC, WATCHDOG_SERVICE};

    define_windows_service!(ffi_service_main, service_main);

    pub fn run() -> Result<(), String> {
        service_dispatcher::start(WATCHDOG_SERVICE, ffi_service_main).map_err(|e| e.to_string())
    }

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = serve() {
            tracing::error!(error = %e, "the watchdog stopped with an error");
        }
    }

    fn serve() -> Result<(), String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_handler = stop.clone();
        let handler = move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                stop_for_handler.store(true, Ordering::SeqCst);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let handle = service_control_handler::register(WATCHDOG_SERVICE, handler)
            .map_err(|e| e.to_string())?;
        let report = |state: ServiceState| {
            let _ = handle.set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: state,
                controls_accepted: if state == ServiceState::Running {
                    ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
                } else {
                    ServiceControlAccept::empty()
                },
                exit_code: ServiceExitCode::Win32(0),
                checkpoint: 0,
                wait_hint: Duration::from_secs(10),
                process_id: None,
            });
        };
        report(ServiceState::Running);
        // The watchdog only watches: it holds no socket, no key in memory between checks, and
        // nothing a technician can drive.
        while !stop.load(Ordering::SeqCst) {
            super::check_once();
            for _ in 0..CHECK_INTERVAL_SEC {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        report(ServiceState::Stopped);
        Ok(())
    }
}
