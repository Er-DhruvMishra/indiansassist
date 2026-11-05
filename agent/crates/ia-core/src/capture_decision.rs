//! The DXGI Desktop Duplication health / fallback decision (contract §4.1). Pure: the real
//! `AcquireNextFrame` / `DXGI_ERROR_ACCESS_LOST` handling lives in `ia-capture-win`, but the
//! "3 failures in 5 s => GDI fallback for that monitor" rule and the re-arm-on-recovery
//! behaviour are decided here so they are unit-tested on any target.

use crate::types::CapturePath;

/// Window in which repeated DDA failures trip the GDI fallback (contract §4.1).
const FAILURE_WINDOW_MS: u64 = 5_000;
/// Failures within the window that trip the fallback.
const FAILURE_THRESHOLD: usize = 3;

/// The reason a capture path changed (`ctl.event capture.cause`, contract §4.1/§5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureCause {
    Start,
    DdaLost,
    SecureDesktop,
    Recovered,
    /// Phase E §7.4: a Wayland session shares no screen (name only; the linux stream sends it).
    WaylandUnsupported,
    /// Phase E §16.2: the X11 connection was lost (name only; the linux stream sends it).
    X11Lost,
    /// Phase F §9.3: the user cancelled the portal's source dialog (name only; the wayland stream sends it).
    PortalDenied,
    /// Phase F §9.3: the portal stream ended or the user stopped sharing (name only; wayland stream).
    PortalClosed,
    // apple-owned: begin
    /// Phase F §17.2: the ScreenCaptureKit stream stopped (Screen Recording revoked, display gone).
    /// A shared wire name, so it exists on every target, like the portal names.
    SckStopped,
    // apple-owned: end
}

impl CaptureCause {
    /// Every cause, in the order of the shared `CAPTURE_CAUSES`.
    pub const ALL: [Self; 9] = [
        Self::Start,
        Self::DdaLost,
        Self::SecureDesktop,
        Self::Recovered,
        Self::WaylandUnsupported,
        Self::X11Lost,
        Self::PortalDenied,
        Self::PortalClosed,
        // apple-owned: begin
        Self::SckStopped,
        // apple-owned: end
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CaptureCause::Start => "start",
            CaptureCause::DdaLost => "dda_lost",
            CaptureCause::SecureDesktop => "secure_desktop",
            CaptureCause::Recovered => "recovered",
            CaptureCause::WaylandUnsupported => "wayland_unsupported",
            CaptureCause::X11Lost => "x11_lost",
            CaptureCause::PortalDenied => "portal_denied",
            CaptureCause::PortalClosed => "portal_closed",
            // apple-owned: begin
            CaptureCause::SckStopped => "sck_stopped",
            // apple-owned: end
        }
    }
}

/// Phase F §9.3: where a portal capture stands, as the serve loop sees it. `Pending` until the
/// portal's source dialog is answered; the last three are final for the session (re-asking is
/// not automatic).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PortalStatus {
    /// The session is being set up, or the source dialog is open.
    Pending = 0,
    /// Frames are flowing from PipeWire.
    Streaming = 1,
    /// The user cancelled the source dialog (or the portal refused the request).
    Denied = 2,
    /// The user stopped sharing from the compositor, or the stream ended.
    Closed = 3,
    /// No portal on the session bus, no ScreenCast interface, or no monitor source.
    Unavailable = 4,
}

impl PortalStatus {
    pub const ALL: [Self; 5] = [
        Self::Pending,
        Self::Streaming,
        Self::Denied,
        Self::Closed,
        Self::Unavailable,
    ];

    pub fn from_u8(v: u8) -> Self {
        Self::ALL
            .into_iter()
            .find(|s| *s as u8 == v)
            .unwrap_or(Self::Pending)
    }

    /// Whether nothing more happens in this session (no frames, no re-ask).
    pub fn is_final(self) -> bool {
        matches!(self, Self::Denied | Self::Closed | Self::Unavailable)
    }
}

/// Phase F §9.3: the `ctl.event capture { path, cause }` a portal status change means, given the
/// status last reported. Each state is reported once; nothing follows a final state.
///
/// | now | event |
/// |---|---|
/// | `Streaming` | `portal` / `start` |
/// | `Denied` | `none` / `portal_denied` |
/// | `Closed` | `none` / `portal_closed` |
/// | `Unavailable` | `none` / `wayland_unsupported` |
pub fn portal_capture_change(
    reported: Option<PortalStatus>,
    now: PortalStatus,
) -> Option<(CapturePath, CaptureCause)> {
    if reported == Some(now) || reported.is_some_and(PortalStatus::is_final) {
        return None;
    }
    match now {
        PortalStatus::Pending => None,
        PortalStatus::Streaming => Some((CapturePath::Portal, CaptureCause::Start)),
        PortalStatus::Denied => Some((CapturePath::None, CaptureCause::PortalDenied)),
        PortalStatus::Closed => Some((CapturePath::None, CaptureCause::PortalClosed)),
        PortalStatus::Unavailable => Some((CapturePath::None, CaptureCause::WaylandUnsupported)),
    }
}

/// Per-monitor DDA health. Feed it failure timestamps (monotonic ms) from the capture
/// thread; it decides when to drop to GDI and keeps the current path.
#[derive(Debug, Clone)]
pub struct DxgiHealth {
    path: CapturePath,
    failures: Vec<u64>,
}

impl Default for DxgiHealth {
    fn default() -> Self {
        Self {
            path: CapturePath::Dda,
            failures: Vec::new(),
        }
    }
}

impl DxgiHealth {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn path(&self) -> CapturePath {
        self.path
    }

    pub fn is_fallback(&self) -> bool {
        self.path == CapturePath::Gdi
    }

    /// Record a DDA acquire/re-create failure at `now_ms`. Returns `Some(DdaLost)` when this
    /// failure trips the fallback (3 within 5 s) and the path was DDA.
    pub fn record_failure(&mut self, now_ms: u64) -> Option<CaptureCause> {
        self.failures.push(now_ms);
        let cutoff = now_ms.saturating_sub(FAILURE_WINDOW_MS);
        self.failures.retain(|t| *t >= cutoff);
        if self.path == CapturePath::Dda && self.failures.len() >= FAILURE_THRESHOLD {
            self.path = CapturePath::Gdi;
            self.failures.clear();
            Some(CaptureCause::DdaLost)
        } else {
            None
        }
    }

    /// A clean DDA frame arrived: clears the recent-failure history. Does **not** by itself
    /// return to DDA from GDI (a GDI monitor stays on GDI for the session unless re-created).
    pub fn record_success(&mut self) {
        self.failures.clear();
    }

    /// Explicitly recover to DDA after re-creating the duplication (e.g. a resolved display
    /// mode change). Returns `Recovered` when the path actually changed.
    pub fn recover_to_dda(&mut self) -> Option<CaptureCause> {
        if self.path == CapturePath::Gdi {
            self.path = CapturePath::Dda;
            self.failures.clear();
            Some(CaptureCause::Recovered)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_failures_in_five_seconds_trip_gdi() {
        let mut h = DxgiHealth::new();
        assert_eq!(h.path(), CapturePath::Dda);
        assert!(h.record_failure(1000).is_none());
        assert!(h.record_failure(2000).is_none());
        assert_eq!(h.record_failure(3000), Some(CaptureCause::DdaLost));
        assert!(h.is_fallback());
        // A further failure on GDI does not re-trip.
        assert!(h.record_failure(3500).is_none());
    }

    #[test]
    fn failures_spread_beyond_the_window_do_not_trip() {
        let mut h = DxgiHealth::new();
        assert!(h.record_failure(0).is_none());
        assert!(h.record_failure(3000).is_none());
        // 6000 - 5000 = 1000 cutoff drops the first (0); only 3000 and 6000 remain (2 < 3).
        assert!(h.record_failure(6000).is_none());
        assert!(!h.is_fallback());
    }

    #[test]
    fn success_clears_history() {
        let mut h = DxgiHealth::new();
        h.record_failure(1000);
        h.record_failure(2000);
        h.record_success();
        // Only one failure left after the success reset => no trip.
        assert!(h.record_failure(2500).is_none());
        assert!(!h.is_fallback());
    }

    #[test]
    fn portal_status_changes_are_reported_once_and_final_states_end_it() {
        use PortalStatus::*;
        assert_eq!(portal_capture_change(None, Pending), None);
        assert_eq!(
            portal_capture_change(None, Streaming),
            Some((CapturePath::Portal, CaptureCause::Start))
        );
        assert_eq!(
            portal_capture_change(Some(Pending), Streaming),
            Some((CapturePath::Portal, CaptureCause::Start))
        );
        assert_eq!(portal_capture_change(Some(Streaming), Streaming), None);
        assert_eq!(
            portal_capture_change(Some(Streaming), Closed),
            Some((CapturePath::None, CaptureCause::PortalClosed))
        );
        assert_eq!(
            portal_capture_change(None, Denied),
            Some((CapturePath::None, CaptureCause::PortalDenied))
        );
        assert_eq!(
            portal_capture_change(None, Unavailable),
            Some((CapturePath::None, CaptureCause::WaylandUnsupported))
        );
        // A stream that ends before its first frame is still `portal_closed`.
        assert_eq!(
            portal_capture_change(Some(Pending), Closed),
            Some((CapturePath::None, CaptureCause::PortalClosed))
        );
        for last in [Denied, Closed, Unavailable] {
            assert!(last.is_final());
            for now in PortalStatus::ALL {
                assert_eq!(
                    portal_capture_change(Some(last), now),
                    None,
                    "{last:?} {now:?}"
                );
            }
        }
        for s in PortalStatus::ALL {
            assert_eq!(PortalStatus::from_u8(s as u8), s);
        }
        assert_eq!(PortalStatus::from_u8(99), Pending);
        assert_eq!(CaptureCause::PortalDenied.as_str(), "portal_denied");
        assert_eq!(CaptureCause::PortalClosed.as_str(), "portal_closed");
    }

    #[test]
    fn recover_returns_to_dda_only_from_gdi() {
        let mut h = DxgiHealth::new();
        h.record_failure(0);
        h.record_failure(1);
        h.record_failure(2);
        assert!(h.is_fallback());
        assert_eq!(h.recover_to_dda(), Some(CaptureCause::Recovered));
        assert_eq!(h.path(), CapturePath::Dda);
        assert!(h.recover_to_dda().is_none()); // already DDA
    }
}
