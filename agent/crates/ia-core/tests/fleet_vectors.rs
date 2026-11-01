//! Cross-language conformance for the Phase D fleet half of `ia-core`, against
//! `packages/shared/test/fixtures/fleet/` — the same three files
//! `packages/shared/test/fleet-signing.test.ts` and `fleet-policy.test.ts` load
//! (contract §15.1, §15.2). `pnpm fleet:fixtures` regenerates them from the TypeScript and
//! fails if the committed copies are stale, so a rule that changes on one side and not the
//! other fails here.
//!
//! * `signatures.json` — the eight §3.8 signature domains: signing input **bytes** and the
//!   Ed25519 signature over them.
//! * `seal.json` — the sealing convention for every `SEAL_PURPOSES` value.
//! * `decisions.json` — the §6.1 merge, the `allowedHours` arithmetic, and every row of the
//!   §6.2 session table and the rule 9.9 action table at both stages.

use std::path::PathBuf;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use ia_core::devsig::{
    device_public_key_of, device_signing_input, input, kid_of_b64u, sign_device_input,
    verify_device_signature, SigDomain, SigField,
};
use ia_core::policy::{
    decide_device_action, decide_device_session, is_within_policy_window, next_policy_window_start,
    resolve_unattended_policy, ActionDecision, ActionInput, AllowedHours, DeviceActionKind,
    InteractiveStateName, SessionDecision, SessionInput, UnattendedPolicy, UnattendedPolicyPatch,
};
use ia_core::seal::{kex_public_key_of, open_sealed_text, seal_to_device, SealPurpose, Sealed};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/shared/test/fixtures/fleet")
        .join(name);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    serde_json::from_str(&text).expect("fixture is JSON")
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str()
        .unwrap_or_else(|| panic!("{k} is not a string"))
}

fn seed32(hex_str: &str) -> [u8; 32] {
    hex::decode(hex_str).unwrap().try_into().unwrap()
}

// ---------------------------------------------------------------- §3.8 signatures

/// Rebuilds the signing input for one fixture vector from its `fields`, through the per-domain
/// builders — so a reordered or renamed field fails, not just a changed byte string.
fn signing_input_for(domain: &str, f: &Value) -> Vec<u8> {
    match domain {
        "ia-enroll-v1" => input::enroll(
            s(f, "tokenId"),
            s(f, "devicePublicKey"),
            s(f, "deviceKexPublicKey"),
        ),
        "ia-dev-v1" => input::hello(s(f, "deviceId"), s(f, "serverChallenge"), s(f, "nonce")),
        "ia-rot-v1" => input::rotate(
            s(f, "deviceId"),
            s(f, "rotationNonce"),
            s(f, "newPublicKey"),
            s(f, "newKexPublicKey"),
        ),
        "ia-rot-new-v1" => {
            input::rotate_new(s(f, "deviceId"), s(f, "rotationNonce"), s(f, "oldKeyId"))
        }
        "ia-dereg-v1" => {
            input::deregister(s(f, "deviceId"), f["ts"].as_i64().unwrap(), s(f, "nonce"))
        }
        "ia-tamper-v1" => input::tamper(s(f, "deviceId"), &f["event"]),
        "ia-action-v1" => input::action(
            s(f, "deviceId"),
            s(f, "actionId"),
            s(f, "state"),
            f.get("approvedBy").and_then(Value::as_str),
            f.get("result"),
        ),
        "ia-sas-v1" => input::sas(
            s(f, "sessionId"),
            f["gen"].as_u64().unwrap() as u32,
            s(f, "sas"),
            s(f, "deskFpr"),
            s(f, "assistFpr"),
        ),
        other => panic!("unknown signature domain {other}"),
    }
    .unwrap_or_else(|e| panic!("{domain}: {e:?}"))
}

#[test]
fn every_signature_domain_matches_the_shared_vectors() {
    let fx = fixture("signatures.json");
    let keys = &fx["keys"];
    let seed = seed32(s(keys, "identitySeedHex"));
    let new_seed = seed32(s(keys, "newIdentitySeedHex"));
    assert_eq!(device_public_key_of(&seed), s(keys, "devicePublicKey"));
    assert_eq!(device_public_key_of(&new_seed), s(keys, "newPublicKey"));
    assert_eq!(
        kid_of_b64u(s(keys, "devicePublicKey")).unwrap(),
        s(keys, "keyId")
    );
    assert_eq!(
        kex_public_key_of(&seed32(s(keys, "kexSecretHex"))),
        s(keys, "deviceKexPublicKey")
    );

    let vectors = fx["vectors"].as_array().expect("vectors");
    assert_eq!(vectors.len(), 8, "all eight §3.8 domains are covered");
    for v in vectors {
        let domain = s(v, "domain");
        let got = signing_input_for(domain, &v["fields"]);
        assert_eq!(
            hex::encode(&got),
            s(v, "signingInputHex"),
            "{domain}: signing input"
        );
        // `ia-rot-new-v1` is the only domain the *new* key signs (rule 3.7b).
        let signer = if domain == "ia-rot-new-v1" {
            &new_seed
        } else {
            &seed
        };
        assert_eq!(
            sign_device_input(&got, signer),
            s(v, "sig"),
            "{domain}: signature"
        );
        let pk = device_public_key_of(signer);
        assert!(
            verify_device_signature(&got, s(v, "sig"), &pk),
            "{domain}: verifies"
        );
        // A flipped signature byte and a wrong key both fail, and neither panics.
        let mut bad = URL_SAFE_NO_PAD.decode(s(v, "sig")).unwrap();
        bad[0] ^= 1;
        assert!(
            !verify_device_signature(&got, &URL_SAFE_NO_PAD.encode(&bad), &pk),
            "{domain}: tampered signature"
        );
        let other = if domain == "ia-rot-new-v1" {
            s(keys, "devicePublicKey")
        } else {
            s(keys, "newPublicKey")
        };
        assert!(
            !verify_device_signature(&got, s(v, "sig"), other),
            "{domain}: wrong key"
        );
    }
}

#[test]
fn the_framing_is_length_prefixed_so_fields_cannot_be_slid_into_each_other() {
    // "ab" + "c" and "a" + "bc" would collide without the 4-byte lengths (§3.8 framing rule).
    let a = device_signing_input(
        SigDomain::Hello,
        &[SigField::Text("ab"), SigField::Text("c")],
    )
    .unwrap();
    let b = device_signing_input(
        SigDomain::Hello,
        &[SigField::Text("a"), SigField::Text("bc")],
    )
    .unwrap();
    assert_ne!(a, b);
}

// ---------------------------------------------------------------- sealing

#[test]
fn every_seal_purpose_opens_the_shared_vector() {
    let fx = fixture("seal.json");
    let kex = seed32(s(&fx, "kexSecretHex"));
    let device_id = s(&fx, "deviceId");
    assert_eq!(kex_public_key_of(&kex), s(&fx, "kexPublicKey"));
    let vectors = fx["vectors"].as_array().expect("vectors");
    assert_eq!(vectors.len(), 3, "every SEAL_PURPOSES value is covered");
    for v in vectors {
        let purpose: SealPurpose =
            serde_json::from_value(v["purpose"].clone()).expect("known purpose");
        let sealed: Sealed = serde_json::from_value(v["sealed"].clone()).expect("Sealed");
        let opened = open_sealed_text(&kex, device_id, purpose, &sealed).expect("opens");
        assert_eq!(&*opened, s(v, "plaintext"), "{:?}", purpose);

        // Re-sealing with the fixture's ephemeral secret and nonce reproduces it byte for byte.
        let again = seal_to_device(
            s(&fx, "kexPublicKey"),
            device_id,
            purpose,
            s(v, "plaintext").as_bytes(),
            Some(seed32(s(v, "ephSecretHex"))),
            Some(
                URL_SAFE_NO_PAD
                    .decode(&sealed.nonce)
                    .unwrap()
                    .try_into()
                    .unwrap(),
            ),
        )
        .unwrap();
        assert_eq!(again.epk, sealed.epk);
        assert_eq!(again.ct, sealed.ct, "{:?}: ciphertext", purpose);

        // The purpose and the device id are bound into the key and the AAD.
        for other in [
            SealPurpose::WakeMac,
            SealPurpose::AmtCred,
            SealPurpose::VaultSecret,
        ] {
            if other != purpose {
                assert!(open_sealed_text(&kex, device_id, other, &sealed).is_err());
            }
        }
        assert!(open_sealed_text(
            &kex,
            "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
            purpose,
            &sealed
        )
        .is_err());
        assert!(open_sealed_text(&[0x77; 32], device_id, purpose, &sealed).is_err());
    }
}

// ---------------------------------------------------------------- §6.1 / §6.2 / rule 9.9

fn patch_of(v: &Value) -> Option<UnattendedPolicyPatch> {
    if v.is_null() {
        return None;
    }
    Some(serde_json::from_value(v.clone()).expect("a policy patch"))
}

fn policy_of(v: &Value) -> UnattendedPolicy {
    serde_json::from_value(v.clone()).expect("a full policy")
}

fn at(v: &Value) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(v.as_str().expect("an ISO instant"))
        .expect("RFC 3339")
        .with_timezone(&Utc)
}

fn interactive_of(v: &Value) -> Option<InteractiveStateName> {
    v.as_str()
        .map(|n| serde_json::from_value(Value::String(n.into())).expect("an interactive state"))
}

#[test]
fn the_policy_merge_matches_the_shared_implementation() {
    let fx = fixture("decisions.json");
    let cases = fx["merge"].as_array().expect("merge cases");
    assert!(cases.len() >= 10, "the merge table is covered");
    for c in cases {
        let name = s(c, "name");
        let got = resolve_unattended_policy(
            patch_of(&c["device"]).as_ref(),
            patch_of(&c["group"]).as_ref(),
            patch_of(&c["org"]).as_ref(),
        );
        if c.get("invalid").and_then(Value::as_bool) == Some(true) {
            assert!(got.is_err(), "{name}: expected the merge to be refused");
        } else {
            assert_eq!(got.expect(name), policy_of(&c["expect"]), "{name}");
        }
    }
}

#[test]
fn the_allowed_hours_arithmetic_matches_the_shared_implementation() {
    let fx = fixture("decisions.json");
    for c in fx["windows"].as_array().expect("window cases") {
        let name = s(c, "name");
        let hours: Option<AllowedHours> = if c["allowedHours"].is_null() {
            None
        } else {
            Some(serde_json::from_value(c["allowedHours"].clone()).expect("allowedHours"))
        };
        let policy = UnattendedPolicy {
            allowed_hours: hours,
            ..UnattendedPolicy::default()
        };
        let now = at(&c["now"]);
        assert_eq!(
            is_within_policy_window(&policy, now),
            c["inside"].as_bool().unwrap(),
            "{name}: inside"
        );
        let next = next_policy_window_start(&policy, now);
        match c["nextStart"].as_str() {
            None => assert!(next.is_none(), "{name}: expected no next window"),
            Some(expected) => {
                let got = next.unwrap_or_else(|| panic!("{name}: expected a next window"));
                assert_eq!(
                    got.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    expected,
                    "{name}: next start"
                );
            }
        }
    }
}

#[test]
fn every_session_decision_row_matches_the_shared_implementation() {
    let fx = fixture("decisions.json");
    let cases = fx["sessions"].as_array().expect("session cases");
    assert!(cases.len() >= 15, "the §6.2 table is covered");
    for c in cases {
        let name = s(c, "name");
        let policy = policy_of(&fx["policies"][s(c, "policy")]);
        let input = SessionInput {
            unattended: c["unattended"].as_bool().unwrap(),
            policy: &policy,
            interactive: interactive_of(&c["interactive"]),
            now: at(&c["now"]),
            recorder_available: c["recorderAvailable"].as_bool(),
        };
        let expect: SessionDecision =
            serde_json::from_value(c["expect"].clone()).expect("a §6.2 outcome");
        assert_eq!(decide_device_session(&input), expect, "{name}");
    }
}

#[test]
fn every_action_decision_row_matches_the_shared_implementation() {
    let fx = fixture("decisions.json");
    let cases = fx["actions"].as_array().expect("action cases");
    assert!(
        cases.len() >= 15,
        "the rule 9.9 table is covered at both stages"
    );
    for c in cases {
        let name = s(c, "name");
        let policy = if c["policy"].is_null() {
            policy_of(&c["policyInline"])
        } else {
            policy_of(&fx["policies"][s(c, "policy")])
        };
        let input = ActionInput {
            stage: serde_json::from_value(c["stage"].clone()).expect("a stage"),
            kind: serde_json::from_value::<DeviceActionKind>(c["kind"].clone()).expect("a kind"),
            privileged: c["privileged"].as_bool().unwrap(),
            policy: &policy,
            interactive: interactive_of(&c["interactive"]),
            now: at(&c["now"]),
        };
        let expect: ActionDecision =
            serde_json::from_value(c["expect"].clone()).expect("a rule 9.9 outcome");
        assert_eq!(decide_device_action(&input), expect, "{name}");
    }
    // Both stages and every kind appear, so the table is not quietly one-sided.
    for stage in ["queue", "dispatch"] {
        assert!(
            cases.iter().any(|c| s(c, "stage") == stage),
            "{stage} is covered"
        );
    }
    for kind in ["playbook_run", "file_push", "print", "message"] {
        assert!(
            cases.iter().any(|c| s(c, "kind") == kind),
            "{kind} is covered"
        );
    }
}
