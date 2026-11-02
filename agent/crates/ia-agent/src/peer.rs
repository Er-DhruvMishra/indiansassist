//! The webrtc-rs peer (contract §1.2, §3.6, §4), compiled under `media`.
//!
//! Builds the `MediaEngine` from [`crate::codecs`] (exact fmtp lines), a `SettingEngine`
//! that advertises `a=max-message-size:131072` (§1.3 interop) and the default interceptor
//! registry (nack / reports / twcc). The Desk adds one `TrackLocalStaticSample` per
//! consented monitor (§3.6 M1) and creates the seven ordered+reliable data channels once
//! per peer connection (§1.3); the Assist side receives them through `on_data_channel`.
//! SDP negotiation (offer/answer/ICE) is driven by [`crate::signal`] in a real session and
//! by the in-process loopback test with vanilla ICE.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_VP8};
use webrtc::api::setting_engine::{SctpMaxMessageSize, SettingEngine};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::codecs::{self, VP8};
use ia_core::sec::fingerprint_from_sdp;
use ia_core::types::{limits, P3_DATA_CHANNEL_LABELS};

/// Which side of the connection this peer plays (the Desk is impolite and offers first, A).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerRole {
    Desk,
    Assist,
}

/// A built peer connection with its data channels (by label) and, for the Desk, the per
/// monitor video tracks.
pub struct AgentPeer {
    pub role: PeerRole,
    pub pc: Arc<RTCPeerConnection>,
    pub channels: Arc<Mutex<HashMap<String, Arc<RTCDataChannel>>>>,
    pub video_tracks: Vec<Arc<TrackLocalStaticSample>>,
}

/// Dev builds only (Phase F §17.6): `IA_ICE_LOOPBACK` restricts ICE to loopback candidates, so
/// in-process and same-host tests never wait on a host firewall prompt (the macOS Application
/// Firewall holds inbound UDP to an unsigned, freshly built binary). A release build never
/// restricts ICE. Used by the session peer and the recorder peer alike.
pub(crate) fn apply_dev_ice(se: &mut SettingEngine) {
    #[cfg(feature = "dev")]
    if std::env::var_os("IA_ICE_LOOPBACK").is_some() {
        se.set_include_loopback_candidate(true);
        se.set_ip_filter(Box::new(|ip: std::net::IpAddr| ip.is_loopback()));
    }
    #[cfg(not(feature = "dev"))]
    let _ = se;
}

fn build_api(has_recorder: bool) -> Result<webrtc::api::API, webrtc::Error> {
    let mut me = MediaEngine::default();
    let order = codecs::offer_order(has_recorder, false, false);
    codecs::register_into_media_engine(&mut me, &order)?;
    let registry = register_default_interceptors(Registry::new(), &mut me)?;
    let mut se = SettingEngine::default();
    // Advertise a=max-message-size:131072 so a 64 KiB playbook body fits (§1.3).
    se.set_sctp_max_message_size_can_send(SctpMaxMessageSize::Bounded(
        limits::SEC_FRAME_MAX_BYTES as u32,
    ));
    apply_dev_ice(&mut se);
    Ok(APIBuilder::new()
        .with_media_engine(me)
        .with_interceptor_registry(registry)
        .with_setting_engine(se)
        .build())
}

impl AgentPeer {
    /// Build the peer. The Desk adds a VP8 track per `monitor_ids` and creates the seven
    /// channels; the Assist collects channels the Desk opens. `config` carries the ICE servers
    /// parsed from `consent.ok` (contract §3.4 / F5); on localhost it is empty and only host
    /// candidates are used.
    pub async fn new(
        role: PeerRole,
        monitor_ids: &[u32],
        has_recorder: bool,
        config: RTCConfiguration,
    ) -> Result<Self, webrtc::Error> {
        let api = build_api(has_recorder)?;
        let pc = Arc::new(api.new_peer_connection(config).await?);
        let channels: Arc<Mutex<HashMap<String, Arc<RTCDataChannel>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let mut video_tracks = Vec::new();
        if role == PeerRole::Desk {
            for id in monitor_ids {
                let track = Arc::new(TrackLocalStaticSample::new(
                    RTCRtpCodecCapability {
                        mime_type: MIME_TYPE_VP8.to_string(),
                        clock_rate: 90000,
                        ..Default::default()
                    },
                    format!("monitor-{id}"),
                    "ia-screen".to_string(),
                ));
                pc.add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
                    .await?;
                video_tracks.push(track);
            }
            // Create the seven channels once per PC, ordered + reliable (§1.3).
            let init = RTCDataChannelInit {
                ordered: Some(true),
                ..Default::default()
            };
            let mut map = channels.lock().await;
            for label in P3_DATA_CHANNEL_LABELS {
                let dc = pc.create_data_channel(label, Some(init.clone())).await?;
                map.insert((*label).to_string(), dc);
            }
        } else {
            // The Assist registers channels the Desk announces in-band.
            let chans = Arc::clone(&channels);
            pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
                let chans = Arc::clone(&chans);
                Box::pin(async move {
                    chans.lock().await.insert(dc.label().to_string(), dc);
                })
            }));
        }

        Ok(Self {
            role,
            pc,
            channels,
            video_tracks,
        })
    }

    /// Add the Desk's Opus track (contract §6.3: one audio track at start, muted until the Desk
    /// unmutes, so unmuting needs no renegotiation). Call before [`AgentPeer::offer`].
    pub async fn add_audio_track(
        &self,
        track: Arc<TrackLocalStaticSample>,
    ) -> Result<(), webrtc::Error> {
        self.pc
            .add_track(track as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map(|_| ())
    }

    /// Create the offer, set it locally, and return the gathered (non-trickle) SDP.
    pub async fn offer(&self) -> Result<String, webrtc::Error> {
        let offer = self.pc.create_offer(None).await?;
        let mut gathered = self.pc.gathering_complete_promise().await;
        self.pc.set_local_description(offer).await?;
        let _ = gathered.recv().await;
        Ok(self.local_sdp().await.unwrap_or_default())
    }

    /// Accept a remote offer and return the gathered answer SDP.
    pub async fn accept_offer(&self, remote_sdp: String) -> Result<String, webrtc::Error> {
        self.pc
            .set_remote_description(RTCSessionDescription::offer(remote_sdp)?)
            .await?;
        let answer = self.pc.create_answer(None).await?;
        let mut gathered = self.pc.gathering_complete_promise().await;
        self.pc.set_local_description(answer).await?;
        let _ = gathered.recv().await;
        Ok(self.local_sdp().await.unwrap_or_default())
    }

    /// Apply the remote answer (the Desk side after the Assist answers).
    pub async fn accept_answer(&self, remote_sdp: String) -> Result<(), webrtc::Error> {
        self.pc
            .set_remote_description(RTCSessionDescription::answer(remote_sdp)?)
            .await
    }

    async fn local_sdp(&self) -> Option<String> {
        // `local_description` carries the gathered candidates (the "pending or current"
        // description); `current_local_description` is None until negotiation completes.
        self.pc.local_description().await.map(|d| d.sdp)
    }

    /// Our DTLS fingerprint and the peer's, normalised to 64 hex chars (§1.3 step 1).
    pub async fn fingerprints(&self) -> Option<(String, String)> {
        let local = self.pc.local_description().await?;
        let remote = self.pc.remote_description().await?;
        Some((
            fingerprint_from_sdp(&local.sdp)?,
            fingerprint_from_sdp(&remote.sdp)?,
        ))
    }

    /// Get a channel by label once it exists (the Assist populates them asynchronously).
    pub async fn channel(&self, label: &str) -> Option<Arc<RTCDataChannel>> {
        self.channels.lock().await.get(label).cloned()
    }

    /// The SDP mid of each monitor's video track, read from the local description (§3.6 M3).
    pub async fn monitor_mids(&self) -> HashMap<u32, String> {
        self.local_sdp()
            .await
            .map(|sdp| monitor_mids(&sdp))
            .unwrap_or_default()
    }

    /// The VP8 track for a monitor id (Desk only).
    pub fn video_track(&self, monitor_id: u32) -> Option<Arc<TrackLocalStaticSample>> {
        self.video_tracks
            .iter()
            .find(|t| t.id() == format!("monitor-{monitor_id}"))
            .cloned()
    }
}

/// `monitor id -> mid` from an SDP: within each `m=video` section, the `a=mid:` value and the
/// track id of its `a=msid:<stream> monitor-<id>` line (§3.6 M3). Pure, tested.
pub fn monitor_mids(sdp: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    for section in sdp.split("\nm=").skip(1) {
        if !section.starts_with("video") {
            continue;
        }
        let mut mid = None;
        let mut monitor = None;
        for line in section.lines() {
            let line = line.trim_end_matches('\r');
            if let Some(v) = line.strip_prefix("a=mid:") {
                mid = Some(v.trim().to_string());
            } else if let Some(v) = line.strip_prefix("a=msid:") {
                monitor = v
                    .split_whitespace()
                    .nth(1)
                    .and_then(|t| t.strip_prefix("monitor-"))
                    .and_then(|n| n.parse::<u32>().ok());
            }
        }
        if let (Some(mid), Some(id)) = (mid, monitor) {
            out.insert(id, mid);
        }
    }
    out
}

/// The track codec a Desk monitor stream uses (VP8 software default, §4.2).
pub fn default_video_codec() -> codecs::VideoCodec {
    VP8
}

/// Parse `consent.ok.iceServers` (`[{ urls, username, credential }]`, contract §3.4) into the
/// webrtc-rs [`RTCIceServer`] list. `urls` may be a string or an array of strings. Entries with
/// no usable `urls` are dropped; the result (possibly empty, e.g. on localhost) becomes the
/// peer's ICE configuration (F5).
pub fn ice_servers_from_json(ice: Option<&serde_json::Value>) -> Vec<RTCIceServer> {
    let Some(arr) = ice.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|s| {
            let urls = match s.get("urls") {
                Some(serde_json::Value::String(u)) => vec![u.clone()],
                Some(serde_json::Value::Array(a)) => a
                    .iter()
                    .filter_map(|u| u.as_str().map(str::to_string))
                    .collect(),
                _ => return None,
            };
            if urls.is_empty() {
                return None;
            }
            Some(RTCIceServer {
                urls,
                username: s
                    .get("username")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                credential: s
                    .get("credential")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect()
}

/// An [`RTCConfiguration`] carrying `ice_servers` (everything else default).
pub fn configuration(ice_servers: Vec<RTCIceServer>) -> RTCConfiguration {
    RTCConfiguration {
        ice_servers,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn monitor_mids_come_from_each_video_section() {
        let sdp = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=msid:ia-screen monitor-1\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=msid:ia-screen monitor-2\r\n\
m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:2\r\na=msid:ia-screen desk-audio\r\n\
m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:3\r\n";
        let mids = monitor_mids(sdp);
        assert_eq!(mids.len(), 2);
        assert_eq!(mids.get(&1).map(String::as_str), Some("0"));
        assert_eq!(mids.get(&2).map(String::as_str), Some("1"));
        assert!(monitor_mids("v=0\r\n").is_empty());
    }

    #[test]
    fn ice_servers_parse_urls_string_or_array() {
        let v = json!([
            { "urls": "stun:stun.l.google.com:19302" },
            { "urls": ["turns:turn.example.com:443?transport=tcp"], "username": "u", "credential": "c" },
            { "nonsense": true }
        ]);
        let servers = ice_servers_from_json(Some(&v));
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].urls, vec!["stun:stun.l.google.com:19302"]);
        assert_eq!(servers[1].username, "u");
        assert_eq!(servers[1].credential, "c");
    }

    #[test]
    fn ice_servers_empty_when_absent() {
        assert!(ice_servers_from_json(None).is_empty());
        assert!(ice_servers_from_json(Some(&json!([]))).is_empty());
    }
}
