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
}
