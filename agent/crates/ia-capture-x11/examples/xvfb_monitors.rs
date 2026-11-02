//! `e2e:p3:linux` helper (Phase E §7.10): give the harness-owned Xvfb two RandR 1.5 monitors
//! (`IA-E2E-LEFT` 1920x1080 at 0,0, primary, and `IA-E2E-RIGHT` 1920x1080 at 1920,0) so the agent
//! shares two monitors in the end-to-end run. Run by `agent/scripts/e2e-agent.sh` only.
//!
//! It refuses unless the binding X11 test guard passes (`IA_TEST_X11_DISPLAY` names an Xvfb the
//! harness started, never the session's display or `:0`), and it connects only to that display.
//! The monitors live as long as the X server; the harness stops the server afterwards.

#[cfg(target_os = "linux")]
fn main() {
    use x11rb::connection::Connection;
    use x11rb::protocol::randr::{self, ConnectionExt as _};
    use x11rb::protocol::xproto::ConnectionExt as _;

    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("xvfb_monitors: refusing: {e}");
            std::process::exit(2);
        }
    };
    let (conn, screen) = x11rb::connect(Some(&display)).unwrap_or_else(|e| {
        eprintln!("xvfb_monitors: cannot connect to {display}: {e}");
        std::process::exit(1);
    });
    let root = conn.setup().roots[screen].root;
    let atom = |name: &str| {
        conn.intern_atom(false, name.as_bytes())
            .expect("intern_atom")
            .reply()
            .expect("intern_atom reply")
            .atom
    };
    let resources = conn
        .randr_get_screen_resources_current(root)
        .expect("GetScreenResourcesCurrent")
        .reply()
        .expect("GetScreenResourcesCurrent reply");
    for (name, primary, x, outputs) in [
        (
            atom("IA-E2E-LEFT"),
            true,
            0,
            resources.outputs.iter().take(1).copied().collect(),
        ),
        (atom("IA-E2E-RIGHT"), false, 1920, Vec::new()),
    ] {
        conn.randr_set_monitor(
            root,
            randr::MonitorInfo {
                name,
                primary,
                automatic: false,
                x,
                y: 0,
                width: 1920,
                height: 1080,
                width_in_millimeters: 527,
                height_in_millimeters: 296,
                outputs,
            },
        )
        .expect("SetMonitor")
        .check()
        .expect("SetMonitor accepted");
    }
    let got = conn
        .randr_get_monitors(root, true)
        .expect("GetMonitors")
        .reply()
        .expect("GetMonitors reply");
    println!(
        "xvfb_monitors: {display} now has {} monitors",
        got.monitors.len()
    );
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("xvfb_monitors runs on Linux only");
}
