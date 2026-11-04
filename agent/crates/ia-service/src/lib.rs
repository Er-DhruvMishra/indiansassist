//! `ia-service`: the installed Windows service of Phase D
//! (`docs/specs/phase-d-contracts.md` §4, §11.1).
//!
//! | Module | Owns |
//! |---|---|
//! | [`paths`] | the `%ProgramData%\IndiansAssist` layout |
//! | [`config`] | `config.json`, `manifest.json`, and the origin rules they must satisfy |
//! | [`identity`] | the device keys, DPAPI-sealed at rest (§3.3) |
//! | [`facts`] | what the device honestly advertises (§3.2, §13.1a) |
//! | [`enrollclient`] | the §3.1 enrollment sequence and its retry policy |
//! | [`tamperstore`] | the §10.2 outbox on disk and the §10.3 integrity check |
//! | [`devicesock`] | the persistent `/signal/device` socket and its dispatch (§3.4) |
//! | [`worker`] | the §4.2 handoff: launching, supervising and serving the desktop worker |
//! | [`actions`] | the offline action queue on the device (§9) |
//! | `win` | DPAPI, the registry entropy blob, the SCM, the machine and network facts, the toast |
//!
//! **What runs where.** The service is `LocalSystem` and holds the device identity, the device
//! socket and the policy. It never captures a screen or injects input: that is the worker's
//! job, in the user's session (or on the secure desktop), and the worker holds no device key —
//! it asks the service to sign (§4.2 `sign_sas`). That split is what lets a session be
//! unattended without handing a session-0 process the ability to be driven by a technician.

pub mod actions;
pub mod config;
pub mod devicesock;
pub mod enrollclient;
pub mod facts;
pub mod identity;
pub mod paths;
pub mod tamperstore;
pub mod worker;

#[cfg(feature = "service")]
pub mod netstate;
#[cfg(feature = "service")]
pub mod runtime;
#[cfg(feature = "service")]
pub mod session;

#[cfg(all(windows, feature = "service"))]
pub mod win;

/// The Linux half (F §8.2–§8.8). The pure parts compile on Linux always; the runtime, the D-Bus
/// clients and the worker launch need the `linux-service` feature. Nothing here builds on
/// Windows, so the Windows gate is untouched.
#[cfg(target_os = "linux")]
pub mod linux;

// apple-owned: begin
/// Phase F §17.3: the macOS LaunchDaemon half (feature `macos-service`, apple stream).
#[cfg(target_os = "macos")]
pub mod macos;
// apple-owned: end

/// The service name the MSI registers and the watchdog watches (§4.1); on Linux the systemd
/// unit, `indiansassist-agent` (F §8.2, §8.8).
#[cfg(not(target_os = "linux"))]
pub const SERVICE_NAME: &str = "IndiansAssistAgent";
/// The systemd unit name (F §8.2, `packaging/linux/indiansassist-agent.service`).
#[cfg(target_os = "linux")]
pub const SERVICE_NAME: &str = "indiansassist-agent";
/// The display name shown in `services.msc`.
pub const SERVICE_DISPLAY_NAME: &str = "IndiansAssist Agent";
/// The watchdog service (§10.1).
pub const WATCHDOG_SERVICE_NAME: &str = "IndiansAssistWatchdog";
/// The worker binary the MSI installs beside the service (§11.3).
pub const WORKER_EXE: &str = "ia-desktop.exe";
/// The heartbeat cadence (§3.4: every 30 s ± 5 s jitter).
pub const HEARTBEAT_SEC: u64 = 30;
/// §10.3: the integrity self-check runs at start and every hour.
pub const INTEGRITY_CHECK_SEC: u64 = 3600;

/// The `User-Agent` every call from the service carries (C §3.1's shape, with the service's
/// own name so a server log can tell a service from a worker).
pub fn user_agent() -> String {
    format!(
        "IndiansAssist-Service/{} ({}; {})",
        env!("CARGO_PKG_VERSION"),
        if cfg!(target_os = "linux") {
            "Linux"
        } else {
            "Windows"
        },
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        }
    )
}

/// The version the service reports.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names the MSI registers (`packaging/windows/IndiansAssist.wxs`) and the watchdog
    /// watches (`ia_watchdog::{AGENT_SERVICE, WATCHDOG_SERVICE}`, asserted equal there, since
    /// that crate is the one that depends on this one).
    #[test]
    fn the_service_names_are_the_ones_the_msi_uses() {
        #[cfg(not(target_os = "linux"))]
        assert_eq!(SERVICE_NAME, "IndiansAssistAgent");
        // F §8.2: the systemd unit the deb and rpm install.
        #[cfg(target_os = "linux")]
        assert_eq!(SERVICE_NAME, "indiansassist-agent");
        assert_eq!(SERVICE_DISPLAY_NAME, "IndiansAssist Agent");
        assert_eq!(WATCHDOG_SERVICE_NAME, "IndiansAssistWatchdog");
        assert_eq!(WORKER_EXE, "ia-desktop.exe");
    }

    #[test]
    fn the_user_agent_names_the_service_its_platform_and_its_version() {
        let ua = user_agent();
        assert!(ua.starts_with("IndiansAssist-Service/"));
        assert!(ua.contains(version()));
        // F §8.2: a Linux service says so; no personal data is ever in it.
        assert!(ua.contains(if cfg!(target_os = "linux") {
            "(Linux; "
        } else {
            "(Windows; "
        }));
        assert!(!ua.contains('@'));
    }
}
