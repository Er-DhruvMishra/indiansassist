//! The channel pair between the serve loop (tokio, `ia-agent`) and the UI thread (eframe,
//! contract §11.4 "the egui UI ... talking to the runtime over a channel pair"). Pure data;
//! compiled in every build so the serve loop can be written against it without `gui`.

use ia_core::types::{AgentConsentLevel, ElevationLevel, MonitorInfo};

use crate::model::ConsentPayload;

/// What the consent window shows (contract §3.3).
#[derive(Debug, Clone)]
pub struct ConsentRequest {
    /// `session.created.assist.name`.
    pub technician: String,
    /// `session.created.org.displayName`.
    pub org: String,
    /// "Connecting through <api host>".
    pub api_host: String,
    /// The monitors from enumeration (all checked by default).
    pub monitors: Vec<MonitorInfo>,
    /// The A.2 U1 recording sentence when `recordingMode` is `server` / `both`.
    pub recording_sentence: Option<String>,
    /// Yellow lines (§2.4 / §2.6, and "development build" for a dev exe).
    pub warnings: Vec<String>,
    /// The consent deadline (A: 180 s), shown as a countdown; expiry = Decline.
    pub deadline_secs: u64,
    /// Phase D §6.2 `auto_grant`: the server already settled consent under the device's
    /// unattended policy, so there is nobody to ask and no form to show. The window opens
    /// **as the indicator pill** instead — the indicator is never skipped (P3), it is just
    /// not preceded by a question. `false` for every Phase C session.
    pub start_live: bool,
}

/// The Desk's file-accept prompt facts (contract §6.1 F4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePrompt {
    pub file_id: u32,
    /// The sanitised, collision-free final name the file will be saved as.
    pub name: String,
    /// Lower-case extension (no dot), or empty.
    pub ext: String,
    /// The sender's declared MIME (shown as declared, never trusted).
    pub mime: String,
    pub size: u64,
    /// The technician's name.
    pub sender: String,
    /// `EXECUTABLE_EXTENSIONS`: red warning and a second physical click.
    pub executable: bool,
    /// Seconds before an unanswered prompt becomes `declined` (60).
    pub timeout_secs: u64,
}

/// Serve loop -> UI.
#[derive(Debug, Clone)]
pub enum UiCommand {
    /// Consent was sent; the window becomes the indicator pill (contract §3.5).
    Live {
        technician: String,
        org: String,
        level: AgentConsentLevel,
        clipboard: bool,
        monitors: Vec<MonitorInfo>,
        recording: bool,
        recording_is_server: bool,
    },
    /// The six-digit security code (contract §1.3 step 7), always on the pill face.
    Sas(String),
    /// The live level / clipboard / integrity after any change.
    Level {
        level: AgentConsentLevel,
        clipboard: bool,
        integrity: ElevationLevel,
    },
    Recording {
        on: bool,
        server: bool,
    },
    /// An incoming `file.offer` that passed the name/size/type checks.
    FilePrompt(FilePrompt),
    /// The offer was answered, timed out, finished or was cancelled.
    FileClosed {
        file_id: u32,
        outcome: String,
    },
    /// The Assist asked for `control` (contract §3.4): Allow / Refuse, 60 s.
    LevelPrompt {
        reason: String,
        timeout_secs: u64,
    },
    LevelPromptClosed,
    /// A chat line (`from_technician` false = sent from this Desk).
    Chat {
        from_technician: bool,
        text: String,
    },
    /// A short pill toast (e.g. "Copied text was shared with <technician>", §5.6 C1).
    Toast(String),
    /// The Desk microphone (contract §6.3): `available` = a capture + render device exists (the
    /// pill shows the mic button only then); `muted` = the live state (default muted, A D8).
    Voice {
        available: bool,
        muted: bool,
    },
    /// The technician's `voice.state` (shown on the pill: "Technician is talking").
    TechnicianVoice {
        muted: bool,
    },
    /// The session ended; show the receipt lines, then close.
    Ended {
        lines: Vec<String>,
    },
}

/// UI -> serve loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiEvent {
    ConsentGranted(ConsentPayload),
    ConsentDeclined,
    /// **Stop** (pill, panel or tray).
    Stop,
    /// **Revoke consent** (panel).
    Revoke,
    /// The Desk changed the level from the panel / tray (lowering is always allowed; raising
    /// back to `control` needs a physical click).
    SetLevel(AgentConsentLevel),
    /// The Desk clipboard switch (turning it on needs a physical click).
    Clipboard(bool),
    FileDecision {
        file_id: u32,
        accept: bool,
    },
    LevelDecision {
        allow: bool,
    },
    ChatSend(String),
    /// The pill microphone button: `true` = unmute (grant direction, needs a physical press),
    /// `false` = mute (safe direction, never gated).
    Mic(bool),
    /// The UI could not start (no display, window creation failed): treated as Decline.
    Failed(String),
    /// The UI window is gone.
    Closed,
}

/// Format a byte count for the file prompt ("1.5 MB").
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} bytes");
    }
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    format!("{v:.1} {}", UNITS[u])
}

/// The A.2 U1 recording sentence for the consent window (contract §3.3).
pub fn recording_sentence(mode: &str, region: Option<&str>) -> Option<String> {
    let region = region.unwrap_or("the organisation's region");
    match mode {
        "server" => Some(format!(
            "This session will be recorded and stored by the organisation in {region}."
        )),
        "both" => Some(format!(
            "This session will be recorded and stored by the organisation in {region}. \
             The technician may also record it on their computer."
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_sizes() {
        assert_eq!(human_size(10), "10 bytes");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(5 * 1024 * 1024), "5.0 MB");
    }

    #[test]
    fn recording_sentence_only_for_server_modes() {
        assert!(recording_sentence("off", None).is_none());
        assert!(recording_sentence("console", None).is_none());
        assert!(recording_sentence("server", Some("India"))
            .unwrap()
            .contains("India"));
        assert!(recording_sentence("both", None)
            .unwrap()
            .contains("their computer"));
    }
}
