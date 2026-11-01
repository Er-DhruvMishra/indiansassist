//! The Phase D service seams (`docs/specs/phase-d-contracts.md` §11.1: "`ia-platform` gains
//! traits `ServiceHost`, `DesktopBridge`, `Waker`, `Amt`, `SecretInjector` so the Phase E
//! macOS/Linux daemons fill the same seam").
//!
//! Each trait is the *OS boundary only*. Every decision that can be made without touching the
//! OS — which desktop to target, whether to restart a service, what a magic packet looks like,
//! how a secret is masked — is a pure function in `ia-session0`, `ia-waker` or `ia-vault`, so
//! it is unit-tested with a table instead of a machine. That split is what lets the service be
//! tested at all: nothing here is called in an automated run (§15.2 "no test calls
//! `CreateProcessAsUser`, `SendSAS`, `BlockInput`, a real AMT host").

use std::path::{Path, PathBuf};
use std::time::Duration;

use ia_core::fleet::{AmtBootTarget, AmtInventory, InteractiveState, LanSegment};
use zeroize::Zeroizing;

/// What the SCM reports for a service (§10.1: the watchdog's input).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    Running,
    StartPending,
    StopPending,
    Stopped,
    /// Installed but its start type is `SERVICE_DISABLED`.
    Disabled,
    /// No such service: the binary or its registration was removed.
    Missing,
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("access denied (the caller is not SYSTEM or an administrator)")]
    AccessDenied,
    #[error("no such service: {0}")]
    NotFound(String),
    #[error("the service control manager refused: {0}")]
    Refused(String),
    #[error("os error: {0}")]
    Os(String),
}

/// §4.1: the service's own lifecycle, and the control it has over itself and the watchdog.
/// Implemented over `windows-service` + `ChangeServiceConfig2` in `ia-service`.
pub trait ServiceHost: Send + Sync {
    /// Tell the SCM the service is up (so a slow start is not killed as hung).
    fn report_running(&self) -> Result<(), ServiceError>;
    /// Tell the SCM the service is stopping, with the exit code it should record.
    fn report_stopped(&self, exit_code: u32) -> Result<(), ServiceError>;
    /// §4.1: restart after 5 s / 10 s / 60 s. Applied by the service itself, because the MSI
    /// `MsiServiceConfig*` tables are not reliable (`packaging/README.md`).
    fn set_failure_actions(&self, name: &str, delays: &[Duration]) -> Result<(), ServiceError>;
    /// The state of another service (the watchdog asks about the agent, and the agent about
    /// the watchdog).
    fn query_state(&self, name: &str) -> Result<ServiceState, ServiceError>;
    /// One restart attempt (§10.1); never a loop — the caller decides whether to try again.
    fn start(&self, name: &str) -> Result<(), ServiceError>;
    /// Re-enable a service whose start type was set to disabled (§10.1 `disabled` cause).
    fn set_auto_start(&self, name: &str) -> Result<(), ServiceError>;
    /// Register (or re-register) the §10.1 scheduled task from the installed XML.
    fn register_task(&self, name: &str, xml: &Path) -> Result<(), ServiceError>;
    /// Whether the §10.1 scheduled task is present.
    fn task_exists(&self, name: &str) -> Result<bool, ServiceError>;
}

/// Which desktop the worker must be launched onto (§5.3), decided by
/// `ia_session0::select_desktop` and performed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopTarget {
    /// `WinSta0\Default` of the console session, as that session's user.
    ConsoleDefault { session_id: u32 },
    /// `WinSta0\Winlogon`: the secure desktop of a logged-on user (UAC, lock, Ctrl+Alt+Del).
    SecureDesktop,
    /// `WinSta0\Winlogon` with nobody logged on: the logon screen (pre-login access).
    LogonScreen,
}

impl DesktopTarget {
    /// The desktop's Win32 name, for logs and for `SetThreadDesktop`.
    pub fn desktop_name(self) -> &'static str {
        match self {
            DesktopTarget::ConsoleDefault { .. } => "Default",
            DesktopTarget::SecureDesktop | DesktopTarget::LogonScreen => "Winlogon",
        }
    }
    /// Whether frames and input on this target are secure-desktop surfaces (rule 5.1c gates).
    pub fn is_secure_surface(self) -> bool {
        !matches!(self, DesktopTarget::ConsoleDefault { .. })
    }
}

/// A worker the service launched: enough to supervise and verify it (§4.2 pid / image check).
#[derive(Debug, Clone)]
pub struct LaunchedWorker {
    pub pid: u32,
    pub session_id: u32,
    pub target: DesktopTarget,
    pub image: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum DesktopError {
    #[error("no console session is active")]
    NoConsoleSession,
    #[error("the console user token could not be obtained")]
    NoUserToken,
    #[error("the desktop could not be opened: {0}")]
    Desktop(String),
    #[error("the worker could not be launched: {0}")]
    Launch(String),
    #[error("os error: {0}")]
    Os(String),
}

/// §5.3 and §4.2: session and desktop facts, and launching the worker onto the right one.
pub trait DesktopBridge: Send + Sync {
    /// §3.4 `InteractiveState` for the console session, as reported in `device.hello` and on
    /// every `WTS_SESSION_*` change.
    fn interactive_state(&self) -> Result<InteractiveState, DesktopError>;
    /// The console session id, or `None` when nobody is logged on there.
    fn console_session_id(&self) -> Option<u32>;
    /// Whether the current input desktop is the secure one (a UAC prompt or the lock screen is
    /// up). Feeds the §5.3 re-evaluation.
    fn secure_desktop_is_input(&self) -> bool;
    /// Launch `ia-desktop` onto `target`, passing it the pipe-name suffix. The blob itself
    /// goes over the pipe, never the command line (§4.2).
    fn launch_worker(
        &self,
        image: &Path,
        pipe_suffix: &str,
        target: DesktopTarget,
    ) -> Result<LaunchedWorker, DesktopError>;
    /// Stop a worker (a desktop switch, session end, or a worker that went silent).
    fn terminate_worker(&self, worker: &LaunchedWorker) -> Result<(), DesktopError>;
    /// Whether the launched process is still alive (supervision).
    fn worker_alive(&self, worker: &LaunchedWorker) -> bool;
}

#[derive(Debug, thiserror::Error)]
pub enum WakerError {
    #[error("the socket could not be opened or bound: {0}")]
    Socket(String),
    #[error("the packet could not be sent: {0}")]
    Send(String),
    #[error("no usable network interface")]
    NoInterface,
}

/// §8.2: this device acting as a LAN waker for its segment, and reporting the facts the
/// server elects wakers by.
pub trait Waker: Send + Sync {
    /// Send the 102-byte magic packet to the broadcast address of every usable interface
    /// (rule 8.2b). The MAC arrives sealed and is opened by the caller, never stored.
    fn send_magic_packet(&self, packet: &[u8]) -> Result<(), WakerError>;
    /// Rule 8.2a: the org-salted segment hashes. Raw addresses never leave the device.
    fn lan_segment(&self, org_id: &str) -> Result<LanSegment, WakerError>;
    /// This machine's own wake MAC (hex12), for `device.hello`; `None` when there is no
    /// wake-capable NIC.
    fn own_wake_mac(&self) -> Option<String>;
}

/// An AMT command this device proxies for another (rule 8.4b). The credential arrives sealed
/// and lives only for the call.
#[derive(Debug, Clone)]
pub struct AmtRequest<'a> {
    pub host: &'a str,
    pub tls: bool,
    pub user: &'a str,
    pub password: Zeroizing<String>,
    pub op: AmtProxyOp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmtProxyOp {
    PowerOn,
    BootRedirect { target: AmtBootTarget },
    SolOpen,
    SolClose,
}

/// What the proxy reports back in `amt.result` (rule 8.4b).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmtOutcome {
    pub ok: bool,
    /// One of `amt_unreachable`, `auth_failed`, `unsupported`, `tls_failed`.
    pub error: Option<String>,
    pub power_state: Option<i32>,
}

#[derive(Debug, thiserror::Error)]
pub enum AmtError {
    #[error("the AMT host could not be reached: {0}")]
    Unreachable(String),
    #[error("AMT refused the credentials")]
    AuthFailed,
    #[error("AMT does not support this operation")]
    Unsupported,
    #[error("the TLS connection to AMT failed: {0}")]
    TlsFailed(String),
}

/// Rule 8.4: the local AMT inventory, and the WS-Management client used when this device is
/// the elected AMT proxy for a segment.
pub trait Amt: Send + Sync {
    /// What this machine can see of its own AMT (`present`, `provisioned`, version, host).
    fn inventory(&self) -> AmtInventory;
    /// Perform one command against another machine's AMT.
    fn command(&self, req: &AmtRequest<'_>) -> Result<AmtOutcome, AmtError>;
}

/// Rule 9.8: the **injection** side of a vault secret. The device holds no vault credential
/// and makes no vault call; it opens what the server sealed to it, places it in one child
/// process's environment, wipes it, and masks it in anything captured.
pub trait SecretInjector: Send + Sync {
    /// The environment pairs to give the child. The values are wiped when the returned guard
    /// is dropped, which the caller does immediately after the spawn.
    fn environment(&self) -> Vec<(String, Zeroizing<String>)>;
    /// Replace every exact secret value in captured output before it is reported or logged.
    fn mask(&self, text: &str) -> String;
    /// Wipe every held secret now (after the spawn, and on any failure path).
    fn wipe(&mut self);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_target_names_its_desktop_and_knows_which_are_secure() {
        assert_eq!(
            DesktopTarget::ConsoleDefault { session_id: 1 }.desktop_name(),
            "Default"
        );
        assert_eq!(DesktopTarget::SecureDesktop.desktop_name(), "Winlogon");
        assert_eq!(DesktopTarget::LogonScreen.desktop_name(), "Winlogon");
        assert!(!DesktopTarget::ConsoleDefault { session_id: 1 }.is_secure_surface());
        assert!(DesktopTarget::SecureDesktop.is_secure_surface());
        assert!(DesktopTarget::LogonScreen.is_secure_surface());
    }
}
