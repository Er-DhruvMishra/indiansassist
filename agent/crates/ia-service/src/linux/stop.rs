//! SIGTERM and SIGINT for every state of the Linux service (F §8.8; linux-p4 L3).
//!
//! systemd stops the unit with SIGTERM. The tokio signal streams exist only once the runtime
//! runs, so before this module a service that was still **waiting unenrolled** (§8.2f), or still
//! enrolling, died of the default action and systemd saw exit status 143 instead of a clean 0.
//! [`install`] puts a minimal async-signal-safe handler in place at the very start of the
//! service (it only stores into two atomics), the wait loop polls [`requested`] through
//! [`sleep_or_stop`], and the running service checks it once after tokio's own streams are
//! installed, so a signal that arrived in between is not lost.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::{Duration, Instant};

static STOP: AtomicBool = AtomicBool::new(false);
static SIGNAL: AtomicI32 = AtomicI32::new(0);

extern "C" fn on_stop(sig: libc::c_int) {
    // Only atomics: nothing here allocates, locks or logs (async-signal safety).
    SIGNAL.store(sig, Ordering::SeqCst);
    STOP.store(true, Ordering::SeqCst);
}

/// Install the SIGTERM and SIGINT handler. Idempotent.
pub fn install() -> std::io::Result<()> {
    for sig in [libc::SIGTERM, libc::SIGINT] {
        // SAFETY: `sa` is zeroed and then filled with a valid handler, an empty mask and
        // SA_RESTART, as sigaction(2) requires; the handler only touches atomics.
        let rc = unsafe {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = on_stop as extern "C" fn(libc::c_int) as usize;
            libc::sigemptyset(&mut sa.sa_mask);
            sa.sa_flags = libc::SA_RESTART;
            libc::sigaction(sig, &sa, std::ptr::null_mut())
        };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Whether SIGTERM or SIGINT arrived since [`install`].
pub fn requested() -> bool {
    STOP.load(Ordering::SeqCst)
}

/// The signal that asked the service to stop, for the log.
pub fn signal_name() -> &'static str {
    match SIGNAL.load(Ordering::SeqCst) {
        libc::SIGTERM => "SIGTERM",
        libc::SIGINT => "SIGINT",
        _ => "none",
    }
}

/// Sleep up to `total`, waking within `tick` of a stop request. Returns true when stopped.
pub fn sleep_or_stop(total: Duration, tick: Duration) -> bool {
    let end = Instant::now() + total;
    loop {
        if requested() {
            return true;
        }
        let now = Instant::now();
        if now >= end {
            return false;
        }
        std::thread::sleep(tick.min(end - now));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sigterm_is_a_stop_request_not_a_death() {
        install().unwrap();
        install().unwrap();
        assert!(!sleep_or_stop(Duration::from_millis(30), Duration::from_millis(5)) || requested());
        // SAFETY: raise(3) with a signal whose handler is installed just above.
        assert_eq!(unsafe { libc::raise(libc::SIGTERM) }, 0);
        assert!(requested());
        assert_eq!(signal_name(), "SIGTERM");
        let t = Instant::now();
        assert!(sleep_or_stop(
            Duration::from_secs(10),
            Duration::from_millis(10)
        ));
        assert!(t.elapsed() < Duration::from_secs(1));
    }
}
