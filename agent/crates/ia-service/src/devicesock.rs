//! The persistent `/signal/device` socket (§3.4, §3.6b) and what arrives on it.
//!
//! Three things make this socket different from the Desk socket the worker holds:
//!
//! * **It is authenticated by the device key, not a token.** The server sends a challenge; the
//!   service signs it (`ia-dev-v1`) and nothing else can. There is no token to steal and no
//!   credential on disk that is not DPAPI-sealed.
//! * **It carries no session.** It is a presence (rule 3.6a). A session arrives as one message
//!   (`device.session_open`) that makes the service launch a worker; the session itself lives
//!   on the worker's own socket.
//! * **It must send an absent `Origin`** and never carry a cookie, which is what keeps a
//!   browser from reaching it at all.
//!
//! The dispatch half is pure ([`plan_for_frame`]) so every branch is tested without a server:
//! the handler decides *what to do* with a frame, and the async half does it.

use ia_core::fleet::{DeviceClientMessage, DeviceServerMessage};

/// What a server frame makes the service do. Keeping this a value rather than a pile of
/// `match` arms inside the socket loop is what lets §15.2's "the device side of the service's
/// own protocol handling" be covered without a network.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// Sign the challenge and send `device.hello` (§3.4).
    Hello { server_challenge: String },
    /// `device.hello.ok`: adopt the policy and the playbook catalogue, drain the queue,
    /// backfill tamper events.
    Ready {
        device_id: String,
        policy: Box<ia_core::policy::UnattendedPolicy>,
        queued: Vec<ia_core::fleet::QueuedAction>,
        playbooks: Vec<ia_core::playbook::ManifestEntry>,
        rotation_armed: bool,
    },
    /// Launch a worker for this session (§4.2).
    OpenSession(Box<SessionOpen>),
    /// A fresh worker credential for a rebuild or a reconnect (rule 3.6d).
    WorkerCredential {
        session_id: String,
        gen: u16,
        credential: ia_core::fleet::Secret,
    },
    /// Run (or gate) one action (§9).
    RunAction(Box<ActionRequest>),
    /// The effective policy changed (rule 9.9's push).
    Policy(Box<ia_core::policy::UnattendedPolicy>),
    /// Store the receipt and, when somebody is there, show the §6.4 toast.
    Receipt(serde_json::Value),
    /// Remove the acknowledged tamper events from the outbox (§10.2).
    TamperAcknowledged { ids: Vec<String> },
    /// The key rotation of rule 3.7b completed: wipe the old sealed keys.
    KeyRotated { key_id: String },
    /// Open the sealed MAC and broadcast a magic packet (rule 8.2b).
    Wake {
        wake_id: String,
        sealed: ia_core::seal::Sealed,
    },
    /// Proxy an AMT command for another device (rule 8.4b).
    Amt(Box<AmtCommand>),
    /// The server refused something; `fatal` means stop retrying this hello.
    ServerError { code: String, fatal: bool },
    /// Answer a ping.
    Pong,
    /// Nothing to do (a frame a newer server sent, or one with no device-side action).
    Ignore,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionOpen {
    pub session_id: String,
    pub assist_name: String,
    pub reason: Option<String>,
    pub unattended: bool,
    pub decision: ia_core::policy::ConsentDecision,
    pub policy: ia_core::policy::UnattendedPolicy,
    pub recording_mode: String,
    pub credential: ia_core::fleet::Secret,
    pub credential_expires_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActionRequest {
    pub action_id: String,
    pub kind: ia_core::policy::DeviceActionKind,
    pub payload: serde_json::Value,
    pub reason: Option<String>,
    pub technician: String,
    pub secrets: Vec<ia_core::fleet::ActionSecret>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AmtCommand {
    pub cmd_id: String,
    pub target_device_id: String,
    pub host: String,
    pub tls: bool,
    pub op: ia_core::fleet::AmtOp,
    pub boot_target: Option<ia_core::fleet::AmtBootTarget>,
    pub cred_sealed: ia_core::seal::Sealed,
}

/// One catalogue entry of `device.hello.ok.playbooks`, as the C §8.4 checks want it. An entry
/// this build cannot read is dropped rather than failing the hello: the catalogue is advisory
/// until a run is attempted, and a run against a missing entry is refused as `not_allowed`.
pub fn manifest_entry(v: &serde_json::Value) -> Option<ia_core::playbook::ManifestEntry> {
    let o = v.as_object()?;
    Some(ia_core::playbook::ManifestEntry {
        id: o.get("id")?.as_str()?.to_string(),
        body_hash: o.get("bodyHash")?.as_str()?.to_string(),
        requires_elevation: o
            .get("requiresElevation")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        parameters: o
            .get("parameters")
            .and_then(serde_json::Value::as_array)
            .map(|ps| ps.iter().filter_map(manifest_param).collect())
            .unwrap_or_default(),
        timeout_sec: o
            .get("timeoutSec")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(120) as u32,
    })
}

/// A catalogue parameter. `PlaybookParam` is the shared shape and deserialises itself, so the
/// pinned `parameters` the run re-validates against are exactly what the server sent.
fn manifest_param(v: &serde_json::Value) -> Option<ia_core::playbook::PlaybookParam> {
    serde_json::from_value(v.clone()).ok()
}

/// Which server error codes mean "stop retrying with this identity" (§3.4: `device_disabled`
/// pauses retries for an hour; `device_unauthenticated` means the server does not know this
/// key, which a retry will not fix).
pub fn is_fatal_error(code: &str) -> bool {
    matches!(
        code,
        "device_unauthenticated" | "device_disabled" | "region_mismatch" | "device_bad_signature"
    )
}

/// The pure dispatch: one server frame in, one [`Step`] out.
pub fn plan_for_frame(frame: DeviceServerMessage) -> Step {
    match frame {
        DeviceServerMessage::Challenge {
            server_challenge, ..
        } => Step::Hello { server_challenge },
        DeviceServerMessage::HelloOk {
            device_id,
            policy,
            queued,
            playbooks,
            rotation_nonce,
            ..
        } => Step::Ready {
            device_id,
            policy: Box::new(policy),
            queued,
            playbooks: playbooks.iter().filter_map(manifest_entry).collect(),
            rotation_armed: rotation_nonce.is_some(),
        },
        DeviceServerMessage::SessionOpen {
            session_id,
            assist,
            reason,
            unattended,
            decision,
            policy,
            recording_mode,
            worker_credential,
            worker_credential_expires_at,
        } => Step::OpenSession(Box::new(SessionOpen {
            session_id,
            assist_name: assist.name,
            reason,
            unattended,
            decision,
            policy,
            recording_mode,
            credential: worker_credential,
            credential_expires_at: worker_credential_expires_at,
        })),
        DeviceServerMessage::WorkerCredential {
            session_id,
            gen,
            worker_credential,
            ..
        } => Step::WorkerCredential {
            session_id,
            gen,
            credential: worker_credential,
        },
        DeviceServerMessage::Action {
            action_id,
            kind,
            payload,
            reason,
            technician,
            secrets,
        } => Step::RunAction(Box::new(ActionRequest {
            action_id,
            kind,
            payload,
            reason,
            technician: technician.name,
            secrets: secrets.unwrap_or_default(),
        })),
        DeviceServerMessage::Policy { policy } => Step::Policy(Box::new(policy)),
        DeviceServerMessage::Receipt { receipt } => Step::Receipt(receipt),
        DeviceServerMessage::TamperOk { ids } => Step::TamperAcknowledged { ids },
        DeviceServerMessage::RotateOk { key_id } => Step::KeyRotated { key_id },
        DeviceServerMessage::WakeSend {
            wake_id,
            target_mac_sealed,
        } => Step::Wake {
            wake_id,
            sealed: target_mac_sealed,
        },
        DeviceServerMessage::AmtCommand {
            cmd_id,
            target_device_id,
            amt_host,
            tls,
            op,
            args,
            cred_sealed,
        } => Step::Amt(Box::new(AmtCommand {
            cmd_id,
            target_device_id,
            host: amt_host,
            tls,
            op,
            boot_target: args.target,
            cred_sealed,
        })),
        DeviceServerMessage::Error { code, .. } => {
            let fatal = is_fatal_error(&code);
            Step::ServerError { code, fatal }
        }
        DeviceServerMessage::Ping { .. } => Step::Pong,
        DeviceServerMessage::Pong { .. } => Step::Ignore,
    }
}

/// The `device.hello` a challenge deserves (§3.4). The nonce is fresh per hello so a replayed
/// hello cannot be built from a captured one.
pub fn hello_for(
    device_id: &str,
    key_id: &str,
    server_challenge: &str,
    identity: &crate::identity::Identity,
    client: ia_core::fleet::DeviceHelloClient,
) -> Result<DeviceClientMessage, ia_core::CoreError> {
    use base64::Engine as _;
    let nonce =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(ia_core::rnd::bytes::<16>());
    let input = ia_core::devsig::input::hello(device_id, server_challenge, &nonce)?;
    Ok(DeviceClientMessage::Hello {
        id: Some(ia_core::rnd::hex(8)),
        device_id: device_id.to_string(),
        key_id: key_id.to_string(),
        nonce,
        sig: identity.sign(&input),
        client,
    })
}

/// The signed `device.action_result` of rule 9.7.
pub fn action_result(
    device_id: &str,
    identity: &crate::identity::Identity,
    action_id: &str,
    state: ia_core::fleet::ReportedActionState,
    approved_by: Option<ia_core::policy::ApprovedBy>,
    result: Option<ia_core::fleet::DeviceActionResult>,
) -> Result<DeviceClientMessage, ia_core::CoreError> {
    let approved = approved_by.map(|a| match a {
        ia_core::policy::ApprovedBy::Policy => "policy",
        ia_core::policy::ApprovedBy::LocalUser => "local_user",
        ia_core::policy::ApprovedBy::AutoAfterTimeout => "auto_after_timeout",
    });
    let result_value = match &result {
        Some(r) => {
            Some(serde_json::to_value(r).map_err(|e| ia_core::CoreError::BadInput(e.to_string()))?)
        }
        None => None,
    };
    let input = ia_core::devsig::input::action(
        device_id,
        action_id,
        state.as_str(),
        approved,
        result_value.as_ref(),
    )?;
    Ok(DeviceClientMessage::ActionResult {
        action_id: action_id.to_string(),
        state,
        approved_by,
        result,
        sig: identity.sign(&input),
    })
}

/// The `device.rotate` of rule 3.7b: the old key signs the new pair, the new key proves
/// possession of itself. Both signatures are required, so neither key alone can rotate.
pub fn rotate_message(
    device_id: &str,
    rotation_nonce: &str,
    old_key_id: &str,
    current: &crate::identity::Identity,
    next: &crate::identity::Identity,
) -> Result<DeviceClientMessage, ia_core::CoreError> {
    let new_public_key = next.public_key();
    let new_kex_public_key = next.kex_public_key();
    let old_sig_input = ia_core::devsig::input::rotate(
        device_id,
        rotation_nonce,
        &new_public_key,
        &new_kex_public_key,
    )?;
    let proof_input = ia_core::devsig::input::rotate_new(device_id, rotation_nonce, old_key_id)?;
    Ok(DeviceClientMessage::Rotate {
        id: Some(ia_core::rnd::hex(8)),
        new_public_key,
        new_kex_public_key,
        old_key_sig: current.sign(&old_sig_input),
        new_key_proof: next.sign(&proof_input),
    })
}

/// The signed `POST /devices/:id/deregister` body the uninstall sends (§4.1, §7.2). Returned
/// as a JSON value because it is a REST body, not a socket frame.
pub fn deregister_body(
    device_id: &str,
    identity: &crate::identity::Identity,
    now_ms: i64,
) -> Result<serde_json::Value, ia_core::CoreError> {
    use base64::Engine as _;
    let nonce =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(ia_core::rnd::bytes::<16>());
    let input = ia_core::devsig::input::deregister(device_id, now_ms, &nonce)?;
    Ok(serde_json::json!({ "ts": now_ms, "nonce": nonce, "sig": identity.sign(&input) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ia_core::fleet::parse_server_frame;

    const POLICY: &str = r#"{"mode":"allow","requireLocalApprovalWhenPresent":false,"autoAllowAfterSec":null,
        "allowedHours":null,"recordingRequired":true,"allowLogonScreen":false,"allowSecureDesktop":false,
        "allowPrivileged":true,"allowInputLock":false,"allowPrivacyScreen":false,"allowAmtSol":false,
        "allowAmtBootRedirect":false,"notifyLocalUser":true,"maxUnattendedMinutes":120}"#;

    fn plan(json: &str) -> Step {
        plan_for_frame(parse_server_frame(json).unwrap_or_else(|e| panic!("{e}: {json}")))
    }

    #[test]
    fn a_challenge_asks_for_a_hello() {
        let step = plan(r#"{"t":"device.challenge","serverChallenge":"AAAA","ts":1762000000000}"#);
        assert_eq!(
            step,
            Step::Hello {
                server_challenge: "AAAA".into()
            }
        );
    }

    #[test]
    fn the_hello_signs_the_servers_challenge_with_a_fresh_nonce() {
        use base64::Engine as _;
        let id = crate::identity::Identity::generate();
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0x55u8; 32]);
        let client = client_facts();
        let a = hello_for(device, &id.key_id(), &challenge, &id, client.clone()).unwrap();
        let b = hello_for(device, &id.key_id(), &challenge, &id, client).unwrap();
        let (
            DeviceClientMessage::Hello { nonce, sig, .. },
            DeviceClientMessage::Hello { nonce: n2, .. },
        ) = (&a, &b)
        else {
            panic!("not a hello")
        };
        assert_ne!(nonce, n2, "a fresh nonce per hello");
        let input = ia_core::devsig::input::hello(device, &challenge, nonce).unwrap();
        assert!(ia_core::devsig::verify_device_signature(
            &input,
            sig,
            &id.public_key()
        ));
    }

    fn client_facts() -> ia_core::fleet::DeviceHelloClient {
        ia_core::fleet::DeviceHelloClient {
            service_version: "0.3.0".into(),
            agent_version: "0.3.0".into(),
            os_version: "10.0.26100".into(),
            arch: "x64".into(),
            capabilities: crate::facts::capabilities(&crate::facts::CapabilityFacts::default()),
            lan_segment: ia_core::fleet::LanSegment {
                subnet_hash: "ab".repeat(32),
                gateway_mac_hash: "cd".repeat(32),
                dhcp_domain: None,
            },
            wake_mac: Some("0a1b2c3d4e5f".into()),
            amt: None,
            interactive: ia_core::fleet::InteractiveState {
                state: ia_core::policy::InteractiveStateName::None,
                idle_sec: None,
                at: 1_762_000_000_000,
            },
        }
    }

    #[test]
    fn a_hello_ok_adopts_the_policy_and_notices_a_queue_and_an_armed_rotation() {
        let step = plan(&format!(
            r#"{{"t":"device.hello.ok","deviceId":"0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a","orgDisplayName":"Acme",
            "region":"in-mum","policy":{POLICY},"groupId":null,"queued":[],"playbooks":[],"rotationNonce":"{}"}}"#,
            "A".repeat(22)
        ));
        match step {
            Step::Ready {
                device_id,
                policy,
                queued,
                playbooks,
                rotation_armed,
            } => {
                assert_eq!(device_id, "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a");
                assert_eq!(policy.mode, ia_core::policy::UnattendedMode::Allow);
                assert!(queued.is_empty());
                assert!(playbooks.is_empty());
                assert!(rotation_armed);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_session_open_becomes_a_worker_launch_with_its_credential() {
        let step = plan(&format!(
            r#"{{"t":"device.session_open","sessionId":"5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b","assist":{{"name":"Asha"}},
            "reason":"disk check","unattended":true,"decision":"auto_grant","policy":{POLICY},"recordingMode":"server",
            "workerCredential":"{}","workerCredentialExpiresAt":"2026-11-01T10:02:00.000Z"}}"#,
            "A".repeat(43)
        ));
        match step {
            Step::OpenSession(s) => {
                assert_eq!(s.decision, ia_core::policy::ConsentDecision::AutoGrant);
                assert!(s.unattended);
                assert_eq!(s.assist_name, "Asha");
                assert_eq!(s.credential.expose().len(), 43);
                // The credential must not be printable in a log.
                assert!(format!("{s:?}").contains("<redacted>"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_action_with_secrets_keeps_them_sealed_until_the_injector_opens_them() {
        let step = plan(
            r#"{"t":"device.action","actionId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","kind":"playbook_run",
            "payload":{"playbookId":"7c9e6679-7425-40de-944b-e07fc1f90ae7"},"reason":"rotate the key",
            "technician":{"name":"Asha"},"secrets":[{"env":"IA_API_KEY","sealed":{"epk":"AAAA","nonce":"BBBB","ct":"CCCCCCCCCCCCCCCCCCCCCC"}}]}"#,
        );
        match step {
            Step::RunAction(a) => {
                assert_eq!(a.kind, ia_core::policy::DeviceActionKind::PlaybookRun);
                assert_eq!(a.secrets.len(), 1);
                assert_eq!(a.secrets[0].env, "IA_API_KEY");
                assert_eq!(a.reason.as_deref(), Some("rotate the key"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_wake_and_an_amt_command_carry_their_sealed_payloads() {
        let sealed = r#"{"epk":"AAAA","nonce":"BBBB","ct":"CCCCCCCCCCCCCCCCCCCCCC"}"#;
        match plan(&format!(
            r#"{{"t":"wake.send","wakeId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","targetMacSealed":{sealed}}}"#
        )) {
            Step::Wake { wake_id, .. } => {
                assert_eq!(wake_id, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d")
            }
            other => panic!("{other:?}"),
        }
        match plan(&format!(
            r#"{{"t":"amt.command","cmdId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","targetDeviceId":"0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a",
            "amtHost":"10.1.2.7","tls":true,"op":"boot_redirect","args":{{"target":"pxe"}},"credSealed":{sealed}}}"#
        )) {
            Step::Amt(c) => {
                assert_eq!(c.op, ia_core::fleet::AmtOp::BootRedirect);
                assert_eq!(c.boot_target, Some(ia_core::fleet::AmtBootTarget::Pxe));
                assert!(c.tls);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_ping_is_answered_and_an_unknown_frame_is_ignored_rather_than_fatal() {
        assert_eq!(plan(r#"{"t":"ping"}"#), Step::Pong);
        assert_eq!(plan(r#"{"t":"pong"}"#), Step::Ignore);
        // A type this build does not know is a parse error the socket loop logs and skips.
        assert!(parse_server_frame(r#"{"t":"device.something_new"}"#).is_err());
    }

    #[test]
    fn the_errors_that_stop_a_retry_are_the_ones_a_retry_cannot_fix() {
        for code in [
            "device_unauthenticated",
            "device_disabled",
            "region_mismatch",
            "device_bad_signature",
        ] {
            assert!(is_fatal_error(code), "{code} should pause retries");
        }
        for code in [
            "rate_limited",
            "bad_state",
            "unknown_type",
            "payload_too_large",
        ] {
            assert!(!is_fatal_error(code), "{code} should not pause retries");
        }
        match plan(r#"{"t":"error","code":"device_disabled","message":"this device is retired"}"#) {
            Step::ServerError { code, fatal } => {
                assert_eq!(code, "device_disabled");
                assert!(fatal);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_action_result_is_signed_over_exactly_what_the_server_verifies() {
        let id = crate::identity::Identity::generate();
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let action = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
        let result = ia_core::fleet::DeviceActionResult {
            exit: Some(0),
            ran_as: Some("admin".into()),
            ..Default::default()
        };
        let msg = action_result(
            device,
            &id,
            action,
            ia_core::fleet::ReportedActionState::Done,
            Some(ia_core::policy::ApprovedBy::Policy),
            Some(result.clone()),
        )
        .unwrap();
        let DeviceClientMessage::ActionResult { sig, .. } = &msg else {
            panic!("not a result")
        };
        let value = serde_json::to_value(&result).unwrap();
        let input =
            ia_core::devsig::input::action(device, action, "done", Some("policy"), Some(&value))
                .unwrap();
        assert!(ia_core::devsig::verify_device_signature(
            &input,
            sig,
            &id.public_key()
        ));
        // The wire form carries the camelCase names the server parses.
        let text = serde_json::to_string(&msg).unwrap();
        assert!(text.contains("\"actionId\""));
        assert!(text.contains("\"approvedBy\":\"policy\""));
        assert!(text.contains("\"ranAs\":\"admin\""));
    }

    #[test]
    fn a_rotation_carries_both_signatures_and_neither_key_alone_can_make_it() {
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let current = crate::identity::Identity::generate();
        let next = crate::identity::Identity::generate();
        let nonce = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            [0x77u8; 16],
        );
        let msg = rotate_message(device, &nonce, &current.key_id(), &current, &next).unwrap();
        let DeviceClientMessage::Rotate {
            new_public_key,
            new_kex_public_key,
            old_key_sig,
            new_key_proof,
            ..
        } = &msg
        else {
            panic!("not a rotation")
        };
        let old_input =
            ia_core::devsig::input::rotate(device, &nonce, new_public_key, new_kex_public_key)
                .unwrap();
        let proof_input =
            ia_core::devsig::input::rotate_new(device, &nonce, &current.key_id()).unwrap();
        assert!(ia_core::devsig::verify_device_signature(
            &old_input,
            old_key_sig,
            &current.public_key()
        ));
        assert!(ia_core::devsig::verify_device_signature(
            &proof_input,
            new_key_proof,
            &next.public_key()
        ));
        // The old key cannot make the new key's proof.
        assert!(!ia_core::devsig::verify_device_signature(
            &proof_input,
            new_key_proof,
            &current.public_key()
        ));
    }

    #[test]
    fn the_deregister_body_is_signed_and_time_stamped() {
        let id = crate::identity::Identity::generate();
        let device = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
        let body = deregister_body(device, &id, 1_793_520_000_000).unwrap();
        let ts = body["ts"].as_i64().unwrap();
        let nonce = body["nonce"].as_str().unwrap();
        let input = ia_core::devsig::input::deregister(device, ts, nonce).unwrap();
        assert!(ia_core::devsig::verify_device_signature(
            &input,
            body["sig"].as_str().unwrap(),
            &id.public_key()
        ));
    }
}
