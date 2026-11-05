//! Phase F §9.6: the portal tests, against the headless stack of `agent/scripts/portal-test.sh`
//! (private session bus, headless sway on a solid known colour, PipeWire, WirePlumber,
//! xdg-desktop-portal with the wlr backend). `#[ignore]`-marked: run only by that script.
//!
//! Guard (binding): each test refuses to run unless `IA_TEST_PORTAL_BUS` equals the session bus
//! address in use, `WAYLAND_DISPLAY` starts with `ia-wl-`, and `XDG_RUNTIME_DIR` is the harness's
//! temporary runtime dir, so no test ever reaches the user's session, runtime dir or WSLg display.
#![cfg(all(target_os = "linux", feature = "portal"))]

use std::time::{Duration, Instant};

use ia_capture_portal::{PortalCapturer, PORTAL_MONITOR_ID};
use ia_core::capture_decision::PortalStatus;
use ia_core::types::CapturePath;
use ia_platform::traits::Capturer;

fn guard() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_test_writer()
        .try_init();
    let bus = std::env::var("IA_TEST_PORTAL_BUS").unwrap_or_default();
    let session = std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap_or_default();
    assert!(
        !bus.is_empty() && bus == session,
        "refusing: IA_TEST_PORTAL_BUS must name the harness's private bus (run scripts/portal-test.sh)"
    );
    let wl = std::env::var("WAYLAND_DISPLAY").unwrap_or_default();
    assert!(
        wl.starts_with("ia-wl-"),
        "refusing: WAYLAND_DISPLAY must be the harness compositor (ia-wl-*), not {wl:?}"
    );
    let rt = std::env::var("XDG_RUNTIME_DIR").unwrap_or_default();
    let harness_rt = std::env::var("IA_TEST_PORTAL_RUNTIME").unwrap_or_default();
    assert!(
        !rt.is_empty() && rt == harness_rt && !rt.starts_with("/run/user/"),
        "refusing: XDG_RUNTIME_DIR must be the harness's temporary runtime dir"
    );
    assert!(
        std::env::var_os("DISPLAY").is_none(),
        "refusing: DISPLAY is set (the WSLg desktop)"
    );
}

fn wait_status(c: &PortalCapturer, want: PortalStatus, secs: u64) -> PortalStatus {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        let s = c.status();
        if s == want || s.is_final() || Instant::now() > end {
            return s;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn known_colour() -> [u8; 3] {
    let hex = std::env::var("IA_TEST_PORTAL_COLOUR").unwrap_or_else(|_| "3366cc".into());
    let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).expect("a hex colour");
    [(v >> 16) as u8, (v >> 8) as u8, v as u8]
}

#[test]
#[ignore = "needs the headless portal stack: scripts/portal-test.sh"]
fn a_session_starts_without_a_dialog_and_frames_have_the_known_colour() {
    guard();
    ia_capture_portal::probe(Duration::from_secs(5)).expect("the harness portal offers ScreenCast");
    let mut c = PortalCapturer::start();
    let st = wait_status(&c, PortalStatus::Streaming, 20);
    assert_eq!(
        st,
        PortalStatus::Streaming,
        "no dialog, straight to streaming"
    );
    assert_eq!(c.path(), CapturePath::Portal);
    assert_eq!(c.native_size(), Some((1280, 720)));
    let mons = c.enumerate();
    assert_eq!(mons.len(), 1);
    assert_eq!((mons[0].id, mons[0].width, mons[0].height), (1, 1280, 720));

    let (w, h, bgra) = c.latest_bgra().expect("a frame");
    assert_eq!((w, h), (1280, 720));
    let [r, g, b] = known_colour();
    // Sample a grid away from the corners (the embedded cursor may sit anywhere).
    let mut matching = 0;
    let mut total = 0;
    for gy in 1..8u32 {
        for gx in 1..8u32 {
            let (x, y) = (gx * w / 8, gy * h / 8);
            let i = ((y * w + x) * 4) as usize;
            total += 1;
            if bgra[i] == b && bgra[i + 1] == g && bgra[i + 2] == r && bgra[i + 3] == 0xFF {
                matching += 1;
            }
        }
    }
    assert!(
        matching * 10 >= total * 9,
        "{matching}/{total} samples have #{r:02x}{g:02x}{b:02x}"
    );

    let f = c.next_frame(PORTAL_MONITOR_ID).expect("an I420 frame");
    assert_eq!((f.width, f.height), (1280, 720));
    // The same frame again when nothing changed (the E rule).
    let again = c
        .next_frame(PORTAL_MONITOR_ID)
        .expect("the last frame again");
    assert_eq!(again.y, f.y);
    assert!(c.next_frame(2).is_none(), "only monitor 1 exists");
    c.stop();
    assert_eq!(c.status(), PortalStatus::Closed);
}

#[test]
#[ignore = "needs the headless portal stack: scripts/portal-test.sh"]
fn stopping_the_stream_is_portal_closed() {
    guard();
    let pid: i32 = std::env::var("IA_TEST_PORTAL_WLR_PID")
        .expect("the harness names its xdg-desktop-portal-wlr")
        .parse()
        .expect("a pid");
    let mut c = PortalCapturer::start();
    assert_eq!(
        wait_status(&c, PortalStatus::Streaming, 20),
        PortalStatus::Streaming
    );
    assert!(c.next_frame(PORTAL_MONITOR_ID).is_some());
    // The screen cast ends on the compositor side: the harness's own portal backend goes away
    // (a process the harness started; the stream's node is removed with it).
    // SAFETY: kill(2) on a pid the harness started, with SIGTERM.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGTERM) }, 0);
    assert_eq!(
        wait_status(&c, PortalStatus::Closed, 15),
        PortalStatus::Closed
    );
    assert_eq!(c.path(), CapturePath::None);
    // The no-screen state for the rest of the session.
    assert!(c.next_frame(PORTAL_MONITOR_ID).is_none());
    c.stop();
}

#[test]
#[ignore = "needs the headless portal stack: scripts/portal-test.sh"]
fn a_cancelled_dialog_is_portal_denied() {
    guard();
    assert_eq!(
        std::env::var("IA_TEST_PORTAL_MODE").as_deref(),
        Ok("deny"),
        "the harness configured the portal to cancel"
    );
    let mut c = PortalCapturer::start();
    assert_eq!(
        wait_status(&c, PortalStatus::Denied, 20),
        PortalStatus::Denied
    );
    assert_eq!(c.path(), CapturePath::None);
    assert!(c.next_frame(PORTAL_MONITOR_ID).is_none());
    c.stop();
    assert_eq!(c.status(), PortalStatus::Denied, "the first ending stays");
}
