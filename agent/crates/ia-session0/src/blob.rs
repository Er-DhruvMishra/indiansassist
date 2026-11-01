//! The §4.2 launch blob: the one JSON object the service writes down the pipe to start a
//! session on the worker.
//!
//! Three properties matter more than the shape:
//!
//! * **It never touches disk, the environment or a command line.** The worker gets only the
//!   pipe suffix on its command line (which is not a secret); the blob arrives over the pipe
//!   the service created with a DACL for `SYSTEM` and the worker's user alone.
//! * **It carries the worker credential, not the device key.** The worker can join its session
//!   and nothing else: it cannot sign as the device (that is what the `sign_sas` request on
//!   the same pipe is for) and it holds no enrollment material.
//! * **It carries `gen`.** The console accepts a rebuild offer only at `lastGen + 1`, so a
//!   worker launched to replace another (§5.3 desktop switch, rule 3.6d reconnect) has to know
//!   which generation it is. The Phase C hand-over blob lacked this field, which is what
//!   `agent/README.md` recorded as an open question; D §4.2 settles it for both.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use ia_core::fleet::{Assist, Secret};
use ia_core::policy::{ConsentDecision, UnattendedPolicy};

/// The largest blob either side accepts. The §4.2 object with a full policy and a playbook-free
/// payload is well under 8 KiB; the cap is what stops a torn or hostile write from being read
/// into memory without bound.
pub const BLOB_MAX: usize = 16 * 1024;

/// The consent the server already settled (`auto_grant` only): the worker applies it rather
/// than asking anyone (§6.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlobConsent {
    /// `view` | `control` | `elevated` (the C consent levels).
    pub level: String,
    /// The monitor ids to share.
    pub monitors: Vec<u32>,
    pub clipboard: bool,
}

/// The §4.2 blob, verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchBlob {
    pub v: u8,
    pub session_id: String,
    pub api_origin: String,
    /// The region's ordinary `/signal` URL — **not** `/signal/device`: the worker joins as a
    /// Desk on the same socket the Phase C agent uses, which is what keeps the C serve loop
    /// byte-for-byte (§4.2).
    pub signal_url: String,
    pub assist: Assist,
    /// The technician's typed reason (`device.session_open.reason`), which the rule 6.2a arrival
    /// card and the §6.2 approval card show to the person at the machine. `session.created` does
    /// not carry it, so the blob is the only way it reaches the worker (added in revision 5).
    pub reason: Option<String>,
    pub unattended: bool,
    pub decision: ConsentDecision,
    pub policy: UnattendedPolicy,
    /// Set only for `auto_grant`; `null` when a person is going to answer.
    pub consent: Option<BlobConsent>,
    pub recording_mode: String,
    /// The `ia.sec` key generation this worker starts at (0 for the first worker of a session).
    pub gen: u16,
    pub device_id: String,
    /// Whether the worker is starting on a secure desktop (the logon screen or a locked /
    /// UAC desktop); the rule 5.1c gates then apply to its frames and input.
    pub secure_desktop: bool,
    pub worker_credential: Secret,
    pub worker_credential_expires_at: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BlobError {
    #[error("the blob is {0} bytes, over the {BLOB_MAX} cap")]
    TooLarge(usize),
    #[error("the blob is not the JSON the contract defines: {0}")]
    Malformed(String),
    #[error("unsupported blob version {0}")]
    Version(u8),
    #[error("{0}")]
    Invalid(&'static str),
}

/// A worker credential is 43 base64url characters (32 bytes).
fn valid_credential(c: &str) -> bool {
    c.len() == 43
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn looks_like_ws_url(u: &str) -> bool {
    (u.starts_with("wss://") || u.starts_with("ws://")) && !u.contains("/signal/device")
}

impl LaunchBlob {
    /// Serialise for the pipe (compact, one object, no trailing newline).
    pub fn to_bytes(&self) -> Result<Zeroizing<Vec<u8>>, BlobError> {
        let v = serde_json::to_vec(self).map_err(|e| BlobError::Malformed(e.to_string()))?;
        if v.len() > BLOB_MAX {
            return Err(BlobError::TooLarge(v.len()));
        }
        Ok(Zeroizing::new(v))
    }

    /// Parse and validate what arrived on the pipe. The worker refuses a blob it cannot fully
    /// make sense of rather than starting a session with a half-understood instruction.
    pub fn parse(bytes: &[u8]) -> Result<Self, BlobError> {
        if bytes.len() > BLOB_MAX {
            return Err(BlobError::TooLarge(bytes.len()));
        }
        let blob: Self =
            serde_json::from_slice(bytes).map_err(|e| BlobError::Malformed(e.to_string()))?;
        blob.validate()?;
        Ok(blob)
    }

    pub fn validate(&self) -> Result<(), BlobError> {
        if self.v != 1 {
            return Err(BlobError::Version(self.v));
        }
        if !valid_credential(self.worker_credential.expose()) {
            return Err(BlobError::Invalid(
                "workerCredential: 43 base64url characters (32 bytes)",
            ));
        }
        if !looks_like_ws_url(&self.signal_url) {
            return Err(BlobError::Invalid(
                "signalUrl: the region's /signal URL, not /signal/device",
            ));
        }
        if self.session_id.len() != 36 || self.device_id.len() != 36 {
            return Err(BlobError::Invalid("sessionId and deviceId are uuids"));
        }
        // `auto_grant` is the only decision that carries a settled consent, and it must carry
        // one: a worker that auto-granted with no monitors would show a pill over nothing.
        match (self.decision, &self.consent) {
            (ConsentDecision::AutoGrant, None) => {
                return Err(BlobError::Invalid("auto_grant must carry its consent"))
            }
            (ConsentDecision::AutoGrant, Some(c)) if c.monitors.is_empty() => {
                return Err(BlobError::Invalid("auto_grant consent needs a monitor"))
            }
            (ConsentDecision::LocalApproval | ConsentDecision::LocalConsent, Some(_)) => {
                return Err(BlobError::Invalid(
                    "consent is set only for auto_grant; a person is going to answer",
                ))
            }
            _ => {}
        }
        self.policy
            .validate()
            .map_err(|_| BlobError::Invalid("policy: not a valid UnattendedPolicy"))?;
        Ok(())
    }

    /// Whether this worker must apply the rule 5.1c secure-surface gate from its first frame.
    pub fn starts_on_secure_desktop(&self) -> bool {
        self.secure_desktop
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob() -> LaunchBlob {
        LaunchBlob {
            v: 1,
            session_id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b".into(),
            api_origin: "https://in.example".into(),
            signal_url: "wss://in.example/signal".into(),
            assist: Assist {
                name: "Asha".into(),
            },
            reason: Some("unattended disk check".into()),
            unattended: true,
            decision: ConsentDecision::AutoGrant,
            policy: UnattendedPolicy::default(),
            consent: Some(BlobConsent {
                level: "control".into(),
                monitors: vec![1],
                clipboard: false,
            }),
            recording_mode: "server".into(),
            gen: 0,
            device_id: "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a".into(),
            secure_desktop: false,
            worker_credential: Secret::new("A".repeat(43)),
            worker_credential_expires_at: "2026-11-01T10:02:00.000Z".into(),
        }
    }

    #[test]
    fn it_round_trips_over_the_pipe() {
        let b = blob();
        let bytes = b.to_bytes().unwrap();
        let back = LaunchBlob::parse(&bytes).unwrap();
        assert_eq!(back.session_id, b.session_id);
        assert_eq!(back.gen, 0);
        assert_eq!(
            back.worker_credential.expose(),
            b.worker_credential.expose()
        );
    }

    #[test]
    fn the_credential_is_not_in_a_debug_dump_of_the_blob() {
        let dump = format!("{:?}", blob());
        assert!(dump.contains("<redacted>"));
        assert!(!dump.contains(&"A".repeat(43)));
    }

    #[test]
    fn an_unknown_field_or_a_future_version_is_refused() {
        let mut v: serde_json::Value = serde_json::from_slice(&blob().to_bytes().unwrap()).unwrap();
        v["surprise"] = serde_json::json!(1);
        assert!(matches!(
            LaunchBlob::parse(serde_json::to_vec(&v).unwrap().as_slice()),
            Err(BlobError::Malformed(_))
        ));
        let mut v: serde_json::Value = serde_json::from_slice(&blob().to_bytes().unwrap()).unwrap();
        v["v"] = serde_json::json!(2);
        assert_eq!(
            LaunchBlob::parse(serde_json::to_vec(&v).unwrap().as_slice()).unwrap_err(),
            BlobError::Version(2)
        );
    }

    #[test]
    fn a_blob_pointing_at_the_device_socket_is_refused() {
        let b = LaunchBlob {
            signal_url: "wss://in.example/signal/device".into(),
            ..blob()
        };
        assert_eq!(
            b.validate(),
            Err(BlobError::Invalid(
                "signalUrl: the region's /signal URL, not /signal/device"
            ))
        );
    }

    #[test]
    fn a_malformed_credential_is_refused() {
        for c in ["", "short", &"A".repeat(44), &"!".repeat(43)] {
            let b = LaunchBlob {
                worker_credential: Secret::new(c),
                ..blob()
            };
            assert!(b.validate().is_err(), "{c} must not pass");
        }
    }

    #[test]
    fn consent_is_carried_exactly_when_the_server_settled_it() {
        assert!(LaunchBlob {
            consent: None,
            ..blob()
        }
        .validate()
        .is_err());
        let ask = LaunchBlob {
            decision: ConsentDecision::LocalApproval,
            ..blob()
        };
        assert!(
            ask.validate().is_err(),
            "a card is going to be shown; consent must be null"
        );
        let ask = LaunchBlob {
            decision: ConsentDecision::LocalApproval,
            consent: None,
            ..blob()
        };
        assert!(ask.validate().is_ok());
        let empty = LaunchBlob {
            consent: Some(BlobConsent {
                level: "control".into(),
                monitors: vec![],
                clipboard: false,
            }),
            ..blob()
        };
        assert!(empty.validate().is_err());
    }

    #[test]
    fn an_oversize_blob_is_refused_before_it_is_parsed() {
        let big = vec![b'{'; BLOB_MAX + 1];
        assert_eq!(
            LaunchBlob::parse(&big).unwrap_err(),
            BlobError::TooLarge(BLOB_MAX + 1)
        );
    }

    #[test]
    fn a_rebuild_blob_carries_the_next_generation() {
        let b = LaunchBlob {
            gen: 3,
            secure_desktop: true,
            ..blob()
        };
        let back = LaunchBlob::parse(&b.to_bytes().unwrap()).unwrap();
        assert_eq!(back.gen, 3);
        assert!(back.starts_on_secure_desktop());
    }
}
