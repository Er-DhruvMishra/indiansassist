//! What kind of Desk this process is serving (Phase E §7.3a, §7.4, §7.5): the screen mode, the
//! `desk.hello` operating-system identity and the capabilities that follow from them. The
//! decisions are pure and tested on every host; [`detect`] reads the process once.
//!
//! | Mode | Capture | Input | Capabilities |
//! |---|---|---|---|
//! | `Synthetic` | generated frames | none | the platform's full set (e2e, loopback) |
//! | `Windows` | DXGI / GDI | `SendInput` | C §3.1 |
//! | `X11` | `ia-capture-x11` | `ia-input-x11` | §7.5 X11 row, RandR monitor count |
//! | `Wayland` | none, no video track | none | §7.5 Wayland row |

use std::sync::OnceLock;

use ia_core::types::{linux_capabilities, AgentCapabilities, MonitorInfo};
use ia_platform::linux::{display_server, DisplayEnv, DisplayServer};

/// The screen source of this Desk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenMode {
    /// `--synthetic-capture` (dev builds): generated frames and no-op input, on any OS.
    Synthetic,
    /// The Windows capture and input stack.
    Windows,
    /// A Linux X11 session on `display`.
    X11 { display: String },
    /// A Linux Wayland session: the agent connects and shares nothing on screen (§7.4).
    Wayland,
    /// Linux with no graphical session: "No graphical session found" (§7.4).
    NoSession,
}

impl ScreenMode {
    /// Whether this Desk offers a screen (a video track and the screen features).
    pub fn shares_screen(&self) -> bool {
        !matches!(self, ScreenMode::Wayland | ScreenMode::NoSession)
    }
}

/// The decision, pure: `synthetic` wins (a headless dev run), then the OS, then on Linux the
/// §7.4 display-server table.
pub fn decide(synthetic: bool, linux: bool, display: &DisplayServer) -> ScreenMode {
    if synthetic {
        return ScreenMode::Synthetic;
    }
    if !linux {
        return ScreenMode::Windows;
    }
    match display {
        DisplayServer::X11 { display } => ScreenMode::X11 {
            display: display.clone(),
        },
        DisplayServer::Wayland => ScreenMode::Wayland,
        DisplayServer::None => ScreenMode::NoSession,
    }
}

static MODE: OnceLock<ScreenMode> = OnceLock::new();

/// The process's screen mode, decided once from the command line and the environment.
pub fn detect(synthetic: bool) -> ScreenMode {
    MODE.get_or_init(|| {
        decide(
            synthetic,
            cfg!(target_os = "linux"),
            &display_server(&DisplayEnv::from_process()),
        )
    })
    .clone()
}

/// The mode once [`detect`] has run (tests and early paths default to synthetic-free Windows /
/// Linux detection).
pub fn current() -> Option<ScreenMode> {
    MODE.get().cloned()
}

/// The monitor ids that get a video track: none on Wayland ("no video track is offered", §7.4).
pub fn video_ids(ids: &[u32]) -> Vec<u32> {
    match current() {
        Some(m) if !m.shares_screen() => Vec::new(),
        _ => ids.to_vec(),
    }
}

/// `desk.hello.client.os` for a native Desk on this target (§7.3a).
pub fn native_os() -> &'static str {
    // apple-owned: begin
    #[cfg(target_os = "macos")]
    return "mac";
    // apple-owned: end
    #[allow(unreachable_code)]
    if cfg!(target_os = "linux") {
        "linux"
    } else {
        "windows"
    }
}

/// The `PRETTY_NAME` of an `/etc/os-release` text, unquoted, cut to 32 characters (§7.3a).
pub fn pretty_name(os_release: &str) -> Option<String> {
    let line = os_release
        .lines()
        .find_map(|l| l.trim().strip_prefix("PRETTY_NAME="))?;
    let v = line.trim().trim_matches('"').trim_matches('\'').trim();
    if v.is_empty() {
        return None;
    }
    Some(v.chars().filter(|c| !c.is_control()).take(32).collect())
}

/// `desk.hello.client.platform.osVersion`: `10.0` on Windows (as before), the os-release
/// `PRETTY_NAME` on Linux (fallback `Linux`).
pub fn os_version() -> String {
    // apple-owned: begin
    // Phase F §17.2: the macOS product version (`kern.osproductversion`, for example `15.4`).
    #[cfg(target_os = "macos")]
    return macos_product_version().unwrap_or_else(|| "macOS".to_string());
    // apple-owned: end
    #[allow(unreachable_code)]
    if cfg!(target_os = "linux") {
        std::fs::read_to_string("/etc/os-release")
            .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
            .ok()
            .and_then(|t| pretty_name(&t))
            .unwrap_or_else(|| "Linux".to_string())
    } else {
        "10.0".to_string()
    }
}

/// The capabilities of a Linux Desk in `mode` with `monitors` shared monitors (§7.5).
pub fn linux_caps(mode: &ScreenMode, monitors: usize) -> AgentCapabilities {
    let wayland = !mode.shares_screen();
    linux_capabilities(monitors.clamp(1, 16) as u8, wayland)
}

// apple-owned: begin
/// Phase F §17.2: the capabilities of a macOS Desk, from what TCC has granted at `desk.hello`
/// (`ia_core::types::macos_capabilities`). A synthetic run (A1) captures nothing real and posts
/// no input, so it advertises the full set the e2e gate exercises.
#[cfg(target_os = "macos")]
pub fn macos_caps(monitors: usize, synthetic: bool) -> AgentCapabilities {
    let grants = if synthetic {
        ia_core::types::MacGrants {
            screen: true,
            accessibility: true,
        }
    } else {
        macos_grants()
    };
    ia_core::types::macos_capabilities(monitors.clamp(1, 16) as u8, grants)
}

/// `sysctlbyname("kern.osproductversion")`, cut to 32 printable characters.
#[cfg(target_os = "macos")]
pub fn macos_product_version() -> Option<String> {
    let mut buf = [0u8; 64];
    let mut len = buf.len();
    // SAFETY: a NUL-terminated name and a buffer of `len` bytes; `len` receives the size written.
    let rc = unsafe {
        libc::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || len == 0 {
        return None;
    }
    let v: String = String::from_utf8_lossy(&buf[..len])
        .trim_end_matches('\0')
        .chars()
        .filter(|c| !c.is_control())
        .take(32)
        .collect();
    (!v.is_empty()).then_some(v)
}

/// What the `IndiansAssist.iaconfig` sidecar beside the bundle gave (§17.2, C §2.4).
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq)]
pub enum MacSidecar {
    /// A join code from a sidecar whose signature verified against a compiled region key.
    Verified(ia_core::join_input::TokenInput),
    /// A dev build with no compiled keys: the code is used, unsigned, with a warning.
    Unsigned(ia_core::join_input::TokenInput),
    /// A valid sidecar without a `code` (an enrollment-only or label-only config).
    NoCode,
}

/// Parse and check a sidecar: size and strict schema (`parse_iaconfig`), then the Ed25519
/// signature against `keys` (comma-separated base64url, the `IA_TOKEN_PUBKEYS` list). A sidecar
/// that does not verify against any compiled key is refused.
#[cfg(target_os = "macos")]
pub fn macos_sidecar(bytes: &[u8], keys: &str) -> Result<MacSidecar, String> {
    let cfg = ia_core::download::parse_iaconfig(bytes)?;
    let keys: Vec<&str> = keys
        .split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .collect();
    let signed = keys
        .iter()
        .any(|k| ia_core::download::verify_iaconfig_sig(&cfg, k));
    if !keys.is_empty() && !signed {
        return Err("the sidecar's signature does not verify".into());
    }
    let Some(code) = cfg
        .code
        .as_deref()
        .and_then(ia_core::join_input::normalise_token_input)
    else {
        return Ok(MacSidecar::NoCode);
    };
    Ok(if signed {
        MacSidecar::Verified(code)
    } else {
        MacSidecar::Unsigned(code)
    })
}

#[cfg(all(test, target_os = "macos"))]
mod macos_sidecar_tests {
    use super::*;
    use ia_core::devsig::{device_public_key_of, sign_device_input};
    use ia_core::download::{iaconfig_signing_input, Iaconfig};

    const SEED: [u8; 32] = [7; 32];

    /// A Luhn-valid 12-digit desk code, the same for the whole test run.
    fn desk_code() -> &'static str {
        static CODE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        CODE.get_or_init(ia_core::download::make_desk_code)
    }

    fn sidecar(code: Option<&str>, sign_with: Option<[u8; 32]>) -> Vec<u8> {
        let mut cfg = Iaconfig {
            v: 1,
            api_origin: "https://support.example.com".into(),
            region: "in-mum".into(),
            code: code.map(String::from),
            desk_label: None,
            kid: "k1".into(),
            sig: String::new(),
        };
        cfg.sig = match sign_with {
            Some(seed) => sign_device_input(iaconfig_signing_input(&cfg).as_bytes(), &seed),
            None => "A".repeat(86),
        };
        serde_json::to_vec(&cfg).unwrap()
    }

    fn code() -> ia_core::join_input::TokenInput {
        ia_core::join_input::normalise_token_input(desk_code()).expect("a valid desk code")
    }

    #[test]
    fn a_signed_sidecar_gives_its_code() {
        let key = device_public_key_of(&SEED);
        let got = macos_sidecar(
            &sidecar(Some(desk_code()), Some(SEED)),
            &format!("junk,{key}"),
        );
        assert_eq!(got, Ok(MacSidecar::Verified(code())));
    }

    #[test]
    fn a_sidecar_signed_by_another_key_is_refused() {
        let key = device_public_key_of(&SEED);
        assert!(macos_sidecar(&sidecar(Some(desk_code()), Some([9; 32])), &key).is_err());
        assert!(macos_sidecar(&sidecar(Some(desk_code()), None), &key).is_err());
    }

    #[test]
    fn a_dev_build_without_keys_uses_the_code_unsigned() {
        let got = macos_sidecar(&sidecar(Some(desk_code()), None), "");
        assert_eq!(got, Ok(MacSidecar::Unsigned(code())));
    }

    #[test]
    fn a_sidecar_without_a_code_or_with_garbage_is_handled() {
        let key = device_public_key_of(&SEED);
        assert_eq!(
            macos_sidecar(&sidecar(None, Some(SEED)), &key),
            Ok(MacSidecar::NoCode)
        );
        assert!(macos_sidecar(b"not json", "").is_err());
        assert!(
            macos_sidecar(&vec![b' '; 20_000], "").is_err(),
            "over iaconfigMaxBytes"
        );
    }
}

/// The live TCC state (no prompt is shown).
#[cfg(target_os = "macos")]
pub fn macos_grants() -> ia_core::types::MacGrants {
    #[cfg(feature = "macos")]
    {
        ia_core::types::MacGrants {
            screen: ia_capture_mac::screen_recording_granted(),
            accessibility: ia_input_mac::accessibility_granted(),
        }
    }
    #[cfg(not(feature = "macos"))]
    {
        ia_core::types::MacGrants::default()
    }
}

/// The active displays a real (non-synthetic) macOS run captures.
#[cfg(all(target_os = "macos", feature = "macos"))]
pub fn macos_monitors() -> Vec<ia_core::types::MonitorInfo> {
    ia_capture_mac::geometry::monitors(&ia_capture_mac::active_displays())
        .into_iter()
        .map(|(m, _)| m)
        .collect()
}
// apple-owned: end

/// The X11 monitors of `display` (RandR 1.5, root fallback), or an empty list when the X server
/// cannot be reached.
#[cfg(all(target_os = "linux", feature = "x11"))]
pub fn x11_monitors(display_name: &str) -> Vec<MonitorInfo> {
    use ia_platform::traits::Capturer;
    match ia_capture_x11::X11Capturer::open(display_name) {
        Ok(c) => c.enumerate(),
        Err(e) => {
            tracing::warn!("X11 display {display_name} could not be opened: {e}");
            Vec::new()
        }
    }
}

/// Without the X11 layer there are no X11 monitors.
#[cfg(not(all(target_os = "linux", feature = "x11")))]
pub fn x11_monitors(_display: &str) -> Vec<MonitorInfo> {
    Vec::new()
}

/// The single monitor a Wayland Desk advertises (`monitors: 1`, the schema minimum; §7.4
/// sends `capture { monitorId: 1, path: 'none' }`). It is never captured.
pub fn wayland_placeholder_monitor() -> MonitorInfo {
    MonitorInfo {
        id: 1,
        name: "Wayland session (not shared)".into(),
        primary: true,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        scale: 1.0,
        mid: None,
    }
}

/// The `ctl.event capture` a Wayland Desk sends once the control channel opens (§7.4).
pub fn wayland_capture_event(ts: i64) -> serde_json::Value {
    serde_json::json!({
        "t": "ctl.event", "kind": "capture",
        "monitorId": 1, "path": "none", "cause": "wayland_unsupported", "ts": ts,
    })
}

/// The `ctl.event capture` for a capture path that started or was lost (§7.2, §16.2 C §5.1).
pub fn capture_event(monitor_id: u32, path: &str, cause: &str, ts: i64) -> serde_json::Value {
    serde_json::json!({
        "t": "ctl.event", "kind": "capture",
        "monitorId": monitor_id, "path": path, "cause": cause, "ts": ts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_decision() {
        let x11 = DisplayServer::X11 {
            display: ":1".into(),
        };
        assert_eq!(
            decide(true, true, &DisplayServer::Wayland),
            ScreenMode::Synthetic
        );
        assert_eq!(decide(false, false, &x11), ScreenMode::Windows);
        assert_eq!(
            decide(false, true, &x11),
            ScreenMode::X11 {
                display: ":1".into()
            }
        );
        assert_eq!(
            decide(false, true, &DisplayServer::Wayland),
            ScreenMode::Wayland
        );
        assert_eq!(
            decide(false, true, &DisplayServer::None),
            ScreenMode::NoSession
        );
        assert!(!ScreenMode::Wayland.shares_screen());
        assert!(ScreenMode::Synthetic.shares_screen());
    }

    #[test]
    fn pretty_names_are_unquoted_and_capped() {
        let t = "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 26.04.1 LTS\"\nID=ubuntu\n";
        assert_eq!(pretty_name(t).as_deref(), Some("Ubuntu 26.04.1 LTS"));
        let long = format!("PRETTY_NAME='{}'", "x".repeat(50));
        assert_eq!(pretty_name(&long).unwrap().chars().count(), 32);
        assert_eq!(pretty_name("ID=arch\n"), None);
        assert_eq!(pretty_name("PRETTY_NAME=\"\"\n"), None);
    }

    #[test]
    fn wayland_caps_and_the_capture_event() {
        let caps = linux_caps(&ScreenMode::Wayland, 3);
        assert_eq!(caps.monitors, 1);
        assert!(!caps.features.contains(&"screen".to_string()));
        let caps = linux_caps(
            &ScreenMode::X11 {
                display: ":0".into(),
            },
            2,
        );
        assert!(caps.features.contains(&"multi_monitor".to_string()));
        let ev = wayland_capture_event(5);
        assert_eq!(ev["kind"], "capture");
        assert_eq!(ev["monitorId"], 1);
        assert_eq!(ev["path"], "none");
        assert_eq!(ev["cause"], "wayland_unsupported");
    }
}
