//! Phase F §17.3 (stream apple): the macOS LaunchAgent worker.
//!
//! launchd starts `ia-desktop` in every GUI login session. It:
//!
//! 1. connects to the daemon's socket (`/var/run/indiansassist/worker.sock`; `--socket` in a dev
//!    run), retrying with a backoff while the daemon is not up;
//! 2. checks what answered **before saying anything**: `getpeereid` must be root (in a dev run,
//!    this user), and the `LOCAL_PEERPID` process must be the installed
//!    `/Library/IndiansAssist/ia-service` (in a dev run, the `ia-service` beside this binary),
//!    with a signature that satisfies this binary's own signer ([`ia_platform::macos::service::admit_daemon`]). Anything else is dropped and retried;
//! 3. says `ready { pid }`, reports its monitor count, and from then on reports its screen lock
//!    (`DesktopSwitch { reason: "screen_locked" | "screen_unlocked" }`, the existing frame) for as
//!    long as the connection lives;
//! 4. waits for a launch blob, and serves that one session with the shared channel code
//!    ([`crate::channel::serve_blob`]) on a worker thread while the main thread hosts the UI
//!    (AppKit windows live on the main thread). When the session ends the process exits, and
//!    launchd starts a fresh worker that connects again.
//!
//! A connection the daemon closes before a blob arrives (a restart, a refused handshake) goes back
//! to step 1. The worker holds no device key and no token.

use std::io::{BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ia_platform::macos::service::{admit_daemon, REASON_LOCKED, REASON_UNLOCKED};
use ia_session0::blob::LaunchBlob;
use ia_session0::proto::{read_frame, write_frame, WorkerFrame};

/// The daemon's socket (§17.3).
pub const SOCKET: &str = "/var/run/indiansassist/worker.sock";
/// The daemon binary's name (a dev daemon runs beside this worker).
const DAEMON_BIN: &str = "ia-service";
/// How often the screen lock is read.
const LOCK_POLL: Duration = Duration::from_secs(1);
/// The longest wait between connection attempts.
const MAX_RETRY: Duration = Duration::from_secs(30);

/// The worker's own switches; everything else goes to the serve loop's `Cli`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub socket: PathBuf,
    /// Dev only: the daemon runs as this user (`ia-service --console`), not root.
    pub dev_daemon: bool,
    pub rest: Vec<String>,
}

/// Split the worker's switches from the serve loop's.
pub fn options(args: &[String]) -> Result<Options, String> {
    let mut o = Options {
        socket: PathBuf::from(SOCKET),
        dev_daemon: false,
        rest: Vec::new(),
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--socket" => {
                o.socket = PathBuf::from(it.next().ok_or("--socket needs a path")?);
            }
            "--dev-daemon" if cfg!(feature = "dev") => o.dev_daemon = true,
            "--dev-daemon" => return Err("--dev-daemon exists only in a dev build".into()),
            _ => o.rest.push(a.clone()),
        }
    }
    Ok(o)
}

/// The uid the daemon must run as: root, or this user for a dev daemon.
fn expected_daemon_uid(o: &Options) -> u32 {
    if o.dev_daemon {
        // SAFETY: getuid has no preconditions.
        unsafe { libc::getuid() }
    } else {
        0
    }
}

/// The installed daemon (§17.3).
pub const DAEMON: &str = "/Library/IndiansAssist/ia-service";

/// The canonical path of the daemon this worker trusts: the installed one, or for a dev daemon the
/// `ia-service` beside this binary.
fn installed_daemon(o: &Options) -> Option<String> {
    let daemon = if o.dev_daemon {
        std::env::current_exe()
            .ok()?
            .canonicalize()
            .ok()?
            .parent()?
            .join(DAEMON_BIN)
    } else {
        PathBuf::from(DAEMON)
    };
    Some(daemon.canonicalize().ok()?.to_string_lossy().into_owned())
}

/// Step 2: is what answered on the socket the installed daemon?
fn check_daemon(s: &UnixStream, expected_uid: u32, installed: &str) -> Result<(), String> {
    let (uid, pid) = ia_platform::macos::os::peer_identity(s)
        .map_err(|e| format!("the peer could not be identified: {e}"))?;
    let image = ia_platform::macos::codesign::same_signer_image(pid)
        .map(|p| p.to_string_lossy().into_owned());
    admit_daemon(uid, expected_uid, image.as_deref(), installed).map_err(|why| {
        format!("the socket's peer is not the daemon ({why:?}, uid {uid}, pid {pid})")
    })
}

/// Step 1 and 2: a checked connection, retried with a backoff until one is made.
fn connect(o: &Options, installed: &str) -> UnixStream {
    let mut wait = Duration::from_secs(1);
    loop {
        match UnixStream::connect(&o.socket) {
            Ok(s) => match check_daemon(&s, expected_daemon_uid(o), installed) {
                Ok(()) => return s,
                Err(e) => tracing::warn!(socket = %o.socket.display(), "{e}"),
            },
            Err(e) => {
                tracing::debug!(socket = %o.socket.display(), error = %e, "the daemon is not reachable yet")
            }
        }
        std::thread::sleep(wait);
        wait = (wait * 2).min(MAX_RETRY);
    }
}

/// The connection's writer, shared by the lock watcher and the session. Each frame is one
/// `write_all` (`write_frame`), and each `write` here holds the lock for the whole buffer, so two
/// writers never interleave inside a frame.
#[derive(Clone)]
pub struct SharedWriter(Arc<Mutex<UnixStream>>);

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut s = self
            .0
            .lock()
            .map_err(|_| std::io::Error::other("writer lock"))?;
        s.write_all(buf)?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn send(w: &SharedWriter, frame: &WorkerFrame) -> bool {
    write_frame(&mut w.clone(), frame).is_ok()
}

/// The `DesktopSwitch` reason for a lock reading.
pub fn lock_reason(locked: bool) -> &'static str {
    if locked {
        REASON_LOCKED
    } else {
        REASON_UNLOCKED
    }
}

/// Report the screen lock on every change until the connection fails or `stop` is set.
fn watch_lock(w: SharedWriter, stop: Arc<AtomicBool>) {
    let mut last: Option<bool> = None;
    let mut n = 0u32;
    while !stop.load(Ordering::SeqCst) {
        let now = sys::screen_locked();
        if last != Some(now) {
            n += 1;
            if !send(
                &w,
                &WorkerFrame::DesktopSwitch {
                    id: format!("lock{n}"),
                    reason: lock_reason(now).to_string(),
                },
            ) {
                return;
            }
            last = Some(now);
        }
        std::thread::sleep(LOCK_POLL);
    }
}

/// Steps 1 to 4: wait, connected, for a session; returns the blob and the connection.
fn wait_for_session(
    o: &Options,
    installed: &str,
) -> (LaunchBlob, BufReader<UnixStream>, SharedWriter) {
    loop {
        let stream = connect(o, installed);
        let (reader, writer) = match stream.try_clone() {
            Ok(r) => (r, SharedWriter(Arc::new(Mutex::new(stream)))),
            Err(e) => {
                tracing::warn!(error = %e, "the connection could not be shared");
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        let ready = send(
            &writer,
            &WorkerFrame::Ready {
                pid: std::process::id(),
            },
        ) && send(
            &writer,
            &WorkerFrame::Monitors {
                count: sys::display_count().max(1),
            },
        );
        if !ready {
            continue;
        }
        tracing::info!(socket = %o.socket.display(), "connected to the daemon; waiting for a session");
        let stop = Arc::new(AtomicBool::new(false));
        {
            let (w, stop) = (writer.clone(), stop.clone());
            let _ = std::thread::Builder::new()
                .name("ia-lock-watch".into())
                .spawn(move || watch_lock(w, stop));
        }
        let mut reader = BufReader::new(reader);
        match read_frame::<_, LaunchBlob>(&mut reader) {
            Ok(blob) => match blob.validate() {
                Ok(()) => return (blob, reader, writer),
                Err(e) => {
                    tracing::error!(error = %e, "the launch blob is not usable");
                    stop.store(true, Ordering::SeqCst);
                }
            },
            Err(e) => {
                tracing::info!(error = %e, "the daemon closed the connection; reconnecting");
                stop.store(true, Ordering::SeqCst);
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// The worker. Never returns: it exits when its session ends.
pub fn main(args: &[String]) -> ! {
    let o = match options(args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let Some(installed) = installed_daemon(&o) else {
        eprintln!("the IndiansAssist daemon is not installed ({DAEMON}); this worker has nothing to serve");
        std::process::exit(2);
    };
    // AppKit windows live on the main thread: the session runs on a worker thread and every
    // window it opens is handed to the host below.
    ia_agent::macos_main_thread_enable();
    let worker = std::thread::Builder::new()
        .name("ia-worker".into())
        .spawn(move || {
            let (blob, reader, writer) = wait_for_session(&o, &installed);
            crate::channel::serve_blob(blob, reader, writer, &o.rest)
        });
    let worker = match worker {
        Ok(w) => w,
        Err(e) => {
            eprintln!("the worker thread could not start: {e}");
            std::process::exit(1);
        }
    };
    ia_agent::macos_main_thread_host(|| worker.is_finished());
    match worker.join() {
        Ok(Ok(())) => std::process::exit(0),
        Ok(Err(e)) => {
            tracing::error!(error = %e, "the worker stopped");
            std::process::exit(1);
        }
        Err(_) => std::process::exit(1),
    }
}

/// The calls that need the OS.
mod sys {
    use std::ffi::c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> *const c_void;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            s: *const std::ffi::c_char,
            enc: u32,
        ) -> *const c_void;
        fn CFBooleanGetValue(b: *const c_void) -> u8;
        fn CFGetTypeID(cf: *const c_void) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFRelease(cf: *const c_void);
    }

    const UTF8: u32 = 0x0800_0100;

    /// Whether this login session's screen is locked (`CGSSessionScreenIsLocked` in the session
    /// dictionary; absent means unlocked).
    pub fn screen_locked() -> bool {
        // SAFETY: both CF objects are +1 (Copy/Create) and released here; the value read from the
        // dictionary is borrowed and only used while the dictionary is alive; its type is checked.
        unsafe {
            let dict = CGSessionCopyCurrentDictionary();
            if dict.is_null() {
                return false;
            }
            let key = CFStringCreateWithCString(
                std::ptr::null(),
                c"CGSSessionScreenIsLocked".as_ptr(),
                UTF8,
            );
            let locked = if key.is_null() {
                false
            } else {
                let v = CFDictionaryGetValue(dict, key);
                let locked = !v.is_null()
                    && CFGetTypeID(v) == CFBooleanGetTypeID()
                    && CFBooleanGetValue(v) != 0;
                CFRelease(key);
                locked
            };
            CFRelease(dict);
            locked
        }
    }

    /// The active displays (`CGGetActiveDisplayList`), at most 16.
    pub fn display_count() -> u32 {
        let mut ids = [0u32; 16];
        let mut count = 0u32;
        // SAFETY: a buffer of 16 ids and its length; `count` receives how many were written.
        let err = unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
        if err == 0 {
            count.min(16)
        } else {
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_workers_own_switches_are_taken_out_and_the_rest_reach_the_serve_loop() {
        let o = options(&a(&[
            "--socket",
            "/tmp/x/worker.sock",
            "--synthetic-capture",
        ]))
        .unwrap();
        assert_eq!(o.socket, PathBuf::from("/tmp/x/worker.sock"));
        assert_eq!(o.rest, a(&["--synthetic-capture"]));
        assert!(!o.dev_daemon);
        assert_eq!(options(&[]).unwrap().socket, PathBuf::from(SOCKET));
        assert!(options(&a(&["--socket"])).is_err());
        let dev = options(&a(&["--dev-daemon"]));
        assert_eq!(dev.is_ok(), cfg!(feature = "dev"));
    }

    #[test]
    fn a_production_worker_trusts_only_a_root_daemon() {
        let o = options(&[]).unwrap();
        assert_eq!(expected_daemon_uid(&o), 0);
    }

    #[test]
    fn the_lock_reasons_are_the_ones_the_daemon_reads() {
        use ia_platform::macos::service::lock_report;
        assert_eq!(lock_report(lock_reason(true)), Some(true));
        assert_eq!(lock_report(lock_reason(false)), Some(false));
        // Read-only queries of this login session; no prompt, no permission.
        let _ = sys::screen_locked();
        assert!(sys::display_count() >= 1);
    }
}
