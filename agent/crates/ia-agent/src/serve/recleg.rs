//! The server-recorder leg of the serve loop (contract §9 R2 / R6, A.2 N1-N5).
//!
//! The recorder offers (`webrtc.offer { peer: 'recorder' }`); the agent answers with a second
//! PC whose VP8 track the pump feeds (see [`crate::pump`]), trickles its candidates as
//! `webrtc.ice { peer: 'recorder' }` and applies the recorder's. A fresh recorder offer while a
//! leg exists replaces it: that is the recorder's own N4 restart, or its `recorder.assign
//! { resume: true }` after a `recorder.pause` (a Desk resume or a hand-over, §3.7). The leg is
//! independent of the Assist PC, so a §3.7 Assist rebuild leaves it running; it is closed when
//! its PC fails, when the server says the server recording stopped, and at teardown.

#[allow(unused_imports)]
use super::*;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;

type LegCandidate = (u32, Option<RTCIceCandidateInit>);

pub(super) struct RecorderLegs {
    monitor_id: u32,
    /// `recordingMode` is `server` / `both` (contract §9 R2); otherwise offers are ignored.
    allowed: bool,
    /// The current leg number; events of an older leg are dropped.
    leg: u32,
    /// The Desk's Opus track, also sent to the recorder (§9 R5; silent while muted).
    audio: Option<Arc<TrackLocalStaticSample>>,
    current: Option<(RecorderPeer, tokio::task::JoinHandle<()>)>,
    ice_tx: mpsc::UnboundedSender<LegCandidate>,
    pub(super) ice_rx: mpsc::UnboundedReceiver<LegCandidate>,
    state_tx: mpsc::UnboundedSender<(u32, RTCPeerConnectionState)>,
    pub(super) state_rx: mpsc::UnboundedReceiver<(u32, RTCPeerConnectionState)>,
}

impl RecorderLegs {
    pub(super) fn new(
        monitor_id: u32,
        allowed: bool,
        audio: Option<Arc<TrackLocalStaticSample>>,
    ) -> Self {
        let (ice_tx, ice_rx) = mpsc::unbounded_channel();
        let (state_tx, state_rx) = mpsc::unbounded_channel();
        Self {
            monitor_id,
            allowed,
            leg: 0,
            audio,
            current: None,
            ice_tx,
            ice_rx,
            state_tx,
            state_rx,
        }
    }

    /// Route one `peer: 'recorder'` signaling frame.
    pub(super) async fn on_frame(
        &mut self,
        v: &Value,
        ws: &mut SignalWriter,
        session_id: &str,
        ice_servers: &[RTCIceServer],
        ctl: &Arc<VideoCtl>,
    ) {
        match v.get("t").and_then(|t| t.as_str()) {
            Some("webrtc.offer") => {
                let Some(sdp) = v.get("sdp").and_then(|s| s.as_str()) else {
                    return;
                };
                self.on_offer(sdp, ws, session_id, ice_servers, ctl).await;
            }
            Some("webrtc.ice") => {
                let Some((peer, _)) = &self.current else {
                    return;
                };
                if let Some(init) = candidate_init(v) {
                    peer.add_candidate(init).await;
                }
            }
            other => tracing::debug!(t = ?other, "recorder frame ignored"),
        }
    }

    async fn on_offer(
        &mut self,
        sdp: &str,
        ws: &mut SignalWriter,
        session_id: &str,
        ice_servers: &[RTCIceServer],
        ctl: &Arc<VideoCtl>,
    ) {
        if !self.allowed {
            tracing::warn!(
                "recorder offer ignored: the session's recording mode is not server/both"
            );
            return;
        }
        if self.current.is_some() {
            self.close(ctl, "replaced by a new recorder offer").await;
        }
        self.leg = self.leg.wrapping_add(1);
        let leg = self.leg;
        let tx = self.ice_tx.clone();
        let sink: crate::recorder::CandidateSink = Arc::new(move |c| {
            let _ = tx.send((leg, c));
        });
        let answered = RecorderPeer::answer(
            sdp,
            crate::peer::configuration(ice_servers.to_vec()),
            self.monitor_id,
            self.audio.clone(),
            Some(sink),
        )
        .await;
        let (peer, answer) = match answered {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!("recorder answer failed: {e}");
                return;
            }
        };
        let state_tx = self.state_tx.clone();
        peer.pc
            .on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
                let _ = state_tx.send((leg, s));
                Box::pin(async {})
            }));
        let sent = ws
            .send(json!({ "t": "webrtc.answer", "sessionId": session_id, "sdp": answer, "peer": "recorder" }))
            .await;
        if sent.is_err() {
            peer.close().await;
            return;
        }
        let keyframe = ctl.attach_recorder(peer.video.clone());
        let task = peer.spawn_keyframe_reader(keyframe);
        tracing::info!(
            leg,
            sdp_len = answer.len(),
            "recorder offer answered (peer: recorder)"
        );
        self.current = Some((peer, task));
    }

    /// Trickle one local candidate of the current leg to the recorder.
    pub(super) async fn send_candidate(
        &self,
        leg: u32,
        cand: Option<RTCIceCandidateInit>,
        ws: &mut SignalWriter,
        session_id: &str,
    ) {
        if leg != self.leg || self.current.is_none() {
            return;
        }
        let candidate = cand
            .and_then(|c| serde_json::to_value(c).ok())
            .unwrap_or(Value::Null);
        let _ = ws
            .send(json!({ "t": "webrtc.ice", "sessionId": session_id, "candidate": candidate, "peer": "recorder" }))
            .await;
    }

    pub(super) async fn on_state(
        &mut self,
        leg: u32,
        state: RTCPeerConnectionState,
        ctl: &Arc<VideoCtl>,
    ) {
        if leg != self.leg {
            return;
        }
        match state {
            RTCPeerConnectionState::Connected => tracing::info!(leg, "recorder peer connected"),
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                // The recorder re-offers on its own (A.2 N4) if it still records.
                self.close(ctl, "recorder peer connection ended").await;
            }
            _ => {}
        }
    }

    /// Close the current leg (if any) and stop feeding its track.
    pub(super) async fn close(&mut self, ctl: &Arc<VideoCtl>, why: &str) {
        if let Some((peer, task)) = self.current.take() {
            ctl.detach_recorder();
            task.abort();
            peer.close().await;
            tracing::info!(why, "recorder peer closed");
        }
    }
}

/// The `candidate` of a `webrtc.ice` frame as webrtc-rs wants it (`None` for end-of-candidates).
pub(super) fn candidate_init(v: &Value) -> Option<RTCIceCandidateInit> {
    let cand = v.get("candidate")?;
    if cand.is_null() {
        return None;
    }
    let s = cand.get("candidate").and_then(|c| c.as_str()).unwrap_or("");
    if s.is_empty() {
        return None;
    }
    Some(RTCIceCandidateInit {
        candidate: s.to_string(),
        sdp_mid: cand
            .get("sdpMid")
            .and_then(|c| c.as_str())
            .map(str::to_string),
        sdp_mline_index: cand
            .get("sdpMLineIndex")
            .and_then(|c| c.as_u64())
            .map(|n| n as u16),
        username_fragment: cand
            .get("usernameFragment")
            .and_then(|c| c.as_str())
            .map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_init_reads_the_wire_shape() {
        let v = json!({ "t": "webrtc.ice", "peer": "recorder", "candidate": {
            "candidate": "candidate:1 1 udp 2130706431 127.0.0.1 5000 typ host",
            "sdpMid": "0", "sdpMLineIndex": 0, "usernameFragment": "abcd" } });
        let c = candidate_init(&v).unwrap();
        assert_eq!(c.sdp_mid.as_deref(), Some("0"));
        assert_eq!(c.sdp_mline_index, Some(0));
        assert!(candidate_init(&json!({ "t": "webrtc.ice", "candidate": null })).is_none());
        assert!(
            candidate_init(&json!({ "t": "webrtc.ice", "candidate": { "candidate": "" } }))
                .is_none()
        );
    }

    #[test]
    fn local_candidates_serialise_to_the_shared_schema_keys() {
        let v = serde_json::to_value(RTCIceCandidateInit {
            candidate: "candidate:x".into(),
            sdp_mid: Some("0".into()),
            sdp_mline_index: Some(0),
            username_fragment: None,
        })
        .unwrap();
        assert!(v.get("sdpMid").is_some() && v.get("sdpMLineIndex").is_some());
    }
}
