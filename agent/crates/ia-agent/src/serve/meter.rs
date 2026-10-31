//! Measured `agent.stats` (contract §4.4, correctness F13): the send-path throughput meter,
//! the REMB/loss RTCP reader feeding the ABR controller, and the stats assembly.

#[allow(unused_imports)]
use super::*;

/// Throughput the encode/send path measures so `agent.stats` reports real numbers rather than
/// the former placeholders (contract §4.4 / correctness F13 / conformance C-06).
#[derive(Default)]
pub(super) struct VideoMeter {
    pub(super) sent_bytes: AtomicU64,
    pub(super) sent_frames: AtomicU64,
    pub(super) encode_ns: AtomicU64,
    pub(super) encode_frames: AtomicU64,
}

/// Snapshot of the throughput meter for per-interval deltas.
#[derive(Clone, Copy)]
pub(super) struct MeterSnapshot {
    pub(super) bytes: u64,
    pub(super) frames: u64,
    pub(super) encode_ns: u64,
    pub(super) encode_frames: u64,
}

/// Measured throughput over one stats interval.
pub(super) struct MeterInterval {
    pub(super) sent_kbps: u32,
    pub(super) sent_fps: f32,
    pub(super) encode_ms: Option<f32>,
}

impl MeterSnapshot {
    pub(super) fn take(m: &VideoMeter) -> Self {
        Self {
            bytes: m.sent_bytes.load(Ordering::Relaxed),
            frames: m.sent_frames.load(Ordering::Relaxed),
            encode_ns: m.encode_ns.load(Ordering::Relaxed),
            encode_frames: m.encode_frames.load(Ordering::Relaxed),
        }
    }
    pub(super) fn diff(&self, prev: &MeterSnapshot, interval_ms: u64) -> MeterInterval {
        let secs = (interval_ms as f32 / 1000.0).max(0.001);
        let d_bytes = self.bytes.saturating_sub(prev.bytes);
        let d_frames = self.frames.saturating_sub(prev.frames);
        let d_enc_ns = self.encode_ns.saturating_sub(prev.encode_ns);
        let d_enc_frames = self.encode_frames.saturating_sub(prev.encode_frames);
        MeterInterval {
            sent_kbps: ((d_bytes as f32 * 8.0) / secs / 1000.0) as u32,
            sent_fps: d_frames as f32 / secs,
            encode_ms: (d_enc_frames > 0)
                .then(|| (d_enc_ns as f32 / d_enc_frames as f32) / 1_000_000.0),
        }
    }
}

/// Poll the first RTP sender's RTCP on a dedicated task, updating `remb_kbps` (REMB estimate)
/// and `loss_permille` (fraction lost x 1000) so the ABR controller has a live estimate
/// (contract §4.3). Best effort: if no sender/REMB appears the controller falls back to its
/// smoothed estimate and the values stay 0 (reported as measured-unknown, not invented).
pub(super) fn spawn_remb_reader(
    peer: &AgentPeer,
    remb_kbps: Arc<AtomicU64>,
    loss_permille: Arc<AtomicU64>,
    stop: Arc<tokio::sync::Notify>,
) -> tokio::task::JoinHandle<()> {
    let pc = peer.pc.clone();
    tokio::spawn(async move {
        // Wait for a sender to exist, then read its RTCP stream until teardown.
        let sender = loop {
            let senders = pc.get_senders().await;
            if let Some(s) = senders.into_iter().next() {
                break s;
            }
            tokio::select! {
                _ = stop.notified() => return,
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
        };
        loop {
            tokio::select! {
                _ = stop.notified() => return,
                r = sender.read_rtcp() => {
                    let Ok((packets, _)) = r else { return };
                    for p in packets {
                        let any = p.as_any();
                        if let Some(remb) = any.downcast_ref::<webrtc::rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate>() {
                            remb_kbps.store((remb.bitrate / 1000.0) as u64, Ordering::Relaxed);
                        } else if let Some(rr) = any.downcast_ref::<webrtc::rtcp::receiver_report::ReceiverReport>() {
                            if let Some(rep) = rr.reports.first() {
                                loss_permille.store((rep.fraction_lost as u64 * 1000) / 256, Ordering::Relaxed);
                            }
                        }
                    }
                }
            }
        }
    })
}

/// Assemble `agent.stats` from the measured throughput (`interval`) and the ABR decision
/// (contract §4.4 / correctness F13). Fields that are not measured here are omitted/zeroed
/// rather than invented: `recorderKbps` (no recorder PC this pass) and `cpuPercent` are `null`.
pub(super) fn build_stats(
    monitors: &[MonitorInfo],
    viewed: u32,
    capture_path: CapturePath,
    interval: &MeterInterval,
    decision: &ia_core::abr::AbrDecision,
) -> AgentStats {
    let viewed_fps = interval.sent_fps.round() as u32;
    let stat_monitors = monitors
        .iter()
        .map(|m| StatMonitor {
            id: m.id,
            width: m.width,
            height: m.height,
            fps: if m.id == viewed { viewed_fps } else { 0 },
        })
        .collect();
    AgentStats {
        encoder: VideoEncoder::Vp8,
        hw_encoder: false,
        capture_path,
        rung: Some(decision.rung),
        floor_mode: decision.floor_mode,
        target_kbps: decision.target_kbps,
        sent_kbps: interval.sent_kbps,
        recorder_kbps: None,
        capture_fps: interval.sent_fps,
        sent_fps: interval.sent_fps,
        encode_ms: interval.encode_ms,
        monitors: stat_monitors,
        cpu_percent: None,
        ts: now_ms(),
    }
}

/// The bandwidth estimate fed to the ABR controller: the REMB, raised to the throughput the
/// receiver demonstrably absorbed in the last interval when loss stayed under 2 % (delivered,
/// loss-free throughput is a measured lower bound on the available bandwidth). Without this a
/// stale REMB (Chrome keeps its ~300 kbps start value when transport-cc is negotiated and the
/// sender never probes) would report `floor` while ~1 Mbps flows without loss.
pub(super) fn abr_estimate_kbps(remb_kbps: u64, sent_kbps: u32, loss_permille: u64) -> Option<u32> {
    let delivered = if loss_permille < 20 {
        sent_kbps as u64
    } else {
        0
    };
    let est = remb_kbps.max(delivered);
    (est > 0).then_some(est.min(u32::MAX as u64) as u32)
}

#[cfg(test)]
mod tests {
    use super::abr_estimate_kbps;

    #[test]
    fn loss_free_throughput_lifts_a_stale_remb() {
        // REMB 201 kbps but 954 kbps delivered with no loss: the estimate is 954.
        assert_eq!(abr_estimate_kbps(201, 954, 0), Some(954));
        // With real loss the delivered rate is not a bound: the REMB stands.
        assert_eq!(abr_estimate_kbps(201, 954, 150), Some(201));
        // A higher REMB is kept.
        assert_eq!(abr_estimate_kbps(3000, 954, 0), Some(3000));
        // Nothing measured yet: no estimate (the controller keeps its smoothed value).
        assert_eq!(abr_estimate_kbps(0, 0, 0), None);
    }
}
