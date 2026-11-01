//! The §7.2 hand-over blob and the elevated child's context (§7.3 steps 3-5).
//!
//! The parent writes one JSON object down a named pipe it created before launching; the child
//! reads it, checks that it is running the very image the parent hashed, and takes the session
//! over. The blob is the only thing that crosses: it never touches disk, the environment or a
//! command line, because every one of those is readable by other processes of the same user —
//! which is exactly who the hand-over is defending against.
//!
//! `gen` is the field `agent/README.md` recorded as an open question and C §7.2 (revision 3,
//! W43) settled: the console accepts a rebuild offer only at `lastGen + 1`, so the child has to
//! know which generation the parent was on. The Phase D launch blob carries it for the same
//! reason (D §4.2), so both hand-overs are generation-aware in the same way.

use std::sync::OnceLock;

use ia_core::types::AgentConsentLevel;
use serde::{Deserialize, Serialize};

/// The consent the Desk already gave, inherited by the child rather than asked again (§7.3
/// step 4: the same session continues, and asking twice would be a worse experience and a
/// worse record).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InheritedConsent {
    pub level: String,
    pub monitors: Vec<u32>,
    pub clipboard: bool,
}

/// The §7.2 blob, verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoverBlob {
    pub v: u8,
    /// The one-time hand-over token the server minted (`elevation.handover`).
    pub handover: String,
    /// The session's token: the child's `desk.hello` carries both.
    pub token: String,
    pub api_origin: String,
    pub signal_url: String,
    pub session_id: String,
    /// sha256 of the parent's own image, computed over a `FILE_SHARE_READ`-only handle the
    /// parent holds through the UAC prompt. The child refuses to run if its own image differs.
    pub image_sha256: String,
    pub token_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desk_label: Option<String>,
    /// The parent's current `ia.sec` key generation; the child offers `gen + 1` (W43).
    pub gen: u16,
    pub consent: InheritedConsent,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BlobError {
    #[error("the hand-over blob is not the JSON the contract defines: {0}")]
    Malformed(String),
    #[error("unsupported hand-over blob version {0}")]
    Version(u8),
    #[error("{0}")]
    Invalid(&'static str),
}

impl HandoverBlob {
    pub fn parse(bytes: &[u8]) -> Result<Self, BlobError> {
        let blob: Self =
            serde_json::from_slice(bytes).map_err(|e| BlobError::Malformed(e.to_string()))?;
        blob.validate()?;
        Ok(blob)
    }

    pub fn validate(&self) -> Result<(), BlobError> {
        if self.v != 1 {
            return Err(BlobError::Version(self.v));
        }
        if self.handover.is_empty() || self.token.is_empty() {
            return Err(BlobError::Invalid("the blob carries no hand-over or token"));
        }
        if self.image_sha256.len() != 64
            || !self.image_sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(BlobError::Invalid("imageSha256 is 64 hex characters"));
        }
        if self.session_id.len() != 36 {
            return Err(BlobError::Invalid("sessionId is a uuid"));
        }
        if self.consent.monitors.is_empty() {
            return Err(BlobError::Invalid("the inherited consent names no monitor"));
        }
        Ok(())
    }

    /// The consent level to resume at, defaulting to `control` rather than `elevated`: the
    /// server raises the level when it accepts the hand-over, and guessing upward here would
    /// mean honouring input before it has.
    pub fn level(&self) -> AgentConsentLevel {
        match self.consent.level.as_str() {
            "view" => AgentConsentLevel::View,
            "elevated" => AgentConsentLevel::Elevated,
            _ => AgentConsentLevel::Control,
        }
    }

    /// The generation the child offers (§3.7 rebuild, W43).
    pub fn child_gen(&self) -> u16 {
        self.gen.saturating_add(1)
    }
}

static CHILD: OnceLock<HandoverBlob> = OnceLock::new();

/// Install the child context (called once, by `main`, after the image checks pass).
pub fn set(blob: HandoverBlob) -> Result<(), &'static str> {
    CHILD
        .set(blob)
        .map_err(|_| "the hand-over context is already set")
}

/// The child context, or `None` in a parent instance.
pub fn get() -> Option<&'static HandoverBlob> {
    CHILD.get()
}

/// Whether this process is the elevated hand-over child.
pub fn is_child() -> bool {
    CHILD.get().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob() -> HandoverBlob {
        HandoverBlob {
            v: 1,
            handover: "h".repeat(43),
            token: "ia1.payload.sig".into(),
            api_origin: "https://in.example".into(),
            signal_url: "wss://in.example/signal".into(),
            session_id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b".into(),
            image_sha256: "ab".repeat(32),
            token_source: "filename".into(),
            desk_label: Some("DESK-01".into()),
            gen: 2,
            consent: InheritedConsent {
                level: "control".into(),
                monitors: vec![1],
                clipboard: false,
            },
        }
    }

    #[test]
    fn it_round_trips_and_carries_the_generation_the_console_expects() {
        let bytes = serde_json::to_vec(&blob()).unwrap();
        let back = HandoverBlob::parse(&bytes).unwrap();
        assert_eq!(back, blob());
        assert_eq!(back.gen, 2);
        assert_eq!(
            back.child_gen(),
            3,
            "the console accepts exactly lastGen + 1"
        );
    }

    #[test]
    fn a_blob_without_the_image_hash_or_the_handover_is_refused() {
        for bad in [
            HandoverBlob {
                image_sha256: "short".into(),
                ..blob()
            },
            HandoverBlob {
                image_sha256: "zz".repeat(32),
                ..blob()
            },
            HandoverBlob {
                handover: String::new(),
                ..blob()
            },
            HandoverBlob {
                token: String::new(),
                ..blob()
            },
            HandoverBlob {
                session_id: "x".into(),
                ..blob()
            },
            HandoverBlob {
                consent: InheritedConsent {
                    level: "control".into(),
                    monitors: vec![],
                    clipboard: false,
                },
                ..blob()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn an_unknown_field_or_version_is_refused() {
        let mut v: serde_json::Value = serde_json::to_value(blob()).unwrap();
        v["surprise"] = serde_json::json!(1);
        assert!(matches!(
            HandoverBlob::parse(serde_json::to_vec(&v).unwrap().as_slice()),
            Err(BlobError::Malformed(_))
        ));
        let mut v: serde_json::Value = serde_json::to_value(blob()).unwrap();
        v["v"] = serde_json::json!(2);
        assert_eq!(
            HandoverBlob::parse(serde_json::to_vec(&v).unwrap().as_slice()).unwrap_err(),
            BlobError::Version(2)
        );
    }

    #[test]
    fn the_level_never_guesses_upward() {
        assert_eq!(blob().level(), AgentConsentLevel::Control);
        let unknown = HandoverBlob {
            consent: InheritedConsent {
                level: "something".into(),
                monitors: vec![1],
                clipboard: false,
            },
            ..blob()
        };
        assert_eq!(
            unknown.level(),
            AgentConsentLevel::Control,
            "an unknown level is control, not elevated"
        );
        let view = HandoverBlob {
            consent: InheritedConsent {
                level: "view".into(),
                monitors: vec![1],
                clipboard: false,
            },
            ..blob()
        };
        assert_eq!(view.level(), AgentConsentLevel::View);
    }
}
