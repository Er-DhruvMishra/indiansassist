//! Phase D device signatures (`docs/specs/phase-d-contracts.md` §3.8 and the conventions
//! table): every Ed25519 signature a device makes is over
//! `deviceSigningInput(domain, fields)` = `utf8(domain)` then, per field in the table's
//! order, a 4-byte big-endian length and the field bytes.
//!
//! The TypeScript authority is `packages/shared/src/fleet/signing.ts`; this module is its
//! mirror and both are checked against `packages/shared/test/fixtures/fleet/signatures.json`
//! (see `tests/fleet_vectors.rs`). Field encodings: UUIDs as their lower-case 36-char text,
//! base64url values decoded to raw bytes, integers as decimal ASCII, structured payloads as
//! canonical JSON, plain text as UTF-8. Pure Ed25519 (RFC 8032), no prehash.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canonical::canonical_json;
use crate::{CoreError, CoreResult};

/// The eight signature domains of §3.8 (`DEVICE_SIG_DOMAINS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SigDomain {
    #[serde(rename = "ia-enroll-v1")]
    Enroll,
    #[serde(rename = "ia-dev-v1")]
    Hello,
    #[serde(rename = "ia-rot-v1")]
    Rotate,
    #[serde(rename = "ia-rot-new-v1")]
    RotateNew,
    #[serde(rename = "ia-dereg-v1")]
    Deregister,
    #[serde(rename = "ia-tamper-v1")]
    Tamper,
    #[serde(rename = "ia-action-v1")]
    Action,
    #[serde(rename = "ia-sas-v1")]
    Sas,
}

impl SigDomain {
    pub fn as_str(self) -> &'static str {
        match self {
            SigDomain::Enroll => "ia-enroll-v1",
            SigDomain::Hello => "ia-dev-v1",
            SigDomain::Rotate => "ia-rot-v1",
            SigDomain::RotateNew => "ia-rot-new-v1",
            SigDomain::Deregister => "ia-dereg-v1",
            SigDomain::Tamper => "ia-tamper-v1",
            SigDomain::Action => "ia-action-v1",
            SigDomain::Sas => "ia-sas-v1",
        }
    }
}

/// All eight domains, in the §3.8 table's order (the fixture iterates this list).
pub const SIG_DOMAINS: [SigDomain; 8] = [
    SigDomain::Enroll,
    SigDomain::Hello,
    SigDomain::Rotate,
    SigDomain::RotateNew,
    SigDomain::Deregister,
    SigDomain::Tamper,
    SigDomain::Action,
    SigDomain::Sas,
];

/// One signed field and its encoding (the TS `DeviceSigField`).
#[derive(Debug, Clone)]
pub enum SigField<'a> {
    /// A lower-case 36-char UUID, signed as its text.
    Uuid(&'a str),
    /// A base64url value decoded to raw bytes; `len` asserts the decoded length.
    B64u { value: &'a str, len: Option<usize> },
    /// A safe integer, signed as decimal ASCII.
    Int(i64),
    /// A structured payload, signed as canonical JSON.
    Json(&'a Value),
    /// Plain text, signed as UTF-8.
    Text(&'a str),
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
    })
}

fn field_bytes(f: &SigField<'_>) -> CoreResult<Vec<u8>> {
    match f {
        SigField::Uuid(v) => {
            if !is_uuid(v) {
                return Err(CoreError::BadInput(
                    "device signature field: expected a lower-case uuid".into(),
                ));
            }
            Ok(v.as_bytes().to_vec())
        }
        SigField::B64u { value, len } => {
            let b = URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| CoreError::BadInput("device signature field: not base64url".into()))?;
            if let Some(n) = len {
                if b.len() != *n {
                    return Err(CoreError::BadInput(format!(
                        "device signature field: expected {n} bytes"
                    )));
                }
            }
            Ok(b)
        }
        SigField::Int(v) => Ok(v.to_string().into_bytes()),
        SigField::Json(v) => Ok(canonical_json(v).into_bytes()),
        SigField::Text(v) => Ok(v.as_bytes().to_vec()),
    }
}

/// The bytes a device signs for `domain` over `fields` (§3.8 framing).
pub fn device_signing_input(domain: SigDomain, fields: &[SigField<'_>]) -> CoreResult<Vec<u8>> {
    let mut out = domain.as_str().as_bytes().to_vec();
    for f in fields {
        let b = field_bytes(f)?;
        out.extend_from_slice(&(b.len() as u32).to_be_bytes());
        out.extend_from_slice(&b);
    }
    Ok(out)
}

/// Per-domain builders: the field lists of the §3.8 table, in order.
pub mod input {
    use super::*;

    /// `ia-enroll-v1`: `tokenId`, `devicePublicKey`, `deviceKexPublicKey`.
    pub fn enroll(
        token_id: &str,
        device_public_key: &str,
        device_kex_public_key: &str,
    ) -> CoreResult<Vec<u8>> {
        device_signing_input(
            SigDomain::Enroll,
            &[
                SigField::Uuid(token_id),
                SigField::B64u {
                    value: device_public_key,
                    len: Some(32),
                },
                SigField::B64u {
                    value: device_kex_public_key,
                    len: Some(32),
                },
            ],
        )
    }

    /// `ia-dev-v1`: `deviceId`, `serverChallenge`, `nonce`.
    pub fn hello(device_id: &str, server_challenge: &str, nonce: &str) -> CoreResult<Vec<u8>> {
        device_signing_input(
            SigDomain::Hello,
            &[
                SigField::Uuid(device_id),
                SigField::B64u {
                    value: server_challenge,
                    len: Some(32),
                },
                SigField::B64u {
                    value: nonce,
                    len: Some(16),
                },
            ],
        )
    }

    /// `ia-rot-v1`: `deviceId`, `rotationNonce`, `newPublicKey`, `newKexPublicKey` (old key signs).
    pub fn rotate(
        device_id: &str,
        rotation_nonce: &str,
        new_public_key: &str,
        new_kex_public_key: &str,
    ) -> CoreResult<Vec<u8>> {
        device_signing_input(
            SigDomain::Rotate,
            &[
                SigField::Uuid(device_id),
                SigField::B64u {
                    value: rotation_nonce,
                    len: Some(16),
                },
                SigField::B64u {
                    value: new_public_key,
                    len: Some(32),
                },
                SigField::B64u {
                    value: new_kex_public_key,
                    len: Some(32),
                },
            ],
        )
    }

    /// `ia-rot-new-v1`: `deviceId`, `rotationNonce`, `oldKeyId` (the new key proves possession).
    pub fn rotate_new(
        device_id: &str,
        rotation_nonce: &str,
        old_key_id: &str,
    ) -> CoreResult<Vec<u8>> {
        device_signing_input(
            SigDomain::RotateNew,
            &[
                SigField::Uuid(device_id),
                SigField::B64u {
                    value: rotation_nonce,
                    len: Some(16),
                },
                SigField::Text(old_key_id),
            ],
        )
    }

    /// `ia-dereg-v1`: `deviceId`, `ts` (epoch ms), `nonce`.
    pub fn deregister(device_id: &str, ts_ms: i64, nonce: &str) -> CoreResult<Vec<u8>> {
        device_signing_input(
            SigDomain::Deregister,
            &[
                SigField::Uuid(device_id),
                SigField::Int(ts_ms),
                SigField::B64u {
                    value: nonce,
                    len: Some(16),
                },
            ],
        )
    }

    /// `ia-tamper-v1`: `deviceId` and the canonical JSON of the event **without** `sig`.
    pub fn tamper(device_id: &str, event: &Value) -> CoreResult<Vec<u8>> {
        let mut e = event.clone();
        if let Some(o) = e.as_object_mut() {
            o.remove("sig");
        }
        device_signing_input(
            SigDomain::Tamper,
            &[SigField::Uuid(device_id), SigField::Json(&e)],
        )
    }

    /// `ia-action-v1`: `deviceId` and `{ actionId, state, approvedBy?, result? }` with absent keys omitted.
    pub fn action(
        device_id: &str,
        action_id: &str,
        state: &str,
        approved_by: Option<&str>,
        result: Option<&Value>,
    ) -> CoreResult<Vec<u8>> {
        let mut payload = serde_json::Map::new();
        payload.insert("actionId".into(), Value::String(action_id.to_string()));
        payload.insert("state".into(), Value::String(state.to_string()));
        if let Some(a) = approved_by {
            payload.insert("approvedBy".into(), Value::String(a.to_string()));
        }
        if let Some(r) = result {
            payload.insert("result".into(), r.clone());
        }
        let v = Value::Object(payload);
        device_signing_input(
            SigDomain::Action,
            &[SigField::Uuid(device_id), SigField::Json(&v)],
        )
    }

    /// `ia-sas-v1` (rule 3.5b): `sessionId`, `gen`, `sas`, `deskFpr`, `assistFpr`.
    pub fn sas(
        session_id: &str,
        gen: u32,
        sas: &str,
        desk_fpr: &str,
        assist_fpr: &str,
    ) -> CoreResult<Vec<u8>> {
        device_signing_input(
            SigDomain::Sas,
            &[
                SigField::Uuid(session_id),
                SigField::Int(i64::from(gen)),
                SigField::Text(sas),
                SigField::Text(desk_fpr),
                SigField::Text(assist_fpr),
            ],
        )
    }
}

/// Signs `input` with a 32-byte Ed25519 seed; the signature is base64url (86 chars).
pub fn sign_device_input(input: &[u8], seed: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(seed).sign(input).to_bytes())
}

/// Verifies a base64url signature over `input` with a base64url public key. Never panics;
/// false on any defect (§15.1 "a bad signature never throwing").
pub fn verify_device_signature(input: &[u8], sig: &str, public_key: &str) -> bool {
    let Ok(s) = URL_SAFE_NO_PAD.decode(sig) else {
        return false;
    };
    let Ok(pk) = URL_SAFE_NO_PAD.decode(public_key) else {
        return false;
    };
    let (Ok(s), Ok(pk)): (Result<[u8; 64], _>, Result<[u8; 32], _>) = (s.try_into(), pk.try_into())
    else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else {
        return false;
    };
    vk.verify(input, &Signature::from_bytes(&s)).is_ok()
}

/// The base64url Ed25519 public key of a 32-byte seed.
pub fn device_public_key_of(seed: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(seed).verifying_key().to_bytes())
}

/// `kidOf` (shared `crypto.ts`): the first 16 hex chars of sha256 over the 32-byte key.
pub fn kid_of(public_key: &[u8]) -> CoreResult<String> {
    if public_key.len() != 32 {
        return Err(CoreError::BadInput("public key must be 32 bytes".into()));
    }
    Ok(hex::encode(Sha256::digest(public_key))[..16].to_string())
}

/// `kidOf` over a base64url key.
pub fn kid_of_b64u(public_key: &str) -> CoreResult<String> {
    let b = URL_SAFE_NO_PAD
        .decode(public_key)
        .map_err(|_| CoreError::BadInput("public key is not base64url".into()))?;
    kid_of(&b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SEED: [u8; 32] = [0x11; 32];

    #[test]
    fn framing_is_domain_then_length_prefixed_fields() {
        let got = device_signing_input(SigDomain::Hello, &[SigField::Text("ab"), SigField::Int(7)])
            .unwrap();
        let mut want = b"ia-dev-v1".to_vec();
        want.extend_from_slice(&2u32.to_be_bytes());
        want.extend_from_slice(b"ab");
        want.extend_from_slice(&1u32.to_be_bytes());
        want.extend_from_slice(b"7");
        assert_eq!(got, want);
    }

    #[test]
    fn a_field_of_the_wrong_length_or_shape_is_refused() {
        assert!(matches!(
            device_signing_input(SigDomain::Hello, &[SigField::Uuid("NOT-A-UUID")]),
            Err(CoreError::BadInput(_))
        ));
        assert!(matches!(
            device_signing_input(
                SigDomain::Hello,
                &[SigField::B64u {
                    value: "AAAA",
                    len: Some(32)
                }]
            ),
            Err(CoreError::BadInput(_))
        ));
    }

    #[test]
    fn sign_round_trips_and_a_flipped_byte_fails_without_panicking() {
        let input = input::deregister(
            "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a",
            1_793_520_000_000,
            &URL_SAFE_NO_PAD.encode([0x66; 16]),
        )
        .unwrap();
        let pk = device_public_key_of(&SEED);
        let sig = sign_device_input(&input, &SEED);
        assert!(verify_device_signature(&input, &sig, &pk));
        let mut bad = input.clone();
        bad[0] ^= 1;
        assert!(!verify_device_signature(&bad, &sig, &pk));
        assert!(!verify_device_signature(&input, "not-base64url-$$", &pk));
        assert!(!verify_device_signature(&input, &sig, "AAAA"));
    }

    #[test]
    fn the_tamper_domain_drops_sig_before_signing() {
        let with = json!({ "id": "x", "cause": "stopped", "sig": "ignored" });
        let without = json!({ "id": "x", "cause": "stopped" });
        assert_eq!(
            input::tamper("0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a", &with).unwrap(),
            input::tamper("0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a", &without).unwrap()
        );
    }

    #[test]
    fn the_action_domain_omits_absent_keys() {
        let id = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let a = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
        let only = input::action(id, a, "running", None, None).unwrap();
        let text = String::from_utf8_lossy(&only).to_string();
        assert!(text
            .contains(r#"{"actionId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","state":"running"}"#));
    }

    #[test]
    fn kid_is_sixteen_hex_chars() {
        let pk = device_public_key_of(&SEED);
        let kid = kid_of_b64u(&pk).unwrap();
        assert_eq!(kid.len(), 16);
        assert!(kid
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
