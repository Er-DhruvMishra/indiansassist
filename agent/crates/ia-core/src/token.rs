//! The compact support token client check (contract §2.1 "a compact token is verified locally
//! before any network call", A §3.4-3.5 client subset), a port of the shared TS
//! `checkToken` (`packages/shared/src/token/codec.ts`): parse `ia1.<kid>.<payload>.<sig>`,
//! require the canonical payload with exactly the ten fields, verify the Ed25519 signature with
//! the key whose kid (first 16 hex of sha256 over the raw public key) matches, and check
//! `iat <= now + 60 && now < exp`. The server check stays authoritative (it alone knows the
//! token's status, the region set and the database).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canonical::canonical_json;

/// Why a compact token failed the local check (the shared `TokenCheckResult` errors).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenCheckError {
    /// Structure, encoding, field set / types or canonical form.
    Malformed,
    /// No key with that kid, or the signature does not verify.
    BadSignature,
    /// `iat` in the future (beyond 60 s skew) or `exp` reached.
    Expired,
}

impl TokenCheckError {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenCheckError::Malformed => "token_malformed",
            TokenCheckError::BadSignature => "token_bad_signature",
            TokenCheckError::Expired => "token_gone",
        }
    }
}

/// The payload facts the agent uses after a successful check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenFacts {
    pub kid: String,
    pub tid: String,
    pub tier: String,
    pub typ: String,
    pub region: String,
    pub iat: u64,
    pub exp: u64,
}

/// The kid of a raw 32-byte Ed25519 public key.
pub fn kid_of(public_key: &[u8; 32]) -> String {
    hex::encode(Sha256::digest(public_key))[..16].to_string()
}

/// Decode a base64url (no padding) 32-byte public key, as `/.well-known` publishes them.
pub fn public_key_from_b64url(s: &str) -> Option<[u8; 32]> {
    let bytes = URL_SAFE_NO_PAD.decode(s.trim()).ok()?;
    bytes.try_into().ok()
}

fn is_segment(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

const TIERS: &[&str] = &["p1_browser", "p2_extension", "p3_portable", "p4_installed"];
const TYPES: &[&str] = &["one_time", "timed", "enrollment"];
/// The regions a token, a desk code filename and a sidecar may name (`REGIONS`, A §1).
pub const REGIONS: &[&str] = &["in-mum", "eu-fra", "us-east"];
const FIELDS: &[&str] = &[
    "by", "exp", "iat", "nonce", "org", "reg", "tid", "tier", "typ", "v",
];

/// Steps 1-2: the structure and the strict, canonical payload.
fn parse(compact: &str) -> Result<(String, Vec<u8>, Value, Vec<u8>), TokenCheckError> {
    use TokenCheckError::Malformed;
    if compact.len() > 4096 {
        return Err(Malformed);
    }
    let parts: Vec<&str> = compact.split('.').collect();
    let [prefix, kid, payload, sig] = parts[..] else {
        return Err(Malformed);
    };
    let kid_ok = kid.len() == 16
        && kid
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    if prefix != "ia1" || !kid_ok || !is_segment(payload) || !is_segment(sig) {
        return Err(Malformed);
    }
    let payload_bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| Malformed)?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig).map_err(|_| Malformed)?;
    let json = std::str::from_utf8(&payload_bytes).map_err(|_| Malformed)?;
    let value: Value = serde_json::from_str(json).map_err(|_| Malformed)?;
    let obj = value.as_object().ok_or(Malformed)?;
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if keys != FIELDS {
        return Err(Malformed);
    }
    let s = |k: &str| obj.get(k).and_then(Value::as_str).ok_or(Malformed);
    let n = |k: &str| obj.get(k).and_then(Value::as_u64).ok_or(Malformed);
    if obj.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(Malformed);
    }
    if !is_uuid(s("tid")?) || !is_uuid(s("org")?) || !is_uuid(s("by")?) {
        return Err(Malformed);
    }
    if !TIERS.contains(&s("tier")?) || !TYPES.contains(&s("typ")?) || !REGIONS.contains(&s("reg")?)
    {
        return Err(Malformed);
    }
    let nonce = s("nonce")?;
    if nonce.len() != 22 || !is_segment(nonce) {
        return Err(Malformed);
    }
    n("iat")?;
    n("exp")?;
    if canonical_json(&value) != json {
        return Err(Malformed);
    }
    Ok((kid.to_string(), payload_bytes, value, sig_bytes))
}

/// The shared `checkToken`: parse, signature against `keys`, then time (`now_sec` unix seconds).
pub fn check_token(
    compact: &str,
    keys: &[[u8; 32]],
    now_sec: u64,
) -> Result<TokenFacts, TokenCheckError> {
    let (kid, payload_bytes, value, sig_bytes) = parse(compact)?;
    let key = keys
        .iter()
        .find(|k| kid_of(k) == kid)
        .ok_or(TokenCheckError::BadSignature)?;
    let vk = VerifyingKey::from_bytes(key).map_err(|_| TokenCheckError::BadSignature)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| TokenCheckError::BadSignature)?;
    vk.verify(&payload_bytes, &sig)
        .map_err(|_| TokenCheckError::BadSignature)?;
    let facts = facts(kid, &value);
    if !(facts.iat <= now_sec + 60 && now_sec < facts.exp) {
        return Err(TokenCheckError::Expired);
    }
    Ok(facts)
}

/// Structure and time only, for a build with no compiled key (dev): the signature is left to
/// the server. Never used when a key is compiled in.
pub fn check_token_unsigned(compact: &str, now_sec: u64) -> Result<TokenFacts, TokenCheckError> {
    let (kid, _, value, _) = parse(compact)?;
    let facts = facts(kid, &value);
    if !(facts.iat <= now_sec + 60 && now_sec < facts.exp) {
        return Err(TokenCheckError::Expired);
    }
    Ok(facts)
}

fn facts(kid: String, v: &Value) -> TokenFacts {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    TokenFacts {
        kid,
        tid: s("tid"),
        tier: s("tier"),
        typ: s("typ"),
        region: s("reg"),
        iat: n("iat"),
        exp: n("exp"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minted by the shared TS `signToken` (packages/shared/src/token/codec.ts) with the RFC 8032
    // test seed 9d61b1...7f60, iat 1800000000, exp 1800003600: a cross-language vector.
    const TS_TOKEN: &str = "ia1.21fe31dfa154a261.eyJieSI6IjMzMzMzMzMzLTMzMzMtNDMzMy04MzMzLTMzMzMzMzMzMzMzMyIsImV4cCI6MTgwMDAwMzYwMCwiaWF0IjoxODAwMDAwMDAwLCJub25jZSI6IlpRcFpxNW0tRXczajNrT3FoTF85TXciLCJvcmciOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJyZWciOiJpbi1tdW0iLCJ0aWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJ0aWVyIjoicDNfcG9ydGFibGUiLCJ0eXAiOiJvbmVfdGltZSIsInYiOjF9.6zXv1MUNrQHLxW_Udde5o7LQO9MZ4NH1AMSOlPLuOL6AhyUJIVGfrNj2gMbWnwO-JHsnF9vXA6bkcQmvq2MQDg";
    const TS_PUB: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const NOW: u64 = 1_800_000_100;

    fn key() -> [u8; 32] {
        public_key_from_b64url(TS_PUB).unwrap()
    }

    #[test]
    fn a_ts_minted_token_verifies() {
        assert_eq!(kid_of(&key()), "21fe31dfa154a261");
        let f = check_token(TS_TOKEN, &[key()], NOW).unwrap();
        assert_eq!(f.tier, "p3_portable");
        assert_eq!(f.typ, "one_time");
        assert_eq!(f.region, "in-mum");
        assert_eq!(f.tid, "11111111-1111-4111-8111-111111111111");
    }

    #[test]
    fn time_window_is_enforced() {
        assert_eq!(
            check_token(TS_TOKEN, &[key()], 1_800_003_600),
            Err(TokenCheckError::Expired)
        );
        // iat may be up to 60 s ahead of the local clock (skew), not more.
        assert!(check_token(TS_TOKEN, &[key()], 1_800_000_000 - 60).is_ok());
        assert_eq!(
            check_token(TS_TOKEN, &[key()], 1_800_000_000 - 61),
            Err(TokenCheckError::Expired)
        );
    }

    #[test]
    fn wrong_key_or_tampering_fails_the_signature() {
        let other = [7u8; 32];
        // A key with another kid: no matching key.
        let k = ed25519_dalek::SigningKey::from_bytes(&other)
            .verifying_key()
            .to_bytes();
        assert_eq!(
            check_token(TS_TOKEN, &[k], NOW),
            Err(TokenCheckError::BadSignature)
        );
        // A flipped signature byte.
        let mut t = TS_TOKEN.to_string();
        let last = t.pop().unwrap();
        t.push(if last == 'g' { 'h' } else { 'g' });
        assert!(check_token(&t, &[key()], NOW).is_err());
        assert_eq!(
            check_token(TS_TOKEN, &[], NOW),
            Err(TokenCheckError::BadSignature)
        );
    }

    #[test]
    fn structure_and_canonical_form_are_strict() {
        for bad in [
            "",
            "ia1.a.b.c",
            "ia2.21fe31dfa154a261.e30.AAAA",
            "ia1.21fe31dfa154a261.e30.AAAA", // `{}`: missing fields
            "ia1.21fe31dfa154a261.@@@.AAAA",
        ] {
            assert_eq!(
                check_token(bad, &[key()], NOW),
                Err(TokenCheckError::Malformed),
                "{bad}"
            );
        }
        // A re-encoded payload with whitespace is not canonical.
        let payload = TS_TOKEN.split('.').nth(2).unwrap();
        let json = String::from_utf8(URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        let spaced = json.replacen(',', ", ", 1);
        let t = format!(
            "ia1.21fe31dfa154a261.{}.{}",
            URL_SAFE_NO_PAD.encode(spaced),
            TS_TOKEN.split('.').nth(3).unwrap()
        );
        assert_eq!(
            check_token(&t, &[key()], NOW),
            Err(TokenCheckError::Malformed)
        );
    }

    #[test]
    fn unsigned_check_is_structure_and_time_only() {
        assert!(check_token_unsigned(TS_TOKEN, NOW).is_ok());
        assert_eq!(
            check_token_unsigned(TS_TOKEN, 1_900_000_000),
            Err(TokenCheckError::Expired)
        );
        assert_eq!(
            check_token_unsigned("ia1.x", NOW),
            Err(TokenCheckError::Malformed)
        );
    }
}
