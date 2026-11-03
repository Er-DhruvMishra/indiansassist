//! Cross-language conformance: ia-core against `packages/shared/test/fixtures/agent/`, the
//! same files the TypeScript (`packages/shared/test/agent-sec.test.ts`) and Kotlin
//! (`apps/android` `Vectors.kt`) tests load (contract §13.1 "Ownership of names", §15.1-15.2).

use std::path::PathBuf;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ia_core::canonical::canonical_json;
use ia_core::files::{
    sanitise_file_name, EXECUTABLE_EXTENSIONS, PASSIVE_RISK_EXTENSIONS, RESERVED_DEVICE_STEMS,
};
use ia_core::join_input::{is_valid_short_code, normalise_token_input, TokenInput};
use ia_core::sec::{
    commit_hash, fingerprint_from_sdp, transcript_hash, verify_hello, EphemeralKey, SecCommit,
    SecConfirm, SecHello, SessionKeys, Side, SideInfo, SEC_SUITE,
};
use ia_core::secchan::{Operator, SecChannelSet};
use ia_core::types::{op_id_for, sec_label_id, SecFailReason};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/shared/test/fixtures/agent")
        .join(name);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    serde_json::from_str(&text).expect("fixture is JSON")
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("{k} not a string"))
}

fn h32(hex_str: &str) -> [u8; 32] {
    hex::decode(hex_str).unwrap().try_into().unwrap()
}

fn side_of(name: &str) -> Side {
    match name {
        "desk" => Side::Desk,
        "assist" => Side::Assist,
        other => panic!("side {other}"),
    }
}

fn side_info(h: &Value, side: &str) -> SideInfo {
    let p = &h[side];
    SideInfo {
        h: s(p, "h").into(),
        epk: s(p, "epk").into(),
        fpr: s(p, "fpr").into(),
    }
}

fn reason_name(r: SecFailReason) -> String {
    serde_json::to_value(r)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

fn handshake_keys(v: &Value, gen: u64) -> (String, [u8; 32], [u8; 32]) {
    let h = v["handshakes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["gen"].as_u64() == Some(gen))
        .expect("handshake for gen");
    let e = &h["expected"];
    (
        s(h, "sessionId").into(),
        h32(s(e, "kD2AHex")),
        h32(s(e, "kA2DHex")),
    )
}

#[test]
fn constants_and_xchacha_draft_vector() {
    let v = fixture("sec-vectors.json");
    assert_eq!(s(&v, "suite"), SEC_SUITE);
    for (label, id) in v["labelIds"].as_object().unwrap() {
        assert_eq!(
            sec_label_id(label),
            Some(id.as_u64().unwrap() as u8),
            "{label}"
        );
    }
    let d = &v["xchacha20poly1305Draft"];
    let cipher = XChaCha20Poly1305::new(h32(s(d, "keyHex")).as_slice().into());
    let nonce = hex::decode(s(d, "nonceHex")).unwrap();
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: s(d, "plaintextUtf8").as_bytes(),
                aad: &hex::decode(s(d, "aadHex")).unwrap(),
            },
        )
        .unwrap();
    assert_eq!(hex::encode(ct), s(d, "ciphertextAndTagHex"));
}

#[test]
fn handshakes_derive_identical_keys_sas_and_macs() {
    let v = fixture("sec-vectors.json");
    for h in v["handshakes"].as_array().unwrap() {
        let name = s(h, "name");
        let gen = h["gen"].as_u64().unwrap() as u16;
        let mut keys = Vec::new();
        for side in ["desk", "assist"] {
            let p = &h[side];
            let k = EphemeralKey::from_secret_bytes(h32(s(p, "eskHex")));
            assert_eq!(k.epk_b64(), s(p, "epk"), "{name} {side} epk");
            assert_eq!(
                commit_hash(side_of(side), s(h, "suite"), s(p, "epk"), s(p, "fpr")),
                s(p, "h"),
                "{name} {side} commit"
            );
            let commit: SecCommit = serde_json::from_value(p["commit"].clone()).unwrap();
            assert_eq!(serde_json::to_value(&commit).unwrap(), p["commit"]);
            let hello: SecHello = serde_json::from_value(p["hello"].clone()).unwrap();
            assert_eq!(serde_json::to_value(&hello).unwrap(), p["hello"]);
            verify_hello(&hello, &commit.h).expect("hello matches commit");
            keys.push(k);
        }
        let e = &h["expected"];
        let ss_d = keys[0].diffie_hellman(s(&h["assist"], "epk")).unwrap();
        let ss_a = keys[1].diffie_hellman(s(&h["desk"], "epk")).unwrap();
        assert_eq!(hex::encode(ss_d), s(e, "ssHex"));
        assert_eq!(ss_a, ss_d);
        let (desk, assist) = (side_info(h, "desk"), side_info(h, "assist"));
        let sid = s(h, "sessionId");
        let t = transcript_hash(sid, s(h, "suite"), gen, &desk, &assist);
        assert_eq!(hex::encode(t), s(e, "transcriptHashHex"), "{name} T");
        let sk = SessionKeys::derive(sid, s(h, "suite"), gen, &desk, &assist, &ss_d);
        assert_eq!(hex::encode(sk.k_d2a), s(e, "kD2AHex"));
        assert_eq!(hex::encode(sk.k_a2d), s(e, "kA2DHex"));
        assert_eq!(sk.sas, s(e, "sas"));
        assert_eq!(sk.sas_display(), s(e, "sasDisplay"));
        for (side, key) in [(Side::Desk, "deskConfirm"), (Side::Assist, "assistConfirm")] {
            let c: SecConfirm = serde_json::from_value(e[key].clone()).unwrap();
            assert_eq!(sk.confirm_mac(side, &t), c.mac, "{name} {key}");
            sk.verify_confirm(side, &t, &c.mac).unwrap();
        }
    }
}

#[test]
fn every_frame_vector_seals_and_opens_byte_for_byte() {
    let v = fixture("sec-vectors.json");
    for f in v["frames"].as_array().unwrap() {
        let label = s(f, "label");
        let gen = f["gen"].as_u64().unwrap();
        let seq = f["seq"].as_u64().unwrap();
        let (sid, kd2a, ka2d) = handshake_keys(&v, gen);
        let d2a = s(f, "direction") == "desk_to_assist";
        let (sender, receiver) = if d2a {
            (Operator::Desk, Operator::Assist)
        } else {
            (Operator::Assist, Operator::Desk)
        };
        let mut set = SecChannelSet::new();
        let mut tx = set
            .open(sender, &sid, label, gen as u16, kd2a, ka2d)
            .unwrap();
        let mut rx = set
            .open(receiver, &sid, label, gen as u16, kd2a, ka2d)
            .unwrap();
        // Advance both counters to the vector's seq with throwaway frames (seq is per channel).
        let mut frame = Vec::new();
        for _ in 0..=seq.min(8) {
            frame = match f.get("plaintextUtf8").and_then(Value::as_str) {
                Some(text) => tx.seal_text(text).unwrap(),
                None => tx
                    .seal_binary(&hex::decode(s(f, "plaintextHex")).unwrap())
                    .unwrap(),
            };
            if u64::from_be_bytes(frame[2..10].try_into().unwrap()) == seq {
                break;
            }
            rx.open(&frame).unwrap();
        }
        if seq > 8 {
            // seq 2^32: verify against an independent seal (the counter cannot be fast-forwarded).
            let nonce = hex::decode(s(f, "nonceHex")).unwrap();
            let key = if d2a { kd2a } else { ka2d };
            let ct = XChaCha20Poly1305::new(key.as_slice().into())
                .encrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: s(f, "plaintextUtf8").as_bytes(),
                        aad: &hex::decode(s(f, "aadHex")).unwrap(),
                    },
                )
                .unwrap();
            let mut expect = vec![1u8, f["flags"].as_u64().unwrap() as u8];
            expect.extend_from_slice(&seq.to_be_bytes());
            expect.extend_from_slice(&ct);
            assert_eq!(hex::encode(expect), s(f, "frameHex"), "{label} seq {seq}");
            continue;
        }
        assert_eq!(hex::encode(&frame), s(f, "frameHex"), "{label} seq {seq}");
        let opened = rx.open(&hex::decode(s(f, "frameHex")).unwrap()).unwrap();
        assert_eq!(opened.text, f["flags"].as_u64() == Some(1));
    }
}

#[test]
fn negative_vectors_give_the_expected_reason() {
    let v = fixture("sec-vectors.json");
    let h0 = &v["handshakes"][0];
    for n in v["negative"].as_array().unwrap() {
        let name = s(n, "name");
        let got: SecFailReason = match s(n, "kind") {
            "hello" => {
                let hello: SecHello = serde_json::from_value(n["hello"].clone()).unwrap();
                verify_hello(&hello, s(n, "committedH")).unwrap_err()
            }
            "fingerprint" => {
                assert_ne!(s(&n["hello"], "fpr"), s(n, "observedRemoteFpr"));
                SecFailReason::Fingerprint
            }
            "key" => {
                let k = EphemeralKey::from_secret_bytes(h32(s(n, "eskHex")));
                assert!(k.diffie_hellman(s(n, "peerEpk")).is_err(), "{name}");
                SecFailReason::Key
            }
            "mac" => {
                let (desk, assist) = (side_info(h0, "desk"), side_info(h0, "assist"));
                let sid = s(h0, "sessionId");
                let k = EphemeralKey::from_secret_bytes(h32(s(&h0["desk"], "eskHex")));
                let ss = k.diffie_hellman(s(&h0["assist"], "epk")).unwrap();
                let sk = SessionKeys::derive(sid, SEC_SUITE, 0, &desk, &assist, &ss);
                let t = transcript_hash(sid, SEC_SUITE, 0, &desk, &assist);
                sk.verify_confirm(Side::Assist, &t, s(n, "mac"))
                    .unwrap_err()
            }
            "frame" => {
                let gen = n["gen"].as_u64().unwrap();
                let (sid, kd2a, ka2d) = handshake_keys(&v, gen);
                let receiver = if s(n, "direction") == "desk_to_assist" {
                    Operator::Assist
                } else {
                    Operator::Desk
                };
                let label = s(n, "label");
                let mut set = SecChannelSet::new();
                let mut rx = set
                    .open(receiver, &sid, label, gen as u16, kd2a, ka2d)
                    .unwrap();
                let sender = if receiver == Operator::Desk {
                    Operator::Assist
                } else {
                    Operator::Desk
                };
                let mut tx = set
                    .open(sender, &sid, label, gen as u16, kd2a, ka2d)
                    .unwrap();
                for _ in 0..n["expectedSeq"].as_u64().unwrap() {
                    rx.open(&tx.seal_text("{}").unwrap()).unwrap();
                }
                rx.open(&hex::decode(s(n, "frameHex")).unwrap())
                    .unwrap_err()
            }
            other => panic!("unknown negative kind {other}"),
        };
        assert_eq!(reason_name(got), s(n, "expect"), "{name}");
    }
}

#[test]
fn helper_vectors_agree_with_shared() {
    let v = fixture("sec-vectors.json");
    for f in v["fingerprintFromSdp"].as_array().unwrap() {
        assert_eq!(
            fingerprint_from_sdp(s(f, "sdp")).as_deref(),
            f["fpr"].as_str(),
            "{}",
            s(f, "name")
        );
    }
    for c in v["canonicalJson"].as_array().unwrap() {
        assert_eq!(canonical_json(&c["value"]), s(c, "canonical"));
    }
    for o in v["opIds"].as_array().unwrap() {
        assert_eq!(op_id_for(s(o, "sessionId"), s(o, "id")), s(o, "opId"));
    }
    for f in v["fileNames"].as_array().unwrap() {
        let got = sanitise_file_name(s(f, "name"), f["fileId"].as_u64().unwrap());
        assert_eq!(got, s(f, "sanitised"), "{:?}", s(f, "name"));
    }
    for j in v["joinInput"].as_array().unwrap() {
        let got = normalise_token_input(s(j, "input")).map(|t| match t {
            TokenInput::Compact(c) => ("compact".to_string(), c),
            TokenInput::ShortCode(c) => ("short_code".to_string(), c),
        });
        let want = j["normalised"].as_object().map(|o| {
            (
                s(&j["normalised"], "kind").to_string(),
                o["value"].as_str().unwrap().to_string(),
            )
        });
        assert_eq!(got, want, "{:?}", s(j, "input"));
    }
    for c in v["shortCodes"].as_array().unwrap() {
        assert_eq!(
            is_valid_short_code(s(c, "code")),
            c["valid"].as_bool().unwrap()
        );
    }
    // A fresh key's epk is 43 base64url chars.
    assert_eq!(EphemeralKey::generate().epk_b64().len(), 43);
    assert_eq!(URL_SAFE_NO_PAD.encode([0u8; 32]).len(), 43);
}

#[test]
fn file_lists_equal_the_shared_lists() {
    let v = fixture("file-lists.json");
    let list = |k: &str| -> Vec<String> {
        v[k].as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(list("executableExtensions"), EXECUTABLE_EXTENSIONS);
    assert_eq!(list("passiveRiskExtensions"), PASSIVE_RISK_EXTENSIONS);
    assert_eq!(list("reservedDeviceStems"), RESERVED_DEVICE_STEMS);
}

fn names<T: serde::Serialize>(all: &[T]) -> Vec<String> {
    all.iter()
        .map(|v| {
            serde_json::to_value(v)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn wire_names_equal_the_shared_names() {
    use ia_core::control::{
        agent_min_level_for, ElevationDenyCause, ElevationFailError, AGENT_CONTROL_ERROR_CODES,
        AGENT_CONTROL_EVENT_KINDS, AGENT_CONTROL_OPS,
    };
    use ia_core::playbook::PlaybookError;
    use ia_core::types::{
        limits, AgentConsentLevel, CapturePath, ElevationLevel, NavAction, PlaybookInterpreter,
        QualityPreset, TokenSource, VideoEncoder, AGENT_FEATURES, P3_DATA_CHANNEL_LABELS,
        SEC_ENCRYPTED_LABELS, WS_CLOSE_HANDED_OVER,
    };
    let v = fixture("agent-names.json");
    assert_eq!(
        names(&AgentConsentLevel::ALL),
        strs(&v["agentConsentLevels"])
    );
    assert_eq!(names(&ElevationLevel::ALL), strs(&v["elevationLevels"]));
    assert_eq!(AGENT_FEATURES, strs(&v["agentFeatures"]));
    assert_eq!(names(&VideoEncoder::ALL), strs(&v["videoEncoders"]));
    assert_eq!(names(&QualityPreset::ALL), strs(&v["qualityPresets"]));
    assert_eq!(names(&TokenSource::ALL), strs(&v["tokenSources"]));
    assert_eq!(
        names(&PlaybookInterpreter::ALL),
        strs(&v["playbookInterpreters"])
    );
    assert_eq!(names(&PlaybookError::ALL), strs(&v["playbookErrors"]));
    assert_eq!(
        names(&ElevationDenyCause::ALL),
        strs(&v["elevationDenyCauses"])
    );
    assert_eq!(
        names(&ElevationFailError::ALL),
        strs(&v["elevationFailErrors"])
    );
    assert_eq!(names(&NavAction::ALL), strs(&v["navActions"]));
    assert_eq!(names(&CapturePath::ALL), strs(&v["capturePaths"]));
    // Phase F revision 3: `sck_stopped` (apple) is mirrored in the shared CAPTURE_CAUSES too.
    let causes: Vec<String> = ia_core::capture_decision::CaptureCause::ALL
        .iter()
        .map(|c| c.as_str().to_string())
        .collect();
    assert_eq!(causes, strs(&v["captureCauses"]));
    assert_eq!(names(&SecFailReason::ALL), strs(&v["secFailReasons"]));
    assert_eq!(P3_DATA_CHANNEL_LABELS, strs(&v["p3DataChannelLabels"]));
    assert_eq!(SEC_ENCRYPTED_LABELS, strs(&v["secEncryptedLabels"]));
    assert_eq!(AGENT_CONTROL_OPS, strs(&v["agentControlOps"]));
    for (op, level) in v["agentMinLevels"].as_object().unwrap() {
        let got = agent_min_level_for(op, false).map(|l| names(&[l]).remove(0));
        assert_eq!(got.as_deref(), level.as_str(), "{op}");
    }
    assert_eq!(
        AGENT_CONTROL_ERROR_CODES,
        strs(&v["agentControlErrorCodes"])
    );
    assert_eq!(
        AGENT_CONTROL_EVENT_KINDS,
        strs(&v["agentControlEventKinds"])
    );
    assert_eq!(
        u64::from(WS_CLOSE_HANDED_OVER),
        v["wsCloseHandedOver"].as_u64().unwrap()
    );
    let l = &v["limits"];
    let lim = |k: &str| l[k].as_u64().unwrap_or_else(|| panic!("{k}"));
    assert_eq!(
        limits::SEC_HANDSHAKE_TIMEOUT_MS,
        lim("secHandshakeTimeoutMs")
    );
    assert_eq!(limits::SEC_FRAME_MAX_BYTES as u64, lim("secFrameMaxBytes"));
    assert_eq!(limits::DOWNLOAD_GRANT_TTL_SEC, lim("downloadGrantTtlSec"));
    assert_eq!(
        u64::from(limits::DOWNLOAD_GRANT_MAX_USES),
        lim("downloadGrantMaxUses")
    );
    assert_eq!(limits::HANDOVER_TTL_SEC, lim("handoverTtlSec"));
    assert_eq!(
        u64::from(limits::HANDOVER_MINTS_PER_10MIN),
        lim("handoverMintsPer10Min")
    );
    assert_eq!(limits::IACONFIG_MAX_BYTES as u64, lim("iaconfigMaxBytes"));
    assert_eq!(limits::CLIPBOARD_MAX_BYTES as u64, lim("clipboardMaxBytes"));
    assert_eq!(u64::from(limits::AGENT_MAX_KBPS), lim("agentMaxKbps"));
    assert_eq!(limits::AGENT_STATS_INTERVAL_MS, lim("agentStatsIntervalMs"));
    assert_eq!(
        u64::from(limits::POINTER_MOVES_PER_SEC_NATIVE),
        lim("pointerMovesPerSecNative")
    );
    assert_eq!(
        u64::from(limits::TEXT_CHARS_PER_SEC),
        lim("textCharsPerSec")
    );
    assert_eq!(
        limits::TEXT_QUEUE_MAX_UNITS as u64,
        lim("textQueueMaxUnits")
    );
    assert_eq!(limits::TEXT_BURST_CHARS as u64, lim("textBurstChars"));
    assert_eq!(
        limits::PLAYBOOK_BODY_MAX_BYTES as u64,
        lim("playbookBodyMaxBytes")
    );
    assert_eq!(
        u64::from(limits::PLAYBOOK_TIMEOUT_MAX_SEC),
        lim("playbookTimeoutMaxSec")
    );
    assert_eq!(
        limits::PLAYBOOK_OUTPUT_MAX_BYTES as u64,
        lim("playbookOutputMaxBytes")
    );
    assert_eq!(
        limits::PLAYBOOK_CATALOGUE_MAX as u64,
        lim("playbookCatalogueMax")
    );
    assert_eq!(
        limits::PLAYBOOK_MANIFEST_MAX_BYTES as u64,
        lim("playbookManifestMaxBytes")
    );
    assert_eq!(limits::PLAYBOOK_PARAMS_MAX as u64, lim("playbookParamsMax"));
    assert_eq!(limits::FILE_MAX_BYTES_NATIVE, lim("fileMaxBytesNative"));
    assert_eq!(u64::from(limits::MONITORS_MAX), lim("monitorsMax"));
}

#[test]
fn linux_file_names_agree_with_shared() {
    // Phase E §7.6: the inner binary name of the Linux archive, mirrored from the shared TS.
    use ia_core::download::{agent_linux_file_name, parse_linux_filename};
    let v = fixture("agent-names.json");
    let cases = v["linuxFileNames"].as_array().expect("linuxFileNames");
    assert!(cases.len() >= 5);
    let regions = ["in-mum", "eu-fra", "us-east"];
    for c in cases {
        let name = s(c, "name");
        let got = parse_linux_filename(name, &regions);
        match c["parsed"].as_object() {
            Some(p) => {
                let got = got.unwrap_or_else(|| panic!("{name} must parse"));
                assert_eq!(got.region, p["region"].as_str().unwrap(), "{name}");
                assert_eq!(got.code, p["deskCode"].as_str().unwrap(), "{name}");
                assert_eq!(
                    agent_linux_file_name(&got.region, &got.code).as_deref(),
                    Some(name)
                );
            }
            None => assert!(got.is_none(), "{name} must not parse"),
        }
    }
}

#[test]
fn modifiers_are_strict_like_the_shared_schema() {
    use ia_core::types::Modifiers;
    let all = r#"{"ctrl":false,"shift":true,"alt":false,"meta":false}"#;
    assert!(serde_json::from_str::<Modifiers>(all).unwrap().shift);
    assert!(serde_json::from_str::<Modifiers>("{}").is_err());
    let extra = r#"{"ctrl":false,"shift":true,"alt":false,"meta":false,"fn":true}"#;
    assert!(serde_json::from_str::<Modifiers>(extra).is_err());
}

/// `fixtures/agent/playbook-args.json`: the agent path (`canonicalCases`, canonical strings)
/// and the cmd value rule (`cmdCases`) agree with the TypeScript `validatePlaybookArgs`.
#[test]
fn playbook_args_canonical_and_cmd_cases_agree_with_shared() {
    use ia_core::playbook::{cmd_value_re, validate_canonical_playbook_args, PlaybookParam};
    use ia_core::types::PlaybookInterpreter;
    use std::collections::BTreeMap;
    let v = fixture("playbook-args.json");
    let params: Vec<PlaybookParam> = serde_json::from_value(v["params"].clone()).unwrap();
    for case in v["canonicalCases"].as_array().unwrap() {
        let args: BTreeMap<String, Value> = serde_json::from_value(case["args"].clone()).unwrap();
        let got = validate_canonical_playbook_args(&params, &args, PlaybookInterpreter::Powershell);
        let want_ok = case["ok"].as_bool().unwrap();
        assert_eq!(got.is_ok(), want_ok, "{}: {got:?}", s(case, "name"));
        if let (Err(e), Some(param)) = (&got, case["param"].as_str()) {
            assert!(e.contains(param), "{}: {e}", s(case, "name"));
        }
    }
    for case in v["cmdCases"].as_array().unwrap() {
        assert_eq!(
            cmd_value_re().is_match(s(case, "value")),
            case["ok"].as_bool().unwrap(),
            "{}",
            s(case, "name")
        );
    }
}
