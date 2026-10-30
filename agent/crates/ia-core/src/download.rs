//! Download carriers: the stub filename grammar (§2.3), the signed `.iaconfig` sidecar
//! (§2.4), the desk-code generator, and the manifest / prepare wire types (§2.2).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::OnceLock;

use crate::canonical::canonical_json;
use crate::join_input::is_valid_short_code;

/// `AGENT_FILENAME_RE` (contract §2.3). Case-insensitive; tolerates a ` (1)` suffix.
fn filename_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^IndiansAssist-(?P<region>[a-z]{2}-[a-z]{3,5})-(?P<a>\d{4})-(?P<b>\d{4})-(?P<c>\d{4})(?: \(\d+\))?\.exe$",
        )
        .unwrap()
    })
}

/// A parsed stub filename (contract §2.3 rank 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFilename {
    pub region: String,
    /// The 12-digit desk code (Luhn-valid).
    pub code: String,
}

/// Parse `current_exe` file name. `region` must be in `allowed_regions` (the compiled
/// `IA_REGION_ORIGINS` list) and the 12 digits Luhn-valid.
pub fn parse_filename(file_name: &str, allowed_regions: &[&str]) -> Option<ParsedFilename> {
    let caps = filename_re().captures(file_name)?;
    let region = caps.name("region")?.as_str().to_lowercase();
    if !allowed_regions
        .iter()
        .any(|r| r.eq_ignore_ascii_case(&region))
    {
        return None;
    }
    let code = format!(
        "{}{}{}",
        caps.name("a")?.as_str(),
        caps.name("b")?.as_str(),
        caps.name("c")?.as_str()
    );
    if !is_valid_short_code(&code) {
        return None;
    }
    Some(ParsedFilename { region, code })
}

/// The signed sidecar `iaconfigSchema` (contract §2.4). Unknown keys are an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Iaconfig {
    pub v: u8,
    #[serde(rename = "apiOrigin")]
    pub api_origin: String,
    pub region: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(rename = "deskLabel", default, skip_serializing_if = "Option::is_none")]
    pub desk_label: Option<String>,
    pub kid: String,
    pub sig: String,
}

/// Parse a sidecar JSON, enforcing size (`iaconfigMaxBytes`) and the strict schema.
pub fn parse_iaconfig(bytes: &[u8]) -> Result<Iaconfig, String> {
    if bytes.len() > crate::types::limits::IACONFIG_MAX_BYTES {
        return Err("iaconfig too large".into());
    }
    let cfg: Iaconfig = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if cfg.v != 1 {
        return Err("unsupported iaconfig version".into());
    }
    if let Some(label) = &cfg.desk_label {
        if label.chars().count() > 80 {
            return Err("deskLabel too long".into());
        }
    }
    Ok(cfg)
}

/// `iaconfigSigningInput(cfg)` = `canonicalJson(sidecar minus sig)` (contract §2.4).
pub fn iaconfig_signing_input(cfg: &Iaconfig) -> String {
    let mut obj = json!({
        "v": cfg.v,
        "apiOrigin": cfg.api_origin,
        "region": cfg.region,
        "kid": cfg.kid,
    });
    if let Some(code) = &cfg.code {
        obj["code"] = json!(code);
    }
    if let Some(label) = &cfg.desk_label {
        obj["deskLabel"] = json!(label);
    }
    canonical_json(&obj)
}

/// Verify the sidecar's Ed25519 `sig` against a region public key (contract §2.4).
pub fn verify_iaconfig_sig(cfg: &Iaconfig, pubkey_b64: &str) -> bool {
    let pk_bytes = match URL_SAFE_NO_PAD.decode(pubkey_b64) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let pk_arr: [u8; 32] = match pk_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let vk = match VerifyingKey::from_bytes(&pk_arr) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let sig_bytes = match URL_SAFE_NO_PAD.decode(&cfg.sig) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let sig_arr: [u8; 64] = match sig_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify(iaconfig_signing_input(cfg).as_bytes(), &sig)
        .is_ok()
}

/// `makeDeskCode()` — 12 digits, Luhn-valid (contract §2.2).
pub fn make_desk_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    loop {
        let mut s = String::with_capacity(12);
        for _ in 0..11 {
            s.push(char::from(b'0' + rng.gen_range(0..10)));
        }
        // Append the Luhn check digit.
        let check = luhn_check_digit(&s);
        s.push(char::from(b'0' + check));
        if is_valid_short_code(&s) {
            return s;
        }
    }
}

fn luhn_check_digit(prefix11: &str) -> u8 {
    // The check digit makes the whole 12-digit string pass Luhn.
    let mut sum = 0u32;
    // Positions as if the check digit (not yet appended) is position 1.
    for (i, c) in prefix11.bytes().rev().enumerate() {
        let mut d = (c - b'0') as u32;
        // With the check digit appended, these move to even positions (doubled).
        if i % 2 == 0 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    ((10 - (sum % 10)) % 10) as u8
}

/// `AgentBuild` (contract §2.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentBuild {
    pub platform: String,
    pub arch: String,
    pub version: String,
    pub size: u64,
    pub sha256: String,
    pub signed: bool,
    #[serde(rename = "minOs")]
    pub min_os: String,
}

/// `GET /download/manifest` reply (contract §2.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadManifest {
    pub v: u8,
    pub builds: Vec<AgentBuild>,
}

/// `POST /download/prepare` reply (contract §2.2); carries the desk code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadPrepareReply {
    pub url: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    pub filename: String,
    #[serde(rename = "deskCode")]
    pub desk_code: String,
    pub version: String,
    pub sha256: String,
    pub signed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand_core::OsRng;

    const REGIONS: &[&str] = &["in-mum", "us-iad", "eu-fra"];

    #[test]
    fn filename_grammar_parses_desk_code_and_region() {
        // Build a Luhn-valid 12-digit code and split into 4-4-4.
        let code = make_desk_code();
        let name = format!(
            "IndiansAssist-in-mum-{}-{}-{}.exe",
            &code[..4],
            &code[4..8],
            &code[8..]
        );
        let parsed = parse_filename(&name, REGIONS).unwrap();
        assert_eq!(parsed.region, "in-mum");
        assert_eq!(parsed.code, code);
    }

    #[test]
    fn tolerates_browser_duplicate_suffix() {
        let code = make_desk_code();
        let name = format!(
            "IndiansAssist-in-mum-{}-{}-{} (1).exe",
            &code[..4],
            &code[4..8],
            &code[8..]
        );
        assert!(parse_filename(&name, REGIONS).is_some());
    }

    #[test]
    fn rejects_unknown_region() {
        let code = make_desk_code();
        let name = format!(
            "IndiansAssist-zz-xxx-{}-{}-{}.exe",
            &code[..4],
            &code[4..8],
            &code[8..]
        );
        assert_eq!(parse_filename(&name, REGIONS), None);
    }

    #[test]
    fn make_desk_code_is_luhn_valid() {
        for _ in 0..200 {
            let c = make_desk_code();
            assert_eq!(c.len(), 12);
            assert!(is_valid_short_code(&c), "{c} not luhn valid");
        }
    }

    #[test]
    fn iaconfig_rejects_unknown_keys() {
        let bad =
            br#"{"v":1,"apiOrigin":"https://x","region":"in-mum","kid":"k","sig":"s","evil":1}"#;
        assert!(parse_iaconfig(bad).is_err());
    }

    #[test]
    fn signing_input_excludes_sig_and_is_canonical() {
        let cfg = Iaconfig {
            v: 1,
            api_origin: "https://in.example".into(),
            region: "in-mum".into(),
            code: Some("ia1.abc".into()),
            desk_label: Some("Rahul".into()),
            kid: "3f9a1c2b4d5e6f70".into(),
            sig: "ignored".into(),
        };
        let input = iaconfig_signing_input(&cfg);
        assert!(!input.contains("\"sig\""));
        // Canonical => keys ascending.
        assert!(input.starts_with(r#"{"apiOrigin":"#));
    }

    #[test]
    fn signature_round_trips() {
        let sk = SigningKey::generate(&mut OsRng);
        let vk = sk.verifying_key();
        let pub_b64 = URL_SAFE_NO_PAD.encode(vk.to_bytes());

        let mut cfg = Iaconfig {
            v: 1,
            api_origin: "https://in.example".into(),
            region: "in-mum".into(),
            code: None,
            desk_label: None,
            kid: "testkid".into(),
            sig: String::new(),
        };
        let sig = sk.sign(iaconfig_signing_input(&cfg).as_bytes());
        cfg.sig = URL_SAFE_NO_PAD.encode(sig.to_bytes());

        assert!(verify_iaconfig_sig(&cfg, &pub_b64));

        // Tamper with the origin => verification fails.
        let mut tampered = cfg.clone();
        tampered.api_origin = "https://attacker.example".into();
        assert!(!verify_iaconfig_sig(&tampered, &pub_b64));
    }

    #[test]
    fn manifest_round_trips() {
        let m = DownloadManifest {
            v: 1,
            builds: vec![AgentBuild {
                platform: "windows".into(),
                arch: "x64".into(),
                version: "0.3.0".into(),
                size: 12_345,
                sha256: "ab".repeat(32),
                signed: true,
                min_os: "10.0.19041".into(),
            }],
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"minOs\""));
        assert_eq!(serde_json::from_str::<DownloadManifest>(&json).unwrap(), m);
    }
}
