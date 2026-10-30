//! `agent.stats` assembly (contract §4.4) and the two audit aggregators the agent reports
//! over a 10 s window (contract §3.8): `control.input` (with the `monitorId` inference rule
//! and the `input.text_burst` threshold) and `clipboard.sync`. All pure and unit-tested; the
//! binary feeds these from the encode threads and the control dispatcher and flushes the
//! aggregates before `session.end`.

use serde::Serialize;
use serde_json::{json, Value};

use crate::abr::Rung;
use crate::types::{CapturePath, VideoEncoder};

/// One monitor line in `agent.stats` (contract §4.4).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatMonitor {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// The `agent.stats` message (contract §4.4), sent on `ia.ctrl` every 2 s. `rung` is `null`
/// and `capturePath` is `projection` only on the Android host.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentStats {
    pub encoder: VideoEncoder,
    pub hw_encoder: bool,
    pub capture_path: CapturePath,
    pub rung: Option<Rung>,
    pub floor_mode: bool,
    pub target_kbps: u32,
    pub sent_kbps: u32,
    pub recorder_kbps: Option<u32>,
    pub capture_fps: f32,
    pub sent_fps: f32,
    pub encode_ms: Option<f32>,
    pub monitors: Vec<StatMonitor>,
    pub cpu_percent: Option<f32>,
    pub ts: i64,
}

impl AgentStats {
    /// Serialise to the exact `agent.stats` wire shape (camelCase, `t: "agent.stats"`).
    pub fn to_wire(&self) -> Value {
        json!({
            "t": "agent.stats",
            "encoder": self.encoder,
            "hwEncoder": self.hw_encoder,
            "capturePath": self.capture_path,
            "rung": self.rung.map(|r| r.as_str()),
            "floorMode": self.floor_mode,
            "targetKbps": self.target_kbps,
            "sentKbps": self.sent_kbps,
            "recorderKbps": self.recorder_kbps,
            "captureFps": self.capture_fps,
            "sentFps": self.sent_fps,
            "encodeMs": self.encode_ms,
            "monitors": self.monitors,
            "cpuPercent": self.cpu_percent,
            "ts": self.ts,
        })
    }
}

/// The kind of input an op contributes to the `control.input` aggregate (contract §3.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    Pointer,
    Scroll,
    Key,
    Text,
}

impl InputKind {
    fn as_str(self) -> &'static str {
        match self {
            InputKind::Pointer => "pointer",
            InputKind::Scroll => "scroll",
            InputKind::Key => "key",
            InputKind::Text => "text",
        }
    }
}

/// A 10 s `control.input` aggregator for the agent reporter (`mode: 'os'`, contract §3.8).
/// Implements the `monitorId` inference rule: an op without a monitor takes the id of the
/// most recent pointer/scroll in the window, else the currently viewed monitor, else 1.
#[derive(Debug, Clone)]
pub struct ControlInputAggregate {
    window_ms: u64,
    viewed_monitor: u32,
    last_pointer_monitor: Option<u32>,
    monitor_id: Option<u32>,
    count: u32,
    kinds: Vec<InputKind>,
    text_chars: u32,
    refused: u32,
}

impl ControlInputAggregate {
    pub fn new(window_ms: u64, viewed_monitor: u32) -> Self {
        Self {
            window_ms,
            viewed_monitor,
            last_pointer_monitor: None,
            monitor_id: None,
            count: 0,
            kinds: Vec::new(),
            text_chars: 0,
            refused: 0,
        }
    }

    fn note_kind(&mut self, kind: InputKind) {
        if !self.kinds.contains(&kind) {
            self.kinds.push(kind);
        }
    }

    fn note_monitor(&mut self, monitor: Option<u32>) {
        if let Some(m) = monitor {
            self.last_pointer_monitor = Some(m);
        }
        if self.monitor_id.is_none() {
            self.monitor_id = monitor;
        }
    }

    /// Record one op. `monitor` is `Some` for `os.pointer`/`os.scroll`, `None` otherwise.
    /// `text_chars` is the UTF-16 units of an `os.text` op (0 for others). `refused` marks a
    /// `not_allowed` / self-defence drop.
    pub fn record(
        &mut self,
        kind: InputKind,
        monitor: Option<u32>,
        text_chars: u32,
        refused: bool,
    ) {
        self.count += 1;
        self.note_kind(kind);
        self.note_monitor(monitor);
        self.text_chars += text_chars;
        if refused {
            self.refused += 1;
        }
    }

    /// The resolved `monitorId` for the window (the inference rule).
    pub fn resolved_monitor(&self) -> u32 {
        self.monitor_id
            .or(self.last_pointer_monitor)
            .unwrap_or(self.viewed_monitor)
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Whether the window crossed the `input.text_burst` threshold (contract §3.8: more than
    /// 200 characters of `os.text` within the window).
    pub fn text_burst(&self) -> bool {
        self.text_chars as usize > crate::types::limits::TEXT_BURST_CHARS
    }

    /// The `control.input` chain `data` (desk reporter: includes `refused`).
    pub fn to_chain(&self) -> Value {
        let mut kinds: Vec<&str> = self.kinds.iter().map(|k| k.as_str()).collect();
        kinds.sort_unstable();
        json!({
            "mode": "os",
            "monitorId": self.resolved_monitor(),
            "count": self.count,
            "kinds": kinds,
            "windowMs": self.window_ms,
            "textChars": self.text_chars,
            "refused": self.refused,
        })
    }

    /// The `input.text_burst` chain `data`, when [`text_burst`](Self::text_burst) is true.
    pub fn text_burst_chain(&self) -> Option<Value> {
        if self.text_burst() {
            Some(json!({
                "chars": self.text_chars,
                "windowMs": self.window_ms,
                "monitorId": self.resolved_monitor(),
            }))
        } else {
            None
        }
    }
}

/// The `clipboard.sync` 10 s aggregator (contract §3.8 / §5.6 C5). Content never enters it.
#[derive(Debug, Clone, Default)]
pub struct ClipboardSyncAggregate {
    pub to_assist: u32,
    pub to_desk: u32,
    pub bytes: u64,
    window_ms: u64,
}

impl ClipboardSyncAggregate {
    pub fn new(window_ms: u64) -> Self {
        Self {
            window_ms,
            ..Default::default()
        }
    }
    pub fn record_to_assist(&mut self, bytes: u64) {
        self.to_assist += 1;
        self.bytes += bytes;
    }
    pub fn record_to_desk(&mut self, bytes: u64) {
        self.to_desk += 1;
        self.bytes += bytes;
    }
    pub fn is_empty(&self) -> bool {
        self.to_assist == 0 && self.to_desk == 0
    }
    pub fn to_chain(&self) -> Value {
        json!({
            "toAssist": self.to_assist,
            "toDesk": self.to_desk,
            "bytes": self.bytes,
            "windowMs": self.window_ms,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_stats_wire_shape() {
        let s = AgentStats {
            encoder: VideoEncoder::Vp8,
            hw_encoder: false,
            capture_path: CapturePath::Dda,
            rung: Some(Rung::Medium),
            floor_mode: false,
            target_kbps: 1200,
            sent_kbps: 1150,
            recorder_kbps: Some(800),
            capture_fps: 15.0,
            sent_fps: 14.5,
            encode_ms: Some(4.2),
            monitors: vec![StatMonitor {
                id: 1,
                width: 1600,
                height: 900,
                fps: 15,
            }],
            cpu_percent: None,
            ts: 42,
        };
        let w = s.to_wire();
        assert_eq!(w["t"], json!("agent.stats"));
        assert_eq!(w["encoder"], json!("vp8"));
        assert_eq!(w["capturePath"], json!("dda"));
        assert_eq!(w["rung"], json!("medium"));
        assert_eq!(w["hwEncoder"], json!(false));
        assert_eq!(w["monitors"][0]["id"], json!(1));
        assert_eq!(w["cpuPercent"], Value::Null);
    }

    #[test]
    fn android_rung_null_and_projection() {
        let s = AgentStats {
            encoder: VideoEncoder::Vp8,
            hw_encoder: true,
            capture_path: CapturePath::Projection,
            rung: None,
            floor_mode: false,
            target_kbps: 0,
            sent_kbps: 0,
            recorder_kbps: None,
            capture_fps: 30.0,
            sent_fps: 30.0,
            encode_ms: None,
            monitors: vec![],
            cpu_percent: None,
            ts: 1,
        };
        let w = s.to_wire();
        assert_eq!(w["rung"], Value::Null);
        assert_eq!(w["capturePath"], json!("projection"));
    }

    #[test]
    fn control_input_infers_monitor_from_recent_pointer() {
        let mut agg = ControlInputAggregate::new(10_000, 1);
        agg.record(InputKind::Pointer, Some(2), 0, false);
        agg.record(InputKind::Key, None, 0, false); // no monitor: takes 2
        agg.record(InputKind::Text, None, 12, false);
        let c = agg.to_chain();
        assert_eq!(c["monitorId"], json!(2));
        assert_eq!(c["count"], json!(3));
        assert_eq!(c["textChars"], json!(12));
        assert_eq!(c["refused"], json!(0));
        // kinds are unique and sorted.
        assert_eq!(c["kinds"], json!(["key", "pointer", "text"]));
    }

    #[test]
    fn control_input_falls_back_to_viewed_monitor() {
        let mut agg = ControlInputAggregate::new(10_000, 3);
        agg.record(InputKind::Key, None, 0, true);
        assert_eq!(agg.resolved_monitor(), 3);
        assert_eq!(agg.to_chain()["refused"], json!(1));
    }

    #[test]
    fn text_burst_threshold() {
        let mut agg = ControlInputAggregate::new(10_000, 1);
        agg.record(InputKind::Text, None, 150, false);
        assert!(!agg.text_burst());
        agg.record(InputKind::Text, None, 60, false); // 210 > 200
        assert!(agg.text_burst());
        let burst = agg.text_burst_chain().unwrap();
        assert_eq!(burst["chars"], json!(210));
    }

    #[test]
    fn clipboard_sync_counts_both_ways() {
        let mut agg = ClipboardSyncAggregate::new(10_000);
        assert!(agg.is_empty());
        agg.record_to_assist(40);
        agg.record_to_desk(10);
        let c = agg.to_chain();
        assert_eq!(c["toAssist"], json!(1));
        assert_eq!(c["toDesk"], json!(1));
        assert_eq!(c["bytes"], json!(50));
    }
}
