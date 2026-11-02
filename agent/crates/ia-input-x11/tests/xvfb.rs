//! The `ia-input-x11` X11 suite (Phase E §7.10 "X11" and "Guard", §15.6). Every test is
//! `#[ignore]` and is run only by `agent/scripts/xvfb-test.sh`, against the Xvfb that script
//! starts: each test first passes `ia_platform::linux::testguard::x11_test_display()` and then
//! connects only to that display. Each test creates its own test-owned windows, injects through
//! `X11Input`, and reads the delivered events back on its own connection. `xdotool` is used only
//! with `DISPLAY` set to the harness display, as an independent observer.
#![cfg(all(target_os = "linux", feature = "x11"))]

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use ia_core::types::{Modifiers, MonitorInfo};
use ia_input_x11::unicode::{char_for_keysym, XK_RETURN};
use ia_input_x11::{
    clipboard_clear_if_unchanged, clipboard_read_once, keymap, X11Clipboard, X11Input,
};
use ia_platform::traits::{ClipboardBridge, InputSink, KeyAction, PointerAction};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConfigureWindowAux, ConnectionExt as _, CreateWindowAux, EventMask, InputFocus,
    PropMode, SelectionNotifyEvent, Window, WindowClass, SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{COPY_DEPTH_FROM_PARENT, CURRENT_TIME, NONE};

// ---------------------------------------------------------------------------------------------
// Test-side X client (the observer).

struct Observer {
    conn: RustConnection,
    root: Window,
}

fn mask() -> EventMask {
    EventMask::KEY_PRESS
        | EventMask::KEY_RELEASE
        | EventMask::BUTTON_PRESS
        | EventMask::BUTTON_RELEASE
        | EventMask::POINTER_MOTION
        | EventMask::STRUCTURE_NOTIFY
}

impl Observer {
    fn connect(display: &str) -> Self {
        let (conn, screen) =
            RustConnection::connect(Some(display)).expect("connect to the harness Xvfb");
        let root = conn.setup().roots[screen].root;
        Self { conn, root }
    }

    fn atom(&self, name: &str) -> Atom {
        self.conn
            .intern_atom(false, name.as_bytes())
            .expect("intern")
            .reply()
            .expect("intern reply")
            .atom
    }

    /// A window, optionally marked as an agent window (`_NET_WM_PID` = `pid`). Not mapped yet.
    fn window(&self, parent: Window, x: i16, y: i16, w: u16, h: u16, pid: Option<u32>) -> Window {
        let win = self.conn.generate_id().expect("id");
        self.conn
            .create_window(
                COPY_DEPTH_FROM_PARENT,
                win,
                parent,
                x,
                y,
                w,
                h,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new().event_mask(mask()),
            )
            .expect("create window");
        if let Some(pid) = pid {
            let a = self.atom("_NET_WM_PID");
            self.conn
                .change_property32(PropMode::REPLACE, win, a, AtomEnum::CARDINAL, &[pid])
                .expect("set _NET_WM_PID");
        }
        self.conn.sync().expect("sync");
        win
    }

    fn map(&self, win: Window) {
        self.conn.map_window(win).expect("map");
        self.conn.sync().expect("sync");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let attrs = self
                .conn
                .get_window_attributes(win)
                .expect("attrs")
                .reply()
                .expect("attrs reply");
            if attrs.map_state == x11rb::protocol::xproto::MapState::VIEWABLE {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "window {win} never became viewable"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        self.drain_quiet();
    }

    fn unmap(&self, win: Window) {
        self.conn.unmap_window(win).expect("unmap");
        self.conn.sync().expect("sync");
        self.drain_quiet();
    }

    fn focus(&self, win: Window) {
        self.conn
            .set_input_focus(InputFocus::PARENT, win, CURRENT_TIME)
            .expect("focus");
        self.conn.sync().expect("sync");
    }

    fn warp(&self, x: i16, y: i16) {
        self.conn
            .warp_pointer(NONE, self.root, 0, 0, 0, 0, x, y)
            .expect("warp");
        self.conn.sync().expect("sync");
        self.drain_quiet();
    }

    /// Discard everything queued so far.
    fn drain_quiet(&self) {
        self.conn.sync().expect("sync");
        while let Ok(Some(_)) = self.conn.poll_for_event() {}
    }

    /// The events delivered after `sink` sent its requests: the sink's round trip guarantees the
    /// server processed them, ours that the events they generated reached this connection.
    fn events_after(&self, sink: &X11Input) -> Vec<Event> {
        sink.sync().expect("sink sync");
        self.conn.sync().expect("sync");
        let mut out = Vec::new();
        let quiet_until = Instant::now() + Duration::from_millis(50);
        loop {
            match self.conn.poll_for_event().expect("poll") {
                Some(e) => out.push(e),
                None if Instant::now() >= quiet_until => break,
                None => std::thread::sleep(Duration::from_millis(2)),
            }
        }
        out
    }

    fn pointer_position(&self) -> (i16, i16) {
        let p = self
            .conn
            .query_pointer(self.root)
            .expect("query pointer")
            .reply()
            .expect("query pointer reply");
        (p.root_x, p.root_y)
    }

    /// The core keyboard mapping per keycode, trailing `NoSymbol` trimmed.
    fn keymap(&self) -> BTreeMap<u8, Vec<u32>> {
        let setup = self.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = self
            .conn
            .get_keyboard_mapping(min, max - min + 1)
            .expect("mapping")
            .reply()
            .expect("mapping reply");
        let per = usize::from(reply.keysyms_per_keycode);
        reply
            .keysyms
            .chunks(per)
            .enumerate()
            .map(|(i, syms)| {
                let mut v = syms.to_vec();
                while v.last() == Some(&0) {
                    v.pop();
                }
                (min + i as u8, v)
            })
            .collect()
    }

    fn keysym_of(&self, keycode: u8) -> u32 {
        let reply = self
            .conn
            .get_keyboard_mapping(keycode, 1)
            .expect("mapping")
            .reply()
            .expect("mapping reply");
        reply.keysyms.iter().copied().find(|&k| k != 0).unwrap_or(0)
    }
}

/// `xdotool` against the harness display only.
fn xdotool(display: &str, args: &[&str]) -> String {
    let out = std::process::Command::new("xdotool")
        .args(args)
        .env("DISPLAY", display)
        .env_remove("WAYLAND_DISPLAY")
        .output()
        .expect("run xdotool");
    assert!(
        out.status.success(),
        "xdotool {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn xdotool_shell(display: &str, args: &[&str]) -> BTreeMap<String, String> {
    xdotool(display, args)
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn monitor(x: i32, y: i32, width: u32, height: u32) -> MonitorInfo {
    MonitorInfo {
        id: 1,
        name: "XVFB-1".into(),
        primary: true,
        x,
        y,
        width,
        height,
        scale: 1.0,
        mid: None,
    }
}

/// The full Xvfb root (`xvfb-test.sh` starts `-screen 0 3840x1080x24`).
fn full_screen() -> MonitorInfo {
    monitor(0, 0, 3840, 1080)
}

/// `nx, ny` that land exactly on root pixel (`x`, `y`) of `m`.
fn norm(m: &MonitorInfo, x: i32, y: i32) -> (f32, f32) {
    (
        (x - m.x) as f32 / (m.width - 1) as f32,
        (y - m.y) as f32 / (m.height - 1) as f32,
    )
}

fn open_sink(display: &str) -> X11Input {
    X11Input::open(display)
        .expect("open X11Input on the harness display")
        .with_agent_pid(std::process::id())
}

fn buttons(events: &[Event], win: Window) -> Vec<(bool, u8)> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::ButtonPress(b) if b.event == win => Some((true, b.detail)),
            Event::ButtonRelease(b) if b.event == win => Some((false, b.detail)),
            _ => None,
        })
        .collect()
}

fn keys(events: &[Event], win: Window) -> Vec<(bool, u8)> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::KeyPress(k) if k.event == win => Some((true, k.detail)),
            Event::KeyRelease(k) if k.event == win => Some((false, k.detail)),
            _ => None,
        })
        .collect()
}

fn no_input_on(events: &[Event], win: Window) -> bool {
    !events.iter().any(|e| match e {
        Event::ButtonPress(b) | Event::ButtonRelease(b) => b.event == win,
        Event::KeyPress(k) | Event::KeyRelease(k) => k.event == win,
        Event::MotionNotify(m) => m.event == win,
        _ => false,
    })
}

// ---------------------------------------------------------------------------------------------
// Pointer, buttons, wheel.

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn pointer_motion_lands_on_the_expected_root_point() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let obs = Observer::connect(&display);
    let win = obs.window(obs.root, 2000, 100, 400, 300, None);
    obs.map(win);
    let mut sink = open_sink(&display);

    // The second of two side-by-side 1920x1080 monitors: (nx, ny) → root (2100, 200).
    let right = monitor(1920, 0, 1920, 1080);
    let (nx, ny) = norm(&right, 2100, 200);
    sink.pointer(&right, nx, ny, PointerAction::Move);
    let events = obs.events_after(&sink);
    let motion = events
        .iter()
        .rev()
        .find_map(|e| match e {
            Event::MotionNotify(m) if m.event == win => Some(*m),
            _ => None,
        })
        .expect("a MotionNotify on the test window");
    assert_eq!((motion.root_x, motion.root_y), (2100, 200));
    assert_eq!((motion.event_x, motion.event_y), (100, 100));
    assert_eq!(obs.pointer_position(), (2100, 200));
    let loc = xdotool_shell(&display, &["getmouselocation", "--shell"]);
    assert_eq!(loc["X"], "2100");
    assert_eq!(loc["Y"], "200");
    assert_eq!(loc["WINDOW"], win.to_string());

    // The corners of a monitor are its first and last pixel.
    sink.pointer(&right, 1.0, 1.0, PointerAction::Move);
    sink.sync().expect("sync");
    assert_eq!(obs.pointer_position(), (3839, 1079));
    sink.pointer(&right, 0.0, 0.0, PointerAction::Move);
    sink.sync().expect("sync");
    assert_eq!(obs.pointer_position(), (1920, 0));
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn buttons_map_to_x_buttons() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let obs = Observer::connect(&display);
    let win = obs.window(obs.root, 300, 300, 400, 300, None);
    obs.map(win);
    let mut sink = open_sink(&display);
    let m = full_screen();
    let (nx, ny) = norm(&m, 500, 450);

    let cases: &[(PointerAction, &[(bool, u8)])] = &[
        (PointerAction::Click(0), &[(true, 1), (false, 1)]),
        (PointerAction::Click(1), &[(true, 2), (false, 2)]),
        (PointerAction::Click(2), &[(true, 3), (false, 3)]),
        (PointerAction::Click(3), &[(true, 8), (false, 8)]),
        (PointerAction::Click(4), &[(true, 9), (false, 9)]),
        (PointerAction::Down(2), &[(true, 3)]),
        (PointerAction::Up(2), &[(false, 3)]),
        (
            PointerAction::DblClick(0),
            &[(true, 1), (false, 1), (true, 1), (false, 1)],
        ),
        (PointerAction::Move, &[]),
    ];
    for (action, want) in cases {
        sink.pointer(&m, nx, ny, *action);
        let events = obs.events_after(&sink);
        assert_eq!(buttons(&events, win), *want, "{action:?}");
        for e in &events {
            if let Event::ButtonPress(b) | Event::ButtonRelease(b) = e {
                assert_eq!((b.root_x, b.root_y), (500, 450), "{action:?} position");
            }
        }
    }
}

/// `(dx, dy)` of one `os.scroll`.
type Scroll = (i32, i32);

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn wheel_maps_to_buttons_4_to_7() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let obs = Observer::connect(&display);
    let win = obs.window(obs.root, 300, 300, 400, 300, None);
    obs.map(win);
    let mut sink = open_sink(&display);
    let m = full_screen();
    let (nx, ny) = norm(&m, 400, 400);

    let pair = |b: u8| [(true, b), (false, b)];
    let cases: Vec<(Scroll, Vec<(bool, u8)>)> = vec![
        ((0, 2), [pair(5), pair(5)].concat()), // dy > 0 scrolls down
        ((0, -1), pair(4).to_vec()),           // up
        ((3, 0), [pair(7), pair(7), pair(7)].concat()), // dx > 0 scrolls right
        ((-1, 0), pair(6).to_vec()),           // left
        ((-1, 1), [pair(5), pair(6)].concat()), // vertical first, as on Windows
        ((0, 0), vec![]),
    ];
    for ((dx, dy), want) in cases {
        sink.scroll(&m, nx, ny, dx, dy);
        let events = obs.events_after(&sink);
        assert_eq!(buttons(&events, win), want, "scroll dx {dx} dy {dy}");
    }
    assert_eq!(obs.pointer_position(), (400, 400));
}

// ---------------------------------------------------------------------------------------------
// Keys and text.

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn keys_arrive_with_evdev_plus_8_keycodes() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let obs = Observer::connect(&display);
    let win = obs.window(obs.root, 100, 600, 300, 200, None);
    obs.map(win);
    obs.focus(win);
    obs.warp(250, 700); // the pointer over the focused window too
    assert_eq!(xdotool(&display, &["getwindowfocus"]), win.to_string());
    let mut sink = open_sink(&display);
    let mods = Modifiers::default();

    for code in [
        "KeyA",
        "Enter",
        "Escape",
        "ArrowUp",
        "NumpadEnter",
        "F13",
        "Digit0",
        "MetaLeft",
    ] {
        let kc = keymap::x_keycode_for_code(code).expect("mapped");
        sink.key(code, KeyAction::Press, mods);
        let events = obs.events_after(&sink);
        assert_eq!(keys(&events, win), vec![(true, kc), (false, kc)], "{code}");
    }
    // Down and Up separately (a chord: Ctrl held while C is pressed).
    sink.key("ControlLeft", KeyAction::Down, mods);
    sink.key("KeyC", KeyAction::Press, mods);
    sink.key("ControlLeft", KeyAction::Up, mods);
    let events = obs.events_after(&sink);
    assert_eq!(
        keys(&events, win),
        vec![(true, 37), (true, 54), (false, 54), (false, 37)]
    );
    let press = events
        .iter()
        .find_map(|e| match e {
            Event::KeyPress(k) if k.detail == 54 => Some(*k),
            _ => None,
        })
        .expect("KeyC press");
    assert!(
        u16::from(press.state) & u16::from(x11rb::protocol::xproto::KeyButMask::CONTROL) != 0,
        "C was pressed with Control held"
    );
    // An unknown code injects nothing.
    sink.key("NotAKey", KeyAction::Press, mods);
    assert!(keys(&obs.events_after(&sink), win).is_empty());
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn unicode_text_through_a_spare_keycode() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let obs = Observer::connect(&display);
    let win = obs.window(obs.root, 100, 600, 300, 200, None);
    obs.map(win);
    obs.focus(win);
    obs.warp(250, 700);
    let mut sink = open_sink(&display);
    let before = obs.keymap();

    // Latin-1, a non-Latin-1 Euro sign and Devanagari, a repeat, a CRLF, then more distinct
    // characters than one batch has spare keycodes (64), so several batches run.
    let cjk: String = (0x4e00u32..0x4e00 + 80)
        .filter_map(char::from_u32)
        .collect();
    let text = format!("aZ\u{e9}\u{20ac}\u{939}a\r\n{cjk}");
    let want: Vec<char> = format!("aZ\u{e9}\u{20ac}\u{939}a\n{cjk}").chars().collect();

    // Decode as a lazy client does: on each KeyPress, look the keycode up in the mapping the
    // server holds at that moment. The sink keeps each binding until well after the release.
    let mut got = Vec::new();
    let mut pressed_keycodes = Vec::new();
    let mut releases = 0usize;
    std::thread::scope(|s| {
        let typing = s.spawn(|| sink.text(&text));
        let mut done_at: Option<Instant> = None;
        loop {
            match obs.conn.poll_for_event().expect("poll") {
                Some(Event::KeyPress(k)) if k.event == win => {
                    let ks = obs.keysym_of(k.detail);
                    got.push(char_for_keysym(ks).unwrap_or('\u{fffd}'));
                    pressed_keycodes.push(k.detail);
                }
                Some(Event::KeyRelease(k)) if k.event == win => releases += 1,
                Some(_) => {}
                None => {
                    if typing.is_finished() {
                        let t = *done_at.get_or_insert_with(Instant::now);
                        if t.elapsed() > Duration::from_millis(100) {
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        }
        typing.join().expect("text thread");
    });
    assert_eq!(
        got.iter().collect::<String>(),
        want.iter().collect::<String>()
    );
    assert_eq!(releases, want.len(), "every press has its release");
    assert!(want.contains(&'\n') && char_for_keysym(XK_RETURN) == Some('\n'));
    // Only spare keycodes were used, and the mapping is restored exactly.
    for kc in &pressed_keycodes {
        assert!(
            before.get(kc).is_some_and(|v| v.is_empty()),
            "keycode {kc} was not spare"
        );
    }
    assert_eq!(obs.keymap(), before, "the keyboard mapping is restored");
}

// ---------------------------------------------------------------------------------------------
// Rule 7.3c: the injection guard.

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn guard_refuses_pointer_over_agent_windows_read_live() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let obs = Observer::connect(&display);
    let pid = std::process::id();
    let agent = obs.window(obs.root, 100, 100, 300, 200, Some(pid)); // pixels 100..=399 x 100..=299
    let other = obs.window(obs.root, 600, 100, 300, 200, None);
    let foreign = obs.window(obs.root, 600, 400, 300, 200, Some(pid + 1)); // another process's
    obs.map(agent);
    obs.map(other);
    obs.map(foreign);
    let mut sink = open_sink(&display);
    let m = full_screen();
    let refused = |sink: &mut X11Input, x: i32, y: i32| {
        let (nx, ny) = norm(&m, x, y);
        sink.refuses_pointer(&m, nx, ny)
    };

    assert!(refused(&mut sink, 250, 200), "centre of the agent window");
    assert!(refused(&mut sink, 100, 100), "top-left pixel");
    assert!(refused(&mut sink, 399, 299), "bottom-right pixel");
    assert!(!refused(&mut sink, 400, 200), "one right of it");
    assert!(!refused(&mut sink, 250, 300), "one below it");
    assert!(
        !refused(&mut sink, 750, 200),
        "a window without the agent pid"
    );
    assert!(!refused(&mut sink, 750, 500), "a window of another pid");
    assert!(!refused(&mut sink, 2000, 900), "the bare root");
    let geo = xdotool_shell(
        &display,
        &["getwindowgeometry", "--shell", &agent.to_string()],
    );
    assert_eq!((geo["X"].as_str(), geo["Y"].as_str()), ("100", "100"));

    // Live, not cached: hidden, it refuses nothing; moved, it refuses at the new place.
    obs.unmap(agent);
    assert!(
        !refused(&mut sink, 250, 200),
        "an unmapped agent window does not refuse"
    );
    obs.map(agent);
    assert!(refused(&mut sink, 250, 200));
    obs.conn
        .configure_window(agent, &ConfigureWindowAux::new().x(1000).y(500))
        .expect("move");
    obs.conn.sync().expect("sync");
    assert!(!refused(&mut sink, 250, 200), "the old place");
    assert!(refused(&mut sink, 1150, 600), "the new place");

    // A reparenting window manager: the pid is on the client, the frame (title bar and close
    // button included) is what is guarded.
    let frame = obs.window(obs.root, 1500, 100, 400, 300, None);
    let client = obs.window(frame, 10, 30, 380, 260, Some(pid));
    obs.map(frame); // parent first: a child is viewable only once its parent is mapped
    obs.map(client);
    assert!(refused(&mut sink, 1700, 250), "the client area");
    assert!(refused(&mut sink, 1505, 105), "the frame's title bar");
    assert!(!refused(&mut sink, 1900, 250), "just right of the frame");

    let windows = sink.agent_windows().expect("agent windows");
    assert_eq!(windows.len(), 2, "{windows:?}");
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn guard_refuses_keyboard_while_an_agent_window_has_focus() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let obs = Observer::connect(&display);
    let pid = std::process::id();
    let agent = obs.window(obs.root, 100, 100, 300, 200, Some(pid));
    let child = obs.window(agent, 10, 10, 50, 50, None); // a subwindow inside the agent window
    let other = obs.window(obs.root, 600, 100, 300, 200, None);
    let frame = obs.window(obs.root, 1500, 100, 400, 300, None);
    let client = obs.window(frame, 10, 30, 380, 260, Some(pid));
    for w in [agent, child, other, frame, client] {
        obs.map(w);
    }
    let mut sink = open_sink(&display);

    obs.focus(agent);
    assert_eq!(xdotool(&display, &["getwindowfocus"]), agent.to_string());
    assert!(sink.refuses_keyboard(), "focus on the agent window");
    obs.focus(child);
    assert!(sink.refuses_keyboard(), "focus on a subwindow of it");
    obs.focus(client);
    assert!(
        sink.refuses_keyboard(),
        "focus on the agent client inside a frame"
    );
    obs.focus(frame);
    assert!(
        sink.refuses_keyboard(),
        "focus on the frame of an agent client"
    );
    obs.focus(other);
    assert_eq!(xdotool(&display, &["getwindowfocus"]), other.to_string());
    assert!(!sink.refuses_keyboard(), "focus on a foreign window");

    // PointerRoot (and focus on the root): keys go to the window under the pointer.
    obs.conn
        .set_input_focus(InputFocus::POINTER_ROOT, 1u32, CURRENT_TIME)
        .expect("focus PointerRoot");
    obs.conn.sync().expect("sync");
    obs.warp(250, 200);
    assert!(
        sink.refuses_keyboard(),
        "PointerRoot with the pointer over the agent window"
    );
    obs.warp(750, 200);
    assert!(
        !sink.refuses_keyboard(),
        "PointerRoot with the pointer elsewhere"
    );
    obs.focus(obs.root);
    obs.warp(250, 200);
    assert!(
        sink.refuses_keyboard(),
        "root focus with the pointer over the agent window"
    );

    // Focus None discards keys: nothing to refuse.
    obs.conn
        .set_input_focus(InputFocus::NONE, NONE, CURRENT_TIME)
        .expect("focus None");
    obs.conn.sync().expect("sync");
    assert!(!sink.refuses_keyboard());
}

/// The control server consults the guard first and injects only when it does not refuse
/// (`ia-agent` `live.rs` `sink_refuses`): an event aimed at an agent window is never delivered.
#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn guarded_injection_never_reaches_an_agent_window() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let obs = Observer::connect(&display);
    let pid = std::process::id();
    let agent = obs.window(obs.root, 100, 100, 300, 200, Some(pid));
    let other = obs.window(obs.root, 600, 100, 300, 200, None);
    obs.map(agent);
    obs.map(other);
    obs.warp(2000, 900);
    let mut sink = open_sink(&display);
    let m = full_screen();
    let mods = Modifiers::default();

    fn guarded_pointer(
        s: &mut X11Input,
        m: &MonitorInfo,
        x: i32,
        y: i32,
        a: PointerAction,
    ) -> bool {
        let (nx, ny) = norm(m, x, y);
        if s.refuses_pointer(m, nx, ny) {
            return false; // ctl.res { ok: false, error: 'not_allowed' }
        }
        s.pointer(m, nx, ny, a);
        true
    }

    // Aimed at the agent window: refused, nothing delivered, the pointer did not move there.
    assert!(!guarded_pointer(
        &mut sink,
        &m,
        250,
        200,
        PointerAction::Click(0)
    ));
    assert!(!guarded_pointer(
        &mut sink,
        &m,
        399,
        299,
        PointerAction::Move
    ));
    let (nx, ny) = norm(&m, 250, 200);
    assert!(
        sink.refuses_pointer(&m, nx, ny),
        "scroll over it is refused too"
    );
    let events = obs.events_after(&sink);
    assert!(no_input_on(&events, agent), "{events:?}");
    let loc = xdotool_shell(&display, &["getmouselocation", "--shell"]);
    assert_ne!(loc["WINDOW"], agent.to_string());
    assert_eq!(obs.pointer_position(), (2000, 900));

    // Aimed at the foreign window: delivered.
    assert!(guarded_pointer(
        &mut sink,
        &m,
        750,
        200,
        PointerAction::Click(0)
    ));
    let events = obs.events_after(&sink);
    assert_eq!(buttons(&events, other), vec![(true, 1), (false, 1)]);
    assert!(no_input_on(&events, agent));

    // Keys and text with the agent window focused: refused, nothing delivered.
    obs.focus(agent);
    obs.warp(250, 200);
    for _ in 0..2 {
        if !sink.refuses_keyboard() {
            sink.key("KeyA", KeyAction::Press, mods);
        }
        if !sink.refuses_keyboard() {
            sink.text("no");
        }
    }
    let events = obs.events_after(&sink);
    assert!(no_input_on(&events, agent), "{events:?}");

    // Focus on the foreign window: delivered.
    obs.focus(other);
    obs.warp(750, 200);
    assert!(!sink.refuses_keyboard());
    sink.key("KeyA", KeyAction::Press, mods);
    let events = obs.events_after(&sink);
    assert_eq!(keys(&events, other), vec![(true, 38), (false, 38)]);
    assert!(no_input_on(&events, agent));
}

// ---------------------------------------------------------------------------------------------
// Clipboard. The second client is this test's own x11rb connection (an independent X client:
// arboard shares one global connection per process, so a second arboard handle here would read
// arboard's own copy without asking the X server).

struct SelectionAtoms {
    clipboard: Atom,
    utf8: Atom,
    targets: Atom,
    prop: Atom,
}

fn selection_atoms(obs: &Observer) -> SelectionAtoms {
    SelectionAtoms {
        clipboard: obs.atom("CLIPBOARD"),
        utf8: obs.atom("UTF8_STRING"),
        targets: obs.atom("TARGETS"),
        prop: obs.atom("IA_TEST_SELECTION"),
    }
}

/// Read CLIPBOARD as UTF8_STRING through the X server (`ConvertSelection`); `None` when there is
/// no owner or the owner refused.
fn read_clipboard(obs: &Observer, a: &SelectionAtoms, win: Window) -> Option<String> {
    obs.conn
        .convert_selection(win, a.clipboard, a.utf8, a.prop, CURRENT_TIME)
        .expect("convert");
    obs.conn.flush().expect("flush");
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match obs.conn.poll_for_event().expect("poll") {
            Some(Event::SelectionNotify(n)) if n.requestor == win => {
                if n.property == NONE {
                    return None;
                }
                let r = obs
                    .conn
                    .get_property(true, win, a.prop, AtomEnum::ANY, 0, 1 << 20)
                    .expect("get property")
                    .reply()
                    .expect("property reply");
                return Some(String::from_utf8(r.value).expect("utf8"));
            }
            Some(_) => {}
            None => {
                assert!(Instant::now() < deadline, "no SelectionNotify");
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
}

fn own_clipboard(obs: &Observer, a: &SelectionAtoms, win: Window) {
    obs.conn
        .set_selection_owner(win, a.clipboard, CURRENT_TIME)
        .expect("own");
    obs.conn.sync().expect("sync");
    let owner = obs
        .conn
        .get_selection_owner(a.clipboard)
        .expect("owner")
        .reply()
        .expect("owner reply")
        .owner;
    assert_eq!(owner, win);
    std::thread::sleep(Duration::from_millis(50)); // let the XFixes notify reach the bridge
}

/// Run `f` on another thread while this test's window serves CLIPBOARD = `text`.
fn serving<T: Send>(
    obs: &Observer,
    a: &SelectionAtoms,
    text: &str,
    f: impl FnOnce() -> T + Send,
) -> T {
    std::thread::scope(|s| {
        let h = s.spawn(f);
        loop {
            while let Some(ev) = obs.conn.poll_for_event().expect("poll") {
                let Event::SelectionRequest(req) = ev else {
                    continue;
                };
                let property = if req.property == NONE {
                    req.target
                } else {
                    req.property
                };
                let answered = if req.target == a.utf8 {
                    obs.conn
                        .change_property8(
                            PropMode::REPLACE,
                            req.requestor,
                            property,
                            a.utf8,
                            text.as_bytes(),
                        )
                        .expect("answer");
                    property
                } else if req.target == a.targets {
                    obs.conn
                        .change_property32(
                            PropMode::REPLACE,
                            req.requestor,
                            property,
                            AtomEnum::ATOM,
                            &[a.targets, a.utf8],
                        )
                        .expect("answer targets");
                    property
                } else {
                    NONE
                };
                let notify = SelectionNotifyEvent {
                    response_type: SELECTION_NOTIFY_EVENT,
                    sequence: 0,
                    time: req.time,
                    requestor: req.requestor,
                    selection: req.selection,
                    target: req.target,
                    property: answered,
                };
                obs.conn
                    .send_event(false, req.requestor, EventMask::NO_EVENT, notify)
                    .expect("notify");
                obs.conn.flush().expect("flush");
            }
            if h.is_finished() {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        h.join().expect("clipboard thread")
    })
}

/// arboard reads `DISPLAY`: it must be the guarded harness display, never the session's.
fn assert_display_is_harness(display: &str) {
    assert_eq!(
        std::env::var("DISPLAY").ok().as_deref(),
        Some(display),
        "DISPLAY must be the harness display (xvfb-test.sh sets it)"
    );
    assert!(std::env::var_os("WAYLAND_DISPLAY").is_none());
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn clipboard_round_trip_and_external_change() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    assert_display_is_harness(&display);
    let obs = Observer::connect(&display);
    let a = selection_atoms(&obs);
    let win = obs.window(obs.root, 0, 0, 10, 10, None);
    let mut cb = X11Clipboard::new().expect("an X11 clipboard on the harness display");
    assert_eq!(cb.take_update(), None, "nothing changed yet");

    // Assist → Desk: set, and an independent X client reads it through the server.
    let sent = "IndiansAssist clip \u{e9} \u{20ac} \u{939}";
    cb.set_text(sent);
    assert_eq!(read_clipboard(&obs, &a, win).as_deref(), Some(sent));
    assert_eq!(cb.take_update(), None, "our own set is not echoed back");

    // Desk → Assist: another client copies; the change is reported once.
    own_clipboard(&obs, &a, win);
    let copied = "copied on the Desk \u{4e2d}";
    let got = serving(&obs, &a, copied, || cb.take_update());
    assert_eq!(got.as_deref(), Some(copied));
    let again = serving(&obs, &a, copied, || cb.take_update());
    assert_eq!(again, None, "an unchanged clipboard is not reported twice");

    // The same text copied again by the owner is not news; a different text is.
    own_clipboard(&obs, &a, win);
    assert_eq!(serving(&obs, &a, copied, || cb.take_update()), None);
    own_clipboard(&obs, &a, win);
    let second = "second copy";
    assert_eq!(
        serving(&obs, &a, second, || cb.take_update()).as_deref(),
        Some(second)
    );
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn clipboard_token_carrier_reads_once_and_clears_only_if_unchanged() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    assert_display_is_harness(&display);
    let obs = Observer::connect(&display);
    let a = selection_atoms(&obs);
    let win = obs.window(obs.root, 0, 0, 10, 10, None);
    let token = "ia-test-token-0000";
    own_clipboard(&obs, &a, win);

    assert_eq!(
        serving(&obs, &a, token, clipboard_read_once).as_deref(),
        Some(token)
    );
    // Something else on the clipboard is left alone.
    assert!(!serving(&obs, &a, token, || clipboard_clear_if_unchanged(
        "other"
    )));
    let owner = obs
        .conn
        .get_selection_owner(a.clipboard)
        .expect("owner")
        .reply()
        .expect("owner reply")
        .owner;
    assert_eq!(owner, win, "not taken when the value differs");
    // Still the token: cleared by taking the selection with an empty string.
    assert!(serving(&obs, &a, token, || clipboard_clear_if_unchanged(
        token
    )));
    let owner = obs
        .conn
        .get_selection_owner(a.clipboard)
        .expect("owner")
        .reply()
        .expect("owner reply")
        .owner;
    assert_ne!(owner, win, "the selection was taken from the token's owner");
    let after = read_clipboard(&obs, &a, win);
    assert!(
        matches!(after.as_deref(), None | Some("")),
        "the token is gone: {after:?}"
    );
}
