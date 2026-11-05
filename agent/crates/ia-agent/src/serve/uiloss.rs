//! A Desk UI that fails ends the session cleanly; it never crashes the agent or the worker.
//!
//! **No indicator, no sharing.** C §1 (P4 "Visible, always": the consent window, the pill, the
//! tray and the recording dot, none of which can be switched off), C §3.5 and D rule 6.2b ("in
//! every case the pill, tray and recording dot are drawn") leave no consent decision under which
//! a session may go on without its visible notice: not `local_consent`, not `local_approval`,
//! and not `auto_grant` either, whose table rows name the pill (and the notice card for a present
//! user, and the rule 6.2a arrival card for one who arrives later, which a dead UI cannot show).
//! So whenever the UI reports `Failed` (it could not start, or it stopped; `ia_ui::uifail`), or
//! its thread is gone, the session ends:
//!
//! * live: `stop.sharing { reason: 'indicator_failed' }` on `ia.ctrl` first, so the console can
//!   say why, then the teardown, then `session.end { note: 'indicator_lost' }`, which the server
//!   ends as `error` (C W21: a lost consent indicator is an error, not a user stop);
//! * before consent: `session.end { note: 'indicator_lost' }` alone (no channel is open yet).
//!
//! The only run without an indicator is a build without the `gui` feature (the headless
//! loopback), where the missing indicator is a build fact and not a runtime failure.

use serde_json::{json, Value};

/// The `session.end` note of a lost indicator (C W21, shared with the Android and iOS Desks).
pub const INDICATOR_LOST_NOTE: &str = "indicator_lost";
/// The `stop.sharing.reason` of a failed indicator (`STOP_SHARING_REASONS` in the shared enums).
pub const INDICATOR_FAILED_REASON: &str = "indicator_failed";

/// The `ia.ctrl` last word before the teardown of a session whose indicator failed.
pub fn indicator_failed_stop(ts: i64) -> Value {
    json!({ "t": "stop.sharing", "ts": ts, "reason": INDICATOR_FAILED_REASON })
}

/// The WS `session.end` of a session whose indicator failed (live or before consent).
pub fn indicator_lost_end(session_id: &str) -> Value {
    json!({ "t": "session.end", "sessionId": session_id, "note": INDICATOR_LOST_NOTE })
}

/// Whether a UI event (or the UI channel closing, `None`) means the indicator is gone.
pub fn indicator_gone(ev: Option<&ia_ui::bridge::UiEvent>) -> Option<String> {
    use ia_ui::bridge::UiEvent;
    match ev {
        None => Some("the indicator's thread is gone".into()),
        Some(UiEvent::Failed(why)) => Some(why.clone()),
        Some(UiEvent::Closed) => Some("the indicator closed".into()),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ia_ui::bridge::UiEvent;

    #[test]
    fn a_failed_indicator_says_why_on_the_channel_and_ends_as_the_w21_error() {
        let stop = indicator_failed_stop(1_762_000_000_000);
        assert_eq!(stop["t"], "stop.sharing");
        assert_eq!(stop["reason"], "indicator_failed");
        let end = indicator_lost_end("sess-1");
        assert_eq!(end["t"], "session.end");
        assert_eq!(end["sessionId"], "sess-1");
        // The note the server already ends as `error` (apps/api relay.ts `endReasonFor`).
        assert_eq!(end["note"], "indicator_lost");
    }

    #[test]
    fn a_ui_failure_a_closed_ui_and_a_vanished_thread_all_mean_the_indicator_is_gone() {
        assert_eq!(
            indicator_gone(Some(&UiEvent::Failed("libxkbcommon-x11.so.0".into()))).as_deref(),
            Some("libxkbcommon-x11.so.0")
        );
        assert!(indicator_gone(Some(&UiEvent::Closed)).is_some());
        assert!(indicator_gone(None).is_some());
        assert!(indicator_gone(Some(&UiEvent::Stop)).is_none());
        assert!(indicator_gone(Some(&UiEvent::ChatSend("hi".into()))).is_none());
    }
}
