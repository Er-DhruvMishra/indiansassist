//! The X11 capture suite (Phase E §7.10 "X11"). Every test is `#[ignore]`d and runs only through
//! `agent/scripts/xvfb-test.sh`, which starts its own Xvfb (3840x1080x24) and names it in
//! `IA_TEST_X11_DISPLAY`; each test first passes the binding guard
//! (`ia_platform::linux::testguard`) and then connects only to that display. Every window,
//! pixmap and cursor here belongs to the test's own connection and goes away when it closes.
#![cfg(all(target_os = "linux", feature = "x11"))]

use ia_capture_x11::{Options, X11Capturer};
use ia_core::types::CapturePath;
use ia_frame::convert::bgra_to_i420;
use ia_platform::traits::{Capturer, Frame};
use x11rb::connection::Connection;
use x11rb::protocol::randr::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{
    Atom, ChangeWindowAttributesAux, ConnectionExt as _, CreateGCAux, CreateWindowAux, Gcontext,
    ImageFormat, Rectangle, Window, WindowClass,
};
use x11rb::rust_connection::RustConnection;
use x11rb::{COPY_DEPTH_FROM_PARENT, COPY_FROM_PARENT, NONE};

/// The test's own client on the harness display.
struct Client {
    conn: RustConnection,
    root: Window,
    depth: u8,
    gc: Gcontext,
}

/// Connect to the harness display, retrying for up to 5 s. The harness starts Xvfb without
/// `-noreset`, so when the previous test's last connection closes the server regenerates and
/// resets connections made meanwhile. While this client stays connected the server cannot reset,
/// so the capturer each test opens afterwards connects at once.
fn connect_harness(display: &str) -> (RustConnection, usize) {
    let mut last = None;
    for _ in 0..50 {
        match RustConnection::connect(Some(display)) {
            Ok(c) => return c,
            Err(e) => last = Some(e),
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    panic!("connect to the harness display {display}: {last:?}");
}

impl Client {
    fn connect(display: &str) -> Client {
        let (conn, n) = connect_harness(display);
        let screen = &conn.setup().roots[n];
        let (root, depth) = (screen.root, screen.root_depth);
        let gc = conn.generate_id().unwrap();
        conn.create_gc(gc, root, &CreateGCAux::new().graphics_exposures(0))
            .unwrap();
        let client = Client {
            conn,
            root,
            depth,
            gc,
        };
        client.sync();
        client
    }

    /// A round trip: every request sent before it has been processed by the server.
    fn sync(&self) {
        self.conn.get_input_focus().unwrap().reply().unwrap();
    }

    /// A mapped, override-redirect, borderless window with a solid background pixel.
    fn window(&self, x: i16, y: i16, w: u16, h: u16, background: u32) -> Window {
        let win = self.conn.generate_id().unwrap();
        self.conn
            .create_window(
                COPY_DEPTH_FROM_PARENT,
                win,
                self.root,
                x,
                y,
                w,
                h,
                0,
                WindowClass::INPUT_OUTPUT,
                COPY_FROM_PARENT,
                &CreateWindowAux::new()
                    .background_pixel(background)
                    .override_redirect(1),
            )
            .unwrap();
        self.conn.map_window(win).unwrap();
        self.sync();
        win
    }

    /// `PutImage` a BGRX buffer (32 bpp ZPixmap at the root depth) into `win` at (0, 0).
    fn put(&self, win: Window, w: u16, h: u16, bgrx: &[u8]) {
        self.conn
            .put_image(
                ImageFormat::Z_PIXMAP,
                win,
                self.gc,
                w,
                h,
                0,
                0,
                0,
                self.depth,
                bgrx,
            )
            .unwrap();
        self.sync();
    }

    /// Move the pointer of the harness display (root coordinates).
    fn warp(&self, x: i16, y: i16) {
        self.conn
            .warp_pointer(NONE, self.root, 0, 0, 0, 0, x, y)
            .unwrap();
        self.sync();
    }

    fn atom(&self, name: &str) -> Atom {
        self.conn
            .intern_atom(false, name.as_bytes())
            .unwrap()
            .reply()
            .unwrap()
            .atom
    }
}

/// A BGRX test pattern where every pixel differs from its neighbours.
fn pattern(w: usize, h: usize, seed: u8) -> Vec<u8> {
    let mut v = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            v.extend_from_slice(&[
                (x * 4) as u8 ^ seed,
                (y * 4) as u8,
                ((x + y) * 2) as u8 ^ seed.rotate_left(3),
                0,
            ]);
        }
    }
    v
}

/// The I420 of `bgra` (w x h) must appear exactly at (fx, fy) of `frame` (even coordinates, so
/// the 2x2 chroma blocks line up and the reference converter gives identical values).
fn assert_region(frame: &Frame, fx: usize, fy: usize, bgra: &[u8], w: usize, h: usize) {
    assert!([fx, fy, w, h].iter().all(|v| v.is_multiple_of(2)));
    let exp = bgra_to_i420(bgra, w as u32, h as u32, w * 4);
    for y in 0..h {
        assert_eq!(
            &frame.y[(fy + y) * frame.y_stride + fx..][..w],
            &exp.y[y * w..][..w],
            "luma row {y} of the region at ({fx}, {fy})"
        );
    }
    let (cw, ch) = (w / 2, h / 2);
    for y in 0..ch {
        let at = (fy / 2 + y) * frame.uv_stride + fx / 2;
        assert_eq!(&frame.u[at..][..cw], &exp.u[y * cw..][..cw], "U row {y}");
        assert_eq!(&frame.v[at..][..cw], &exp.v[y * cw..][..cw], "V row {y}");
    }
}

/// (Y, U, V) of a solid colour through the reference converter.
fn yuv(b: u8, g: u8, r: u8) -> (u8, u8, u8) {
    let px = [b, g, r, 0].repeat(4);
    let f = bgra_to_i420(&px, 2, 2, 8);
    (f.y[0], f.u[0], f.v[0])
}

fn yuv_at(frame: &Frame, x: usize, y: usize) -> (u8, u8, u8) {
    let c = (y / 2) * frame.uv_stride + x / 2;
    (frame.y[y * frame.y_stride + x], frame.u[c], frame.v[c])
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn shm_capture_reads_a_put_image_pattern() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let c = Client::connect(&display);
    c.warp(3830, 1070);
    let win = c.window(200, 100, 64, 48, 0);
    let pat = pattern(64, 48, 0x11);
    c.put(win, 64, 48, &pat);

    let mut cap = X11Capturer::open(&display).expect("open the harness display");
    assert_eq!(cap.path(1), CapturePath::Xshm, "MIT-SHM with fd passing");
    let monitors = cap.enumerate();
    eprintln!("monitors: {monitors:?}");
    assert_eq!(monitors.len(), 1);
    let m = &monitors[0];
    assert_eq!((m.id, m.primary), (1, true));
    assert_eq!((m.x, m.y, m.width, m.height), (0, 0, 3840, 1080));
    assert_eq!(m.scale, 1.0);

    let frame = cap.next_frame(1).expect("a frame");
    assert_eq!((frame.width, frame.height), (3840, 1080));
    assert_eq!((frame.y_stride, frame.uv_stride), (3840, 1920));
    assert_region(&frame, 200, 100, &pat, 64, 48);
    assert!(cap.next_frame(2).is_none(), "unknown monitor");
    assert!(!cap.lost());
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn getimage_fallback_reads_the_same_pattern() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let c = Client::connect(&display);
    c.warp(3830, 1070);
    let win = c.window(1000, 500, 96, 64, 0);
    let pat = pattern(96, 64, 0x5A);
    c.put(win, 96, 64, &pat);

    let mut cap = X11Capturer::open_with(
        &display,
        Options {
            force_getimage: true,
        },
    )
    .expect("open the harness display");
    assert_eq!(cap.path(1), CapturePath::Xgetimage);
    assert_eq!(cap.test_owned_resource(), None, "no SHM segment");
    let frame = cap.next_frame(1).expect("a frame");
    assert_eq!((frame.width, frame.height), (3840, 1080));
    assert_region(&frame, 1000, 500, &pat, 96, 64);
    assert!(!cap.lost());
}

/// Deletes the test's RandR monitors on every exit path.
struct MonitorCleanup<'a> {
    c: &'a Client,
    names: Vec<Atom>,
}

impl Drop for MonitorCleanup<'_> {
    fn drop(&mut self) {
        for name in self.names.drain(..) {
            if let Ok(cookie) = self.c.conn.randr_delete_monitor(self.c.root, name) {
                let _ = cookie.check();
            }
        }
    }
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn two_randr_monitors_set_with_set_monitor() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let c = Client::connect(&display);
    let v = c.conn.randr_query_version(1, 5).unwrap().reply().unwrap();
    assert!((v.major_version, v.minor_version) >= (1, 5), "RandR {v:?}");
    let left = c.atom("IA-TEST-LEFT");
    let right = c.atom("IA-TEST-RIGHT");
    let resources = c
        .conn
        .randr_get_screen_resources_current(c.root)
        .unwrap()
        .reply()
        .unwrap();
    let cleanup = MonitorCleanup {
        c: &c,
        names: vec![left, right],
    };
    // The left monitor takes over the server's output, so its automatic monitor is replaced.
    for (name, primary, x, outputs) in [
        (
            left,
            true,
            0,
            resources.outputs.iter().take(1).copied().collect(),
        ),
        (right, false, 1920, Vec::new()),
    ] {
        c.conn
            .randr_set_monitor(
                c.root,
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
            .unwrap()
            .check()
            .expect("SetMonitor");
    }
    let raw = c
        .conn
        .randr_get_monitors(c.root, true)
        .unwrap()
        .reply()
        .unwrap();
    eprintln!(
        "GetMonitors: {:?}",
        raw.monitors
            .iter()
            .map(|m| (m.name, m.primary, m.x, m.y, m.width, m.height))
            .collect::<Vec<_>>()
    );

    let mut cap = X11Capturer::open(&display).expect("open the harness display");
    let monitors = cap.enumerate();
    eprintln!("monitors: {monitors:?}");
    assert_eq!(monitors.len(), 2);
    let rects: Vec<_> = monitors
        .iter()
        .map(|m| {
            (
                m.id,
                m.name.as_str(),
                m.primary,
                m.x,
                m.y,
                m.width,
                m.height,
            )
        })
        .collect();
    assert_eq!(
        rects,
        [
            (1, "IA-TEST-LEFT", true, 0, 0, 1920, 1080),
            (2, "IA-TEST-RIGHT", false, 1920, 0, 1920, 1080),
        ]
    );

    // A pattern on the right monitor appears at monitor-relative coordinates.
    c.warp(100, 1000);
    let win = c.window(1920 + 300, 200, 64, 64, 0);
    let pat = pattern(64, 64, 0x33);
    c.put(win, 64, 64, &pat);
    let right_frame = cap.next_frame(2).expect("monitor 2");
    assert_eq!((right_frame.width, right_frame.height), (1920, 1080));
    assert_region(&right_frame, 300, 200, &pat, 64, 64);
    let left_frame = cap.next_frame(1).expect("monitor 1");
    assert_eq!((left_frame.width, left_frame.height), (1920, 1080));

    // Delete them again: the refreshed list is the single automatic monitor.
    drop(cleanup);
    let monitors = cap.refresh_monitors();
    eprintln!("after delete: {monitors:?}");
    assert_eq!(monitors.len(), 1);
    assert_eq!(
        (
            monitors[0].x,
            monitors[0].y,
            monitors[0].width,
            monitors[0].height
        ),
        (0, 0, 3840, 1080)
    );
    assert_eq!(cap.enumerate(), monitors);
    assert!(cap.next_frame(2).is_none(), "monitor 2 is gone");
    let whole = cap.next_frame(1).expect("monitor 1, now the whole screen");
    assert_eq!((whole.width, whole.height), (3840, 1080));
    assert_region(&whole, 1920 + 300, 200, &pat, 64, 64);
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn cursor_is_composited_at_the_pointer() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let c = Client::connect(&display);
    let win = c.window(400, 300, 128, 128, 0x0000_00FF); // solid blue
                                                         // A 16x16 solid red cursor, hotspot (0, 0), from a 1-bit pixmap used as source and mask.
    let pix = c.conn.generate_id().unwrap();
    c.conn.create_pixmap(1, pix, c.root, 16, 16).unwrap();
    let gc1 = c.conn.generate_id().unwrap();
    c.conn
        .create_gc(gc1, pix, &CreateGCAux::new().foreground(1))
        .unwrap();
    c.conn
        .poly_fill_rectangle(
            pix,
            gc1,
            &[Rectangle {
                x: 0,
                y: 0,
                width: 16,
                height: 16,
            }],
        )
        .unwrap();
    let cursor = c.conn.generate_id().unwrap();
    c.conn
        .create_cursor(cursor, pix, pix, 0xFFFF, 0, 0, 0, 0, 0, 0, 0)
        .unwrap();
    c.conn
        .change_window_attributes(win, &ChangeWindowAttributesAux::new().cursor(cursor))
        .unwrap();
    c.warp(432, 332);

    let red = yuv(0, 0, 255);
    let blue = yuv(255, 0, 0);
    let mut cap = X11Capturer::open(&display).expect("open the harness display");
    let frame = cap.next_frame(1).expect("a frame");
    for y in 332..348 {
        for x in 432..448 {
            assert_eq!(yuv_at(&frame, x, y), red, "cursor pixel ({x}, {y})");
        }
    }
    for (x, y) in [
        (404, 304),
        (430, 340),
        (448, 340),
        (440, 330),
        (440, 348),
        (520, 420),
    ] {
        assert_eq!(yuv_at(&frame, x, y), blue, "window pixel ({x}, {y})");
    }

    // The pointer moves: the old spot is the window again, the new one is the cursor.
    c.warp(480, 380);
    let moved = cap.next_frame(1).expect("a frame");
    assert_eq!(yuv_at(&moved, 440, 340), blue);
    assert_eq!(yuv_at(&moved, 486, 386), red);
    assert_eq!(cap.counters().converted, 2, "a cursor move is a change");
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn a_static_screen_resends_the_frame_and_a_change_is_seen() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let c = Client::connect(&display);
    c.warp(3830, 1070);
    let win = c.window(600, 600, 64, 64, 0);
    c.put(win, 64, 64, &pattern(64, 64, 0x01));

    let mut cap = X11Capturer::open(&display).expect("open the harness display");
    let first = cap.next_frame(1).expect("a frame");
    let k1 = cap.counters();
    assert_eq!((k1.grabs, k1.converted, k1.reused), (1, 1, 0));

    let again = cap.next_frame(1).expect("the same frame again, not None");
    let k2 = cap.counters();
    assert_eq!((k2.grabs, k2.converted, k2.reused), (2, 1, 1));
    assert_eq!(
        (again.y, again.u, again.v),
        (first.y.clone(), first.u.clone(), first.v.clone())
    );

    let next = pattern(64, 64, 0xC3);
    c.put(win, 64, 64, &next);
    let changed = cap.next_frame(1).expect("a frame");
    let k3 = cap.counters();
    assert_eq!((k3.grabs, k3.converted, k3.reused), (3, 2, 1));
    assert_ne!(changed.y, first.y);
    assert_region(&changed, 600, 600, &next, 64, 64);
}

#[test]
#[ignore = "X11: run through agent/scripts/xvfb-test.sh"]
fn lost_after_the_server_drops_the_connection() {
    let display = match ia_platform::linux::testguard::x11_test_display() {
        Ok(d) => d,
        Err(e) => panic!("{e}"),
    };
    let c = Client::connect(&display);
    let mut cap = X11Capturer::open(&display).expect("open the harness display");
    let first = cap.next_frame(1).expect("a frame");
    assert!(!cap.lost());
    // KillClient on a resource the capturer's connection owns closes that connection only
    // (the harness's own Xvfb; the server keeps running).
    let resource = cap.test_owned_resource().expect("the SHM segment");
    c.conn.kill_client(resource).unwrap();
    c.sync();

    let after = cap.next_frame(1).expect("the last frame again");
    assert!(cap.lost(), "the broken connection is reported");
    assert_eq!(after.y, first.y);
    assert_eq!(cap.refresh_monitors().len(), 1, "the cached list is kept");
    assert!(cap.next_frame(1).is_some());
    // The server is still serving other clients.
    c.sync();
}
