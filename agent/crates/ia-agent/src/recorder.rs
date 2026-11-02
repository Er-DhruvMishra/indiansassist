//! The server-recorder peer (contract §9 R2 / A.2 N1-N5), compiled under `media`.
//!
//! The Phase A.2 recorder is a receive-only pion peer that offers (`webrtc.offer { peer:
//! 'recorder' }`, one recvonly video and one recvonly audio m-line, no data channel). The agent
//! answers with a **second** `RTCPeerConnection`: webrtc-rs binds a `TrackLocalStaticSample` to
//! one codec capability, so the agent adds its **own** VP8 track `monitor-<id>-rec` (and the
//! Opus track when voice is live) before applying the offer, so webrtc-rs pairs them with the
//! recorder's recvonly sections and the answer is `sendonly`. The pump feeds the track (shared
//! encoder or a second VP8 instance, see [`crate::pump`]); the recorder's PLI / FIR requests a
//! keyframe in that stream. ICE is trickled to the recorder as `webrtc.ice { peer: 'recorder' }`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_VP8};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::codecs;

/// The recorder track id for a monitor (contract §9 R2 `monitor-<id>-rec`).
pub fn recorder_track_id(monitor_id: u32) -> String {
    format!("monitor-{monitor_id}-rec")
}

/// Whether the session's recording policy asks for the server recorder (contract §9 R2:
/// `recordingMode` `server` / `both`).
pub fn server_records(recording_mode: &str) -> bool {
    matches!(recording_mode, "server" | "both")
}

/// Whether a signaling frame belongs to the recorder leg (`peer: 'recorder'`, A.2 N2).
pub fn is_recorder_frame(v: &serde_json::Value) -> bool {
    v.get("peer").and_then(|p| p.as_str()) == Some("recorder")
}

/// Receives each gathered local candidate (`None` = end of candidates) for trickle ICE.
pub type CandidateSink = Arc<dyn Fn(Option<RTCIceCandidateInit>) + Send + Sync>;

/// The answering side of one recorder connection.
pub struct RecorderPeer {
    pub pc: Arc<RTCPeerConnection>,
    pub video: Arc<TrackLocalStaticSample>,
    pub video_sender: Arc<RTCRtpSender>,
    pub audio_sender: Option<Arc<RTCRtpSender>>,
}

fn build_api() -> Result<webrtc::api::API, webrtc::Error> {
    let mut me = MediaEngine::default();
    // VP8 first (the recorder decodes VP8/VP9 only, A.2 N1; §4.2 order with a recorder).
    codecs::register_into_media_engine(&mut me, &codecs::offer_order(true, false, false))?;
    let registry = register_default_interceptors(Registry::new(), &mut me)?;
    let mut se = webrtc::api::setting_engine::SettingEngine::default();
    crate::peer::apply_dev_ice(&mut se);
    Ok(APIBuilder::new()
        .with_media_engine(me)
        .with_interceptor_registry(registry)
        .with_setting_engine(se)
        .build())
}

impl RecorderPeer {
    /// Build the recorder PC, add the VP8 track (and `audio`, when voice is live), apply the
    /// recorder's offer and create the answer. With `candidates`, every gathered local candidate
    /// is forwarded (trickle; `None` = end of candidates) and the answer is returned at once;
    /// without it the answer is returned after gathering completes (vanilla ICE, the loopback).
    pub async fn answer(
        offer_sdp: &str,
        config: RTCConfiguration,
        monitor_id: u32,
        audio: Option<Arc<TrackLocalStaticSample>>,
        candidates: Option<CandidateSink>,
    ) -> Result<(Self, String), webrtc::Error> {
        let api = build_api()?;
        let pc = Arc::new(api.new_peer_connection(config).await?);
        let video = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_VP8.to_string(),
                clock_rate: 90000,
                ..Default::default()
            },
            recorder_track_id(monitor_id),
            "ia-recorder".to_string(),
        ));
        // Tracks first: applying the offer then pairs them with the recvonly sections.
        let video_sender = pc
            .add_track(Arc::clone(&video) as Arc<dyn TrackLocal + Send + Sync>)
            .await?;
        let audio_sender = match audio {
            Some(a) => Some(pc.add_track(a as Arc<dyn TrackLocal + Send + Sync>).await?),
            None => None,
        };
        if let Some(sink) = candidates.clone() {
            pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
                sink(c.and_then(|c| c.to_json().ok()));
                Box::pin(async {})
            }));
        }
        pc.set_remote_description(RTCSessionDescription::offer(offer_sdp.to_string())?)
            .await?;
        let answer = pc.create_answer(None).await?;
        let sdp = if candidates.is_some() {
            pc.set_local_description(answer).await?;
            pc.local_description()
                .await
                .map(|d| d.sdp)
                .unwrap_or_default()
        } else {
            let mut gathered = pc.gathering_complete_promise().await;
            pc.set_local_description(answer).await?;
            let _ = gathered.recv().await;
            pc.local_description()
                .await
                .map(|d| d.sdp)
                .unwrap_or_default()
        };
        Ok((
            Self {
                pc,
                video,
                video_sender,
                audio_sender,
            },
            sdp,
        ))
    }

    /// Apply one trickled candidate from the recorder.
    pub async fn add_candidate(&self, init: RTCIceCandidateInit) {
        let _ = self.pc.add_ice_candidate(init).await;
    }

    /// Read the video sender's RTCP until it ends, raising `keyframe` on every PLI / FIR (§9 R2
    /// "a keyframe ... on every PLI"); the RTCP must be drained anyway so the interceptors run.
    pub fn spawn_keyframe_reader(&self, keyframe: Arc<AtomicBool>) -> tokio::task::JoinHandle<()> {
        let sender = Arc::clone(&self.video_sender);
        tokio::spawn(async move {
            while let Ok((packets, _)) = sender.read_rtcp().await {
                if packets.iter().any(|p| is_keyframe_request(p.as_ref())) {
                    keyframe.store(true, Ordering::Relaxed);
                }
            }
        })
    }

    pub async fn close(&self) {
        let _ = self.pc.close().await;
    }
}

/// A PLI or FIR (the receiver lost the picture and needs a keyframe).
pub fn is_keyframe_request(p: &(dyn webrtc::rtcp::packet::Packet + Send + Sync)) -> bool {
    let any = p.as_any();
    any.downcast_ref::<webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication>()
        .is_some()
        || any
            .downcast_ref::<webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest>()
            .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recorder_frames_and_policy() {
        assert!(is_recorder_frame(
            &json!({ "t": "webrtc.offer", "peer": "recorder" })
        ));
        assert!(!is_recorder_frame(&json!({ "t": "webrtc.offer" })));
        assert!(!is_recorder_frame(
            &json!({ "t": "webrtc.ice", "peer": "assist" })
        ));
        assert!(server_records("server") && server_records("both"));
        assert!(!server_records("assist_only") && !server_records("off") && !server_records(""));
        assert_eq!(recorder_track_id(2), "monitor-2-rec");
    }

    #[test]
    fn pli_and_fir_request_keyframes() {
        use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
        use webrtc::rtcp::receiver_report::ReceiverReport;
        let pli = PictureLossIndication {
            sender_ssrc: 1,
            media_ssrc: 2,
        };
        assert!(is_keyframe_request(&pli));
        assert!(!is_keyframe_request(&ReceiverReport::default()));
    }
}
