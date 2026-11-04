//! What the macOS daemon tells the server about itself (Phase F §17.3, mirroring F §8.3d / §8.7).
//!
//! The daemon cannot count monitors or read the worker's TCC grants, so it advertises the full
//! envelope (as the Linux service does) and learns the monitor count from its worker's `monitors`
//! frame. `elevation` is `'user'` and the privileged mode is refused (§17.3, §8.7). Device actions
//! run as root in the daemon (`ranAs: 'admin'`).

use sha2::{Digest, Sha256};

use ia_core::fleet::{DeviceMachine, InteractiveState, ServiceCapabilities};

/// The service feature set, in the `SERVICE_FEATURES` order; `waker` is dropped only by the 8.2d
/// opt-out.
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
        // A macOS device action's playbook runs under `zsh` or `sh` (the native interpreters).
        interpreters: vec!["zsh".to_string(), "sh".to_string()],
        service_version: service_version.to_string(),
    }
}

/// `hwFingerprint` over the Mac's `IOPlatformUUID`, in the D form
/// (`ia-hwfp-v1/<anchor>/<name>/<arch>`), so a reinstall matches and another Mac does not.
pub fn hw_fingerprint(platform_uuid: &str, hostname: &str, arch: &str) -> String {
    let input = format!(
        "ia-hwfp-v1/{}/{}/{}",
        platform_uuid.trim().to_uppercase(),
        hostname.trim().to_lowercase(),
        arch
    );
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// The §3.2 machine facts with `platform: 'macos'`.
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
        platform: "macos".to_string(),
        os_version: os_version.chars().take(32).collect(),
        arch: arch().to_string(),
        service_version: capabilities.service_version.clone(),
        hw_fingerprint: hw_fingerprint.to_string(),
        wake_mac,
        amt: None,
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

/// The `IOPlatformUUID` from one `ioreg -rd1 -c IOPlatformExpertDevice` listing.
pub fn platform_uuid_from_ioreg(listing: &str) -> Option<String> {
    listing.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("\"IOPlatformUUID\"")?;
        let value = rest.trim().strip_prefix('=')?.trim().trim_matches('"');
        let ok = value.len() == 36 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
        ok.then(|| value.to_string())
    })
}

/// The Mac's `IOPlatformUUID` (empty when it cannot be read: the fingerprint is then the name).
pub fn platform_uuid() -> String {
    std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()
        .and_then(|o| platform_uuid_from_ioreg(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

/// `osVersion`: `macOS <kern.osproductversion>`, at most 32 characters.
pub fn os_version() -> String {
    let mut buf = [0u8; 64];
    let mut len = buf.len();
    let name = c"kern.osproductversion";
    // SAFETY: a NUL-terminated name and a buffer of `len` bytes; `len` receives the size written.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    let v = if rc == 0 {
        String::from_utf8_lossy(&buf[..len.min(buf.len())])
            .trim_end_matches('\0')
            .trim()
            .to_string()
    } else {
        String::new()
    };
    if v.is_empty() {
        "macOS".to_string()
    } else {
        format!("macOS {v}").chars().take(32).collect()
    }
}

/// The host name (`gethostname`), for the device row's name.
pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is sized and its length passed; the scan stops at the buffer's end.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return "mac-device".to_string();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
    if name.is_empty() {
        "mac-device".to_string()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capabilities_are_the_user_envelope() {
        let c = capabilities(0, false, "0.3.0");
        assert_eq!(c.monitors, 1);
        assert_eq!(c.elevation, "user");
        assert!(c.features.contains(&"waker".to_string()));
        assert!(!c
            .features
            .iter()
            .any(|f| f == "secure_desktop" || f == "elevation" || f == "amt"));
        assert_eq!(c.interpreters, vec!["zsh", "sh"]);
        assert!(!capabilities(3, true, "0.3.0")
            .features
            .contains(&"waker".to_string()));
    }

    #[test]
    fn the_fingerprint_is_stable_per_mac_and_differs_between_macs() {
        let a = hw_fingerprint("12345678-927A-5A15-B88C-8EF979B48B85", "Mac-mini", "arm64");
        assert_eq!(
            a,
            hw_fingerprint("12345678-927a-5a15-b88c-8ef979b48b85", "mac-mini", "arm64")
        );
        assert_ne!(
            a,
            hw_fingerprint("22345678-927A-5A15-B88C-8EF979B48B85", "Mac-mini", "arm64")
        );
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn the_platform_uuid_is_read_from_an_ioreg_listing() {
        let listing = "+-o Mac  <class IOPlatformExpertDevice>\n    {\n      \"IOPlatformSerialNumber\" = \"X\"\n      \"IOPlatformUUID\" = \"12345678-927A-5A15-B88C-8EF979B48B85\"\n    }\n";
        assert_eq!(
            platform_uuid_from_ioreg(listing).as_deref(),
            Some("12345678-927A-5A15-B88C-8EF979B48B85")
        );
        assert_eq!(
            platform_uuid_from_ioreg("\"IOPlatformUUID\" = \"not-a-uuid\""),
            None
        );
        assert!(platform_uuid().len() == 36 || platform_uuid().is_empty());
        assert!(os_version().starts_with("macOS"));
    }

    #[test]
    fn the_machine_row_says_macos() {
        let m = machine(
            "x",
            "macOS 15.8.2",
            "f",
            capabilities(1, false, "0.3.0"),
            None,
            crate::macos::facts_nobody(),
        );
        assert_eq!(m.platform, "macos");
        assert!(m.amt.is_none());
    }
}
