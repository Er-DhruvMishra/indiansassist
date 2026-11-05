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
//! | `Portal` | `ia-capture-portal` (Phase F §9) | none (view-only) | F §9.4 portal row |

use std::sync::OnceLock;

use ia_core::capture_decision::{portal_capture_change, PortalStatus};
use ia_core::types::{
    linux_capabilities, linux_portal_capabilities, AgentCapabilities, CapturePath, MonitorInfo,
};
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
    /// Phase F §9: the portal build on a Wayland session whose desktop portal offers ScreenCast
    /// of a monitor: the screen view-only through the portal, no input, no clipboard.
    Portal,
    /// Linux with no graphical session: "No graphical session found" (§7.4).
    NoSession,
}

impl ScreenMode {
    /// Whether this Desk offers a screen (a video track and the screen features).
    pub fn shares_screen(&self) -> bool {
        !matches!(self, ScreenMode::Wayland | ScreenMode::NoSession)
    }
}

/// Phase F §9.4, pure: a Wayland session becomes the portal mode when the portal build found a
/// ScreenCast portal on the session bus; every other mode is unchanged.
pub fn with_portal(mode: ScreenMode, portal_available: bool) -> ScreenMode {
    match mode {
        ScreenMode::Wayland if portal_available => ScreenMode::Portal,
        other => other,
    }
}

/// Whether the portal build's probe finds a ScreenCast portal (no dialog). Dev builds honour
/// `IA_TEST_NO_PORTAL=1` (the no-portal row of §9.4 without touching the session).
#[cfg(all(target_os = "linux", feature = "portal"))]
fn portal_available() -> bool {
    if cfg!(feature = "dev") && std::env::var("IA_TEST_NO_PORTAL").is_ok_and(|v| v == "1") {
        return false;
    }
    match ia_capture_portal::probe(std::time::Duration::from_secs(3)) {
        Ok(()) => {
            tracing::info!("portal: ScreenCast is available on the session bus");
            true
        }
        Err(f) => {
            tracing::info!(failure = ?f, "portal: no ScreenCast portal; the screen is not shared");
            false
        }
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
        let mode = decide(
            synthetic,
            cfg!(target_os = "linux"),
            &display_server(&DisplayEnv::from_process()),
        );
        #[cfg(all(target_os = "linux", feature = "portal"))]
        if mode == ScreenMode::Wayland {
            return with_portal(mode, portal_available());
        }
        mode
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

/// The capabilities of a Linux Desk in `mode` with `monitors` shared monitors (§7.5; the
/// portal mode is Phase F §9.4).
pub fn linux_caps(mode: &ScreenMode, monitors: usize) -> AgentCapabilities {
    if *mode == ScreenMode::Portal {
        return linux_portal_capabilities();
    }
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

/// Phase F §9.3: the one monitor of a portal session, before the stream reports its size (the
/// pump follows the real size once frames arrive).
pub fn portal_placeholder_monitor() -> MonitorInfo {
    MonitorInfo {
        id: 1,
        name: "Wayland screen (portal)".into(),
        primary: true,
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        scale: 1.0,
        mid: None,
    }
}

/// The process's one portal session (Phase F §9.3): started by the first pump after consent and
/// shared by every later pump of the session, so a pump restart never asks the user again.
#[cfg(all(target_os = "linux", feature = "portal"))]
static PORTAL: std::sync::Mutex<
    Option<std::sync::Arc<std::sync::Mutex<ia_capture_portal::PortalCapturer>>>,
> = std::sync::Mutex::new(None);

/// The portal capturer, started on first use (this shows the compositor's source dialog).
#[cfg(all(target_os = "linux", feature = "portal"))]
pub fn portal_capturer() -> std::sync::Arc<std::sync::Mutex<ia_capture_portal::PortalCapturer>> {
    let mut slot = PORTAL.lock().unwrap_or_else(|p| p.into_inner());
    slot.get_or_insert_with(|| {
        tracing::info!("portal: starting the screen cast session (the source dialog follows)");
        std::sync::Arc::new(std::sync::Mutex::new(
            ia_capture_portal::PortalCapturer::start(),
        ))
    })
    .clone()
}

/// End the portal session, if one was started (the session's end).
pub fn stop_portal() {
    #[cfg(all(target_os = "linux", feature = "portal"))]
    {
        let taken = PORTAL.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(c) = taken {
            if let Ok(mut c) = c.lock() {
                c.stop();
            }
        }
    }
}

/// Where the portal session stands, when one was started.
pub fn portal_status() -> Option<PortalStatus> {
    #[cfg(all(target_os = "linux", feature = "portal"))]
    {
        let c = PORTAL.lock().unwrap_or_else(|p| p.into_inner()).clone()?;
        let s = c.lock().map(|c| c.status()).ok();
        s
    }
    #[cfg(not(all(target_os = "linux", feature = "portal")))]
    None
}

/// `ctl.event capture` for a portal status change (Phase F §9.3), each reported once; `None`
/// when there is nothing new or no portal session.
pub fn portal_capture_event(
    reported: &mut Option<PortalStatus>,
    monitor_id: u32,
    ts: i64,
) -> Option<serde_json::Value> {
    let now = portal_status()?;
    portal_event_for(reported, now, monitor_id, ts)
}

/// The pure half of [`portal_capture_event`].
pub fn portal_event_for(
    reported: &mut Option<PortalStatus>,
    now: PortalStatus,
    monitor_id: u32,
    ts: i64,
) -> Option<serde_json::Value> {
    let (path, cause) = portal_capture_change(*reported, now)?;
    *reported = Some(now);
    let path = match path {
        CapturePath::Portal => "portal",
        _ => "none",
    };
    Some(capture_event(monitor_id, path, cause.as_str(), ts))
}

// ---- Phase F §9.5: the Wayland hand-over from the X11 binary to its portal companion ----------

/// The switch the X11 binary adds when it hands over: `--handed-from <its own path>`. It is put
/// **first**, so a `--url` tail (which takes every later argument) never swallows it.
pub const HANDED_FROM: &str = "--handed-from";
/// The inherited pipe the already-resolved token arrives on (never argv or the environment).
pub const TOKEN_FD: i32 = 4;
/// The companion's file name beside the X11 binary.
pub const COMPANION_NAME: &str = ".ia-portal";
/// The library the portal build links (checked with `dlopen` before handing over).
pub const PIPEWIRE_LIB: &str = "libpipewire-0.3.so.0";
/// Added to the E §7.4 Wayland message when only PipeWire is missing.
pub const PIPEWIRE_MISSING_LINE: &str =
    "Screen sharing on Wayland needs PipeWire, which was not found.";
/// The most a hand-over token payload may be.
const TOKEN_PAYLOAD_MAX: usize = 8192;

/// Split a leading `--handed-from <path>` off the arguments (only in first position).
pub fn take_handed_from(args: Vec<String>) -> (Option<std::path::PathBuf>, Vec<String>) {
    if args.first().map(String::as_str) == Some(HANDED_FROM) && args.len() >= 2 {
        let path = std::path::PathBuf::from(&args[1]);
        return (Some(path), args[2..].to_vec());
    }
    (None, args)
}

/// What is known about `.ia-portal` beside the X11 binary.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CompanionFacts {
    pub exists: bool,
    /// A regular file, read with `lstat` (a symlink is not).
    pub regular: bool,
    /// Owned by the user running the agent.
    pub owned: bool,
    /// Its sha256 (hex), when it could be read.
    pub sha256: Option<String>,
}

/// Why the X11 binary stays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stay {
    /// Not a Wayland session: the X11 binary is the right one.
    NotWayland,
    /// This is the portal build already.
    PortalBuild,
    /// No `.ia-portal` beside the binary (an X11-only download).
    NoCompanion,
    /// `.ia-portal` is there but is not ours to run (not a regular file, someone else's, or its
    /// sha256 is not the one this build embeds).
    CompanionRefused(&'static str),
    /// `libpipewire-0.3.so.0` cannot be opened: the honest PipeWire message.
    NoPipeWire,
}

/// The hand-over decision, pure (§9.5): only on Wayland, only from the X11 build, only to a
/// regular file the user owns whose sha256 is the embedded one (`expected_sha256 = None`: a dev
/// build, which skips the check), and only when PipeWire opens.
pub fn handover_decision(
    mode: &ScreenMode,
    portal_build: bool,
    companion: &CompanionFacts,
    expected_sha256: Option<&str>,
    pipewire: bool,
) -> Result<(), Stay> {
    if portal_build {
        return Err(Stay::PortalBuild);
    }
    if *mode != ScreenMode::Wayland {
        return Err(Stay::NotWayland);
    }
    if !companion.exists {
        return Err(Stay::NoCompanion);
    }
    if !companion.regular {
        return Err(Stay::CompanionRefused("not a regular file"));
    }
    if !companion.owned {
        return Err(Stay::CompanionRefused("not owned by this user"));
    }
    if let Some(want) = expected_sha256 {
        if companion.sha256.as_deref() != Some(want) || want.is_empty() {
            return Err(Stay::CompanionRefused(
                "its sha256 is not the one this build expects",
            ));
        }
    }
    if !pipewire {
        return Err(Stay::NoPipeWire);
    }
    Ok(())
}

/// The arguments the companion is started with: `--handed-from <self>` first, then the original
/// arguments unchanged.
pub fn handover_args(own_path: &std::path::Path, args: &[String]) -> Vec<String> {
    let mut out = vec![
        HANDED_FROM.to_string(),
        own_path.to_string_lossy().into_owned(),
    ];
    out.extend(args.iter().cloned());
    out
}

/// The token payload on [`TOKEN_FD`]: the carrier and the raw credential, one JSON object.
pub fn encode_handover_token(
    source: ia_core::types::TokenSource,
    token: &ia_core::join_input::TokenInput,
) -> String {
    let raw = match token {
        ia_core::join_input::TokenInput::Compact(s)
        | ia_core::join_input::TokenInput::ShortCode(s) => s.as_str(),
    };
    serde_json::json!({ "source": source, "token": raw }).to_string()
}

/// Read back [`encode_handover_token`]; the credential is validated again.
pub fn decode_handover_token(
    payload: &[u8],
) -> Option<(ia_core::types::TokenSource, ia_core::join_input::TokenInput)> {
    if payload.len() > TOKEN_PAYLOAD_MAX {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let source = serde_json::from_value(v.get("source")?.clone()).ok()?;
    let token = ia_core::join_input::normalise_token_input(v.get("token")?.as_str()?)?;
    Some((source, token))
}

static HANDED: OnceLock<std::path::PathBuf> = OnceLock::new();
static PIPEWIRE_MISSING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// This process is the portal companion, started by the X11 binary at `main`.
pub fn set_handed_from(main: std::path::PathBuf) {
    let _ = HANDED.set(main);
}

/// The X11 binary that handed over to this process, if any (self-delete and Keep treat the pair
/// as one program).
pub fn handed_from() -> Option<std::path::PathBuf> {
    HANDED.get().cloned()
}

/// Record that the hand-over stayed because PipeWire is missing (the consent window says so).
pub fn set_pipewire_missing() {
    PIPEWIRE_MISSING.store(true, std::sync::atomic::Ordering::Relaxed);
}

pub fn pipewire_missing() -> bool {
    PIPEWIRE_MISSING.load(std::sync::atomic::Ordering::Relaxed)
}

/// The facts about `path` (`lstat`, owner, sha256).
#[cfg(target_os = "linux")]
pub fn companion_facts(path: &std::path::Path) -> CompanionFacts {
    use sha2::Digest;
    use std::os::unix::fs::MetadataExt;
    let Ok(m) = std::fs::symlink_metadata(path) else {
        return CompanionFacts::default();
    };
    // SAFETY: getuid has no preconditions and cannot fail.
    let me = unsafe { libc::getuid() };
    let regular = m.file_type().is_file();
    let sha256 = if regular {
        std::fs::read(path)
            .ok()
            .map(|b| hex::encode(sha2::Sha256::digest(&b)))
    } else {
        None
    };
    CompanionFacts {
        exists: true,
        regular,
        owned: m.uid() == me,
        sha256,
    }
}

/// Whether the dynamic loader can open libpipewire now (`RTLD_NOW`), closed again at once. Dev
/// builds honour `IA_TEST_NO_PIPEWIRE=1` (the e2e's "PipeWire missing" case).
#[cfg(target_os = "linux")]
pub fn pipewire_loadable() -> bool {
    if cfg!(feature = "dev") && std::env::var("IA_TEST_NO_PIPEWIRE").is_ok_and(|v| v == "1") {
        tracing::info!("IA_TEST_NO_PIPEWIRE=1: treating {PIPEWIRE_LIB} as missing (dev build)");
        return false;
    }
    let name = std::ffi::CString::new(PIPEWIRE_LIB).expect("no NUL");
    // SAFETY: a valid NUL-terminated name; a non-null handle is closed exactly once.
    unsafe {
        let h = libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        if h.is_null() {
            return false;
        }
        libc::dlclose(h);
    }
    true
}

/// The companion sha256 a release X11 build embeds (`IA_PORTAL_SHA256` at build time, from the
/// dist manifest); `None` in a dev build, which skips the check and logs it.
pub fn expected_companion_sha256() -> Option<&'static str> {
    if cfg!(feature = "dev") {
        None
    } else {
        Some(option_env!("IA_PORTAL_SHA256").unwrap_or(""))
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
    fn the_portal_mode_and_its_capabilities_and_events() {
        assert_eq!(with_portal(ScreenMode::Wayland, true), ScreenMode::Portal);
        assert_eq!(with_portal(ScreenMode::Wayland, false), ScreenMode::Wayland);
        let x11 = ScreenMode::X11 {
            display: ":1".into(),
        };
        assert_eq!(with_portal(x11.clone(), true), x11);
        assert_eq!(
            with_portal(ScreenMode::NoSession, true),
            ScreenMode::NoSession
        );
        assert!(ScreenMode::Portal.shares_screen());
        let caps = linux_caps(&ScreenMode::Portal, 3);
        assert_eq!(caps.monitors, 1);
        assert_eq!(
            caps.features,
            vec!["screen", "files", "chat", "playbooks", "recorder"]
        );
        // §9.4 second row: no portal is the E Wayland set.
        let no_portal = linux_caps(&ScreenMode::Wayland, 1);
        assert!(!no_portal.features.contains(&"screen".to_string()));
        assert_eq!(portal_placeholder_monitor().id, 1);

        let mut reported = None;
        assert!(portal_event_for(&mut reported, PortalStatus::Pending, 1, 1).is_none());
        let ev = portal_event_for(&mut reported, PortalStatus::Streaming, 1, 2).unwrap();
        assert_eq!(
            (ev["path"].as_str(), ev["cause"].as_str()),
            (Some("portal"), Some("start"))
        );
        assert!(portal_event_for(&mut reported, PortalStatus::Streaming, 1, 3).is_none());
        let ev = portal_event_for(&mut reported, PortalStatus::Closed, 1, 4).unwrap();
        assert_eq!(ev["kind"], "capture");
        assert_eq!(ev["monitorId"], 1);
        assert_eq!(
            (ev["path"].as_str(), ev["cause"].as_str()),
            (Some("none"), Some("portal_closed"))
        );
        assert!(portal_event_for(&mut reported, PortalStatus::Denied, 1, 5).is_none());
        let mut fresh = None;
        let ev = portal_event_for(&mut fresh, PortalStatus::Denied, 1, 6).unwrap();
        assert_eq!(ev["cause"], "portal_denied");
        // No portal session in this process: nothing to report.
        assert!(portal_capture_event(&mut None, 1, 7).is_none());
    }

    #[test]
    fn the_handed_from_switch_is_taken_only_in_first_position() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (h, rest) =
            take_handed_from(a(&["--handed-from", "/d/IndiansAssist-x", "--code", "1"]));
        assert_eq!(h, Some(std::path::PathBuf::from("/d/IndiansAssist-x")));
        assert_eq!(rest, a(&["--code", "1"]));
        let (h, rest) = take_handed_from(a(&[
            "--url",
            "indiansassist://join?c=1",
            "--handed-from",
            "/x",
        ]));
        assert_eq!(h, None, "inside a --url tail it is part of the URL");
        assert_eq!(rest.len(), 4);
        assert_eq!(take_handed_from(a(&["--handed-from"])).0, None);
        let args = handover_args(std::path::Path::new("/d/main"), &a(&["--url", "x"]));
        assert_eq!(args, a(&["--handed-from", "/d/main", "--url", "x"]));
        assert_eq!(take_handed_from(args).1, a(&["--url", "x"]));
    }

    #[test]
    fn the_hand_over_decision() {
        let ok = CompanionFacts {
            exists: true,
            regular: true,
            owned: true,
            sha256: Some("ab".repeat(32)),
        };
        let want = "ab".repeat(32);
        let w = ScreenMode::Wayland;
        assert_eq!(handover_decision(&w, false, &ok, Some(&want), true), Ok(()));
        assert_eq!(
            handover_decision(&w, false, &ok, None, true),
            Ok(()),
            "dev: no hash check"
        );
        assert_eq!(
            handover_decision(&w, false, &ok, Some(&want), false),
            Err(Stay::NoPipeWire)
        );
        assert_eq!(
            handover_decision(&w, true, &ok, None, true),
            Err(Stay::PortalBuild)
        );
        let x11 = ScreenMode::X11 {
            display: ":0".into(),
        };
        assert_eq!(
            handover_decision(&x11, false, &ok, None, true),
            Err(Stay::NotWayland)
        );
        assert_eq!(
            handover_decision(&ScreenMode::NoSession, false, &ok, None, true),
            Err(Stay::NotWayland)
        );
        assert_eq!(
            handover_decision(&w, false, &CompanionFacts::default(), None, false),
            Err(Stay::NoCompanion),
            "an X11-only download stays without the PipeWire line"
        );
        for bad in [
            CompanionFacts {
                regular: false,
                ..ok.clone()
            },
            CompanionFacts {
                owned: false,
                ..ok.clone()
            },
        ] {
            assert!(matches!(
                handover_decision(&w, false, &bad, None, true),
                Err(Stay::CompanionRefused(_))
            ));
        }
        let other = CompanionFacts {
            sha256: Some("cd".repeat(32)),
            ..ok.clone()
        };
        assert!(matches!(
            handover_decision(&w, false, &other, Some(&want), true),
            Err(Stay::CompanionRefused(_))
        ));
        // A release build without an embedded hash never runs a companion.
        assert!(matches!(
            handover_decision(&w, false, &ok, Some(""), true),
            Err(Stay::CompanionRefused(_))
        ));
    }

    #[test]
    fn the_token_crosses_the_pipe_intact() {
        use ia_core::join_input::TokenInput;
        use ia_core::types::TokenSource;
        let code = ia_core::download::make_desk_code();
        let tok = ia_core::join_input::normalise_token_input(&code).unwrap();
        let p = encode_handover_token(TokenSource::Filename, &tok);
        assert_eq!(
            decode_handover_token(p.as_bytes()),
            Some((TokenSource::Filename, tok))
        );
        assert_eq!(
            decode_handover_token(b"{\"source\":\"arg\",\"token\":\"nope\"}"),
            None
        );
        assert_eq!(decode_handover_token(b"not json"), None);
        assert_eq!(decode_handover_token(&vec![b' '; 9000]), None);
        let _ = TokenInput::ShortCode(String::new());
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
