//! The worker socket (Phase F §17.3): `/var/run/indiansassist/worker.sock`, mode 0666, where each
//! GUI session's LaunchAgent worker connects and waits for a session.
//!
//! The socket is reachable by any local process, so the file mode is not the gate; the peer checks
//! are, and no stranger may block or slow the real worker:
//!
//! 1. **At accept, before any frame**, cheapest first: `getpeereid` must give the console user;
//!    the `LOCAL_PEERPID` process's executable must be the installed worker's path (a root-owned
//!    file, so a stranger's program fails here in microseconds); and only then its signature must
//!    satisfy the daemon's own signer (a Security-framework lookup, cached per process for a
//!    moment, warmed up when the socket opens). A connection that fails is closed at once, with no
//!    reply. At most [`MAX_CHECKING`] are checked at a time; one that arrives when they are all
//!    busy is closed.
//! 2. **The `ready` frame:** only a connection that passed (1) waits for `ready { pid }`, within one
//!    overall [`HANDSHAKE_DEADLINE`] (a peer that trickles bytes cannot stretch it), at most
//!    [`READY_MAX`] bytes. At most [`MAX_PENDING`] wait at a time; when they are all taken, the
//!    **oldest is evicted** to make room, so a flood of silent connections can never keep a new one
//!    out. The `ready` pid must be the socket's peer pid.
//! 3. **Admitted:** the connection is handed to the runtime, which holds it for the session; a
//!    pending connection never holds the session slot.
//!
//! Refusals are logged with their reason and never told to the peer.

use std::collections::VecDeque;
use std::io::{self, Read};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ia_platform::macos::service::{admit_worker, AdmissionRefusal, WorkerPeer};
use ia_session0::proto::WorkerFrame;

/// The time a checked connection has to send its `ready` frame.
pub const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(2);
/// At most this many checked connections wait for `ready` at once (the oldest is evicted).
pub const MAX_PENDING: usize = 8;
/// At most this many connections are being checked at once (more are closed on arrival).
pub const MAX_CHECKING: usize = 32;
/// The longest `ready` line accepted.
pub const READY_MAX: usize = 256;

/// What the daemon checks a peer against. The functions are injected so the tests can stand in
/// for the console user and the signer; the daemon passes the real ones.
#[derive(Clone)]
pub struct Admission {
    /// The console user a session may be served to (`console_target`).
    pub console: Arc<dyn Fn() -> Option<u32> + Send + Sync>,
    /// The canonical path of the installed worker.
    pub installed: String,
    /// The peer's image path when its signature checks out (`codesign::same_signer_image`).
    pub image_of: Arc<dyn Fn(i32) -> Option<String> + Send + Sync>,
}

/// A worker that passed every check.
pub struct AdmittedWorker {
    pub uid: u32,
    pub pid: i32,
    pub stream: UnixStream,
}

/// Why a connection was closed (for the log, and the tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closed {
    Busy,
    Identity,
    Refused(AdmissionRefusal),
    Silent,
    Evicted,
    Garbled,
}

type OnAdmitted = Arc<dyn Fn(AdmittedWorker) + Send + Sync>;
type OnClosed = Arc<dyn Fn(Closed) + Send + Sync>;

/// A connection must have waited this long before a newcomer may evict it, so a real worker that
/// has just connected (and sends `ready` at once) is never evicted by a burst arriving behind it.
pub const EVICT_AFTER: Duration = Duration::from_millis(50);

/// The waiting connections, oldest first, so a full set can evict.
struct Pending {
    next: AtomicU64,
    waiting: Mutex<VecDeque<(u64, Instant, UnixStream)>>,
}

impl Pending {
    /// Enter the waiting set: when it is full, evict the oldest connection if it has waited at
    /// least [`EVICT_AFTER`]; otherwise this newcomer is turned away (`None`).
    fn enter(&self, stream: &UnixStream) -> Option<u64> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut w = self.waiting.lock().ok()?;
        if w.len() >= MAX_PENDING {
            let old_enough = w
                .front()
                .is_some_and(|(_, at, _)| at.elapsed() >= EVICT_AFTER);
            if !old_enough {
                return None;
            }
            if let Some((_, _, oldest)) = w.pop_front() {
                // Its thread's read fails at once and it closes as `Evicted`.
                let _ = oldest.shutdown(std::net::Shutdown::Both);
            }
        }
        w.push_back((id, Instant::now(), stream.try_clone().ok()?));
        Some(id)
    }

    /// Whether `id` is still waiting (false: it was evicted).
    fn leave(&self, id: u64) -> bool {
        let Ok(mut w) = self.waiting.lock() else {
            return false;
        };
        match w.iter().position(|(i, _, _)| *i == id) {
            Some(at) => {
                w.remove(at);
                true
            }
            None => false,
        }
    }
}

/// How long a process's image verdict is reused.
const IMAGE_TTL: Duration = Duration::from_secs(2);

/// A process, told apart from a later one that reuses its pid by its start time.
type ProcessKey = (i32, i64, i64);

/// The signature verdicts of recent peers, reused for [`IMAGE_TTL`], so a burst of connections
/// from one process does not repeat its Security-framework lookup.
#[derive(Default)]
struct ImageCache {
    seen: Mutex<std::collections::HashMap<ProcessKey, (Instant, Option<String>)>>,
}

impl ImageCache {
    fn image(
        &self,
        pid: i32,
        lookup: &(dyn Fn(i32) -> Option<String> + Send + Sync),
    ) -> Option<String> {
        let key = process_key(pid)?;
        {
            let mut seen = self.seen.lock().ok()?;
            seen.retain(|_, (at, _)| at.elapsed() < IMAGE_TTL);
            if let Some((_, image)) = seen.get(&key) {
                return image.clone();
            }
        }
        // The lookup runs without the lock, so different processes are checked in parallel.
        let image = lookup(pid);
        // The process must still be the one the key names: a pid reused during the lookup is
        // another process, and its answer is not kept.
        if process_key(pid) != Some(key) {
            return None;
        }
        if let Ok(mut seen) = self.seen.lock() {
            seen.insert(key, (Instant::now(), image.clone()));
        }
        image
    }
}

/// `(pid, start seconds, start microseconds)` from `proc_pidinfo(PROC_PIDTBSDINFO)`.
fn process_key(pid: i32) -> Option<ProcessKey> {
    // SAFETY: a zeroed proc_bsdinfo of the size passed; the call writes at most that many bytes.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let n = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        );
        (n == size).then_some((
            pid,
            info.pbi_start_tvsec as i64,
            info.pbi_start_tvusec as i64,
        ))
    }
}

/// Bind the socket at `path` (replacing a stale socket file, never anything else), mode 0666, and
/// serve it on a thread until the listener fails.
pub fn listen(
    path: &Path,
    admission: Admission,
    on_admitted: OnAdmitted,
    on_closed: OnClosed,
) -> io::Result<std::thread::JoinHandle<()>> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_socket() => std::fs::remove_file(path)?,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} exists and is not a socket", path.display()),
            ))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    // The first Security-framework lookup in a process costs a few hundred milliseconds; pay it
    // now, not while connections are arriving (it would hold every handshake behind it).
    let _ = (admission.image_of)(std::process::id() as i32);
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    let pending = Arc::new(Pending {
        next: AtomicU64::new(1),
        waiting: Mutex::new(VecDeque::new()),
    });
    let checking = Arc::new(AtomicUsize::new(0));
    let cache = Arc::new(ImageCache::default());
    let path: PathBuf = path.to_path_buf();
    std::thread::Builder::new()
        .name("ia-worker-socket".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let stream = match conn {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!(error = %e, "the worker socket accept failed");
                        continue;
                    }
                };
                if checking.fetch_add(1, Ordering::SeqCst) >= MAX_CHECKING {
                    checking.fetch_sub(1, Ordering::SeqCst);
                    drop(stream);
                    on_closed(Closed::Busy);
                    continue;
                }
                let (admission, pending, in_thread, cache) = (
                    admission.clone(),
                    pending.clone(),
                    checking.clone(),
                    cache.clone(),
                );
                let (on_admitted, on_closed) = (on_admitted.clone(), on_closed.clone());
                let spawned = std::thread::Builder::new()
                    .name("ia-worker-handshake".into())
                    .spawn(move || {
                        let outcome = handshake(stream, &admission, &pending, &in_thread, &cache);
                        match outcome {
                            Ok(w) => on_admitted(w),
                            Err(why) => {
                                tracing::info!(?why, "a worker socket connection was closed");
                                on_closed(why);
                            }
                        }
                    });
                if spawned.is_err() {
                    checking.fetch_sub(1, Ordering::SeqCst);
                }
            }
            tracing::warn!(socket = %path.display(), "the worker socket listener ended");
        })
}

/// Releases the checking slot when the identity phase ends, whatever the outcome.
struct CheckingSlot<'a>(&'a AtomicUsize, bool);

impl CheckingSlot<'_> {
    fn release(&mut self) {
        if !self.1 {
            self.0.fetch_sub(1, Ordering::SeqCst);
            self.1 = true;
        }
    }
}

impl Drop for CheckingSlot<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

fn handshake(
    stream: UnixStream,
    admission: &Admission,
    pending: &Pending,
    checking: &AtomicUsize,
    cache: &ImageCache,
) -> Result<AdmittedWorker, Closed> {
    let mut slot = CheckingSlot(checking, false);
    // 1. Who is it, before reading a byte: the uid first (free), the path, then the signature.
    let (uid, pid) = ia_platform::macos::os::peer_identity_fd(stream.as_raw_fd())
        .map_err(|_| Closed::Identity)?;
    let console = (admission.console)();
    if console != Some(uid) {
        return Err(Closed::Refused(if console.is_none() {
            AdmissionRefusal::NoConsoleUser
        } else {
            AdmissionRefusal::NotConsoleUser
        }));
    }
    // The path next (microseconds): only a process running the installed worker's executable, a
    // root-owned path, goes on to the signature lookup, so other programs cost nothing there.
    let path = ia_platform::macos::os::process_image(pid).map(|p| p.to_string_lossy().into_owned());
    if path.as_deref() != Some(admission.installed.as_str()) {
        return Err(Closed::Refused(AdmissionRefusal::WrongImage));
    }
    let image = cache.image(pid, &*admission.image_of);
    // The ready pid is not known yet; check everything else with the peer pid in its place.
    let early = WorkerPeer {
        uid,
        pid,
        ready_pid: pid.max(0) as u32,
        image: image.as_deref(),
    };
    admit_worker(&early, console, &admission.installed).map_err(Closed::Refused)?;
    slot.release();

    // 2. The ready frame, within one overall deadline.
    let Some(id) = pending.enter(&stream) else {
        let _ = stream.shutdown(std::net::Shutdown::Both);
        return Err(Closed::Busy);
    };
    let ready = read_ready(&stream, HANDSHAKE_DEADLINE);
    let still = pending.leave(id);
    let ready_pid = match ready {
        _ if !still => return Err(Closed::Evicted),
        Ok(p) => p,
        Err(why) => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return Err(why);
        }
    };
    let peer = WorkerPeer {
        uid,
        pid,
        ready_pid,
        image: image.as_deref(),
    };
    if let Err(why) = admit_worker(&peer, (admission.console)(), &admission.installed) {
        let _ = stream.shutdown(std::net::Shutdown::Both);
        return Err(Closed::Refused(why));
    }
    let _ = stream.set_read_timeout(None);
    Ok(AdmittedWorker { uid, pid, stream })
}

/// Read one `ready { pid }` line before `deadline` passes, at most [`READY_MAX`] bytes.
fn read_ready(stream: &UnixStream, deadline: Duration) -> Result<u32, Closed> {
    let until = Instant::now() + deadline;
    let mut line = Vec::with_capacity(64);
    let mut s = stream;
    loop {
        let left = until
            .checked_duration_since(Instant::now())
            .ok_or(Closed::Silent)?;
        if left.is_zero() {
            return Err(Closed::Silent);
        }
        s.set_read_timeout(Some(left))
            .map_err(|_| Closed::Garbled)?;
        let mut byte = [0u8; 1];
        match s.read(&mut byte) {
            Ok(0) => return Err(Closed::Garbled),
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => {
                line.push(byte[0]);
                if line.len() > READY_MAX {
                    return Err(Closed::Garbled);
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Err(Closed::Silent)
            }
            Err(_) => return Err(Closed::Garbled),
        }
    }
    match serde_json::from_slice::<WorkerFrame>(&line) {
        Ok(WorkerFrame::Ready { pid }) => Ok(pid),
        _ => Err(Closed::Garbled),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::sync::mpsc;

    fn me_uid() -> u32 {
        // SAFETY: getuid has no preconditions.
        unsafe { libc::getuid() }
    }

    fn own_image() -> String {
        std::env::current_exe()
            .unwrap()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    struct Harness {
        path: PathBuf,
        admitted: mpsc::Receiver<AdmittedWorker>,
        closed: mpsc::Receiver<Closed>,
        _dir: PathBuf,
    }

    /// A socket whose "installed worker" is this test binary (validly signed, ad hoc) and whose
    /// console user is `console`, unless `image_of` says otherwise.
    fn harness(
        tag: &str,
        console: Option<u32>,
        image_of: Arc<dyn Fn(i32) -> Option<String> + Send + Sync>,
    ) -> Harness {
        // A socket path must fit in 104 bytes, which the per-user temporary directory does not leave
        // room for: a short directory under /tmp, removed by the test.
        let dir = PathBuf::from(format!("/tmp/iaws-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("worker.sock");
        let (atx, arx) = mpsc::channel();
        let (ctx, crx) = mpsc::channel();
        let atx = Mutex::new(atx);
        let ctx = Mutex::new(ctx);
        listen(
            &path,
            Admission {
                console: Arc::new(move || console),
                installed: own_image(),
                image_of,
            },
            Arc::new(move |w| {
                let _ = atx.lock().unwrap().send(w);
            }),
            Arc::new(move |c| {
                let _ = ctx.lock().unwrap().send(c);
            }),
        )
        .unwrap();
        Harness {
            path,
            admitted: arx,
            closed: crx,
            _dir: dir,
        }
    }

    fn signed_image() -> Arc<dyn Fn(i32) -> Option<String> + Send + Sync> {
        Arc::new(|pid| {
            ia_platform::macos::codesign::same_signer_image(pid)
                .map(|p| p.to_string_lossy().into_owned())
        })
    }

    /// The real worker: connect and send `ready` with our own pid at once.
    fn real_worker(path: &Path) -> UnixStream {
        let mut s = UnixStream::connect(path).unwrap();
        let line = format!(
            "{}\n",
            serde_json::to_string(&WorkerFrame::Ready {
                pid: std::process::id()
            })
            .unwrap()
        );
        // A refused peer may already be closed; the test checks what the daemon did instead.
        let _ = s.write_all(line.as_bytes());
        s
    }

    /// Admit one real worker first, as a running daemon has already checked its worker: its
    /// signature verdict is then cached, so a timing test measures the gate, not the system's own
    /// code-signing work (spawning a crowd of processes makes macOS verify each of them, and a
    /// fresh lookup waits behind that).
    fn warm(h: &Harness) {
        let s = real_worker(&h.path);
        h.admitted
            .recv_timeout(Duration::from_secs(10))
            .expect("the warm-up worker is admitted");
        drop(s);
    }

    fn closed_without_a_word(s: &UnixStream) -> bool {
        // On a socket the daemon already shut down, macOS refuses the option (EINVAL): closed.
        if s.set_read_timeout(Some(Duration::from_secs(4))).is_err() {
            return true;
        }
        let mut r = BufReader::new(s);
        let mut line = String::new();
        matches!(r.read_line(&mut line), Ok(0)) || line.is_empty()
    }

    #[test]
    fn the_socket_is_0666_and_a_stale_socket_file_is_replaced_but_nothing_else() {
        let h = harness("mode", Some(me_uid()), signed_image());
        let mode = std::fs::metadata(&h.path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o666);
        // A second bind over the live socket file replaces it (a restarted daemon).
        let h2 = harness("mode2", Some(me_uid()), signed_image());
        assert!(h2.path.exists());
        let plain = h2._dir.join("plain");
        std::fs::write(&plain, b"x").unwrap();
        let err = listen(
            &plain,
            Admission {
                console: Arc::new(|| None),
                installed: String::new(),
                image_of: Arc::new(|_| None),
            },
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );
        assert!(err.is_err(), "a file that is not a socket is never removed");
        assert_eq!(std::fs::read(&plain).unwrap(), b"x");
    }

    #[test]
    fn the_real_worker_is_admitted() {
        let h = harness("ok", Some(me_uid()), signed_image());
        let _s = real_worker(&h.path);
        let w = h
            .admitted
            .recv_timeout(Duration::from_secs(3))
            .expect("admitted");
        assert_eq!(w.uid, me_uid());
        assert_eq!(w.pid, std::process::id() as i32);
    }

    #[test]
    fn a_peer_that_is_not_the_console_user_is_closed_at_once_and_the_real_worker_still_gets_in() {
        // The console belongs to someone else: this process is a "wrong uid" peer.
        let h = harness("uid", Some(me_uid() + 1), signed_image());
        let s = real_worker(&h.path);
        assert_eq!(
            h.closed.recv_timeout(Duration::from_secs(3)).unwrap(),
            Closed::Refused(AdmissionRefusal::NotConsoleUser)
        );
        assert!(closed_without_a_word(&s));
        assert!(h.admitted.try_recv().is_err());
        // The console user's worker on a socket that serves it.
        let ok = harness("uid-ok", Some(me_uid()), signed_image());
        let _s = real_worker(&ok.path);
        assert!(ok.admitted.recv_timeout(Duration::from_secs(3)).is_ok());
    }

    #[test]
    fn a_binary_whose_signature_does_not_satisfy_the_signer_is_refused_even_at_the_right_path() {
        // As a Developer ID daemon sees an ad hoc or unsigned build of the worker at the installed
        // path: the team requirement fails, so no image is vouched for.
        let team_check: Arc<dyn Fn(i32) -> Option<String> + Send + Sync> = Arc::new(|pid| {
            ia_platform::macos::codesign::image_if_satisfies(
                pid,
                Some("anchor apple generic and certificate leaf[subject.OU] = \"ABCDE12345\""),
            )
            .map(|p| p.to_string_lossy().into_owned())
        });
        let h = harness("unsigned", Some(me_uid()), team_check);
        let s = real_worker(&h.path);
        assert_eq!(
            h.closed.recv_timeout(Duration::from_secs(3)).unwrap(),
            Closed::Refused(AdmissionRefusal::UnknownImage)
        );
        assert!(closed_without_a_word(&s));
    }

    #[test]
    fn another_binary_forging_a_ready_frame_is_refused() {
        // /usr/bin/nc is validly (Apple) signed but is not the installed worker.
        let h = harness("stranger", Some(me_uid()), signed_image());
        let mut nc = std::process::Command::new("/usr/bin/nc")
            .args(["-U", &h.path.to_string_lossy()])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let forged = format!(
            "{}\n",
            serde_json::to_string(&WorkerFrame::Ready { pid: nc.id() }).unwrap()
        );
        nc.stdin
            .as_mut()
            .unwrap()
            .write_all(forged.as_bytes())
            .unwrap();
        assert_eq!(
            h.closed.recv_timeout(Duration::from_secs(3)).unwrap(),
            Closed::Refused(AdmissionRefusal::WrongImage)
        );
        let _ = nc.kill();
        let _ = nc.wait();
        let _s = real_worker(&h.path);
        assert!(h.admitted.recv_timeout(Duration::from_secs(3)).is_ok());
    }

    #[test]
    fn a_silent_peer_is_closed_after_the_deadline_without_holding_up_the_real_worker() {
        let h = harness("silent", Some(me_uid()), signed_image());
        warm(&h);
        let silent = UnixStream::connect(&h.path).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        let _s = real_worker(&h.path);
        assert!(h.admitted.recv_timeout(Duration::from_secs(1)).is_ok());
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "not slowed by the silent one"
        );
        assert_eq!(
            h.closed.recv_timeout(Duration::from_secs(4)).unwrap(),
            Closed::Silent
        );
        assert!(closed_without_a_word(&silent));
    }

    #[test]
    fn a_trickling_peer_cannot_stretch_the_deadline() {
        let h = harness("trickle", Some(me_uid()), signed_image());
        let mut s = UnixStream::connect(&h.path).unwrap();
        let started = Instant::now();
        // One byte every 300 ms would take ten seconds for a short line.
        for _ in 0..30 {
            if s.write_all(b" ").is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
            if started.elapsed() > Duration::from_secs(4) {
                break;
            }
        }
        assert_eq!(
            h.closed.recv_timeout(Duration::from_secs(1)).unwrap(),
            Closed::Silent
        );
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn many_connections_at_once_never_keep_the_real_worker_out() {
        let h = harness("flood", Some(me_uid()), signed_image());
        warm(&h);
        let flood: Vec<UnixStream> = (0..40)
            .filter_map(|_| UnixStream::connect(&h.path).ok())
            .collect();
        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        let _s = real_worker(&h.path);
        let w = h
            .admitted
            .recv_timeout(Duration::from_secs(2))
            .expect("the real worker is admitted");
        assert_eq!(w.pid, std::process::id() as i32);
        assert!(started.elapsed() < Duration::from_secs(1));
        // The flood is closed: evicted, refused as busy, or silent, never admitted.
        let mut seen = 0;
        while let Ok(c) = h.closed.recv_timeout(Duration::from_secs(4)) {
            assert!(
                matches!(c, Closed::Evicted | Closed::Busy | Closed::Silent),
                "{c:?}"
            );
            seen += 1;
            if seen >= flood.len() {
                break;
            }
        }
        assert!(
            seen >= flood.len() - MAX_PENDING,
            "the flood was turned away ({seen})"
        );
        assert!(h.admitted.try_recv().is_err(), "only the real worker");
    }

    #[test]
    fn a_crowd_of_other_programs_is_refused_before_it_can_wait_and_the_real_worker_gets_straight_in(
    ) {
        let h = harness("crowd", Some(me_uid()), signed_image());
        warm(&h);
        // Twelve separate processes (another signed program) connect and say nothing.
        let mut crowd: Vec<std::process::Child> = (0..12)
            .map(|_| {
                std::process::Command::new("/usr/bin/nc")
                    .args(["-U", &h.path.to_string_lossy()])
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        std::thread::sleep(Duration::from_millis(150));
        let started = Instant::now();
        let _s = real_worker(&h.path);
        assert!(h.admitted.recv_timeout(Duration::from_secs(1)).is_ok());
        assert!(started.elapsed() < Duration::from_millis(500));
        let mut refused = 0;
        while let Ok(c) = h.closed.recv_timeout(Duration::from_millis(500)) {
            assert_eq!(c, Closed::Refused(AdmissionRefusal::WrongImage));
            refused += 1;
        }
        assert_eq!(
            refused,
            crowd.len(),
            "every stranger refused at once, none left waiting"
        );
        for c in &mut crowd {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    #[test]
    fn a_ready_naming_another_pid_or_garbage_is_refused() {
        let h = harness("pid", Some(me_uid()), signed_image());
        let mut s = UnixStream::connect(&h.path).unwrap();
        let wrong = format!(
            "{}\n",
            serde_json::to_string(&WorkerFrame::Ready { pid: 1 }).unwrap()
        );
        s.write_all(wrong.as_bytes()).unwrap();
        assert_eq!(
            h.closed.recv_timeout(Duration::from_secs(3)).unwrap(),
            Closed::Refused(AdmissionRefusal::ReadyPidMismatch)
        );
        let mut g = UnixStream::connect(&h.path).unwrap();
        g.write_all(b"{\"t\":\"alive\"}\n").unwrap();
        assert_eq!(
            h.closed.recv_timeout(Duration::from_secs(3)).unwrap(),
            Closed::Garbled
        );
        let mut big = UnixStream::connect(&h.path).unwrap();
        let _ = big.write_all(&vec![b'a'; READY_MAX + 10]);
        assert_eq!(
            h.closed.recv_timeout(Duration::from_secs(3)).unwrap(),
            Closed::Garbled
        );
    }
}
