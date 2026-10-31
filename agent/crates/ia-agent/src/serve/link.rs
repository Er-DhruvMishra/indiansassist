//! Offer/answer negotiation and the §3.7 gen+1 peer-connection rebuild.

#[allow(unused_imports)]
use super::*;

/// How the offer/answer exchange ended.
pub(super) enum NegotiateOutcome {
    /// Both DTLS fingerprints are known (own, remote).
    Fingerprints((String, String)),
    /// The session ended (socket closed or `session.ended`) during negotiation.
    Ended,
    /// No answer / no fingerprints before the deadline.
    NoAnswer,
}

/// Send `webrtc.offer { gen[, restart] }`, re-send every 2.5 s until an answer arrives (the
/// console rebuilds idempotently), apply it, and return the fingerprints (contract §1.3 step 1,
/// §3.7 rebuild offer). Trickled ICE is applied while waiting.
pub(super) async fn negotiate(
    peer: &AgentPeer,
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    session_id: &str,
    gen: u16,
    restart: bool,
    recorder_stash: &mut Vec<Value>,
) -> NegotiateOutcome {
    let offer = match peer.offer().await {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("offer failed: {e}");
            return NegotiateOutcome::NoAnswer;
        }
    };
    let mut offer_msg =
        json!({ "t": "webrtc.offer", "sessionId": session_id, "sdp": offer, "gen": gen });
    if restart {
        offer_msg["restart"] = json!(true);
    }
    tracing::info!(gen, restart, sdp_len = offer.len(), "sending webrtc.offer");
    if ws.send(offer_msg.clone()).await.is_err() {
        return NegotiateOutcome::Ended;
    }

    let hs_deadline = tokio::time::sleep(Duration::from_secs(25));
    tokio::pin!(hs_deadline);
    let mut resend = tokio::time::interval(Duration::from_millis(2500));
    resend.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    resend.tick().await; // consume the immediate first tick (we just sent the offer)
    let mut answered = false;
    loop {
        if answered {
            if let Some(f) = peer.fingerprints().await {
                return NegotiateOutcome::Fingerprints(f);
            }
        }
        tokio::select! {
            _ = &mut hs_deadline => return NegotiateOutcome::NoAnswer,
            _ = resend.tick(), if !answered => {
                tracing::info!("re-sending webrtc.offer (no answer yet)");
                let _ = ws.send(offer_msg.clone()).await;
            }
            _ = tokio::time::sleep(Duration::from_millis(50)), if answered => {}
            msg = ws_rx.recv() => {
                let Some(v) = msg else { return NegotiateOutcome::Ended; };
                // Recorder-leg frames are never applied to the Assist PC; the serve loop
                // replays them (contract §9 R2).
                if crate::recorder::is_recorder_frame(&v) {
                    recorder_stash.push(v);
                    continue;
                }
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("webrtc.answer") if !answered => {
                        tracing::info!("webrtc.answer received; applying");
                        if let Some(sdp) = v.get("sdp").and_then(|s| s.as_str()) {
                            match RTCSessionDescription::answer(sdp.to_string()) {
                                Ok(desc) => {
                                    if peer.pc.set_remote_description(desc).await.is_err() {
                                        return NegotiateOutcome::NoAnswer;
                                    }
                                    answered = true;
                                }
                                Err(_) => return NegotiateOutcome::NoAnswer,
                            }
                        }
                    }
                    Some("webrtc.answer") => {}
                    Some("webrtc.ice") => add_remote_ice(peer, &v).await,
                    Some("ping") => { let _ = ws.send(json!({ "t": "pong" })).await; }
                    Some("session.ended") => return NegotiateOutcome::Ended,
                    other => tracing::info!(t = ?other, "ws frame while awaiting answer"),
                }
            }
        }
    }
}

/// Build the fresh secure channels for a generation (Desk operator) from the derived keys.
pub(super) fn open_sec_set(
    chans: &Chans,
    session_id: &str,
    gen: u16,
    keys: &SessionKeys,
) -> Result<Secs, String> {
    let mut set = SecChannelSet::new();
    let mut sec: Secs = HashMap::new();
    for label in ENC_LABELS {
        if chans.contains_key(label) {
            sec.insert(
                label.to_string(),
                set.open(
                    Operator::Desk,
                    session_id,
                    label,
                    gen,
                    keys.k_d2a,
                    keys.k_a2d,
                )
                .map_err(|e| format!("secchan {label}: {e}"))?,
            );
        }
    }
    Ok(sec)
}

/// Forward the Assist's audio track (if it sends one) to the serve loop for playback (§6.3).
pub(super) fn wire_remote_audio(peer: &AgentPeer, tx: mpsc::UnboundedSender<Arc<TrackRemote>>) {
    peer.pc.on_track(Box::new(move |track, _recv, _trans| {
        if track.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Audio {
            let _ = tx.send(track);
        }
        Box::pin(async {})
    }));
}

/// Register the PeerConnection state-change handler, forwarding each state to the serve loop.
pub(super) fn wire_pc_state(peer: &AgentPeer, tx: mpsc::UnboundedSender<RTCPeerConnectionState>) {
    peer.pc
        .on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            let _ = tx.send(s);
            Box::pin(async {})
        }));
}

/// A rebuilt key generation (contract §3.7).
pub(super) struct Generation {
    pub(super) peer: AgentPeer,
    pub(super) chans: Chans,
    pub(super) sec: Secs,
    pub(super) sec_dc: Arc<RTCDataChannel>,
    pub(super) sas: String,
}

/// Why a §3.7 rebuild did not complete.
pub(super) enum RebuildErr {
    Ended,
    SecFail(SecFailReason),
}

/// Build a fresh PC for `gen`, wire its channels, re-offer `{ restart: true, gen }`, re-run the
/// §1.3 handshake and open the secure channels (contract §3.7). The caller restarts the pump.
#[allow(clippy::too_many_arguments)]
pub(super) async fn rebuild_generation(
    ws: &mut SignalWriter,
    ws_rx: &mut mpsc::UnboundedReceiver<Value>,
    session_id: &str,
    gen: u16,
    ice_servers: &[RTCIceServer],
    monitor_ids: &[u32],
    in_tx: &mpsc::UnboundedSender<Inbound>,
    fail_tx: &mpsc::UnboundedSender<(u16, SecFailReason)>,
    recorder_stash: &mut Vec<Value>,
    audio: Option<Arc<TrackLocalStaticSample>>,
    remote_audio: &mpsc::UnboundedSender<Arc<TrackRemote>>,
) -> Result<Generation, RebuildErr> {
    let peer = AgentPeer::new(
        PeerRole::Desk,
        monitor_ids,
        false,
        crate::peer::configuration(ice_servers.to_vec()),
    )
    .await
    .map_err(|_| RebuildErr::SecFail(SecFailReason::Timeout))?;
    if let Some(t) = audio {
        peer.add_audio_track(t)
            .await
            .map_err(|_| RebuildErr::SecFail(SecFailReason::Timeout))?;
    }
    wire_remote_audio(&peer, remote_audio.clone());
    let chans = wire_channels(&peer, gen, in_tx, fail_tx)
        .await
        .map_err(|_| RebuildErr::SecFail(SecFailReason::Timeout))?;
    let (own_fpr, remote_fpr) =
        match negotiate(&peer, ws, ws_rx, session_id, gen, true, recorder_stash).await {
            NegotiateOutcome::Fingerprints(f) => f,
            NegotiateOutcome::Ended => return Err(RebuildErr::Ended),
            NegotiateOutcome::NoAnswer => return Err(RebuildErr::SecFail(SecFailReason::Timeout)),
        };
    let sec_dc = await_channel(&peer, "ia.sec")
        .await
        .ok_or(RebuildErr::SecFail(SecFailReason::Timeout))?;
    let (keys, sas) = run_handshake(
        sec_dc.clone(),
        Side::Desk,
        session_id,
        gen,
        &own_fpr,
        &remote_fpr,
    )
    .await
    .map_err(RebuildErr::SecFail)?;
    let sec = open_sec_set(&chans, session_id, gen, &keys)
        .map_err(|_| RebuildErr::SecFail(SecFailReason::Key))?;
    Ok(Generation {
        peer,
        chans,
        sec,
        sec_dc,
        sas,
    })
}
