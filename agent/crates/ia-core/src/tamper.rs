//! The tamper outbox (`docs/specs/phase-d-contracts.md` §10.2, rule 10.5).
//!
//! Events are recorded locally — by the service and by the watchdog, which may be the only one
//! still running — signed with the device identity key (domain `ia-tamper-v1`), and kept until
//! the server acknowledges them. The B §3.7 outbox rule applies: **only an acknowledged event
//! is removed**; nothing else drops one. An agent that is stopped, disabled or deleted
//! therefore still reports why the next time it runs, which is the whole claim of §10.4 —
//! an attacker can disable the agent, but not silently.
//!
//! The on-disk form is JSON lines (`%ProgramData%\IndiansAssist\tamper.log`), so a process
//! that is about to be killed can append one line and a reader can skip a torn or forged one.
//! Signature verification on load drops forged lines: a local non-admin who can write the file
//! still cannot make the fleet view show an event that never happened.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::devsig::{input, sign_device_input, verify_device_signature};
use crate::fleet::{TamperCause, TamperEvent};
use crate::{CoreError, CoreResult};

/// The most events one `device.tamper` frame carries (`deviceTamperSchema` max).
pub const TAMPER_FRAME_MAX: usize = 100;
/// The most events the log keeps. A machine stuck in a restart loop must not grow the file
/// without bound; the oldest are dropped first and the drop is itself recorded.
pub const TAMPER_LOG_MAX: usize = 1000;

/// Builds the signed event of rule 10.5. `at` is an ISO 8601 UTC instant with milliseconds.
pub fn sign_event(
    device_id: &str,
    identity_seed: &[u8; 32],
    id: &str,
    cause: TamperCause,
    at: &str,
    detail: Option<&str>,
) -> CoreResult<TamperEvent> {
    let detail = detail.map(|d| d.chars().take(500).collect::<String>());
    let mut unsigned = json!({ "id": id, "cause": cause.as_str(), "at": at });
    if let Some(d) = &detail {
        unsigned["detail"] = Value::String(d.clone());
    }
    let sig = sign_device_input(&input::tamper(device_id, &unsigned)?, identity_seed);
    Ok(TamperEvent {
        id: id.to_string(),
        cause,
        at: at.to_string(),
        detail,
        sig,
    })
}

/// Verifies an event's signature against the device's public key (what the service does on
/// load, and the server does on receipt).
pub fn verify_event(device_id: &str, public_key: &str, e: &TamperEvent) -> bool {
    let mut unsigned = json!({ "id": e.id, "cause": e.cause.as_str(), "at": e.at });
    if let Some(d) = &e.detail {
        unsigned["detail"] = Value::String(d.clone());
    }
    match input::tamper(device_id, &unsigned) {
        Ok(i) => verify_device_signature(&i, &e.sig, public_key),
        Err(_) => false,
    }
}

/// The pending events, oldest first.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TamperOutbox {
    events: Vec<TamperEvent>,
}

/// What [`TamperOutbox::from_log`] skipped, so the service can log one honest line about it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LoadReport {
    pub kept: usize,
    /// Lines that were not JSON or not an event shape (a torn append).
    pub malformed: usize,
    /// Events whose signature did not verify (a forged line).
    pub forged: usize,
    /// Events dropped because the log was over [`TAMPER_LOG_MAX`].
    pub dropped: usize,
}

impl TamperOutbox {
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// Appends an already-signed event. The oldest are dropped past [`TAMPER_LOG_MAX`].
    pub fn push(&mut self, e: TamperEvent) {
        self.events.push(e);
        if self.events.len() > TAMPER_LOG_MAX {
            let excess = self.events.len() - TAMPER_LOG_MAX;
            self.events.drain(0..excess);
        }
    }

    /// Signs and appends one event.
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &mut self,
        device_id: &str,
        identity_seed: &[u8; 32],
        id: &str,
        cause: TamperCause,
        at: &str,
        detail: Option<&str>,
    ) -> CoreResult<TamperEvent> {
        let e = sign_event(device_id, identity_seed, id, cause, at, detail)?;
        self.push(e.clone());
        Ok(e)
    }

    /// The next batch to send (oldest first, at most one frame's worth). The events stay in
    /// the outbox: they leave only on an acknowledgement.
    pub fn batch(&self) -> Vec<TamperEvent> {
        self.events.iter().take(TAMPER_FRAME_MAX).cloned().collect()
    }

    /// `device.tamper.ok { ids }`: removes exactly the acknowledged ids and reports how many
    /// were removed. An id the server acknowledges that the outbox does not hold is ignored.
    pub fn acknowledge(&mut self, ids: &[String]) -> usize {
        let before = self.events.len();
        self.events.retain(|e| !ids.iter().any(|i| i == &e.id));
        before - self.events.len()
    }

    /// The JSON-lines form. The service rewrites the file after an acknowledgement; between
    /// them it appends single lines.
    pub fn to_log(&self) -> String {
        let mut out = String::new();
        for e in &self.events {
            out.push_str(&serde_json::to_string(e).expect("an event serialises"));
            out.push('\n');
        }
        out
    }

    /// One event's line, for an append.
    pub fn log_line(e: &TamperEvent) -> CoreResult<String> {
        serde_json::to_string(e)
            .map(|s| format!("{s}\n"))
            .map_err(|e| CoreError::BadInput(e.to_string()))
    }

    /// Reads the log, keeping only well-formed events with a valid signature.
    pub fn from_log(text: &str, device_id: &str, public_key: &str) -> (Self, LoadReport) {
        let mut out = Self::default();
        let mut r = LoadReport::default();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<TamperEvent>(line) {
                Err(_) => r.malformed += 1,
                Ok(e) => {
                    if verify_event(device_id, public_key, &e) {
                        out.events.push(e);
                    } else {
                        r.forged += 1;
                    }
                }
            }
        }
        if out.events.len() > TAMPER_LOG_MAX {
            r.dropped = out.events.len() - TAMPER_LOG_MAX;
            out.events.drain(0..r.dropped);
        }
        r.kept = out.events.len();
        (out, r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devsig::device_public_key_of;

    const SEED: [u8; 32] = [0x11; 32];
    const DEV: &str = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";

    fn ev(n: u8, cause: TamperCause) -> TamperEvent {
        sign_event(
            DEV,
            &SEED,
            &format!("2b3c4d5e-6f70-4182-93a4-b5c6d7e8f9{n:02}"),
            cause,
            "2026-11-01T10:00:00.000Z",
            None,
        )
        .unwrap()
    }

    #[test]
    fn an_event_verifies_with_the_device_key_and_fails_with_another() {
        let e = ev(1, TamperCause::Stopped);
        assert!(verify_event(DEV, &device_public_key_of(&SEED), &e));
        assert!(!verify_event(DEV, &device_public_key_of(&[0x22; 32]), &e));
        assert!(!verify_event(
            "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
            &device_public_key_of(&SEED),
            &e
        ));
        // The cause is covered by the signature, so a flipped cause does not verify.
        let lied = TamperEvent {
            cause: TamperCause::WatchdogRestarted,
            ..e
        };
        assert!(!verify_event(DEV, &device_public_key_of(&SEED), &lied));
    }

    #[test]
    fn the_detail_is_covered_by_the_signature_and_capped() {
        let long = "x".repeat(900);
        let e = sign_event(
            DEV,
            &SEED,
            "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901",
            TamperCause::ConfigChanged,
            "2026-11-01T10:00:00.000Z",
            Some(&long),
        )
        .unwrap();
        assert_eq!(e.detail.as_deref().map(str::len), Some(500));
        assert!(verify_event(DEV, &device_public_key_of(&SEED), &e));
        let changed = TamperEvent {
            detail: Some("something else".into()),
            ..e
        };
        assert!(!verify_event(DEV, &device_public_key_of(&SEED), &changed));
    }

    #[test]
    fn only_acknowledged_events_leave_the_outbox() {
        let mut o = TamperOutbox::default();
        o.push(ev(1, TamperCause::Stopped));
        o.push(ev(2, TamperCause::Disabled));
        o.push(ev(3, TamperCause::BinaryChanged));
        let batch = o.batch();
        assert_eq!(batch.len(), 3);
        assert_eq!(
            o.len(),
            3,
            "a sent batch is still pending until it is acknowledged"
        );
        assert_eq!(
            o.acknowledge(&[batch[0].id.clone(), batch[2].id.clone()]),
            2
        );
        assert_eq!(o.len(), 1);
        assert_eq!(o.batch()[0].cause, TamperCause::Disabled);
        assert_eq!(o.acknowledge(&["not-in-the-outbox".to_string()]), 0);
        assert_eq!(o.len(), 1);
    }

    #[test]
    fn the_batch_is_oldest_first_and_one_frame_at_most() {
        let mut o = TamperOutbox::default();
        for n in 0..150 {
            o.push(ev(n, TamperCause::WatchdogRestarted));
        }
        let batch = o.batch();
        assert_eq!(batch.len(), TAMPER_FRAME_MAX);
        assert!(batch[0].id.ends_with("00"));
        assert!(batch[99].id.ends_with("99"));
    }

    #[test]
    fn the_log_round_trips_and_a_forged_or_torn_line_is_dropped() {
        let mut o = TamperOutbox::default();
        o.push(ev(1, TamperCause::Stopped));
        o.push(ev(2, TamperCause::Deleted));
        let pk = device_public_key_of(&SEED);
        let mut text = o.to_log();
        text.push_str("{\"id\":\"2b3c4d5e-6f70-4182-93a4-b5c6d7e8f903\",\"cause\":\"stopped\",\"at\":\"2026-11-01T10:00:00.000Z\",\"sig\":\"");
        text.push_str(&"A".repeat(86));
        text.push_str("\"}\n");
        text.push_str("{\"id\": truncated mid-wri\n");
        let (loaded, report) = TamperOutbox::from_log(&text, DEV, &pk);
        assert_eq!(report.kept, 2);
        assert_eq!(report.forged, 1);
        assert_eq!(report.malformed, 1);
        assert_eq!(loaded.batch().len(), 2);
        assert_eq!(loaded.to_log(), o.to_log());
    }

    #[test]
    fn the_log_is_bounded_so_a_restart_loop_cannot_fill_the_disk() {
        let mut o = TamperOutbox::default();
        for _ in 0..(TAMPER_LOG_MAX + 50) {
            o.push(ev(7, TamperCause::WatchdogRestarted));
        }
        assert_eq!(o.len(), TAMPER_LOG_MAX);
    }
}
