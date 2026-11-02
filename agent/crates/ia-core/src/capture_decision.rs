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
}

impl CaptureCause {
    /// Every cause, in the order of the shared `CAPTURE_CAUSES`.
    pub const ALL: [Self; 8] = [
        Self::Start,
        Self::DdaLost,
        Self::SecureDesktop,
        Self::Recovered,
        Self::WaylandUnsupported,
        Self::X11Lost,
        Self::PortalDenied,
        Self::PortalClosed,
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
        }
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
