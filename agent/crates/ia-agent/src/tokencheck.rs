//! The local token check that runs **before the first network call** (contract §2.1, security
//! C10): a compact `ia1.*` token is parsed, its Ed25519 signature verified against the region
//! public key(s) compiled into the build (`IA_TOKEN_PUBKEYS`, comma-separated base64url, the
//! keys `/.well-known/indiansassist.json` publishes) and its `iat` / `exp` checked; a 12-digit
//! code is Luhn-checked. A failure means "This code is not valid" and no socket is opened.
//!
//! A build compiled without a key (a local dev build) cannot verify the signature: it checks
//! the structure and the time window only and says so in the log; the server check is
//! authoritative either way.

use ia_core::join_input::{is_valid_short_code, TokenInput};
use ia_core::token::{check_token, check_token_unsigned, public_key_from_b64url, TokenCheckError};

/// The region keys compiled into this build.
pub fn compiled_keys() -> Vec<[u8; 32]> {
    parse_keys(option_env!("IA_TOKEN_PUBKEYS").unwrap_or(""))
}

/// Parse a comma-separated list of base64url public keys (invalid entries are dropped).
pub fn parse_keys(list: &str) -> Vec<[u8; 32]> {
    list.split(',')
        .filter(|s| !s.trim().is_empty())
        .filter_map(public_key_from_b64url)
        .collect()
}

/// How the local check went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalCheck {
    /// A compact token verified against a compiled key.
    Verified { tier: String, region: String },
    /// A compact token with a valid structure and time window; no key compiled in to check the
    /// signature (dev build).
    Unsigned { tier: String, region: String },
    /// A Luhn-valid 12-digit code (resolved by the server).
    ShortCode,
    /// Not valid: do not connect.
    Invalid(&'static str),
}

/// Run the check for `token` with `keys` at `now_sec`.
pub fn local_check(token: &TokenInput, keys: &[[u8; 32]], now_sec: u64) -> LocalCheck {
    match token {
        TokenInput::ShortCode(c) => {
            if is_valid_short_code(c) {
                LocalCheck::ShortCode
            } else {
                LocalCheck::Invalid("short_code_invalid")
            }
        }
        TokenInput::Compact(t) if keys.is_empty() => match check_token_unsigned(t, now_sec) {
            Ok(f) => LocalCheck::Unsigned {
                tier: f.tier,
                region: f.region,
            },
            Err(e) => LocalCheck::Invalid(e.as_str()),
        },
        TokenInput::Compact(t) => match check_token(t, keys, now_sec) {
            Ok(f) => LocalCheck::Verified {
                tier: f.tier,
                region: f.region,
            },
            Err(e @ TokenCheckError::Malformed)
            | Err(e @ TokenCheckError::BadSignature)
            | Err(e @ TokenCheckError::Expired) => LocalCheck::Invalid(e.as_str()),
        },
    }
}

/// Seconds since the Unix epoch.
pub fn now_sec() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TS_TOKEN: &str = "ia1.21fe31dfa154a261.eyJieSI6IjMzMzMzMzMzLTMzMzMtNDMzMy04MzMzLTMzMzMzMzMzMzMzMyIsImV4cCI6MTgwMDAwMzYwMCwiaWF0IjoxODAwMDAwMDAwLCJub25jZSI6IlpRcFpxNW0tRXczajNrT3FoTF85TXciLCJvcmciOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJyZWciOiJpbi1tdW0iLCJ0aWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJ0aWVyIjoicDNfcG9ydGFibGUiLCJ0eXAiOiJvbmVfdGltZSIsInYiOjF9.6zXv1MUNrQHLxW_Udde5o7LQO9MZ4NH1AMSOlPLuOL6AhyUJIVGfrNj2gMbWnwO-JHsnF9vXA6bkcQmvq2MQDg";
    const TS_PUB: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

    #[test]
    fn compiled_key_list_parses() {
        let keys = parse_keys(&format!(" {TS_PUB} ,not-a-key,,"));
        assert_eq!(keys.len(), 1);
        assert!(parse_keys("").is_empty());
    }

    #[test]
    fn verified_unsigned_and_invalid_outcomes() {
        let keys = parse_keys(TS_PUB);
        let tok = TokenInput::Compact(TS_TOKEN.into());
        assert_eq!(
            local_check(&tok, &keys, 1_800_000_100),
            LocalCheck::Verified {
                tier: "p3_portable".into(),
                region: "in-mum".into()
            }
        );
        assert!(matches!(
            local_check(&tok, &[], 1_800_000_100),
            LocalCheck::Unsigned { .. }
        ));
        assert_eq!(
            local_check(&tok, &keys, 1_900_000_000),
            LocalCheck::Invalid("token_gone")
        );
        let other = parse_keys("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(
            local_check(&tok, &other, 1_800_000_100),
            LocalCheck::Invalid("token_bad_signature")
        );
    }

    #[test]
    fn short_codes_are_luhn_checked() {
        // The first Luhn-valid 12-digit code.
        let good = (100_000_000_000u64..)
            .map(|n| n.to_string())
            .find(|s| is_valid_short_code(s))
            .unwrap();
        assert_eq!(
            local_check(&TokenInput::ShortCode(good), &[], 0),
            LocalCheck::ShortCode
        );
        assert_eq!(
            local_check(&TokenInput::ShortCode("100000000001".into()), &[], 0),
            LocalCheck::Invalid("short_code_invalid")
        );
    }
}
