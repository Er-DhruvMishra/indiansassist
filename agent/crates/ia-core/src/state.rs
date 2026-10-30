//! The agent session state machine (`AgentPhase`), following A §7.4 with the Phase C
//! additions of §3.2 (native resume keeps `active`; hand-over keeps `active`).
//!
//! Only the agent-visible phases are modelled; the server owns the authoritative row.

use crate::types::ElevationLevel;

/// The agent's local phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentPhase {
    /// Before a token is chosen / the connect window is open.
    Idle,
    /// WS connected, `desk.hello` sent, awaiting `desk.hello.ok`.
    Connecting,
    /// Knocking and polling; `held` is the A §7.5 held-knock sub-state.
    Waiting { held: bool },
    /// Consent window open (`session.created { state: 'consent_pending' }`).
    ConsentPending,
    /// Sharing (`active`).
    Active,
    /// Terminal.
    Ended(EndReason),
}

/// Why a session ended, as the agent understands it locally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    DeskStopped,
    AssistEnded,
    DeskLeft,
    Error,
    HandedOver,
}

/// Events the agent applies to its phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Connect,
    HelloOk,
    KnockHeld,
    ConsentRequested,
    ConsentGranted,
    ConsentDeclined,
    /// A `desk.hello` + `resumeKey` resume from `active` (keeps `active`, contract §3.2).
    NativeResume,
    /// A hand-over hello replaced this process (keeps `active` on the new process).
    HandoverTookOver,
    /// This (user) process was replaced: close 4411.
    HandedOverAway,
    Crash,
    Stop,
    AssistEnded,
}

/// Session consent/integrity context tracked alongside the phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionContext {
    pub elevation: ElevationLevel,
}

impl Default for SessionContext {
    fn default() -> Self {
        Self {
            elevation: ElevationLevel::User,
        }
    }
}

impl AgentPhase {
    /// A forwarded `--code`/`--url` (single-instance pipe, contract §2.1 rank 1) is
    /// honoured only in the connect / idle state; otherwise it is discarded.
    pub fn accepts_forwarded_code(&self) -> bool {
        matches!(self, AgentPhase::Idle | AgentPhase::Connecting)
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, AgentPhase::Ended(_))
    }

    /// Apply `event`, returning the new phase (or the same phase if the event does not
    /// apply, which the caller treats as a no-op).
    pub fn apply(&self, event: Event) -> AgentPhase {
        use AgentPhase::*;
        use Event::*;
        match (self, event) {
            (Idle, Connect) => Connecting,
            (Connecting, HelloOk) => Waiting { held: false },
            (Waiting { .. }, KnockHeld) => Waiting { held: true },
            (Waiting { .. }, ConsentRequested) => ConsentPending,
            (ConsentPending, ConsentGranted) => Active,
            (ConsentPending, ConsentDeclined) => Ended(EndReason::DeskStopped),
            // Resume and hand-over keep active (consent is a decision, §3.2).
            (Active, NativeResume) => Active,
            (Active, HandoverTookOver) => Active,
            (Active, HandedOverAway) => Ended(EndReason::HandedOver),
            (_, Crash) => Ended(EndReason::DeskLeft),
            (_, Stop) => Ended(EndReason::DeskStopped),
            (_, AssistEnded) => Ended(EndReason::AssistEnded),
            // Anything else is a no-op.
            (other, _) => other.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path() {
        let mut p = AgentPhase::Idle;
        p = p.apply(Event::Connect);
        assert_eq!(p, AgentPhase::Connecting);
        p = p.apply(Event::HelloOk);
        assert_eq!(p, AgentPhase::Waiting { held: false });
        p = p.apply(Event::ConsentRequested);
        assert_eq!(p, AgentPhase::ConsentPending);
        p = p.apply(Event::ConsentGranted);
        assert_eq!(p, AgentPhase::Active);
    }

    #[test]
    fn forwarded_code_only_when_idle_or_connecting() {
        assert!(AgentPhase::Idle.accepts_forwarded_code());
        assert!(AgentPhase::Connecting.accepts_forwarded_code());
        assert!(!AgentPhase::Waiting { held: false }.accepts_forwarded_code());
        assert!(!AgentPhase::ConsentPending.accepts_forwarded_code());
        assert!(!AgentPhase::Active.accepts_forwarded_code());
    }

    #[test]
    fn resume_and_handover_keep_active() {
        let active = AgentPhase::Active;
        assert_eq!(active.apply(Event::NativeResume), AgentPhase::Active);
        assert_eq!(active.apply(Event::HandoverTookOver), AgentPhase::Active);
        assert_eq!(
            active.apply(Event::HandedOverAway),
            AgentPhase::Ended(EndReason::HandedOver)
        );
    }

    #[test]
    fn crash_during_active_is_desk_left() {
        assert_eq!(
            AgentPhase::Active.apply(Event::Crash),
            AgentPhase::Ended(EndReason::DeskLeft)
        );
    }

    #[test]
    fn decline_ends() {
        assert_eq!(
            AgentPhase::ConsentPending.apply(Event::ConsentDeclined),
            AgentPhase::Ended(EndReason::DeskStopped)
        );
    }
}
