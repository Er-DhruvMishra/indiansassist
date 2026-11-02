//! Server-recorder loopback (contract §9 R2 / §15.2): a third in-process webrtc-rs peer plays
//! the Phase A.2 recorder exactly as `services/recorder` builds it (receive-only, one recvonly
//! video and one recvonly audio m-line, VP8 96 / VP9 98 / Opus 111, no data channel, vanilla
//! ICE offer). The agent answers with [`RecorderPeer`] and the real pump feeds the recorder
//! track; the recorder must receive decodable VP8 frames at the `min(assistRung, medium)` size:
//! through the **shared** encoder when the Assist runs at `medium`, through a **second** libvpx
//! instance when the Assist runs above it, and back on the shared encoder (with a fresh
//! keyframe) when the ABR drops the Assist to `floor`.
#![cfg(feature = "media")]

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ia_agent::capture::SyntheticCapturer;
use ia_agent::pump::{run_pump, CaptureSource, PumpSpec, VideoCtl};
use ia_agent::recorder::RecorderPeer;
use ia_core::abr::Rung;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS, MIME_TYPE_VP8, MIME_TYPE_VP9};
use webrtc::api::APIBuilder;
use webrtc::interceptor::registry::Registry;
use webrtc::media::io::sample_builder::SampleBuilder;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::codecs::vp8::Vp8Packet;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType,
};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

/// What the fake recorder saw: every VP8 frame (keyframe flag, keyframe size).
#[derive(Default)]
struct Seen {
    frames: Vec<(bool, Option<(u16, u16)>)>,
    mime: String,
}

/// The VP8 keyframe header size (RFC 6386 9.1: start code then 14-bit width / height).
fn vp8_keyframe_size(frame: &[u8]) -> Option<(u16, u16)> {
    if frame.len() < 10 || frame[0] & 0x01 != 0 || frame[3..6] != [0x9d, 0x01, 0x2a] {
        return None;
    }
    let w = u16::from_le_bytes([frame[6], frame[7]]) & 0x3fff;
    let h = u16::from_le_bytes([frame[8], frame[9]]) & 0x3fff;
    Some((w, h))
}

/// The recorder's receive-only PC (mirrors `services/recorder/internal/peer`).
async fn fake_recorder() -> (Arc<RTCPeerConnection>, Arc<Mutex<Seen>>) {
    let mut me = MediaEngine::default();
    let video = |mime: &str, pt: u8, fmtp: &str| RTCRtpCodecParameters {
        capability: RTCRtpCodecCapability {
            mime_type: mime.to_string(),
            clock_rate: 90000,
            channels: 0,
            sdp_fmtp_line: fmtp.to_string(),
            rtcp_feedback: vec![],
        },
        payload_type: pt,
        stats_id: String::new(),
    };
    me.register_codec(video(MIME_TYPE_VP8, 96, ""), RTPCodecType::Video)
        .unwrap();
    me.register_codec(
        video(MIME_TYPE_VP9, 98, "profile-id=0"),
        RTPCodecType::Video,
    )
    .unwrap();
    me.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_string(),
                clock_rate: 48000,
                channels: 2,
                sdp_fmtp_line: "minptime=10;useinbandfec=1".to_string(),
                rtcp_feedback: vec![],
            },
            payload_type: 111,
            stats_id: String::new(),
        },
        RTPCodecType::Audio,
    )
    .unwrap();
    let registry = register_default_interceptors(Registry::new(), &mut me).unwrap();
    // Loopback-only ICE, as the agent side gets from IA_ICE_LOOPBACK: no host-firewall prompt on
    // macOS, the same result elsewhere.
    let mut se = webrtc::api::setting_engine::SettingEngine::default();
    se.set_include_loopback_candidate(true);
    se.set_ip_filter(Box::new(|ip: std::net::IpAddr| ip.is_loopback()));
    let api = APIBuilder::new()
        .with_media_engine(me)
        .with_interceptor_registry(registry)
        .with_setting_engine(se)
        .build();
    let pc = Arc::new(api.new_peer_connection(Default::default()).await.unwrap());
    for kind in [RTPCodecType::Video, RTPCodecType::Audio] {
        pc.add_transceiver_from_kind(
            kind,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Recvonly,
                send_encodings: vec![],
            }),
        )
        .await
        .unwrap();
    }
    let seen = Arc::new(Mutex::new(Seen::default()));
    let s2 = seen.clone();
    pc.on_track(Box::new(move |track, _recv, _trans| {
        let seen = s2.clone();
        Box::pin(async move {
            if track.kind() != RTPCodecType::Video {
                return;
            }
            seen.lock().unwrap().mime = track.codec().capability.mime_type.clone();
            tokio::spawn(async move {
                let mut sb = SampleBuilder::new(128, Vp8Packet::default(), 90000);
                while let Ok((pkt, _)) = track.read_rtp().await {
                    sb.push(pkt);
                    while let Some(sample) = sb.pop() {
                        let kf = sample.data.first().is_some_and(|b| b & 0x01 == 0);
                        let size = vp8_keyframe_size(&sample.data);
                        seen.lock().unwrap().frames.push((kf, size));
                    }
                }
            });
        })
    }));
    (pc, seen)
}

async fn offer_gathered(pc: &RTCPeerConnection) -> String {
    let offer = pc.create_offer(None).await.unwrap();
    let mut gathered = pc.gathering_complete_promise().await;
    pc.set_local_description(offer).await.unwrap();
    let _ = gathered.recv().await;
    pc.local_description().await.unwrap().sdp
}

/// Wait until `pred` holds over the frames seen so far (or panic after `secs`).
async fn wait_for(seen: &Arc<Mutex<Seen>>, secs: u64, what: &str, pred: impl Fn(&Seen) -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if pred(&seen.lock().unwrap()) {
            return;
        }
        if tokio::time::Instant::now() > deadline {
            let s = seen.lock().unwrap();
            let kfs: Vec<_> = s.frames.iter().filter_map(|f| f.1).collect();
            panic!("{what}: {} frames, keyframe sizes {kfs:?}", s.frames.len());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recorder_peer_receives_vp8_from_the_shared_and_the_second_encoder() {
    std::env::set_var("IA_ICE_LOOPBACK", "1");
    // The recorder offers first (A.2 N1), vanilla ICE over loopback host candidates.
    let (rec_pc, seen) = fake_recorder().await;
    let offer = offer_gathered(&rec_pc).await;
    // The Desk's (muted) Opus track rides along (§9 R5): the audio section is answered too.
    let audio = ia_agent::voice::new_audio_track();
    let (agent_rec, answer) =
        RecorderPeer::answer(&offer, Default::default(), 1, Some(audio), None)
            .await
            .expect("agent answers the recorder offer");
    assert_eq!(
        answer.matches("a=sendonly").count(),
        2,
        "the agent's video and audio answers are sendonly: {answer}"
    );
    assert!(answer.contains("opus/48000/2"));
    assert!(
        !answer.contains("m=application"),
        "no data channel on the recorder PC (A.2 S4)"
    );
    assert!(answer.contains("VP8/90000"));
    rec_pc
        .set_remote_description(RTCSessionDescription::answer(answer).unwrap())
        .await
        .unwrap();

    // The pump: an unbound Assist track (only the recorder leg is under test) and the recorder
    // track attached, with its PLI reader.
    let ctl = Arc::new(VideoCtl::new(Rung::Medium, 1000));
    let keyframe = ctl.attach_recorder(agent_rec.video.clone());
    let _kf_reader = agent_rec.spawn_keyframe_reader(keyframe);
    let assist_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_VP8.to_string(),
            clock_rate: 90000,
            ..Default::default()
        },
        "monitor-1".into(),
        "ia-screen".into(),
    ));
    let stop = Arc::new(tokio::sync::Notify::new());
    let pump = tokio::spawn(run_pump(
        assist_track,
        PumpSpec {
            monitor_id: 1,
            native_w: 1920,
            native_h: 1080,
        },
        CaptureSource::Synthetic(SyntheticCapturer::single(1920, 1080)),
        ctl.clone(),
        stop.clone(),
        Arc::new(AtomicU8::new(0)),
    ));

    // 1) Assist at medium: one shared encode at 1600 x 900, written to both tracks.
    wait_for(&seen, 20, "shared-encoder keyframe 1600x900", |s| {
        s.frames.iter().any(|f| f.1 == Some((1600, 900))) && s.frames.len() >= 5
    })
    .await;
    assert_eq!(seen.lock().unwrap().mime.to_ascii_lowercase(), "video/vp8");
    assert_eq!(ctl.encoded_size(), (1600, 900));
    let shared_rec = ctl.meter.rec_frames.load(Ordering::Relaxed);
    let shared_sent = ctl.meter.sent_frames.load(Ordering::Relaxed);
    assert!(shared_rec > 0 && shared_rec <= shared_sent);

    // 2) Assist climbs to high (1920 x 1080 @ 24 fps): the recorder stays at the medium ladder
    // through a second libvpx instance (its first frame is a keyframe at 1600 x 900).
    let before = seen.lock().unwrap().frames.len();
    ctl.set_decision(Rung::High, 2000);
    wait_for(&seen, 20, "second-encoder frames", |s| {
        s.frames.len() >= before + 10
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        ctl.encoded_size(),
        (1920, 1080),
        "the Assist stream follows the high rung"
    );
    let kf_sizes: Vec<_> = seen.lock().unwrap().frames[before..]
        .iter()
        .filter_map(|f| f.1)
        .collect();
    assert!(
        kf_sizes.iter().all(|s| *s == (1600, 900)),
        "the recorder never sees the Assist's 1080p stream: {kf_sizes:?}"
    );
    let a0 = ctl.meter.sent_frames.load(Ordering::Relaxed);
    let r0 = ctl.meter.rec_frames.load(Ordering::Relaxed);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (da, dr) = (
        ctl.meter.sent_frames.load(Ordering::Relaxed) - a0,
        ctl.meter.rec_frames.load(Ordering::Relaxed) - r0,
    );
    assert!(dr > 0, "the second encoder keeps feeding the recorder");
    // Paced at its own 15 fps, never above the Assist's 24 (an unoptimised test build may
    // not reach either rate, so only the ordering is asserted).
    assert!(
        dr <= da,
        "the recorder is never paced above the Assist: rec {dr} vs assist {da}"
    );

    // 3) The ABR drops to floor: both legs share one encode again at 1024 x 576 / 250 kbps,
    // and the switch puts a keyframe in the recorder stream.
    ctl.set_decision(Rung::Floor, 200);
    wait_for(&seen, 20, "floor keyframe 1024x576", |s| {
        s.frames.iter().any(|f| f.1 == Some((1024, 576)))
    })
    .await;
    assert_eq!(ctl.encoded_size(), (1024, 576));

    stop.notify_waiters();
    let _ = tokio::time::timeout(Duration::from_secs(5), pump).await;
    agent_rec.close().await;
    let _ = rec_pc.close().await;
}
