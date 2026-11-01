//! Pure, platform-independent logic of the custom actions: decoding `IA_ENROLL`, the strict shape
//! check of a signed `enroll.iaconfig` (Phase D contracts section 12.3), the `config.json` the MSI
//! writes at install (section 4.1), and parsing the CustomActionData strings.
//!
//! The custom action does **not** verify the iaconfig signature: the region public keys are compiled
//! into `ia-service` (`IA_REGION_PUBKEYS`, C section 2.4), which verifies `sig` before it sends the
//! file to `POST /api/v1/devices/enroll`, and the server verifies it again. The shape check here only
//! stops a mistyped or truncated `IA_ENROLL` at install time, with an error the admin can see.

use serde::Deserialize;
use serde_json::{Map, Value};

/// `LIMITS.enrollConfigMaxBytes` (section 13.1).
pub const ENROLL_CONFIG_MAX_BYTES: usize = 16384;

/// Why an `IA_ENROLL` value was refused. Never carries any part of the secret.
#[derive(Debug, PartialEq, Eq)]
pub enum EnrollError {
    TooLarge,
    NotBase64url,
    NotUtf8,
    NotJson(String),
    Field(&'static str),
}

impl std::fmt::Display for EnrollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnrollError::TooLarge => write!(f, "larger than {ENROLL_CONFIG_MAX_BYTES} bytes"),
            EnrollError::NotBase64url => write!(f, "not base64url (A-Z a-z 0-9 - _, no padding)"),
            EnrollError::NotUtf8 => write!(f, "decoded bytes are not UTF-8"),
            EnrollError::NotJson(why) => write!(f, "not a strict enroll.iaconfig object ({why})"),
            EnrollError::Field(name) => write!(f, "field `{name}` is missing or malformed"),
        }
    }
}

/// The signed enroll.iaconfig, strict (unknown keys are an error).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EnrollConfig {
    pub v: u8,
    pub api_origin: String,
    pub signal_url: String,
    pub region: String,
    pub token: String,
    pub group_id: Option<String>,
    pub kid: String,
    pub sig: String,
}

fn b64url_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

/// Strict base64url without padding (RFC 4648 section 5). Rejects `=`, `+`, `/`, whitespace and
/// non-canonical trailing bits.
pub fn base64url_decode(input: &str) -> Result<Vec<u8>, EnrollError> {
    let bytes = input.as_bytes();
    if bytes.len() % 4 == 1 {
        return Err(EnrollError::NotBase64url);
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in bytes {
        let v = b64url_value(c).ok_or(EnrollError::NotBase64url)?;
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if acc != 0 {
        return Err(EnrollError::NotBase64url);
    }
    Ok(out)
}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(&c),
        })
}

/// `scheme://host[:port]`; returns what follows the authority. The plain scheme is accepted only for
/// a loopback host (a development region; the service applies the C section 2.4 dev/release rule).
fn origin_ok(s: &str, secure: &str, plain: &str) -> Option<String> {
    let rest = if let Some(r) = s.strip_prefix(secure) {
        r
    } else {
        let r = s.strip_prefix(plain)?;
        let host = r.split([':', '/']).next().unwrap_or("");
        if host != "localhost" && host != "127.0.0.1" {
            return None;
        }
        r
    };
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty()
        || !authority
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':')
    {
        return None;
    }
    Some(rest[authority.len()..].to_string())
}

impl EnrollConfig {
    fn check(&self) -> Result<(), EnrollError> {
        if self.v != 1 {
            return Err(EnrollError::Field("v"));
        }
        match origin_ok(&self.api_origin, "https://", "http://") {
            Some(path) if path.is_empty() && self.api_origin.len() <= 200 => {}
            _ => return Err(EnrollError::Field("apiOrigin")),
        }
        match origin_ok(&self.signal_url, "wss://", "ws://") {
            Some(path) if path == "/signal/device" && self.signal_url.len() <= 300 => {}
            _ => return Err(EnrollError::Field("signalUrl")),
        }
        let region_ok = (1..=32).contains(&self.region.len())
            && self
                .region
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !region_ok {
            return Err(EnrollError::Field("region"));
        }
        let token_ok = (1..=4096).contains(&self.token.len())
            && self.token.bytes().all(|b| b.is_ascii_graphic());
        if !token_ok {
            return Err(EnrollError::Field("token"));
        }
        if let Some(g) = &self.group_id {
            if !is_uuid(g) {
                return Err(EnrollError::Field("groupId"));
            }
        }
        if !is_lower_hex(&self.kid, 16) {
            return Err(EnrollError::Field("kid"));
        }
        let sig_ok = self.sig.len() == 86 && self.sig.bytes().all(|b| b64url_value(b).is_some());
        if !sig_ok {
            return Err(EnrollError::Field("sig"));
        }
        Ok(())
    }
}

/// Decodes `IA_ENROLL` (base64url of the signed enroll.iaconfig, surrounding ASCII whitespace
/// tolerated) and checks its shape. Returns the verbatim file bytes (the service sends them verbatim
/// as `enrollConfig`, section 3.2) and the parsed config.
pub fn decode_ia_enroll(value: &str) -> Result<(Vec<u8>, EnrollConfig), EnrollError> {
    let value = value.trim_matches(|c: char| c.is_ascii_whitespace());
    if value.len() > ENROLL_CONFIG_MAX_BYTES.div_ceil(3) * 4 {
        return Err(EnrollError::TooLarge);
    }
    let bytes = base64url_decode(value)?;
    if bytes.len() > ENROLL_CONFIG_MAX_BYTES {
        return Err(EnrollError::TooLarge);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| EnrollError::NotUtf8)?;
    // serde_json messages can quote string values (the token), so only the category and position
    // are reported.
    let not_json = |e: serde_json::Error| {
        EnrollError::NotJson(format!(
            "{:?} error at line {} column {}",
            e.classify(),
            e.line(),
            e.column()
        ))
    };
    let raw: Value = serde_json::from_str(text).map_err(not_json)?;
    // `groupId` must be present (null when the config has no group), as in the shared schema.
    if !raw.as_object().is_some_and(|o| o.contains_key("groupId")) {
        return Err(EnrollError::Field("groupId"));
    }
    let cfg: EnrollConfig = serde_json::from_value(raw).map_err(not_json)?;
    cfg.check()?;
    Ok((bytes, cfg))
}

/// An MSI opt-out property: empty = not given, "0"/"1" (also "false"/"true", "no"/"yes").
pub fn parse_opt_out(value: &str) -> Result<Option<bool>, EnrollError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" => Ok(None),
        "1" | "true" | "yes" => Ok(Some(true)),
        "0" | "false" | "no" => Ok(Some(false)),
        _ => Err(EnrollError::Field(
            "IA_WAKER_OPT_OUT / IA_AMT_PROXY_OPT_OUT",
        )),
    }
}

/// What to do with `%ProgramData%\IndiansAssist\config.json` (section 4.1).
///
/// * fresh install with an enroll config: write `{ apiOrigin, signalUrl, wakerOptOut, amtProxyOptOut }`
///   (opt-outs default false; `deviceId`/`keyId` are added by the service after enrollment);
/// * existing file: keep every key the service wrote; only opt-outs given explicitly on this
///   install are updated (an enrolled device's origin is never rewritten by a later MSI run);
/// * no file and no enroll config (repair, upgrade): nothing to write.
pub fn plan_config(
    existing: Option<&str>,
    enroll: Option<&EnrollConfig>,
    waker_opt_out: Option<bool>,
    amt_proxy_opt_out: Option<bool>,
) -> Result<Option<String>, String> {
    let mut map = match existing {
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(m)) => m,
            _ => return Err("existing config.json is not a JSON object; left untouched".into()),
        },
        None => {
            let Some(cfg) = enroll else { return Ok(None) };
            let mut m = Map::new();
            m.insert("apiOrigin".into(), Value::String(cfg.api_origin.clone()));
            m.insert("signalUrl".into(), Value::String(cfg.signal_url.clone()));
            m.insert("wakerOptOut".into(), Value::Bool(false));
            m.insert("amtProxyOptOut".into(), Value::Bool(false));
            m
        }
    };
    let before = map.clone();
    if let Some(v) = waker_opt_out {
        map.insert("wakerOptOut".into(), Value::Bool(v));
    }
    if let Some(v) = amt_proxy_opt_out {
        map.insert("amtProxyOptOut".into(), Value::Bool(v));
    }
    if existing.is_some() && map == before {
        return Ok(None);
    }
    serde_json::to_string_pretty(&Value::Object(map))
        .map(Some)
        .map_err(|e| e.to_string())
}

/// CustomActionData of `IaApplyInstall`: `installDir|dataDir|wakerOptOut|amtProxyOptOut|IA_ENROLL`.
/// `|` cannot occur in a Windows path nor in base64url.
pub struct ApplyInstallData<'a> {
    pub install_dir: &'a str,
    pub data_dir: &'a str,
    pub waker_opt_out: &'a str,
    pub amt_proxy_opt_out: &'a str,
    pub ia_enroll: &'a str,
}

pub fn parse_apply_install(data: &str) -> Option<ApplyInstallData<'_>> {
    let mut it = data.splitn(5, '|');
    let d = ApplyInstallData {
        install_dir: it.next()?,
        data_dir: it.next()?,
        waker_opt_out: it.next()?,
        amt_proxy_opt_out: it.next()?,
        ia_enroll: it.next()?,
    };
    (!d.install_dir.is_empty() && !d.data_dir.is_empty()).then_some(d)
}

/// CustomActionData of `IaWipeData`: `installDir|dataDir`.
pub fn parse_wipe(data: &str) -> Option<(&str, &str)> {
    let (a, b) = data.split_once('|')?;
    (!a.is_empty() && !b.is_empty() && !b.contains('|')).then_some((a, b))
}

/// Joins a directory property value (MSI directory values end with `\`) and a file name.
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('\\') {
        format!("{dir}{name}")
    } else {
        format!("{dir}\\{name}")
    }
}

/// Files under the data directory that hold key material and are overwritten before deletion
/// (section 3.3: `device.key`, `device.kex`, `*.privkey`).
pub fn is_key_material(file_name: &str) -> bool {
    let n = file_name.to_ascii_lowercase();
    n == "device.key" || n == "device.kex" || n.ends_with(".privkey") || n == "enroll.iaconfig"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64url(bytes: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut s = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk.len();
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let v = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..=n {
                s.push(A[((v >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        s
    }

    const SIG: &str =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn sample(group: &str) -> String {
        format!(
            r#"{{"apiOrigin":"https://in.indiansassist.example","groupId":{group},"kid":"3f9a1c2b4d5e6f70","region":"in-mum","sig":"{SIG}","signalUrl":"wss://in.indiansassist.example/signal/device","token":"ia1.abc.def","v":1}}"#
        )
    }

    #[test]
    fn base64url_round_trip_and_rejects() {
        for len in 0..40 {
            let data: Vec<u8> = (0..len as u8).map(|i| i.wrapping_mul(37)).collect();
            assert_eq!(base64url_decode(&b64url(&data)).unwrap(), data);
        }
        assert_eq!(base64url_decode("AA=="), Err(EnrollError::NotBase64url));
        assert_eq!(base64url_decode("A+/A"), Err(EnrollError::NotBase64url));
        assert_eq!(base64url_decode("A"), Err(EnrollError::NotBase64url));
        assert_eq!(base64url_decode("AB"), Err(EnrollError::NotBase64url)); // non-zero trailing bits
    }

    #[test]
    fn accepts_a_well_formed_config() {
        let text = sample("null");
        let (bytes, cfg) = decode_ia_enroll(&format!(" {}\r\n", b64url(text.as_bytes()))).unwrap();
        assert_eq!(bytes, text.as_bytes());
        assert_eq!(cfg.region, "in-mum");
        assert!(cfg.group_id.is_none());
        let text = sample(r#""0b7c6f2e-3a41-4f8e-9c1d-2e5f6a7b8c9d""#);
        assert!(decode_ia_enroll(&b64url(text.as_bytes())).is_ok());
    }

    #[test]
    fn rejects_bad_fields_and_unknown_keys() {
        let bad = |text: String| decode_ia_enroll(&b64url(text.as_bytes())).unwrap_err();
        assert!(matches!(
            bad(sample("null").replace("\"v\":1", "\"v\":2")),
            EnrollError::Field("v")
        ));
        assert!(matches!(
            bad(sample("null").replace(
                "https://in.indiansassist.example\"",
                "https://in.indiansassist.example/x\""
            )),
            EnrollError::Field("apiOrigin")
        ));
        assert!(matches!(
            bad(sample("null").replace("https://in.", "http://in.")),
            EnrollError::Field("apiOrigin")
        ));
        assert!(matches!(
            bad(sample("null").replace("/signal/device", "/signal")),
            EnrollError::Field("signalUrl")
        ));
        assert!(matches!(
            bad(sample("\"not-a-uuid\"")),
            EnrollError::Field("groupId")
        ));
        // groupId must be present (null when the config has no group).
        assert!(matches!(
            bad(sample("null").replace("\"groupId\":null,", "")),
            EnrollError::Field("groupId")
        ));
        assert!(matches!(
            bad(sample("null").replace("ia1.abc.def", &"x".repeat(4097))),
            EnrollError::Field("token")
        ));
        // A wrongly typed field is reported by position only, never by value.
        match bad(sample("null").replace("\"v\":1", "\"v\":\"ia1.secret\"")) {
            EnrollError::NotJson(why) => assert!(!why.contains("secret"), "{why}"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            bad(sample("null").replace("3f9a1c2b4d5e6f70", "3F9A1C2B4D5E6F70")),
            EnrollError::Field("kid")
        ));
        assert!(matches!(
            bad(sample("null").replace("\"v\":1", "\"v\":1,\"pubkeys\":[]")),
            EnrollError::NotJson(_)
        ));
        assert_eq!(
            decode_ia_enroll(&"A".repeat(30000)).unwrap_err(),
            EnrollError::TooLarge
        );
    }

    /// Cross-language vector: produced by `packaging/windows/tools/enroll-config.mjs sign-dev`
    /// (RFC 8032 test-1 seed) then `encode`, so it is exactly what an admin passes as IA_ENROLL.
    #[test]
    fn accepts_the_node_tool_vector() {
        const IA_ENROLL: &str = "eyJhcGlPcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjQwMDAiLCJncm91cElkIjpudWxsLCJraWQiOiIyMWZlMzFkZmExNTRhMjYxIiwicmVnaW9uIjoiaW4tbXVtIiwic2lnIjoiN29nbVFHN2ZLU0JFYUJWeDZ4dmJDQ01JVGRLZ3p4TDBiYVNsMWhnRExQaTUtNnV2cHllZzA3ek52MDRnMEQtMHBXb0tGbE0wbnFnZ0JhUV9UTGFOQXciLCJzaWduYWxVcmwiOiJ3czovL2xvY2FsaG9zdDo0MDAwL3NpZ25hbC9kZXZpY2UiLCJ0b2tlbiI6ImlhMS5kZXYudG9rZW4iLCJ2IjoxfQo";
        let (bytes, cfg) = decode_ia_enroll(IA_ENROLL).unwrap();
        assert!(bytes.ends_with(b"}\n"), "verbatim file bytes are kept");
        assert_eq!(cfg.kid, "21fe31dfa154a261");
        assert_eq!(cfg.signal_url, "ws://localhost:4000/signal/device");
        assert!(cfg.group_id.is_none());
    }

    #[test]
    fn loopback_dev_origins_are_shape_valid() {
        let text = sample("null")
            .replace(
                "https://in.indiansassist.example\"",
                "http://localhost:4000\"",
            )
            .replace("wss://in.indiansassist.example/", "ws://127.0.0.1:4000/");
        assert!(decode_ia_enroll(&b64url(text.as_bytes())).is_ok());
    }

    #[test]
    fn config_plan() {
        let text = sample("null");
        let (_, cfg) = decode_ia_enroll(&b64url(text.as_bytes())).unwrap();
        let fresh = plan_config(None, Some(&cfg), Some(true), None)
            .unwrap()
            .unwrap();
        let v: Value = serde_json::from_str(&fresh).unwrap();
        assert_eq!(v["apiOrigin"], "https://in.indiansassist.example");
        assert_eq!(
            v["signalUrl"],
            "wss://in.indiansassist.example/signal/device"
        );
        assert_eq!(v["wakerOptOut"], true);
        assert_eq!(v["amtProxyOptOut"], false);
        assert!(v.get("token").is_none());

        assert_eq!(plan_config(None, None, Some(true), None).unwrap(), None);

        let enrolled = r#"{"apiOrigin":"https://a.example","signalUrl":"wss://a.example/signal/device","deviceId":"d","keyId":"k","wakerOptOut":false,"amtProxyOptOut":false}"#;
        assert_eq!(
            plan_config(Some(enrolled), Some(&cfg), None, None).unwrap(),
            None
        );
        let updated = plan_config(Some(enrolled), Some(&cfg), None, Some(true))
            .unwrap()
            .unwrap();
        let v: Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(v["apiOrigin"], "https://a.example");
        assert_eq!(v["deviceId"], "d");
        assert_eq!(v["amtProxyOptOut"], true);
        assert!(plan_config(Some("[]"), None, Some(true), None).is_err());
    }

    #[test]
    fn custom_action_data() {
        let d = parse_apply_install(
            "C:\\Program Files\\IndiansAssist\\|C:\\ProgramData\\IndiansAssist\\|1||abc",
        )
        .unwrap();
        assert_eq!(d.install_dir, "C:\\Program Files\\IndiansAssist\\");
        assert_eq!(d.waker_opt_out, "1");
        assert_eq!(d.amt_proxy_opt_out, "");
        assert_eq!(d.ia_enroll, "abc");
        assert!(parse_apply_install("a|b|c").is_none());
        assert_eq!(parse_wipe("a\\|b\\"), Some(("a\\", "b\\")));
        assert_eq!(join("C:\\x\\", "f"), "C:\\x\\f");
        assert_eq!(join("C:\\x", "f"), "C:\\x\\f");
        assert_eq!(parse_opt_out(" Yes ").unwrap(), Some(true));
        assert!(parse_opt_out("maybe").is_err());
        assert!(
            is_key_material("Device.KEY")
                && is_key_material("x.privkey")
                && !is_key_material("config.json")
        );
    }
}
