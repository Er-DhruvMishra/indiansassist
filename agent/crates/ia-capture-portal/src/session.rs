//! The portal ScreenCast session as data (Phase F §9.2, §9.3): the steps the capturer walks
//! (`CreateSession`, `SelectSources`, `Start`, `OpenPipeWireRemote`, the PipeWire connection,
//! streaming), what each outcome leads to, the `SelectSources` options, and the mapping of every
//! failure to the [`PortalStatus`] the serve loop reports (`portal_denied`, `portal_closed`,
//! `wayland_unsupported`). The OS half (`os.rs`) only executes what this module decides.

use ia_core::capture_decision::PortalStatus;

/// One step of the session, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Check the portal exists and offers monitor sources (no dialog).
    Probe,
    CreateSession,
    SelectSources,
    /// The compositor's source dialog is shown during this step.
    Start,
    OpenRemote,
    /// The PipeWire stream is connecting to the portal's node.
    Connect,
    Streaming,
    /// Nothing more happens in this session.
    Done(PortalStatus),
}

/// What happened at the current step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The step succeeded.
    Ok,
    /// A failure, classified.
    Failed(Failure),
    /// The agent stops capturing (session end): not a user decision, so it reads as closed.
    Stopped,
}

/// Every way a portal session can fail or end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// No `org.freedesktop.portal.Desktop` on the session bus (or no session bus at all).
    NoPortal,
    /// The portal has no ScreenCast interface.
    NoScreenCast,
    /// ScreenCast offers no monitor source type.
    NoMonitorSource,
    /// The user cancelled the request (response 1).
    Cancelled,
    /// The request ended some other way (response 2), or the call itself failed.
    Refused(String),
    /// The PipeWire remote could not be opened or connected.
    PipeWire(String),
    /// The stream ended: the user stopped sharing, the session was closed, or the node is gone.
    StreamEnded,
}

/// The status a failure leaves the session in (§9.3, §9.4).
pub fn status_for(f: &Failure) -> PortalStatus {
    match f {
        Failure::NoPortal | Failure::NoScreenCast | Failure::NoMonitorSource => {
            PortalStatus::Unavailable
        }
        Failure::Cancelled | Failure::Refused(_) => PortalStatus::Denied,
        Failure::PipeWire(_) | Failure::StreamEnded => PortalStatus::Closed,
    }
}

/// The next step after `outcome` at `step`.
pub fn next(step: Step, outcome: &Outcome) -> Step {
    if let Step::Done(s) = step {
        return Step::Done(s);
    }
    match outcome {
        Outcome::Failed(f) => {
            // Before the dialog was answered, a stream that "ended" means the request failed.
            let status = status_for(f);
            Step::Done(status)
        }
        Outcome::Stopped => Step::Done(PortalStatus::Closed),
        Outcome::Ok => match step {
            Step::Probe => Step::CreateSession,
            Step::CreateSession => Step::SelectSources,
            Step::SelectSources => Step::Start,
            Step::Start => Step::OpenRemote,
            Step::OpenRemote => Step::Connect,
            Step::Connect => Step::Streaming,
            // Streaming has no "next" on success; it stays until it ends.
            Step::Streaming => Step::Streaming,
            Step::Done(s) => Step::Done(s),
        },
    }
}

/// The status the serve loop sees while the session is at `step`.
pub fn status_at(step: Step) -> PortalStatus {
    match step {
        Step::Done(s) => s,
        Step::Streaming => PortalStatus::Streaming,
        _ => PortalStatus::Pending,
    }
}

/// `XdpCursorMode` bits.
pub const CURSOR_HIDDEN: u32 = 1;
pub const CURSOR_EMBEDDED: u32 = 2;
pub const CURSOR_METADATA: u32 = 4;
/// `XdpOutputType` bit for a monitor.
pub const SOURCE_MONITOR: u32 = 1;

/// The cursor mode asked for in `SelectSources`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cursor {
    Embedded,
    Hidden,
}

/// The `SelectSources` options (§9.2): one monitor, never persisted, the cursor embedded when
/// the portal offers it, else hidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectPlan {
    pub cursor: Cursor,
    pub monitor_only: bool,
    pub multiple: bool,
    /// `persist_mode` 0: every session asks (§9.3).
    pub persist: u32,
}

/// The plan for a portal advertising `available_cursor_modes` (bits; 0 when the property is
/// missing, as on portal versions before 2).
pub fn select_plan(available_cursor_modes: u32) -> SelectPlan {
    SelectPlan {
        cursor: if available_cursor_modes & CURSOR_EMBEDDED != 0 {
            Cursor::Embedded
        } else {
            Cursor::Hidden
        },
        monitor_only: true,
        multiple: false,
        persist: 0,
    }
}

/// Whether a portal offering `available_source_types` (bits) can share a monitor.
pub fn offers_monitor(available_source_types: u32) -> bool {
    available_source_types & SOURCE_MONITOR != 0
}

/// The stream to consume out of those `Start` returned: the first (the portal reports one per
/// selected source, and only one is asked for). `None` when the portal returned no stream.
pub fn pick_stream(node_ids: &[u32]) -> Option<u32> {
    node_ids.first().copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn walk(outcomes: &[Outcome]) -> Vec<Step> {
        let mut step = Step::Probe;
        let mut seen = vec![step];
        for o in outcomes {
            step = next(step, o);
            seen.push(step);
        }
        seen
    }

    #[test]
    fn a_session_walks_to_streaming_and_ends_closed() {
        let ok = |n| vec![Outcome::Ok; n];
        let steps = walk(&ok(6));
        assert_eq!(
            steps,
            vec![
                Step::Probe,
                Step::CreateSession,
                Step::SelectSources,
                Step::Start,
                Step::OpenRemote,
                Step::Connect,
                Step::Streaming,
            ]
        );
        assert_eq!(status_at(Step::Start), PortalStatus::Pending);
        assert_eq!(status_at(Step::Streaming), PortalStatus::Streaming);
        let end = next(Step::Streaming, &Outcome::Failed(Failure::StreamEnded));
        assert_eq!(end, Step::Done(PortalStatus::Closed));
        assert_eq!(
            next(Step::Streaming, &Outcome::Stopped),
            Step::Done(PortalStatus::Closed)
        );
    }

    #[test]
    fn every_failure_maps_to_its_status() {
        let table = [
            (Failure::NoPortal, PortalStatus::Unavailable),
            (Failure::NoScreenCast, PortalStatus::Unavailable),
            (Failure::NoMonitorSource, PortalStatus::Unavailable),
            (Failure::Cancelled, PortalStatus::Denied),
            (Failure::Refused("other".into()), PortalStatus::Denied),
            (Failure::PipeWire("no remote".into()), PortalStatus::Closed),
            (Failure::StreamEnded, PortalStatus::Closed),
        ];
        for (f, want) in table {
            assert_eq!(status_for(&f), want, "{f:?}");
        }
        // The dialog cancelled at Start is `portal_denied`.
        assert_eq!(
            next(Step::Start, &Outcome::Failed(Failure::Cancelled)),
            Step::Done(PortalStatus::Denied)
        );
        // No portal at the probe is the E Wayland set (`wayland_unsupported`).
        assert_eq!(
            next(Step::Probe, &Outcome::Failed(Failure::NoPortal)),
            Step::Done(PortalStatus::Unavailable)
        );
    }

    #[test]
    fn done_is_final() {
        for s in PortalStatus::ALL {
            for o in [
                Outcome::Ok,
                Outcome::Stopped,
                Outcome::Failed(Failure::Cancelled),
            ] {
                assert_eq!(next(Step::Done(s), &o), Step::Done(s));
            }
        }
    }

    #[test]
    fn the_select_plan_and_the_stream_pick() {
        let p = select_plan(CURSOR_HIDDEN | CURSOR_EMBEDDED | CURSOR_METADATA);
        assert_eq!(p.cursor, Cursor::Embedded);
        assert!(p.monitor_only && !p.multiple);
        assert_eq!(p.persist, 0, "never persisted: every session asks");
        assert_eq!(select_plan(CURSOR_HIDDEN).cursor, Cursor::Hidden);
        assert_eq!(select_plan(0).cursor, Cursor::Hidden);
        assert!(offers_monitor(SOURCE_MONITOR | 2));
        assert!(!offers_monitor(2 | 4));
        assert_eq!(pick_stream(&[42, 43]), Some(42));
        assert_eq!(pick_stream(&[]), None);
    }
}
