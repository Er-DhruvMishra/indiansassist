//! Enrollment (§3.1, §3.2): read the signed `enroll.iaconfig` beside the binary, verify it
//! against the region keys compiled into this build, POST it with both public keys and a
//! possession proof, and — only on success — shred the enrollment material.
//!
//! The order matters and is the contract's: **the material is deleted after a `201`, never
//! before** (§3.1 step 5). A service that shredded first and then failed would need a new
//! token for a machine that was never enrolled.
//!
//! The retry policy is [`ia_core::enroll`]'s, so the "office of 300 machines imaged at once"
//! case backs off instead of hammering: `429` and `5xx` are retried with jitter, a `410` (the
//! token is used up or revoked) and a `400` (the config itself is wrong) stop and wait for a
//! person.

use std::path::{Path, PathBuf};

use ia_core::enroll::{EnrollAction, EnrollClient, EnrollFailure, EnrollResponse};
use ia_core::fleet::{DeviceEnrollReply, DeviceEnrollRequest, DeviceMachine, EnrollConfig};

use crate::facts::{capabilities, CapabilityFacts};
use crate::identity::Identity;

#[derive(Debug, thiserror::Error)]
pub enum EnrollError {
    #[error("no enrollment configuration: place a signed enroll.iaconfig beside the service, or install with IA_ENROLL")]
    NoConfig,
    #[error("the enrollment configuration is not signed by a region key this build trusts")]
    UntrustedConfig,
    #[error("enrollment stopped: {0:?}")]
    Refused(EnrollFailure),
    #[error("io: {0}")]
    Io(String),
}

/// Where an `enroll.iaconfig` may come from (§3.1 step 3). The filename and clipboard carriers
/// of C §2.1 deliberately do **not** apply to a service: config comes from the sealed install
/// only.
pub fn config_candidates(exe_dir: &Path, data_dir: &Path) -> Vec<PathBuf> {
    vec![
        exe_dir.join("enroll.iaconfig"),
        // The MSI custom action writes it beside the binary; a re-run of the installer may
        // instead have left it in the data directory.
        data_dir.join("enroll.iaconfig"),
    ]
}

/// Read and verify the first candidate that exists. The text is returned **verbatim**: the
/// server re-verifies the same bytes, so re-serialising it would be a way to break a valid
/// signature.
pub fn read_config(
    candidates: &[PathBuf],
    region_keys: &[[u8; 32]],
) -> Result<(PathBuf, String, EnrollConfig), EnrollError> {
    let mut found = None;
    for p in candidates {
        match std::fs::read_to_string(p) {
            Ok(text) => {
                found = Some((p.clone(), text));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(EnrollError::Io(e.to_string())),
        }
    }
    let (path, text) = found.ok_or(EnrollError::NoConfig)?;
    let cfg = ia_core::fleet::verify_enroll_config(&text, region_keys)
        .ok_or(EnrollError::UntrustedConfig)?;
    Ok((path, text, cfg))
}

/// Overwrite and remove the enrollment material (§3.1 step 5, the C §2.4 shred).
pub fn shred_config(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        let zeros = vec![0u8; meta.len() as usize];
        let _ = std::fs::write(path, &zeros);
    }
    let _ = std::fs::remove_file(path);
}

/// The machine facts of §3.2.
pub fn machine_facts(
    name: &str,
    os_version: &str,
    arch: &str,
    hw_fingerprint: &str,
    facts: &CapabilityFacts,
    wake_mac: Option<String>,
    interactive: ia_core::fleet::InteractiveState,
) -> DeviceMachine {
    DeviceMachine {
        name: name.chars().take(80).collect(),
        platform: "windows".to_string(),
        os_version: os_version.chars().take(32).collect(),
        arch: arch.to_string(),
        service_version: facts.service_version.clone(),
        hw_fingerprint: hw_fingerprint.to_string(),
        wake_mac,
        amt: facts.amt.clone(),
        capabilities: capabilities(facts),
        interactive,
    }
}

/// The request body, with the possession proof over `ia-enroll-v1`.
pub fn build_request(
    identity: &Identity,
    enroll_config_text: &str,
    token_id: &str,
    machine: DeviceMachine,
) -> Result<DeviceEnrollRequest, EnrollError> {
    let public_key = identity.public_key();
    let kex_public_key = identity.kex_public_key();
    let input = ia_core::devsig::input::enroll(token_id, &public_key, &kex_public_key)
        .map_err(|e| EnrollError::Io(format!("{e:?}")))?;
    Ok(DeviceEnrollRequest {
        enroll_config: enroll_config_text.to_string(),
        device_public_key: public_key,
        device_kex_public_key: kex_public_key,
        device_key_proof: identity.sign(&input),
        machine,
    })
}

/// The token id the proof covers: the `tid` claim of the compact token
/// `ia1.<kid>.<base64url payload>.<base64url signature>` (`packages/shared/src/token/codec.ts`,
/// `ia_core::token`). The signature and expiry are left to the server, which is authoritative —
/// but the proof needs the id, so a token without one is an error here rather than a `400` later.
pub fn token_id_of(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    let [prefix, _kid, payload, _sig] = parts.as_slice() else {
        return None;
    };
    if *prefix != "ia1" {
        return None;
    }
    let bytes =
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("tid")
        .and_then(|j| j.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Drive the state machine against a transport. `send` performs one POST and returns the
/// status and body (or a transport failure); `sleep` waits. Both are arguments so the whole
/// retry behaviour is testable without a server.
pub fn run<S, W>(
    request: &DeviceEnrollRequest,
    mut send: S,
    mut sleep: W,
) -> Result<DeviceEnrollReply, EnrollError>
where
    S: FnMut(&DeviceEnrollRequest) -> Result<(u16, String), String>,
    W: FnMut(std::time::Duration),
{
    let mut client = EnrollClient::default();
    let mut action = client.start();
    loop {
        match action {
            EnrollAction::Send => {}
            EnrollAction::WaitThenRetry(d) => {
                tracing::info!(secs = d.as_secs_f32(), "enrollment will retry");
                sleep(d);
            }
            EnrollAction::Enrolled(reply) => return Ok(*reply),
            EnrollAction::GiveUp(why) => return Err(EnrollError::Refused(why)),
        }
        action = match send(request) {
            Ok((status, body)) => client.on_response(EnrollResponse::Http {
                status,
                body: &body,
            }),
            Err(e) => client.on_response(EnrollResponse::Transport(&e)),
        };
    }
}

/// The whole §3.1 sequence, with the HTTP transport. Returns the reply and the path that was
/// shredded, so the caller can log what it cleaned up.
#[cfg(any(
    feature = "service",
    all(target_os = "linux", feature = "linux-service"),
    // apple-owned: begin
    all(target_os = "macos", feature = "macos-service"),
    // apple-owned: end
))]
pub fn enroll_now(
    api_origin: &str,
    identity: &Identity,
    config_path: &Path,
    config_text: &str,
    cfg: &EnrollConfig,
    machine: DeviceMachine,
) -> Result<DeviceEnrollReply, EnrollError> {
    let token_id = token_id_of(&cfg.token)
        .ok_or_else(|| EnrollError::Io("the enrollment token carries no id".into()))?;
    let mut request = build_request(identity, config_text, &token_id, machine)?;
    let url = format!("{}/api/v1/devices/enroll", api_origin.trim_end_matches('/'));
    let reply = run(
        &request,
        |req| {
            let body = serde_json::to_string(req).map_err(|e| e.to_string())?;
            match ureq::post(&url)
                .set("content-type", "application/json")
                // A §3.2 requirement: the endpoint takes no cookie and no Origin, and demands
                // this header so a browser cannot be made to enrol a device.
                .set("x-requested-with", "IndiansAssist")
                .set("user-agent", &crate::user_agent())
                .send_string(&body)
            {
                Ok(r) => Ok((r.status(), r.into_string().unwrap_or_default())),
                Err(ureq::Error::Status(code, r)) => {
                    Ok((code, r.into_string().unwrap_or_default()))
                }
                Err(ureq::Error::Transport(t)) => Err(t.to_string()),
            }
        },
        std::thread::sleep,
    );
    // Whatever happened, the request object held the enrollment token: wipe it.
    {
        use zeroize::Zeroize as _;
        request.enroll_config.zeroize();
    }
    let reply = reply?;
    shred_config(config_path);
    tracing::info!(
        device_id = %reply.device_id,
        key_id = %reply.key_id,
        region = %reply.region,
        "enrolled; the enrollment material has been shredded"
    );
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const REPLY: &str = r#"{"deviceId":"0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a","orgId":"5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
        "region":"in-mum","apiOrigin":"https://in.example","signalUrl":"wss://in.example/signal/device","keyId":"0123456789abcdef",
        "group":null,"policy":{"mode":"approval_only","requireLocalApprovalWhenPresent":true,"autoAllowAfterSec":null,
        "allowedHours":null,"recordingRequired":true,"allowLogonScreen":false,"allowSecureDesktop":false,
        "allowPrivileged":true,"allowInputLock":false,"allowPrivacyScreen":false,"allowAmtSol":false,
        "allowAmtBootRedirect":false,"notifyLocalUser":true,"maxUnattendedMinutes":120}}"#;

    fn interactive() -> ia_core::fleet::InteractiveState {
        ia_core::fleet::InteractiveState {
            state: ia_core::policy::InteractiveStateName::None,
            idle_sec: None,
            at: 1_762_000_000_000,
            display: None,
        }
    }

    fn request() -> DeviceEnrollRequest {
        let id = Identity::generate();
        let machine = machine_facts(
            "DESK-01",
            "10.0.26100",
            "x64",
            &"ab".repeat(32),
            &CapabilityFacts::default(),
            Some("0a1b2c3d4e5f".into()),
            interactive(),
        );
        build_request(
            &id,
            "{\"v\":1}",
            "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
            machine,
        )
        .unwrap()
    }

    #[test]
    fn the_request_carries_both_public_keys_and_a_proof_the_server_can_verify() {
        let id = Identity::generate();
        let token_id = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
        let machine = machine_facts(
            "DESK-01",
            "10.0.26100",
            "x64",
            &"ab".repeat(32),
            &CapabilityFacts::default(),
            None,
            interactive(),
        );
        let req = build_request(&id, "{}", token_id, machine).unwrap();
        assert_eq!(req.device_public_key, id.public_key());
        assert_eq!(req.device_kex_public_key, id.kex_public_key());
        let input = ia_core::devsig::input::enroll(
            token_id,
            &req.device_public_key,
            &req.device_kex_public_key,
        )
        .unwrap();
        assert!(ia_core::devsig::verify_device_signature(
            &input,
            &req.device_key_proof,
            &id.public_key()
        ));
    }

    #[test]
    fn a_long_machine_name_is_cut_to_the_schema_limit() {
        let m = machine_facts(
            &"N".repeat(200),
            "10.0.26100",
            "x64",
            &"ab".repeat(32),
            &CapabilityFacts::default(),
            None,
            interactive(),
        );
        assert_eq!(m.name.chars().count(), 80);
        assert_eq!(m.platform, "windows");
    }

    #[test]
    fn a_created_reply_ends_the_loop_after_one_call() {
        let mut calls = 0;
        let reply = run(
            &request(),
            |_| {
                calls += 1;
                Ok((201, REPLY.to_string()))
            },
            |_| panic!("no wait is needed on a first-try success"),
        )
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(reply.key_id, "0123456789abcdef");
    }

    #[test]
    fn a_rate_limited_office_backs_off_and_then_succeeds() {
        let mut calls = 0;
        let mut waited: Vec<Duration> = Vec::new();
        let reply = run(
            &request(),
            |_| {
                calls += 1;
                if calls < 3 {
                    Ok((429, "{}".to_string()))
                } else {
                    Ok((201, REPLY.to_string()))
                }
            },
            |d| waited.push(d),
        )
        .unwrap();
        assert_eq!(calls, 3);
        assert_eq!(waited.len(), 2);
        assert!(
            waited[0] >= Duration::from_millis(600),
            "the first wait is about a second: {:?}",
            waited[0]
        );
        assert_eq!(reply.device_id, "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a");
    }

    #[test]
    fn a_used_up_token_stops_rather_than_retrying_for_ever() {
        let mut calls = 0;
        let err = run(
            &request(),
            |_| {
                calls += 1;
                Ok((
                    410,
                    r#"{"error":{"code":"token_used","message":"used up"}}"#.to_string(),
                ))
            },
            |_| panic!("a used-up token is not retried"),
        )
        .unwrap_err();
        assert_eq!(calls, 1);
        assert!(
            matches!(err, EnrollError::Refused(EnrollFailure::TokenGone(c)) if c == "token_used")
        );
    }

    #[test]
    fn a_machine_that_boots_before_its_network_keeps_trying() {
        let mut calls = 0;
        let reply = run(
            &request(),
            |_| {
                calls += 1;
                if calls < 4 {
                    Err("dns error: no such host".to_string())
                } else {
                    Ok((201, REPLY.to_string()))
                }
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(calls, 4);
        assert_eq!(reply.region, "in-mum");
    }

    #[test]
    fn the_token_id_is_read_out_of_the_compact_token() {
        // The real shape (codec.ts): `ia1.<16-hex kid>.<b64url payload>.<b64url sig>`, id in `tid`.
        let b64 = |v: serde_json::Value| {
            base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                serde_json::to_vec(&v).unwrap(),
            )
        };
        let tid = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
        let payload = b64(serde_json::json!({ "tid": tid, "typ": "enrollment" }));
        let token = format!("ia1.0123456789abcdef.{payload}.c2ln");
        assert_eq!(token_id_of(&token).as_deref(), Some(tid));
        // The old (wrong) three-segment shape, a `jti`-only payload, another prefix, and
        // garbage all give no id.
        assert!(token_id_of(&format!("ia1.{payload}.sig")).is_none());
        let jti_only = b64(serde_json::json!({ "jti": tid }));
        assert!(token_id_of(&format!("ia1.0123456789abcdef.{jti_only}.c2ln")).is_none());
        assert!(token_id_of(&format!("ia2.0123456789abcdef.{payload}.c2ln")).is_none());
        assert!(token_id_of("not-a-token").is_none());
        assert!(token_id_of("ia1.0123456789abcdef.!!!.c2ln").is_none());
    }

    #[test]
    fn the_config_is_looked_for_beside_the_binary_first() {
        let exe = Path::new(r"C:\Program Files\IndiansAssist");
        let data = Path::new(r"C:\ProgramData\IndiansAssist");
        let c = config_candidates(exe, data);
        assert_eq!(c[0], exe.join("enroll.iaconfig"));
        assert_eq!(c[1], data.join("enroll.iaconfig"));
        assert_eq!(
            c.len(),
            2,
            "no other carrier applies to a service (section 3.1 step 3)"
        );
    }

    #[test]
    fn an_unsigned_or_missing_config_is_refused_and_nothing_is_sent() {
        let dir = tempfile::tempdir().unwrap();
        let candidates = vec![dir.path().join("enroll.iaconfig")];
        assert!(matches!(
            read_config(&candidates, &[]),
            Err(EnrollError::NoConfig)
        ));
        std::fs::write(&candidates[0], r#"{"v":1,"apiOrigin":"https://in.example","signalUrl":"wss://in.example/signal/device","region":"in-mum","token":"ia1.x.y","groupId":null,"kid":"0123456789abcdef","sig":"AAAA"}"#).unwrap();
        assert!(matches!(
            read_config(&candidates, &[]),
            Err(EnrollError::UntrustedConfig)
        ));
    }

    #[test]
    fn shredding_overwrites_before_it_removes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("enroll.iaconfig");
        std::fs::write(&p, "a signed config with a token in it").unwrap();
        shred_config(&p);
        assert!(!p.exists());
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }
}
