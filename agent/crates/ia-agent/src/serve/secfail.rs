//! §1.3 step-9 secure-channel failure handling: the `sec.fail` / `sec.failed` / `session.end`
//! messages, the channel-lifetime watchers wired before the handshake, and the pre-serve
//! teardown (correctness F7/F8, security C1).

#[allow(unused_imports)]
use super::*;

/// The three §1.3 step-9 messages for a secure-channel failure: the `sec.fail` to put on
/// `ia.sec` (plaintext), the `desk.event sec.failed` for the WS, and the WS `session.end` with
/// `note: 'sec:<reason>'`. Pure so the teardown can be asserted without a live peer or socket.
pub(super) fn sec_fail_messages(
    session_id: &str,
    reason: ia_core::types::SecFailReason,
    channel: Option<&str>,
) -> (Value, Value, Value) {
    let reason_str = serde_json::to_value(reason)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "commit".into());
    let sec_fail = json!({ "t": "sec.fail", "reason": reason_str, "ts": now_ms() });
    let mut data = json!({ "reason": reason_str });
    if let Some(ch) = channel {
        data["channel"] = json!(ch);
    }
    let desk_event = json!({
        "t": "desk.event", "sessionId": session_id, "action": "sec.failed", "data": data,
    });
    let session_end =
        json!({ "t": "session.end", "sessionId": session_id, "note": format!("sec:{reason_str}") });
    (sec_fail, desk_event, session_end)
}

/// The six encrypted channel labels (every `P3_DATA_CHANNEL_LABELS` except `ia.sec`).
pub(super) const ENC_LABELS: [&str; 6] = [
    "ia.control",
    "ia.chat",
    "ia.file",
    "ia.playbook",
    "ia.ctrl",
    "ia.annot",
];

/// Await the six encrypted channels (created once per PC), attach the inbound forwarder and a
/// close watcher to each, and register the stray-channel guard on the Desk PC (contract §1.3
/// "Channel lifetime rule"): a `SEC_ENCRYPTED_LABELS` close while the PC is alive, or any data
/// channel the remote opens, is `sec.fail { reason: 'channel' }`. The handlers are attached
/// before the handshake sends `sec.commit`, so an early frame is buffered on `in_tx` rather
/// than dropped by webrtc-rs 0.17 (contract correctness F7). Fails are tagged with `gen` so a
/// §3.7 rebuild can ignore the close events of the generation it is replacing.
pub(super) async fn wire_channels(
    peer: &AgentPeer,
    gen: u16,
    in_tx: &mpsc::UnboundedSender<Inbound>,
    fail_tx: &mpsc::UnboundedSender<(u16, SecFailReason)>,
) -> Result<Chans, String> {
    let mut chans: Chans = HashMap::new();
    for label in ENC_LABELS {
        let dc = await_channel(peer, label)
            .await
            .ok_or_else(|| format!("{label} never opened"))?;
        forward(&dc, label, in_tx.clone());
        let fail_tx_c = fail_tx.clone();
        dc.on_close(Box::new(move || {
            let _ = fail_tx_c.send((gen, SecFailReason::Channel));
            Box::pin(async {})
        }));
        chans.insert(label.to_string(), dc);
    }
    // The Desk creates every channel; a channel the remote opens (`ondatachannel`) is a §1.3
    // violation: close it unread and fail the generation.
    let fail_tx_c = fail_tx.clone();
    peer.pc
        .on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
            let fail_tx_c = fail_tx_c.clone();
            Box::pin(async move {
                tracing::warn!(
                    label = dc.label(),
                    "remote opened a data channel on the Desk PC"
                );
                let _ = dc.close().await;
                let _ = fail_tx_c.send((gen, SecFailReason::Channel));
            })
        }));
    Ok(chans)
}

/// Run the §1.3 step-9 secure-channel teardown for a failure detected before (or outside) the
/// serve loop: send `sec.fail` on `ia.sec` (plaintext, best effort), the WS `desk.event
/// sec.failed`, close the peer, then the WS `session.end { note: 'sec:<reason>' }`. Returns the
/// [`LiveOutcome::SecFailed`] the caller propagates (contract correctness F8 / security C1).
pub(super) async fn teardown_sec_fail(
    ws: &mut SignalWriter,
    session_id: &str,
    reason: SecFailReason,
    channel: Option<&str>,
    sec_dc: Option<&Arc<RTCDataChannel>>,
    peer: &AgentPeer,
) -> LiveOutcome {
    let (fail, event, end) = sec_fail_messages(session_id, reason, channel);
    if let Some(dc) = sec_dc {
        let _ = dc.send_text(fail.to_string()).await;
        tokio::time::sleep(Duration::from_millis(100)).await; // let SCTP flush it
    }
    let _ = ws.send(event).await;
    let _ = peer.pc.close().await;
    let _ = ws.send(end.clone()).await;
    tracing::warn!(reason = ?reason, "secure channel failed; session.end note {}", end["note"]);
    LiveOutcome::SecFailed(
        end["note"]
            .as_str()
            .and_then(|n| n.strip_prefix("sec:"))
            .unwrap_or("commit")
            .to_string(),
    )
}

pub(super) fn sec_reason_str(reason: SecFailReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "commit".into())
}
