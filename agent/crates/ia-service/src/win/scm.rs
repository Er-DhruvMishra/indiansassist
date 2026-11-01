//! The service control manager side (§4.1, §10.1): reporting state, the failure actions, and
//! what the watchdog needs to query, start, re-enable and re-register.
//!
//! The failure actions (restart after 5 s / 10 s / 60 s) are applied **by the service itself**
//! rather than by the MSI, because Microsoft documents the MSI `MsiServiceConfig*` tables as
//! unreliable — `packaging/README.md` records that as something this stream owes, and this is
//! where it is paid.

use std::ffi::OsString;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use ia_platform::{ServiceError, ServiceHost, ServiceState};
use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceErrorControl, ServiceExitCode,
    ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType,
    ServiceState as WsState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::ServiceStatusHandle;
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::SERVICE_NAME;

/// The §4.1 failure actions.
pub fn failure_delays() -> [Duration; 3] {
    [
        Duration::from_secs(5),
        Duration::from_secs(10),
        Duration::from_secs(60),
    ]
}

/// The real [`ServiceHost`].
pub struct WinServiceHost {
    /// Set once the SCM has given us a status handle (absent in a `--console` run).
    status: Mutex<Option<ServiceStatusHandle>>,
    /// The controls the service accepts, so every status report is consistent.
    accepted: windows_service::service::ServiceControlAccept,
}

impl WinServiceHost {
    pub fn new(accepted: windows_service::service::ServiceControlAccept) -> Self {
        Self {
            status: Mutex::new(None),
            accepted,
        }
    }

    pub fn set_status_handle(&self, handle: ServiceStatusHandle) {
        if let Ok(mut g) = self.status.lock() {
            *g = Some(handle);
        }
    }

    fn report(&self, state: WsState, exit: ServiceExitCode) -> Result<(), ServiceError> {
        let g = self
            .status
            .lock()
            .map_err(|_| ServiceError::Os("status lock".into()))?;
        let Some(h) = g.as_ref() else {
            // A console run has no SCM to report to; that is not an error.
            return Ok(());
        };
        h.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == WsState::Running {
                self.accepted
            } else {
                windows_service::service::ServiceControlAccept::empty()
            },
            exit_code: exit,
            checkpoint: 0,
            wait_hint: Duration::from_secs(10),
            process_id: None,
        })
        .map_err(|e| ServiceError::Refused(e.to_string()))
    }
}

fn manager(access: ServiceManagerAccess) -> Result<ServiceManager, ServiceError> {
    ServiceManager::local_computer(None::<&str>, access).map_err(|e| {
        let text = e.to_string();
        if text.contains("denied") {
            ServiceError::AccessDenied
        } else {
            ServiceError::Os(text)
        }
    })
}

fn map_state(s: WsState, start_type_disabled: bool) -> ServiceState {
    if start_type_disabled && s == WsState::Stopped {
        return ServiceState::Disabled;
    }
    match s {
        WsState::Running | WsState::ContinuePending => ServiceState::Running,
        WsState::StartPending => ServiceState::StartPending,
        WsState::StopPending | WsState::PausePending | WsState::Paused => ServiceState::StopPending,
        WsState::Stopped => ServiceState::Stopped,
    }
}

impl ServiceHost for WinServiceHost {
    fn report_running(&self) -> Result<(), ServiceError> {
        self.report(WsState::Running, ServiceExitCode::Win32(0))
    }

    fn report_stopped(&self, exit_code: u32) -> Result<(), ServiceError> {
        self.report(WsState::Stopped, ServiceExitCode::Win32(exit_code))
    }

    fn set_failure_actions(&self, name: &str, delays: &[Duration]) -> Result<(), ServiceError> {
        let m = manager(ServiceManagerAccess::CONNECT)?;
        let svc = m
            .open_service(name, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
            .map_err(|_| ServiceError::NotFound(name.to_string()))?;
        let actions = ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
            reboot_msg: None,
            command: None,
            actions: Some(
                delays
                    .iter()
                    .map(|d| ServiceAction {
                        action_type: ServiceActionType::Restart,
                        delay: *d,
                    })
                    .collect(),
            ),
        };
        svc.update_failure_actions(actions)
            .map_err(|e| ServiceError::Refused(e.to_string()))?;
        // Restart on a non-zero exit as well as on a crash: a service that exits because it
        // cannot reach its config should come back when the config is fixed.
        svc.set_failure_actions_on_non_crash_failures(true)
            .map_err(|e| ServiceError::Refused(e.to_string()))
    }

    fn query_state(&self, name: &str) -> Result<ServiceState, ServiceError> {
        let m = manager(ServiceManagerAccess::CONNECT)?;
        let svc = match m.open_service(
            name,
            ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG,
        ) {
            Ok(s) => s,
            // The distinction the watchdog acts on: a service that is not registered at all.
            Err(_) => return Ok(ServiceState::Missing),
        };
        let disabled = svc
            .query_config()
            .map(|c| c.start_type == ServiceStartType::Disabled)
            .unwrap_or(false);
        let status = svc
            .query_status()
            .map_err(|e| ServiceError::Refused(e.to_string()))?;
        Ok(map_state(status.current_state, disabled))
    }

    fn start(&self, name: &str) -> Result<(), ServiceError> {
        let m = manager(ServiceManagerAccess::CONNECT)?;
        let svc = m
            .open_service(name, ServiceAccess::START | ServiceAccess::QUERY_STATUS)
            .map_err(|_| ServiceError::NotFound(name.to_string()))?;
        svc.start(&[] as &[&OsString])
            .map_err(|e| ServiceError::Refused(e.to_string()))
    }

    fn set_auto_start(&self, name: &str) -> Result<(), ServiceError> {
        let m = manager(ServiceManagerAccess::CONNECT)?;
        let svc = m
            .open_service(
                name,
                ServiceAccess::CHANGE_CONFIG | ServiceAccess::QUERY_CONFIG,
            )
            .map_err(|_| ServiceError::NotFound(name.to_string()))?;
        let mut config = svc
            .query_config()
            .map_err(|e| ServiceError::Refused(e.to_string()))?;
        // §4.1: auto-start, and **not** delayed — the service must be up before the logon
        // screen for pre-login access to exist at all.
        let info = ServiceInfo {
            name: OsString::from(name),
            display_name: config.display_name.clone(),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: std::mem::take(&mut config.executable_path),
            launch_arguments: vec![],
            dependencies: vec![],
            account_name: None, // LocalSystem
            account_password: None,
        };
        svc.change_config(&info)
            .map_err(|e| ServiceError::Refused(e.to_string()))?;
        svc.set_delayed_auto_start(false)
            .map_err(|e| ServiceError::Refused(e.to_string()))
    }

    fn register_task(&self, name: &str, xml: &Path) -> Result<(), ServiceError> {
        // `schtasks` is what the MSI uses (`packaging/README.md`), so the service re-registering
        // the task after a removal uses exactly the same path and the same XML.
        let out = std::process::Command::new("schtasks.exe")
            .args(["/Create", "/TN", name, "/XML"])
            .arg(xml)
            .arg("/F")
            .output()
            .map_err(|e| ServiceError::Os(e.to_string()))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(ServiceError::Refused(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ))
        }
    }

    fn task_exists(&self, name: &str) -> Result<bool, ServiceError> {
        let out = std::process::Command::new("schtasks.exe")
            .args(["/Query", "/TN", name])
            .output()
            .map_err(|e| ServiceError::Os(e.to_string()))?;
        Ok(out.status.success())
    }
}

/// Apply the §4.1 failure actions to both services, logging rather than failing: a service that
/// cannot set its own recovery options should still run.
pub fn apply_failure_actions(host: &dyn ServiceHost) {
    for name in [SERVICE_NAME, ia_watchdog_name()] {
        match host.set_failure_actions(name, &failure_delays()) {
            Ok(()) => tracing::info!(
                service = name,
                "failure actions applied (restart 5 s / 10 s / 60 s)"
            ),
            Err(e) => {
                tracing::warn!(service = name, error = %e, "failure actions could not be applied")
            }
        }
    }
}

fn ia_watchdog_name() -> &'static str {
    "IndiansAssistWatchdog"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_failure_ladder_is_the_contract_one() {
        let d = failure_delays();
        assert_eq!(d[0].as_secs(), 5);
        assert_eq!(d[1].as_secs(), 10);
        assert_eq!(d[2].as_secs(), 60);
    }

    #[test]
    fn a_stopped_service_whose_start_type_is_disabled_reads_as_disabled() {
        assert_eq!(map_state(WsState::Stopped, true), ServiceState::Disabled);
        assert_eq!(map_state(WsState::Stopped, false), ServiceState::Stopped);
        assert_eq!(map_state(WsState::Running, false), ServiceState::Running);
        assert_eq!(
            map_state(WsState::StopPending, false),
            ServiceState::StopPending
        );
        assert_eq!(
            map_state(WsState::StartPending, false),
            ServiceState::StartPending
        );
    }
}
