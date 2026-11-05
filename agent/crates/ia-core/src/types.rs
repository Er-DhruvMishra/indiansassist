//! Protocol types mirroring the shared schemas (contract §13.1).
//!
//! Wire conventions (contract §7 preamble): camelCase JSON keys, lower snake_case
//! enum values. `ts` is integer ms. Enums serialise through `rename_all`.

use serde::{Deserialize, Serialize};

/// `AgentConsentLevel` (contract §3.4): ordered view < control < elevated.
/// Distinct from the P2 `ConsentLevel` family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentConsentLevel {
    View,
    Control,
    Elevated,
}

impl AgentConsentLevel {
    pub const ALL: [AgentConsentLevel; 3] = [Self::View, Self::Control, Self::Elevated];

    /// `AGENT_CONSENT_LEVEL_ORDER` 0..2.
    pub fn order(self) -> u8 {
        match self {
            Self::View => 0,
            Self::Control => 1,
            Self::Elevated => 2,
        }
    }
}

/// `agentLevelAtLeast(a, b)` — is `a` at least as permissive as `b` (contract §3.4).
pub fn agent_level_at_least(a: AgentConsentLevel, b: AgentConsentLevel) -> bool {
    a.order() >= b.order()
}

/// `ELEVATION_LEVELS` (contract §3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElevationLevel {
    User,
    Admin,
}

impl ElevationLevel {
    pub const ALL: [Self; 2] = [Self::User, Self::Admin];
}

/// `TokenSource` carrier precedence ranks 1..5 (contract §2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenSource {
    Arg,
    Deeplink,
    Sidecar,
    Filename,
    Clipboard,
    Manual,
    /// Phase D: the desktop worker's single-use credential, delivered by the service.
    Service,
}

impl TokenSource {
    pub const ALL: [Self; 7] = [
        Self::Arg,
        Self::Deeplink,
        Self::Sidecar,
        Self::Filename,
        Self::Clipboard,
        Self::Manual,
        Self::Service,
    ];
}

/// `VIDEO_ENCODERS` preference order (contract §4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoEncoder {
    Vp8,
    Vp9,
    H264,
    Av1,
}

impl VideoEncoder {
    pub const ALL: [Self; 4] = [Self::Vp8, Self::Vp9, Self::H264, Self::Av1];
}

/// `QUALITY_PRESETS` (contract §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualityPreset {
    Auto,
    Sharp,
    Smooth,
    Floor,
}

impl QualityPreset {
    pub const ALL: [Self; 4] = [Self::Auto, Self::Sharp, Self::Smooth, Self::Floor];
}

/// `CAPTURE_PATHS` (contract §4.4; Phase E §7.2/§7.4 adds the Linux X11 paths and the
/// Wayland no-screen path as names only, the linux stream wires them; Phase F §9.2 adds the
/// portal path (wayland stream) and §17.8 the macOS ScreenCaptureKit path (apple stream), names only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapturePath {
    Dda,
    Gdi,
    Projection,
    Xshm,
    Xgetimage,
    None,
    Portal,
    Sck,
}

impl CapturePath {
    pub const ALL: [Self; 8] = [
        Self::Dda,
        Self::Gdi,
        Self::Projection,
        Self::Xshm,
        Self::Xgetimage,
        Self::None,
        Self::Portal,
        Self::Sck,
    ];
}

/// `NAV_ACTIONS` (contract §5.1; Windows answers `not_supported`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NavAction {
    Back,
    Home,
    Recents,
    Notifications,
}

impl NavAction {
    pub const ALL: [Self; 4] = [Self::Back, Self::Home, Self::Recents, Self::Notifications];
}

/// `PLAYBOOK_INTERPRETERS` (contract §8.1). Windows runs powershell/cmd; sh is Android/E;
/// zsh (Phase F §17.8) is the macOS shell, a name only until the apple stream runs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybookInterpreter {
    Powershell,
    Cmd,
    Sh,
    Zsh,
}

impl PlaybookInterpreter {
    pub const ALL: [Self; 4] = [Self::Powershell, Self::Cmd, Self::Sh, Self::Zsh];
}

/// `SEC_FAIL_REASONS` (contract §1.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecFailReason {
    Suite,
    Commit,
    Fingerprint,
    Key,
    Mac,
    Timeout,
    Replay,
    Decrypt,
    Oversize,
    Channel,
}

impl SecFailReason {
    pub const ALL: [Self; 10] = [
        Self::Suite,
        Self::Commit,
        Self::Fingerprint,
        Self::Key,
        Self::Mac,
        Self::Timeout,
        Self::Replay,
        Self::Decrypt,
        Self::Oversize,
        Self::Channel,
    ];
}

/// `AGENT_FEATURES` (contract §3.1). `input_lock`/`privacy_screen` never advertised in C;
/// `nav` is Android-only.
pub const AGENT_FEATURES: &[&str] = &[
    "screen",
    "multi_monitor",
    "input",
    "input_text",
    "clipboard",
    "files",
    "chat",
    "voice",
    "elevation",
    "playbooks",
    "nav",
    "input_lock",
    "privacy_screen",
    "recorder",
];

/// The Windows agent's own feature set (contract §3.1 example, minus Android `nav`). `recorder`
/// is advertised because the agent answers `webrtc.offer { peer: 'recorder' }` with a second
/// PC (`ia_agent::recorder`, contract §9 R2); the API assigns the P3 server recorder only to a
/// Desk that advertises it (§9 R6).
pub const WINDOWS_FEATURES: &[&str] = &[
    "screen",
    "multi_monitor",
    "input",
    "input_text",
    "clipboard",
    "files",
    "chat",
    "voice",
    "elevation",
    "playbooks",
    "recorder",
];

/// The Windows feature list the agent advertises, dropping `voice` when no audio device was
/// found (contract §6.3: "if cpal device enumeration fails … make voice a capability flag
/// that is off when no device").
pub fn windows_features(has_voice: bool) -> Vec<String> {
    WINDOWS_FEATURES
        .iter()
        .filter(|f| has_voice || **f != "voice")
        .map(|s| s.to_string())
        .collect()
}

/// Phase E §7.5: what a Linux agent advertises in an X11 session (`multi_monitor` only when
/// more than one monitor is shared). No `voice` (not built on Linux), no `elevation` (7.3d).
pub const LINUX_X11_FEATURES: &[&str] = &[
    "screen",
    "multi_monitor",
    "input",
    "input_text",
    "clipboard",
    "files",
    "chat",
    "playbooks",
    "recorder",
];

/// Phase E §7.4 / §7.5: a Wayland session shares no screen, so it advertises only these.
pub const LINUX_WAYLAND_FEATURES: &[&str] = &["files", "chat", "playbooks"];

/// Phase F §9.4: the portal build on a Wayland session with a ScreenCast portal: the screen
/// view-only (no `input`, `input_text` or `clipboard`, W113 / W114), one stream (no
/// `multi_monitor`), and the recorder.
pub const LINUX_PORTAL_FEATURES: &[&str] = &["screen", "files", "chat", "playbooks", "recorder"];

/// Phase F §9.4: the portal build's capabilities on a Wayland session whose portal offers
/// ScreenCast: `monitors: 1` (the portal reports one stream), `elevation: 'user'`, VP8 / VP9, no
/// hardware encoder, interpreter `sh`.
pub fn linux_portal_capabilities() -> AgentCapabilities {
    AgentCapabilities {
        monitors: 1,
        elevation: ElevationLevel::User,
        features: LINUX_PORTAL_FEATURES
            .iter()
            .map(|s| s.to_string())
            .collect(),
        encoders: vec![VideoEncoder::Vp8, VideoEncoder::Vp9],
        hw_encoder: false,
        interpreters: vec![PlaybookInterpreter::Sh],
    }
}

/// Phase E §7.5: the Linux `desk.hello.client.capabilities`. `monitors` is the RandR count
/// (clamped 1..16) in an X11 session and 1 (the schema minimum) on Wayland; `elevation: 'user'`,
/// VP8 / VP9, no hardware encoder, interpreter `sh`.
pub fn linux_capabilities(monitors: u8, wayland: bool) -> AgentCapabilities {
    let monitors = if wayland { 1 } else { monitors.clamp(1, 16) };
    let features = if wayland {
        LINUX_WAYLAND_FEATURES
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        LINUX_X11_FEATURES
            .iter()
            .filter(|f| monitors > 1 || **f != "multi_monitor")
            .map(|s| s.to_string())
            .collect()
    };
    AgentCapabilities {
        monitors,
        elevation: ElevationLevel::User,
        features,
        encoders: vec![VideoEncoder::Vp8, VideoEncoder::Vp9],
        hw_encoder: false,
        interpreters: vec![PlaybookInterpreter::Sh],
    }
}

// apple-owned: begin
/// Phase F §17.2: what TCC has granted this process at `desk.hello`.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MacGrants {
    /// Screen Recording (`CGPreflightScreenCaptureAccess`).
    pub screen: bool,
    /// Accessibility (`AXIsProcessTrusted`).
    pub accessibility: bool,
}

/// Phase F §17.2: the macOS `desk.hello.client.capabilities`, from what TCC has granted at
/// `desk.hello`: `screen` (and `multi_monitor`, `recorder`) only with Screen Recording, `input`
/// and `input_text` only with Accessibility; `clipboard`, `files`, `chat` and `playbooks` always.
/// Without Screen Recording one monitor is advertised (the schema minimum, as on Wayland) and the
/// console shows the no-screen state in words. `elevation: 'user'`, interpreters `zsh` and `sh`.
#[cfg(target_os = "macos")]
pub fn macos_capabilities(monitors: u8, grants: MacGrants) -> AgentCapabilities {
    let monitors = if grants.screen {
        monitors.clamp(1, 16)
    } else {
        1
    };
    let mut features: Vec<String> = Vec::new();
    if grants.screen {
        features.push("screen".into());
        if monitors > 1 {
            features.push("multi_monitor".into());
        }
    }
    if grants.accessibility {
        features.extend(["input".to_string(), "input_text".to_string()]);
    }
    features.extend(["clipboard", "files", "chat", "playbooks"].map(String::from));
    if grants.screen {
        features.push("recorder".into());
    }
    AgentCapabilities {
        monitors,
        elevation: ElevationLevel::User,
        features,
        encoders: vec![VideoEncoder::Vp8, VideoEncoder::Vp9],
        hw_encoder: false,
        interpreters: vec![PlaybookInterpreter::Zsh, PlaybookInterpreter::Sh],
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_capabilities_tests {
    use super::*;

    fn grants(screen: bool, accessibility: bool) -> MacGrants {
        MacGrants {
            screen,
            accessibility,
        }
    }

    #[test]
    fn everything_granted_on_two_displays() {
        let c = macos_capabilities(2, grants(true, true));
        assert_eq!(c.monitors, 2);
        assert_eq!(
            c.features,
            [
                "screen",
                "multi_monitor",
                "input",
                "input_text",
                "clipboard",
                "files",
                "chat",
                "playbooks",
                "recorder"
            ]
        );
        assert_eq!(
            c.interpreters,
            [PlaybookInterpreter::Zsh, PlaybookInterpreter::Sh]
        );
        assert_eq!(c.elevation, ElevationLevel::User);
    }

    #[test]
    fn no_screen_recording_means_no_screen_and_one_monitor() {
        let c = macos_capabilities(3, grants(false, true));
        assert_eq!(c.monitors, 1);
        assert!(!c.features.iter().any(|f| f == "screen" || f == "recorder"));
        assert!(c.features.iter().any(|f| f == "input"));
    }

    #[test]
    fn no_accessibility_means_no_input() {
        let c = macos_capabilities(1, grants(true, false));
        assert!(!c.features.iter().any(|f| f.starts_with("input")));
        assert!(!c.features.iter().any(|f| f == "multi_monitor"));
        assert!(c.features.iter().any(|f| f == "screen"));
    }

    #[test]
    fn nothing_granted_still_offers_chat_files_and_playbooks() {
        let c = macos_capabilities(1, grants(false, false));
        assert_eq!(c.features, ["clipboard", "files", "chat", "playbooks"]);
    }
}
// apple-owned: end

/// `P3_DATA_CHANNEL_LABELS`, created by the Desk once per peer connection (contract §1.3).
pub const P3_DATA_CHANNEL_LABELS: &[&str] = &[
    "ia.sec",
    "ia.chat",
    "ia.annot",
    "ia.file",
    "ia.ctrl",
    "ia.control",
    "ia.playbook",
];

/// `SEC_ENCRYPTED_LABELS` — every label except `ia.sec` (contract §1.3).
pub const SEC_ENCRYPTED_LABELS: &[&str] = &[
    "ia.control",
    "ia.file",
    "ia.playbook",
    "ia.chat",
    "ia.annot",
    "ia.ctrl",
];

/// `SEC_LABEL_IDS` — the 1-byte label id used in the frame nonce (contract §1.3).
pub fn sec_label_id(label: &str) -> Option<u8> {
    Some(match label {
        "ia.control" => 1,
        "ia.file" => 2,
        "ia.playbook" => 3,
        "ia.chat" => 4,
        "ia.annot" => 5,
        "ia.ctrl" => 6,
        _ => return None,
    })
}

/// `WS_CLOSE.handedOver` (contract §7.2).
pub const WS_CLOSE_HANDED_OVER: u16 = 4411;

/// The agent's own injection tag written to `dwExtraInfo` on every `SendInput` event
/// (`IA_1`, contract §5.3). The §3.5 low-level hooks drop tagged events over the agent's
/// own windows, and prompt buttons refuse a click whose message carries it.
pub const IA_INJECT_TAG: usize = 0x4941_5F31;

/// Keyboard / pointer modifier state carried on every op (contract §5.1).
/// Strict like the shared B `modifiersSchema`: all four keys required, nothing else.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Modifiers {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

/// `MonitorInfo` in virtual-desktop pixel coordinates (contract §3.6 M3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// DPI / 96, two decimals.
    pub scale: f32,
    /// The SDP mid of this monitor's track; `None` until bound.
    #[serde(default)]
    pub mid: Option<String>,
}

/// `AgentCapabilities` (contract §3.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentCapabilities {
    /// int 1..16.
    pub monitors: u8,
    pub elevation: ElevationLevel,
    pub features: Vec<String>,
    pub encoders: Vec<VideoEncoder>,
    #[serde(rename = "hwEncoder")]
    pub hw_encoder: bool,
    pub interpreters: Vec<PlaybookInterpreter>,
}

/// Shared numeric limits (`LIMITS` additions, contract §13.1).
pub mod limits {
    pub const SEC_HANDSHAKE_TIMEOUT_MS: u64 = 10_000;
    pub const SEC_FRAME_MAX_BYTES: usize = 131_072;
    pub const DOWNLOAD_GRANT_TTL_SEC: u64 = 120;
    pub const DOWNLOAD_GRANT_MAX_USES: u32 = 3;
    pub const HANDOVER_TTL_SEC: u64 = 120;
    pub const HANDOVER_MINTS_PER_10MIN: u32 = 3;
    pub const IACONFIG_MAX_BYTES: usize = 16_384;
    pub const CLIPBOARD_MAX_BYTES: usize = 65_536;
    pub const AGENT_MAX_KBPS: u32 = 6_000;
    pub const AGENT_STATS_INTERVAL_MS: u64 = 2_000;
    pub const POINTER_MOVES_PER_SEC_NATIVE: u32 = 60;
    pub const TEXT_CHARS_PER_SEC: u32 = 400;
    pub const TEXT_QUEUE_MAX_UNITS: usize = 2_048;
    pub const TEXT_BURST_CHARS: usize = 200;
    pub const PLAYBOOK_BODY_MAX_BYTES: usize = 65_536;
    pub const PLAYBOOK_TIMEOUT_MAX_SEC: u32 = 900;
    pub const PLAYBOOK_OUTPUT_MAX_BYTES: usize = 1_048_576;
    pub const PLAYBOOK_CATALOGUE_MAX: usize = 100;
    pub const PLAYBOOK_MANIFEST_MAX_BYTES: usize = 32_768;
    pub const PLAYBOOK_PARAMS_MAX: usize = 16;
    pub const FILE_MAX_BYTES_NATIVE: u64 = 2_147_483_648;
    pub const MONITORS_MAX: u32 = 16;
}

/// `opIdFor(sessionId, reqId)` = `sha256Hex(sessionId + ':' + reqId)[..16]`: the chain
/// correlation id shared by both reporters of one request (B §3.7, contract §8.5).
pub fn op_id_for(session_id: &str, req_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{session_id}:{req_id}").as_bytes());
    hex::encode(digest)[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_ordering() {
        assert!(agent_level_at_least(
            AgentConsentLevel::Elevated,
            AgentConsentLevel::Control
        ));
        assert!(agent_level_at_least(
            AgentConsentLevel::Control,
            AgentConsentLevel::Control
        ));
        assert!(!agent_level_at_least(
            AgentConsentLevel::View,
            AgentConsentLevel::Control
        ));
    }

    #[test]
    fn enums_serialise_snake_case() {
        assert_eq!(
            serde_json::to_string(&AgentConsentLevel::Elevated).unwrap(),
            "\"elevated\""
        );
        assert_eq!(
            serde_json::to_string(&TokenSource::Deeplink).unwrap(),
            "\"deeplink\""
        );
        assert_eq!(
            serde_json::to_string(&VideoEncoder::H264).unwrap(),
            "\"h264\""
        );
        assert_eq!(
            serde_json::to_string(&SecFailReason::Commit).unwrap(),
            "\"commit\""
        );
    }

    #[test]
    fn label_ids_match_contract() {
        assert_eq!(sec_label_id("ia.control"), Some(1));
        assert_eq!(sec_label_id("ia.ctrl"), Some(6));
        assert_eq!(sec_label_id("ia.sec"), None);
        for l in SEC_ENCRYPTED_LABELS {
            assert!(sec_label_id(l).is_some(), "{l} must have a label id");
        }
    }

    #[test]
    fn voice_feature_drops_without_a_device() {
        let with = windows_features(true);
        assert!(with.iter().any(|f| f == "voice"));
        let without = windows_features(false);
        assert!(!without.iter().any(|f| f == "voice"));
        // Everything else is unchanged.
        assert_eq!(without.len(), WINDOWS_FEATURES.len() - 1);
    }

    #[test]
    fn recorder_feature_is_advertised() {
        // The agent answers the server recorder's offer (§9 R2), so the API may assign one.
        assert!(AGENT_FEATURES.contains(&"recorder"));
        assert!(WINDOWS_FEATURES.contains(&"recorder"));
        assert!(windows_features(false).iter().any(|f| f == "recorder"));
    }

    #[test]
    fn capabilities_round_trip() {
        let caps = AgentCapabilities {
            monitors: 2,
            elevation: ElevationLevel::User,
            features: WINDOWS_FEATURES.iter().map(|s| s.to_string()).collect(),
            encoders: vec![VideoEncoder::H264, VideoEncoder::Vp9, VideoEncoder::Vp8],
            hw_encoder: true,
            interpreters: vec![PlaybookInterpreter::Powershell, PlaybookInterpreter::Cmd],
        };
        let json = serde_json::to_string(&caps).unwrap();
        assert!(json.contains("\"hwEncoder\":true"));
        let back: AgentCapabilities = serde_json::from_str(&json).unwrap();
        assert_eq!(caps, back);
    }

    #[test]
    fn linux_capabilities_follow_section_7_5() {
        let one = linux_capabilities(1, false);
        assert_eq!(one.monitors, 1);
        assert!(!one.features.contains(&"multi_monitor".to_string()));
        assert!(one.features.contains(&"screen".to_string()));
        assert!(one.features.contains(&"recorder".to_string()));
        assert!(!one.features.contains(&"voice".to_string()));
        assert!(!one.features.contains(&"elevation".to_string()));
        assert_eq!(one.interpreters, vec![PlaybookInterpreter::Sh]);
        assert_eq!(one.encoders, vec![VideoEncoder::Vp8, VideoEncoder::Vp9]);
        assert!(!one.hw_encoder);
        assert_eq!(one.elevation, ElevationLevel::User);
        let two = linux_capabilities(2, false);
        assert_eq!(two.monitors, 2);
        assert!(two.features.contains(&"multi_monitor".to_string()));
        assert_eq!(linux_capabilities(40, false).monitors, 16);
        let w = linux_capabilities(3, true);
        assert_eq!(w.monitors, 1);
        assert_eq!(w.features, vec!["files", "chat", "playbooks"]);
        for f in LINUX_X11_FEATURES.iter().chain(LINUX_WAYLAND_FEATURES) {
            assert!(AGENT_FEATURES.contains(f), "{f} is a shared feature name");
        }
    }

    #[test]
    fn portal_capabilities_follow_phase_f_section_9_4() {
        let p = linux_portal_capabilities();
        assert_eq!(p.monitors, 1);
        assert_eq!(p.elevation, ElevationLevel::User);
        assert_eq!(
            p.features,
            vec!["screen", "files", "chat", "playbooks", "recorder"]
        );
        for absent in ["input", "input_text", "clipboard", "multi_monitor", "voice"] {
            assert!(!p.features.contains(&absent.to_string()), "{absent}");
        }
        assert_eq!(p.encoders, vec![VideoEncoder::Vp8, VideoEncoder::Vp9]);
        assert!(!p.hw_encoder);
        assert_eq!(p.interpreters, vec![PlaybookInterpreter::Sh]);
        for f in LINUX_PORTAL_FEATURES {
            assert!(AGENT_FEATURES.contains(f), "{f} is a shared feature name");
            assert!(LINUX_X11_FEATURES.contains(f), "a subset of the X11 set");
        }
    }
}
