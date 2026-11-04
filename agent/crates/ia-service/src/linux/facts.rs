//! What a Linux service tells the server about itself (F §8.3d, §8.7).
//!
//! The service never connects to X and cannot count monitors, so it advertises the **full X11
//! envelope** — `multi_monitor` always — and learns the count from its worker's `monitors` frame
//! (the count is informational and gates nothing). `fleet/worker.ts` refuses a worker whose
//! features are not a subset of the device row's, so an envelope without `multi_monitor` would
//! refuse a two-monitor first session with `capability_mismatch`.
//!
//! `elevation` is `'user'`: everything a technician does **in a session** runs as the signed-in
//! user, and the P4 privileged mode is refused (§8.7). Device actions still run as root and say
//! `ranAs: 'admin'`; that is a property of the action, not of the session (§8.6).

use sha2::{Digest, Sha256};

use ia_core::fleet::{AmtInventory, DeviceMachine, InteractiveState, ServiceCapabilities};

/// The §8.7 service feature set, in the `SERVICE_FEATURES` order. `waker` is dropped only by the
/// rule 8.2d opt-out. Never `secure_desktop`, `sas`, `amt`, `amt_proxy`, `input_lock`,
/// `privacy_screen`, `elevation` or `voice`.
pub fn features(waker_opt_out: bool) -> Vec<String> {
    let mut out = vec![
        "screen",
        "multi_monitor",
        "input",
        "input_text",
        "clipboard",
        "files",
        "chat",
        "playbooks",
        "recorder",
        "service_input",
    ];
    if !waker_opt_out {
        out.push("waker");
    }
    out.into_iter().map(str::to_string).collect()
}

/// The whole §8.7 `ServiceCapabilities`. `monitors` is the last count the worker reported
/// (1 until one has).
pub fn capabilities(
    monitors: u8,
    waker_opt_out: bool,
    service_version: &str,
) -> ServiceCapabilities {
    ServiceCapabilities {
        monitors: monitors.clamp(1, 16),
        elevation: "user".to_string(),
        features: features(waker_opt_out),
        encoders: vec!["vp8".to_string(), "vp9".to_string()],
        hw_encoder: false,
        interpreters: vec!["sh".to_string()],
        service_version: service_version.to_string(),
    }
}

/// `amt` on a Linux device: no MEI access in Phase F (§8.2), so never present.
pub fn no_amt() -> Option<AmtInventory> {
    None
}

/// `hwFingerprint` (§8.3d): sha256 over `/etc/machine-id` in the D form
/// (`ia-hwfp-v1/<anchor>/<name>/<arch>`), so a reinstall of the package matches and another
/// machine does not.
pub fn hw_fingerprint(machine_id: &str, hostname: &str, arch: &str) -> String {
    let input = format!(
        "ia-hwfp-v1/{}/{}/{}",
        machine_id.trim(),
        hostname.trim().to_lowercase(),
        arch
    );
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// The §3.2 machine facts with `platform: 'linux'` (§8.3d).
pub fn machine(
    name: &str,
    os_version: &str,
    hw_fingerprint: &str,
    capabilities: ServiceCapabilities,
    wake_mac: Option<String>,
    interactive: InteractiveState,
) -> DeviceMachine {
    DeviceMachine {
        name: name.chars().take(80).collect(),
        platform: "linux".to_string(),
        os_version: os_version.chars().take(32).collect(),
        arch: arch().to_string(),
        service_version: capabilities.service_version.clone(),
        hw_fingerprint: hw_fingerprint.to_string(),
        wake_mac,
        amt: no_amt(),
        capabilities,
        interactive,
    }
}

pub fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

/// `osVersion` = the os-release `PRETTY_NAME`, at most 32 characters (§8.3d).
pub fn os_version() -> String {
    std::fs::read_to_string("/etc/os-release")
        .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
        .ok()
        .and_then(|t| ia_agent::desk::pretty_name(&t))
        .unwrap_or_else(|| "Linux".to_string())
}

/// `/etc/machine-id` (empty when it cannot be read: the fingerprint is then the name alone).
pub fn machine_id() -> String {
    std::fs::read_to_string("/etc/machine-id")
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// The host name (`gethostname`), for the device row's name.
pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is sized and its length passed; gethostname NUL-terminates within it
    // when it fits, and the scan below stops at the buffer's end either way.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return "linux-device".to_string();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
    if name.is_empty() {
        "linux-device".to_string()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_envelope_always_has_multi_monitor_and_user_elevation() {
        let c = capabilities(1, false, "0.3.0");
        assert!(c.features.contains(&"multi_monitor".to_string()));
        assert_eq!(c.elevation, "user");
        assert_eq!(c.interpreters, vec!["sh"]);
        assert_eq!(c.encoders, vec!["vp8", "vp9"]);
        assert!(!c.hw_encoder);
        for absent in [
            "secure_desktop",
            "sas",
            "amt",
            "amt_proxy",
            "input_lock",
            "privacy_screen",
            "elevation",
            "voice",
        ] {
            assert!(!c.features.contains(&absent.to_string()), "{absent}");
        }
        assert_eq!(capabilities(40, false, "x").monitors, 16);
        assert_eq!(capabilities(0, false, "x").monitors, 1);
    }

    #[test]
    fn the_waker_opt_out_removes_only_the_waker() {
        let with = features(false);
        let without = features(true);
        assert!(with.contains(&"waker".to_string()));
        assert!(!without.contains(&"waker".to_string()));
        assert_eq!(with.len(), without.len() + 1);
    }

    #[test]
    fn every_worker_feature_fits_the_envelope() {
        // The E §7.5 X11 and Wayland sets a worker may report must be subsets (§4.2 / §8.7).
        let envelope = features(false);
        for wayland in [false, true] {
            for monitors in [1, 2, 4] {
                let worker = ia_core::types::linux_capabilities(monitors, wayland);
                assert_eq!(
                    crate::facts::worker_features_fit(&envelope, &worker.features),
                    Ok(()),
                    "wayland={wayland} monitors={monitors}"
                );
            }
        }
    }

    #[test]
    fn the_machine_facts_say_linux_and_fit_the_schema() {
        let m = machine(
            &"h".repeat(100),
            "Ubuntu 22.04.5 LTS (Jammy Jellyfish) and more",
            &hw_fingerprint("0123456789abcdef0123456789abcdef", "Desk-01", "x64"),
            capabilities(1, false, "0.3.0"),
            None,
            InteractiveState {
                state: ia_core::policy::InteractiveStateName::Active,
                idle_sec: Some(0),
                at: 1,
                display: Some("x11".into()),
            },
        );
        assert_eq!(m.platform, "linux");
        assert_eq!(m.name.chars().count(), 80);
        assert_eq!(m.os_version.chars().count(), 32);
        assert_eq!(m.hw_fingerprint.len(), 64);
        assert!(m.amt.is_none());
    }

    #[test]
    fn the_fingerprint_is_stable_and_machine_specific() {
        let a = hw_fingerprint("abc\n", "Desk", "x64");
        assert_eq!(a, hw_fingerprint("abc", "desk", "x64"));
        assert_ne!(a, hw_fingerprint("abd", "desk", "x64"));
    }

    #[test]
    fn this_host_has_a_name_and_an_os_version() {
        assert!(!hostname().is_empty());
        assert!(!os_version().is_empty());
        assert!(os_version().chars().count() <= 32);
    }
}
