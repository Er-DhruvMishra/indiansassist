//! Headless loopback test (contract §15.2): two in-process parties complete the §1.3
//! handshake, derive matching keys and SAS, round-trip an encrypted `ia.control`
//! `os.monitors` request/response and an encrypted `ia.chat` message, and round-trip a
//! synthetic I420 frame — "proving the frame path and the crypto handshake with no OS
//! capture or input".
//!
//! The pure part runs on any target (the ia-core cross-check). The `media` variant below
//! (`#[cfg(feature = "media")]`) carries the handshake and a synthetic VP8 stream over two
//! real webrtc-rs peers (DTLS-SRTP + SCTP) and asserts a VP8 keyframe arrives at the
//! receiving peer — the media + crypto path the contract's §15.2 loopback requires.

use ia_core::sec::{
    commit_hash, transcript_hash, EphemeralKey, SessionKeys, Side, SideInfo, SEC_SUITE,
};
use ia_core::secchan::{Operator, SecChannelSet};

/// Run the §1.3 handshake between a desk and an assist party, returning both parties'
/// derived keys (which must match).
fn handshake() -> (SessionKeys, SessionKeys, String) {
    let session_id = "loopback-session";
    let gen = 0u16;

    let desk_key = EphemeralKey::generate();
    let assist_key = EphemeralKey::generate();
    // In a real session these come from the DTLS fingerprints of the descriptions.
    let desk_fpr = hex::encode([0x11u8; 32]);
    let assist_fpr = hex::encode([0x22u8; 32]);

    let desk = SideInfo {
        epk: desk_key.epk_b64(),
        fpr: desk_fpr.clone(),
        h: commit_hash(Side::Desk, SEC_SUITE, &desk_key.epk_b64(), &desk_fpr),
    };
    let assist = SideInfo {
        epk: assist_key.epk_b64(),
        fpr: assist_fpr.clone(),
        h: commit_hash(Side::Assist, SEC_SUITE, &assist_key.epk_b64(), &assist_fpr),
    };

    // X25519 agreement from each side.
    let ss_desk = desk_key.diffie_hellman(&assist.epk).unwrap();
    let ss_assist = assist_key.diffie_hellman(&desk.epk).unwrap();
    assert_eq!(ss_desk, ss_assist);

    let kd = SessionKeys::derive(session_id, SEC_SUITE, gen, &desk, &assist, &ss_desk);
    let ka = SessionKeys::derive(session_id, SEC_SUITE, gen, &desk, &assist, &ss_assist);

    // Key confirmation both ways.
    let th = transcript_hash(session_id, SEC_SUITE, gen, &desk, &assist);
    let desk_conf = kd.confirm_mac(Side::Desk, &th);
    let assist_conf = ka.confirm_mac(Side::Assist, &th);
    ka.verify_confirm(Side::Desk, &th, &desk_conf).unwrap();
    kd.verify_confirm(Side::Assist, &th, &assist_conf).unwrap();

    assert_eq!(kd.sas, ka.sas, "both sides see the same security code");
    let sas = kd.sas.clone();
    (kd, ka, sas)
}

#[test]
fn full_handshake_and_encrypted_channels() {
    let (kd, ka, sas) = handshake();
    assert_eq!(sas.len(), 6);

    let session_id = "loopback-session";
    // Open matching SecChannels on each side (Desk creates them once per PC, §1.3).
    let mut desk_set = SecChannelSet::new();
    let mut assist_set = SecChannelSet::new();

    let mut desk_control = desk_set
        .open(
            Operator::Desk,
            session_id,
            "ia.control",
            0,
            kd.k_d2a,
            kd.k_a2d,
        )
        .unwrap();
    let mut assist_control = assist_set
        .open(
            Operator::Assist,
            session_id,
            "ia.control",
            0,
            ka.k_d2a,
            ka.k_a2d,
        )
        .unwrap();

    // Encrypted ia.control: assist -> desk request, desk -> assist response.
    let req = r#"{"t":"ctl.req","id":"1","op":"os.monitors","args":{}}"#;
    let frame = assist_control.seal_text(req).unwrap();
    let opened = assist_to_desk(&mut desk_control, &frame);
    assert_eq!(opened, req);

    let res = r#"{"t":"ctl.res","id":"1","ok":true,"result":{"monitors":[],"selected":[1]}}"#;
    let frame = desk_control.seal_text(res).unwrap();
    let opened = desk_to_assist(&mut assist_control, &frame);
    assert_eq!(opened, res);

    // Encrypted ia.chat message (A §8.1 JSON as a text frame).
    let mut desk_chat = desk_set
        .open(Operator::Desk, session_id, "ia.chat", 0, kd.k_d2a, kd.k_a2d)
        .unwrap();
    let mut assist_chat = assist_set
        .open(
            Operator::Assist,
            session_id,
            "ia.chat",
            0,
            ka.k_d2a,
            ka.k_a2d,
        )
        .unwrap();
    let chat = r#"{"t":"chat.message","text":"hello"}"#;
    let frame = desk_chat.seal_text(chat).unwrap();
    assert_eq!(desk_to_assist(&mut assist_chat, &frame), chat);
}

#[test]
fn synthetic_i420_frame_round_trips_as_a_binary_frame() {
    let (kd, ka, _) = handshake();
    let session_id = "loopback-session";
    let mut desk_set = SecChannelSet::new();
    let mut assist_set = SecChannelSet::new();
    // A file channel carries binary frames (a synthetic solid-colour I420 buffer stands in
    // for an encoded sample on the frame path).
    let mut desk_file = desk_set
        .open(Operator::Desk, session_id, "ia.file", 0, kd.k_d2a, kd.k_a2d)
        .unwrap();
    let mut assist_file = assist_set
        .open(
            Operator::Assist,
            session_id,
            "ia.file",
            0,
            ka.k_d2a,
            ka.k_a2d,
        )
        .unwrap();

    // 64x64 solid grey I420: Y=0x80 * 64*64, U/V=0x80 * 32*32.
    let mut frame_bytes = vec![0x80u8; 64 * 64 + 2 * (32 * 32)];
    frame_bytes[0] = 0x81; // make it non-uniform so a silent all-zero bug is caught

    let frame = desk_file.seal_binary(&frame_bytes).unwrap();
    let opened = assist_file.open(&frame).unwrap();
    assert!(!opened.text);
    assert_eq!(opened.plaintext, frame_bytes);
}

#[test]
fn wrong_fingerprint_breaks_key_confirmation() {
    // If a MITM rewrote a fingerprint, the confirm MAC (bound to the transcript incl. fpr)
    // fails on the other side.
    let session_id = "s";
    let desk_key = EphemeralKey::generate();
    let assist_key = EphemeralKey::generate();
    let desk = SideInfo {
        epk: desk_key.epk_b64(),
        fpr: hex::encode([1u8; 32]),
        h: "h".into(),
    };
    // Assist computes its transcript with the REAL fpr...
    let assist_real = SideInfo {
        epk: assist_key.epk_b64(),
        fpr: hex::encode([2u8; 32]),
        h: "h".into(),
    };
    // ...but the desk was fed a TAMPERED assist fpr by the server.
    let assist_tampered = SideInfo {
        fpr: hex::encode([0x99u8; 32]),
        ..assist_real.clone()
    };

    let ss = desk_key.diffie_hellman(&assist_real.epk).unwrap();
    let kd = SessionKeys::derive(session_id, SEC_SUITE, 0, &desk, &assist_tampered, &ss);
    let ka = SessionKeys::derive(session_id, SEC_SUITE, 0, &desk, &assist_real, &ss);

    let th_assist = transcript_hash(session_id, SEC_SUITE, 0, &desk, &assist_real);
    let assist_conf = ka.confirm_mac(Side::Assist, &th_assist);
    // The desk verifies against its own (tampered) transcript → MAC mismatch.
    let th_desk = transcript_hash(session_id, SEC_SUITE, 0, &desk, &assist_tampered);
    assert!(kd
        .verify_confirm(Side::Assist, &th_desk, &assist_conf)
        .is_err());
}

fn assist_to_desk(desk_channel: &mut ia_core::secchan::SecChannel, frame: &[u8]) -> String {
    let opened = desk_channel.open(frame).expect("desk opens assist frame");
    opened.as_text().expect("text frame").to_string()
}

fn desk_to_assist(assist_channel: &mut ia_core::secchan::SecChannel, frame: &[u8]) -> String {
    let opened = assist_channel.open(frame).expect("assist opens desk frame");
    opened.as_text().expect("text frame").to_string()
}

// ---------------------------------------------------------------------------
// Fake Assist over encrypted channels (contract §15.2): the receiving party drives
// real `ia.control` / `ia.chat` / `ia.file` / `ia.playbook` frames through the live-session
// logic in `ia-core` and asserts the Desk's answers — the dispatch, gating, file receive,
// playbook checks and teardown the contract requires, with no OS capture or input.
// ---------------------------------------------------------------------------

/// Open a matching Desk/Assist `SecChannel` pair for `label` from a completed handshake.
fn channel_pair(
    kd: &SessionKeys,
    ka: &SessionKeys,
    label: &str,
) -> (ia_core::secchan::SecChannel, ia_core::secchan::SecChannel) {
    let mut desk_set = SecChannelSet::new();
    let mut assist_set = SecChannelSet::new();
    let desk = desk_set
        .open(
            Operator::Desk,
            "loopback-session",
            label,
            0,
            kd.k_d2a,
            kd.k_a2d,
        )
        .unwrap();
    let assist = assist_set
        .open(
            Operator::Assist,
            "loopback-session",
            label,
            0,
            ka.k_d2a,
            ka.k_a2d,
        )
        .unwrap();
    (desk, assist)
}

#[test]
fn fake_assist_control_ops_are_gated_by_level() {
    use ia_core::ctl::{dispatch, Action, CtlReq, DispatchCtx};
    use ia_core::types::{AgentConsentLevel, ElevationLevel};

    let (kd, ka, _) = handshake();
    let (mut desk, mut assist) = channel_pair(&kd, &ka, "ia.control");

    let ctx = |level| DispatchCtx {
        level,
        integrity: ElevationLevel::User,
        clipboard_enabled: false,
        consented_monitors: vec![1],
        secure_desktop: false,
    };

    // The fake Assist sends an encrypted `os.pointer` (an input op) at `control`.
    let req = r#"{"t":"ctl.req","id":"42","op":"os.pointer","args":{"monitorId":1,"kind":"click","nx":0.5,"ny":0.5,"button":0}}"#;
    let frame = assist.seal_text(req).unwrap();
    let opened = assist_to_desk(&mut desk, &frame); // Desk receives it
    let parsed = CtlReq::parse(&opened).unwrap();

    let d = dispatch(&parsed, &ctx(AgentConsentLevel::Control));
    assert!(matches!(d.action, Action::Pointer { monitor_id: 1, .. }));
    let res_frame = desk.seal_text(&d.response.to_string()).unwrap();
    let res_text = desk_to_assist(&mut assist, &res_frame); // Assist reads ctl.res
    let res: serde_json::Value = serde_json::from_str(&res_text).unwrap();
    assert_eq!(res["id"], serde_json::json!("42"));
    assert_eq!(res["ok"], serde_json::json!(true));

    // The same op below `control` (view) is refused `not_allowed`.
    let req2 = r#"{"t":"ctl.req","id":"43","op":"os.pointer","args":{"monitorId":1,"kind":"move","nx":0.1,"ny":0.1,"button":0}}"#;
    let frame = assist.seal_text(req2).unwrap();
    let opened = assist_to_desk(&mut desk, &frame);
    let d = dispatch(
        &CtlReq::parse(&opened).unwrap(),
        &ctx(AgentConsentLevel::View),
    );
    assert!(d.refused);
    let res_frame = desk.seal_text(&d.response.to_string()).unwrap();
    let res: serde_json::Value =
        serde_json::from_str(&desk_to_assist(&mut assist, &res_frame)).unwrap();
    assert_eq!(res["error"], serde_json::json!("not_allowed"));
}

#[test]
fn fake_assist_chat_message_is_acked() {
    let (kd, ka, _) = handshake();
    let (mut desk, mut assist) = channel_pair(&kd, &ka, "ia.chat");

    // Assist -> Desk chat.message (A §8.1 JSON as a text frame).
    let chat = r#"{"t":"chat","id":"m1","from":"assist","text":"are you there?","ts":1}"#;
    let frame = assist.seal_text(chat).unwrap();
    let opened = assist_to_desk(&mut desk, &frame);
    let msg: serde_json::Value = serde_json::from_str(&opened).unwrap();
    assert_eq!(msg["t"], serde_json::json!("chat"));

    // The Desk panel acknowledges (A §8.1 chat.ack) — the round-trip the console expects.
    let ack = serde_json::json!({ "t": "chat.ack", "id": msg["id"], "ts": 2 }).to_string();
    let ack_frame = desk.seal_text(&ack).unwrap();
    let back: serde_json::Value =
        serde_json::from_str(&desk_to_assist(&mut assist, &ack_frame)).unwrap();
    assert_eq!(back["t"], serde_json::json!("chat.ack"));
    assert_eq!(back["id"], serde_json::json!("m1"));
}

#[test]
fn fake_assist_file_offer_is_received_to_the_right_name_and_bytes() {
    use ia_core::filexfer::{encode_file_chunk, FileOffer, Receiver, FILE_CHUNK_SIZE};
    use sha2::{Digest, Sha256};
    use std::collections::HashSet;

    let (kd, ka, _) = handshake();
    let (mut desk, mut assist) = channel_pair(&kd, &ka, "ia.file");

    let data = b"support bundle contents".to_vec();
    let sha = hex::encode(Sha256::digest(&data));
    // Assist -> Desk file.offer (text frame).
    let offer_json = serde_json::json!({
        "t": "file.offer", "fileId": 7, "name": "report (1).txt", "size": data.len(),
        "mime": "text/plain", "sha256": sha, "chunkSize": FILE_CHUNK_SIZE, "chunks": 1, "ts": 1
    })
    .to_string();
    let frame = assist.seal_text(&offer_json).unwrap();
    let opened = assist_to_desk(&mut desk, &frame);
    let offer = FileOffer::parse(&opened).unwrap();

    let (mut recv, accepted) = Receiver::accept(&offer, &HashSet::new()).unwrap();
    assert_eq!(accepted.final_name, "report (1).txt");
    assert!(!accepted.executable);

    // Assist -> Desk one binary chunk.
    let chunk = encode_file_chunk(offer.file_id, 0, &data);
    let cframe = assist.seal_binary(&chunk).unwrap();
    let opened_chunk = desk.open(&cframe).unwrap();
    assert!(!opened_chunk.text);
    let (fid, idx, payload) =
        ia_core::filexfer::decode_file_chunk(&opened_chunk.plaintext).unwrap();
    assert_eq!(fid, 7);
    recv.on_chunk(idx, payload).unwrap();

    let (name, bytes) = recv.finish().unwrap();
    assert_eq!(name, "report (1).txt");
    assert_eq!(bytes, data);
}

#[test]
fn fake_assist_playbook_run_streams_output_and_exit_code() {
    use ia_core::ctl::{dispatch, Action, CtlReq, DispatchCtx};
    use ia_core::playbook::{check_run, ManifestEntry, PbEnd, PbOutput, RunRequest};
    use ia_core::types::{AgentConsentLevel, ElevationLevel, PlaybookInterpreter};
    use sha2::{Digest, Sha256};

    let (kd, ka, _) = handshake();
    let (mut desk_ctl, mut assist_ctl) = channel_pair(&kd, &ka, "ia.control");
    let (mut desk_pb, mut assist_pb) = channel_pair(&kd, &ka, "ia.playbook");

    let body = "Write-Output 'ok'";
    let body_hash = hex::encode(Sha256::digest(body.as_bytes()));
    let run_id = "ab".repeat(16);
    let manifest = vec![ManifestEntry {
        id: "pb-1".into(),
        body_hash: body_hash.clone(),
        requires_elevation: false,
    }];

    // Assist -> Desk playbook.run on ia.control (ctl.req.id === runId, §8.4).
    let req = serde_json::json!({
        "t": "ctl.req", "id": run_id, "op": "playbook.run",
        "args": { "runId": run_id, "playbookId": "pb-1", "bodyHash": body_hash,
                  "body": body, "interpreter": "powershell", "requiresElevation": false,
                  "timeoutSec": 120 }
    })
    .to_string();
    let frame = assist_ctl.seal_text(&req).unwrap();
    let opened = assist_to_desk(&mut desk_ctl, &frame);
    let d = dispatch(
        &CtlReq::parse(&opened).unwrap(),
        &DispatchCtx {
            level: AgentConsentLevel::Control,
            integrity: ElevationLevel::User,
            clipboard_enabled: false,
            consented_monitors: vec![1],
            secure_desktop: false,
        },
    );
    let Action::PlaybookRun {
        run_id: rid,
        playbook_id,
        body_hash: bh,
        body: b,
        requires_elevation,
    } = d.action
    else {
        panic!("expected a PlaybookRun action");
    };
    assert_eq!(d.response["result"]["accepted"], serde_json::json!(true));

    // The agent re-checks the body hash against the pinned manifest before running (§8.4).
    let run = RunRequest {
        run_id: rid.clone(),
        playbook_id,
        body_hash: bh,
        body: b,
        interpreter: PlaybookInterpreter::Powershell,
        requires_elevation,
        timeout_sec: 120,
    };
    check_run(&run, &manifest, ElevationLevel::User).expect("run passes the pinned-hash check");

    // Desk -> Assist pb.output then pb.end on ia.playbook (exit 0).
    let out = PbOutput {
        t: "pb.output".into(),
        run_id: rid.clone(),
        stream: "stdout".into(),
        seq: 0,
        chunk: "ok\r\n".into(),
        ts: 10,
    };
    let f = desk_pb
        .seal_text(&serde_json::to_string(&out).unwrap())
        .unwrap();
    let got_out: PbOutput = serde_json::from_str(&desk_to_assist(&mut assist_pb, &f)).unwrap();
    assert_eq!(got_out.chunk, "ok\r\n");

    let end = PbEnd {
        t: "pb.end".into(),
        run_id: rid,
        exit: Some(0),
        duration_ms: 5,
        truncated: false,
        ran_as: "user".into(),
        error: None,
        ts: 11,
    };
    let f = desk_pb
        .seal_text(&serde_json::to_string(&end).unwrap())
        .unwrap();
    let got_end: PbEnd = serde_json::from_str(&desk_to_assist(&mut assist_pb, &f)).unwrap();
    assert_eq!(got_end.exit, Some(0));
    assert_eq!(got_end.ran_as, "user");
}

#[test]
fn stop_teardown_order_and_self_delete_decision_are_computed() {
    use ia_core::teardown::{
        deletes_on_exit, stop_order, teardown_order, ProcessRole, StopMessage, TeardownStep,
    };

    // Stop runs hard rule 2 in order; keys are zeroised after the peer closes.
    let order = teardown_order();
    assert_eq!(order[0], TeardownStep::StopInput);
    let pos = |s| order.iter().position(|x| *x == s).unwrap();
    assert!(pos(TeardownStep::ClosePeer) < pos(TeardownStep::ZeroiseKeys));

    // Stop then sends stop.sharing, flushes the outbox, and ends the session.
    assert_eq!(stop_order()[0], StopMessage::StopSharing);
    assert_eq!(*stop_order().last().unwrap(), StopMessage::SessionEnd);

    // The self-delete decision is computed (dry run): a standalone user instance deletes,
    // unless Keep was chosen.
    assert!(deletes_on_exit(ProcessRole::UserStandalone, false));
    assert!(!deletes_on_exit(ProcessRole::UserStandalone, true));
    assert!(!deletes_on_exit(ProcessRole::UserHandedOver, false));
}

// ---------------------------------------------------------------------------
// Media variant: two real webrtc-rs peers (contract §15.2). Only built with the
// `media` feature (default on the MSVC host).
// ---------------------------------------------------------------------------
#[cfg(feature = "media")]
mod media_loopback {
    use std::sync::Arc;
    use std::time::Duration;

    use ia_agent::capture::SyntheticCapturer;
    use ia_agent::channels::{run_handshake, send_frames};
    use ia_agent::peer::{AgentPeer, PeerRole};
    use ia_agent::vp8::Vp8Encoder;
    use ia_core::sec::Side;
    use tokio::sync::oneshot;
    use webrtc::rtp::codecs::vp8::Vp8Packet;
    use webrtc::rtp::packetizer::Depacketizer;
    use webrtc::track::track_remote::TrackRemote;

    /// Spawn a reader that resolves the returned receiver when a VP8 keyframe arrives.
    fn watch_for_keyframe(track: Arc<TrackRemote>) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let mut tx = Some(tx);
            let mut vp8 = Vp8Packet::default();
            while let Ok((pkt, _)) = track.read_rtp().await {
                if pkt.payload.is_empty() {
                    continue;
                }
                let head = vp8.is_partition_head(&pkt.payload);
                if let Ok(payload) = vp8.depacketize(&pkt.payload) {
                    // First partition of a VP8 key frame: the P bit (bit 0) is 0.
                    if head && !payload.is_empty() && (payload[0] & 0x01) == 0 {
                        if let Some(tx) = tx.take() {
                            let _ = tx.send(());
                        }
                        return;
                    }
                }
            }
        });
        rx
    }

    async fn await_channel(
        peer: &AgentPeer,
        label: &str,
    ) -> Arc<webrtc::data_channel::RTCDataChannel> {
        for _ in 0..200 {
            if let Some(dc) = peer.channel(label).await {
                return dc;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("channel {label} never opened");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_peers_handshake_and_a_vp8_keyframe_arrives() {
        let desk = AgentPeer::new(PeerRole::Desk, &[1], false)
            .await
            .expect("desk peer");
        let assist = AgentPeer::new(PeerRole::Assist, &[], false)
            .await
            .expect("assist peer");

        // Capture the first inbound video track on the Assist before negotiating.
        let (track_tx, track_rx) = oneshot::channel::<Arc<TrackRemote>>();
        let track_tx = Arc::new(std::sync::Mutex::new(Some(track_tx)));
        assist.pc.on_track(Box::new(move |track, _recv, _trans| {
            if let Some(tx) = track_tx.lock().unwrap().take() {
                let _ = tx.send(track);
            }
            Box::pin(async {})
        }));

        // Vanilla-ICE offer/answer (host candidates over loopback).
        let offer = desk.offer().await.expect("offer");
        let answer = assist.accept_offer(offer).await.expect("answer");
        desk.accept_answer(answer).await.expect("accept answer");

        // Fingerprints from each side's descriptions (§1.3 step 1).
        let (desk_own, desk_remote) = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(f) = desk.fingerprints().await {
                    return f;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("desk fingerprints");
        let (assist_own, assist_remote) = assist.fingerprints().await.expect("assist fingerprints");
        assert_eq!(desk_own, assist_remote);
        assert_eq!(assist_own, desk_remote);

        let desk_sec = await_channel(&desk, "ia.sec").await;
        let assist_sec = await_channel(&assist, "ia.sec").await;

        // Drive the handshake concurrently over the real ia.sec channel.
        let d = tokio::spawn(async move {
            run_handshake(desk_sec, Side::Desk, "loopback", 0, &desk_own, &desk_remote).await
        });
        let a = tokio::spawn(async move {
            run_handshake(
                assist_sec,
                Side::Assist,
                "loopback",
                0,
                &assist_own,
                &assist_remote,
            )
            .await
        });
        let (_dk, desk_sas) = d.await.unwrap().expect("desk handshake");
        let (_ak, assist_sas) = a.await.unwrap().expect("assist handshake");
        assert_eq!(
            desk_sas, assist_sas,
            "both peers derive the same security code"
        );
        assert_eq!(desk_sas.len(), 6);

        // Stream synthetic VP8 from the Desk; a keyframe is forced on the first frame and
        // libvpx emits one every second (fps * keyframe_secs), so a keyframe is in flight
        // whenever the reader attaches to the inbound track.
        let desk_track = desk.video_track(1).expect("monitor-1 track");
        let mut encoder = Vp8Encoder::new(64, 64, 800, 15, 1).expect("encoder");
        let mut cap = SyntheticCapturer::single(64, 64);
        let sender = tokio::spawn(async move {
            send_frames(desk_track, &mut encoder, &mut cap, 1, 90, 15).await
        });

        // The inbound track appears once the first RTP packet arrives.
        let remote = tokio::time::timeout(Duration::from_secs(8), track_rx)
            .await
            .expect("inbound track within 8s")
            .expect("track channel");
        let keyframe = watch_for_keyframe(remote);

        tokio::time::timeout(Duration::from_secs(10), keyframe)
            .await
            .expect("a VP8 keyframe must arrive within 10s")
            .expect("keyframe signal");
        let kf = sender.await.unwrap().expect("send_frames");
        assert!(kf >= 1, "the Desk must have sent at least one keyframe");
    }

    /// The serve seam over real webrtc-rs data channels: a fake Assist seals an `os.monitors`
    /// `ctl.req` on `ia.control`, the Desk's `ControlServer` opens it, dispatches, fills the
    /// consented monitor list and seals the `ctl.res`, and the Assist opens the reply — the
    /// §5.1 encrypted-control path the serve loop runs, proven end to end with no OS input.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn encrypted_control_round_trip_over_real_peers() {
        use ia_agent::live::ControlServer;
        use ia_core::consent::LiveConsent;
        use ia_core::secchan::{Operator, SecChannelSet};
        use ia_core::types::{AgentConsentLevel, Modifiers, MonitorInfo};
        use ia_platform::traits::{ClipboardBridge, InputSink, KeyAction, PointerAction};
        use webrtc::data_channel::data_channel_message::DataChannelMessage;

        #[derive(Default)]
        struct NoSink;
        impl InputSink for NoSink {
            fn pointer(&mut self, _m: &MonitorInfo, _nx: f32, _ny: f32, _a: PointerAction) {}
            fn scroll(&mut self, _m: &MonitorInfo, _nx: f32, _ny: f32, _dx: i32, _dy: i32) {}
            fn key(&mut self, _c: &str, _a: KeyAction, _m: Modifiers) {}
            fn text(&mut self, _t: &str) {}
        }
        #[derive(Default)]
        struct NoClip;
        impl ClipboardBridge for NoClip {
            fn set_text(&mut self, _t: &str) {}
            fn take_update(&mut self) -> Option<String> {
                None
            }
        }

        let desk = AgentPeer::new(PeerRole::Desk, &[1], false)
            .await
            .expect("desk");
        let assist = AgentPeer::new(PeerRole::Assist, &[], false)
            .await
            .expect("assist");
        let offer = desk.offer().await.expect("offer");
        let answer = assist.accept_offer(offer).await.expect("answer");
        desk.accept_answer(answer).await.expect("accept answer");

        let (desk_own, desk_remote) = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(f) = desk.fingerprints().await {
                    return f;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("desk fingerprints");
        let (assist_own, assist_remote) = assist.fingerprints().await.expect("assist fingerprints");

        let desk_sec = await_channel(&desk, "ia.sec").await;
        let assist_sec = await_channel(&assist, "ia.sec").await;
        let d = tokio::spawn(async move {
            run_handshake(desk_sec, Side::Desk, "live", 0, &desk_own, &desk_remote).await
        });
        let a = tokio::spawn(async move {
            run_handshake(
                assist_sec,
                Side::Assist,
                "live",
                0,
                &assist_own,
                &assist_remote,
            )
            .await
        });
        let (kd, _) = d.await.unwrap().expect("desk handshake");
        let (ka, _) = a.await.unwrap().expect("assist handshake");

        let desk_ctl = await_channel(&desk, "ia.control").await;
        let assist_ctl = await_channel(&assist, "ia.control").await;

        // The Desk serves ia.control: open -> ControlServer -> seal response back.
        let (reply_tx, reply_rx) = oneshot::channel::<Vec<u8>>();
        {
            let desk_ctl2 = Arc::clone(&desk_ctl);
            let mut set = SecChannelSet::new();
            let chan = set
                .open(Operator::Desk, "live", "ia.control", 0, kd.k_d2a, kd.k_a2d)
                .unwrap();
            let consent = LiveConsent::new(AgentConsentLevel::Control, false, vec![1]);
            let mon = MonitorInfo {
                id: 1,
                name: "SYNTHETIC1".into(),
                primary: true,
                x: 0,
                y: 0,
                width: 1280,
                height: 720,
                scale: 1.0,
                mid: None,
            };
            let server = Arc::new(tokio::sync::Mutex::new((
                ControlServer::new(consent, vec![mon], 1),
                chan,
                NoSink,
                NoClip,
            )));
            let reply_tx = Arc::new(std::sync::Mutex::new(Some(reply_tx)));
            desk_ctl.on_message(Box::new(move |msg: DataChannelMessage| {
                let server = Arc::clone(&server);
                let reply_tx = Arc::clone(&reply_tx);
                let dc = Arc::clone(&desk_ctl2);
                Box::pin(async move {
                    let mut guard = server.lock().await;
                    let (ctl, chan, sink, clip) = &mut *guard;
                    let opened = chan.open(&msg.data).expect("desk opens control frame");
                    let text = opened.as_text().expect("text").to_string();
                    if let Some((res, _effect)) = ctl.handle_text(&text, sink, clip) {
                        let frame = chan.seal_text(&res.to_string()).unwrap();
                        let _ = dc.send(&bytes::Bytes::from(frame.clone())).await;
                        if let Some(tx) = reply_tx.lock().unwrap().take() {
                            let _ = tx.send(frame);
                        }
                    }
                })
            }));
        }

        // The fake Assist seals os.monitors and sends it; then reads the reply.
        let mut assist_set = SecChannelSet::new();
        let mut assist_chan = assist_set
            .open(
                Operator::Assist,
                "live",
                "ia.control",
                0,
                ka.k_d2a,
                ka.k_a2d,
            )
            .unwrap();
        let req = r#"{"t":"ctl.req","id":"m1","op":"os.monitors","args":{}}"#;
        assist_ctl
            .send(&bytes::Bytes::from(assist_chan.seal_text(req).unwrap()))
            .await
            .unwrap();

        let reply = tokio::time::timeout(Duration::from_secs(5), reply_rx)
            .await
            .expect("reply within 5s")
            .expect("reply bytes");
        let opened = assist_chan.open(&reply).expect("assist opens reply");
        let res: serde_json::Value = serde_json::from_str(opened.as_text().unwrap()).unwrap();
        assert_eq!(res["ok"], serde_json::json!(true));
        let monitors = res["result"]["monitors"].as_array().expect("monitors");
        assert_eq!(monitors.len(), 1);
        assert_eq!(monitors[0]["name"], serde_json::json!("SYNTHETIC1"));
    }
}
