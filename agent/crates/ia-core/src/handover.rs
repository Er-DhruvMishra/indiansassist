//! The parent -> elevated-child hand-over payload codec (contract §7.2) and the §7.3
//! order-of-operations the user instance follows. Pure: the named-pipe plumbing and
//! `ShellExecuteExW(runas)` live in `ia-platform` / the binary, but the JSON blob that rides
//! the pipe, and the sequence, are defined and tested here so both sides agree byte-for-byte.
//!
//! The blob never touches disk, the environment or the command line; the reader zeroises its
//! buffer after [`HandoverPayload::decode`].

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::types::AgentConsentLevel;

/// The consent choices the child inherits (contract §7.2 blob `consent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsentChoice {
    pub level: AgentConsentLevel,
    pub monitors: Vec<u32>,
    pub clipboard: bool,
}

/// The §7.2 hand-over blob. `v` is `1`; unknown keys are rejected so a hostile pipe peer
/// cannot smuggle extra fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoverPayload {
    pub v: u8,
    pub handover: String,
    pub token: String,
    #[serde(rename = "apiOrigin")]
    pub api_origin: String,
    #[serde(rename = "signalUrl")]
    pub signal_url: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "imageSha256")]
    pub image_sha256: String,
    #[serde(rename = "tokenSource")]
    pub token_source: String,
    #[serde(rename = "deskLabel")]
    pub desk_label: String,
    pub consent: ConsentChoice,
}

impl HandoverPayload {
    /// Serialise to the JSON the parent writes to the pipe.
    pub fn encode(&self) -> String {
        serde_json::to_string(self).expect("handover payload serialises")
    }

    /// Parse the blob the child read, then zeroise the source buffer (the caller passes a
    /// mutable buffer so the secret bytes do not linger).
    pub fn decode(buf: &mut Vec<u8>) -> Result<HandoverPayload, &'static str> {
        let parsed = serde_json::from_slice::<HandoverPayload>(buf).map_err(|_| "bad_blob");
        buf.zeroize();
        let payload = parsed?;
        if payload.v != 1 {
            return Err("bad_version");
        }
        Ok(payload)
    }
}

/// The §7.3 steps the user instance runs on **Allow** before the child connects. Returning
/// them as an ordered list lets the binary (and a test) assert the order of operations
/// without launching anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoverStep {
    /// `desk.elevation` -> `elevation.handover` (mint the one-time token).
    MintHandover,
    /// Open own exe `GENERIC_READ` + `FILE_SHARE_READ` only and hold the handle.
    HoldImageHandle,
    /// `WinVerifyTrust` + `IA_EXPECTED_SIGNER` subject compare on that handle.
    VerifySignature,
    /// Compute `imageSha256` over the held handle.
    MeasureImage,
    /// Create the §7.2 named pipe (FIRST_PIPE_INSTANCE, REJECT_REMOTE, user+admins DACL).
    CreatePipe,
    /// `ctl.event elevation { state: 'uac_shown' }` then `ShellExecuteExW(runas)`.
    RelaunchElevated,
    /// Accept one pipe client, verify its pid + image path, write the blob, close.
    WriteBlob,
}

/// The ordered §7.3 operations (used by the binary and asserted by the loopback test).
pub fn handover_order() -> [HandoverStep; 7] {
    [
        HandoverStep::MintHandover,
        HandoverStep::HoldImageHandle,
        HandoverStep::VerifySignature,
        HandoverStep::MeasureImage,
        HandoverStep::CreatePipe,
        HandoverStep::RelaunchElevated,
        HandoverStep::WriteBlob,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> HandoverPayload {
        HandoverPayload {
            v: 1,
            handover: "aGFuZG92ZXItdG9rZW4".into(),
            token: "ia1.deadbeef".into(),
            api_origin: "https://in.indiansassist.example".into(),
            signal_url: "wss://in.indiansassist.example/signal".into(),
            session_id: "sess-123".into(),
            image_sha256: "ab".repeat(32),
            token_source: "filename".into(),
            desk_label: "Rahul".into(),
            consent: ConsentChoice {
                level: AgentConsentLevel::Control,
                monitors: vec![1, 2],
                clipboard: false,
            },
        }
    }

    #[test]
    fn blob_round_trips_with_consent() {
        let p = sample();
        let mut buf = p.encode().into_bytes();
        let back = HandoverPayload::decode(&mut buf).unwrap();
        assert_eq!(back, p);
        assert_eq!(back.consent.monitors, vec![1, 2]);
        assert_eq!(back.consent.level, AgentConsentLevel::Control);
        // The source buffer was zeroised.
        assert!(buf.iter().all(|b| *b == 0));
    }

    #[test]
    fn wire_keys_are_camel_case() {
        let json = sample().encode();
        assert!(json.contains("\"apiOrigin\""));
        assert!(json.contains("\"signalUrl\""));
        assert!(json.contains("\"imageSha256\""));
        assert!(json.contains("\"tokenSource\""));
        assert!(json.contains("\"deskLabel\""));
    }

    #[test]
    fn wrong_version_rejected() {
        let mut p = sample();
        p.v = 2;
        let mut buf = p.encode().into_bytes();
        assert_eq!(HandoverPayload::decode(&mut buf), Err("bad_version"));
    }

    #[test]
    fn unknown_keys_rejected() {
        let mut buf = br#"{"v":1,"handover":"x","token":"y","apiOrigin":"https://a",
            "signalUrl":"wss://a","sessionId":"s","imageSha256":"ab","tokenSource":"arg",
            "deskLabel":"","consent":{"level":"view","monitors":[1],"clipboard":false},
            "evil":"extra"}"#
            .to_vec();
        assert!(HandoverPayload::decode(&mut buf).is_err());
    }

    #[test]
    fn order_of_operations_is_fixed() {
        let order = handover_order();
        assert_eq!(order[0], HandoverStep::MintHandover);
        assert_eq!(order[4], HandoverStep::CreatePipe);
        assert_eq!(order[5], HandoverStep::RelaunchElevated);
        // The pipe is created before the relaunch (so the child can connect).
        let pipe = order.iter().position(|s| *s == HandoverStep::CreatePipe);
        let relaunch = order
            .iter()
            .position(|s| *s == HandoverStep::RelaunchElevated);
        assert!(pipe < relaunch);
    }
}
