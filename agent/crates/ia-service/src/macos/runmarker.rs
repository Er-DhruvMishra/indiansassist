//! The macOS restart signal (Phase F §17.3, the twin of Linux's `NRestarts`): launchd keeps no
//! restart count a daemon can read, so the daemon leaves a run marker in its state directory,
//! `run.marker`, holding its pid and the boot session (`kern.bootsessionuuid`).
//!
//! | At start the daemon finds | Meaning | `watchdog_restarted` |
//! |---|---|---|
//! | no marker | a first start, or the last run stopped cleanly | no |
//! | a marker from another boot | the Mac restarted | no |
//! | a marker from this boot whose daemon is still running | another copy (it is not a restart) | no |
//! | a marker from this boot whose daemon is gone | the daemon died and launchd started it again | **yes, once** |
//!
//! Every start then writes its own marker (so one crash is reported once), and a clean stop
//! removes it.

use std::path::Path;

/// The marker's file name in the state directory.
pub const MARKER_FILE: &str = "run.marker";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub pid: i32,
    pub boot: String,
}

impl Marker {
    pub fn to_text(&self) -> String {
        format!("{}\n{}\n", self.pid, self.boot)
    }

    /// `None` for anything that is not exactly a positive pid line and a boot line.
    pub fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        let pid: i32 = lines.next()?.trim().parse().ok()?;
        let boot = lines.next()?.trim().to_string();
        (pid > 1 && !boot.is_empty() && lines.all(|l| l.trim().is_empty()))
            .then_some(Self { pid, boot })
    }
}

/// Whether this start follows a death of the daemon in the same boot (the table above).
/// `running(pid)` says whether `pid` is still this daemon.
pub fn restarted(
    previous: Option<&Marker>,
    boot_now: &str,
    me: i32,
    running: impl Fn(i32) -> bool,
) -> bool {
    match previous {
        None => false,
        Some(m) if boot_now.is_empty() || m.boot != boot_now => false,
        Some(m) if m.pid == me => false,
        Some(m) => !running(m.pid),
    }
}

/// At start: read the previous marker, decide, and write this run's marker. Returns whether a
/// `watchdog_restarted` is due. A marker that cannot be written only means a later crash goes
/// unreported; it never stops the daemon.
pub fn on_start(state: &Path, boot_now: &str, me: i32, running: impl Fn(i32) -> bool) -> bool {
    let path = state.join(MARKER_FILE);
    let previous = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| Marker::parse(&t));
    let due = restarted(previous.as_ref(), boot_now, me, running);
    let mine = Marker {
        pid: me,
        boot: boot_now.to_string(),
    };
    if let Err(e) = std::fs::write(&path, mine.to_text()) {
        tracing::warn!(error = %e, "the run marker could not be written");
    }
    due
}

/// At a clean stop: remove the marker (only our own, never another run's).
pub fn on_clean_stop(state: &Path, me: i32) {
    let path = state.join(MARKER_FILE);
    let ours = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| Marker::parse(&t))
        .is_some_and(|m| m.pid == me);
    if ours {
        let _ = std::fs::remove_file(&path);
    }
}

/// The calls that need the OS.
pub mod sys {
    /// This boot's session UUID (`kern.bootsessionuuid`); empty when it cannot be read (no
    /// restart is then ever reported, rather than a false one).
    pub fn boot_session() -> String {
        let mut buf = [0u8; 64];
        let mut len = buf.len();
        // SAFETY: a NUL-terminated name and a buffer of `len` bytes; `len` receives the size.
        let rc = unsafe {
            libc::sysctlbyname(
                c"kern.bootsessionuuid".as_ptr(),
                buf.as_mut_ptr().cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 {
            return String::new();
        }
        String::from_utf8_lossy(&buf[..len.min(buf.len())])
            .trim_end_matches('\0')
            .trim()
            .to_string()
    }

    /// Whether `pid` is a live process running `image` (so a reused pid is not mistaken for the
    /// daemon).
    pub fn running_as(pid: i32, image: &std::path::Path) -> bool {
        let mut buf = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: a buffer of the documented maximum size and its length.
        let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if n <= 0 {
            return false;
        }
        let path = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
        let want = std::fs::canonicalize(image).unwrap_or_else(|_| image.to_path_buf());
        std::path::Path::new(&path) == want
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pid: i32, boot: &str) -> Marker {
        Marker {
            pid,
            boot: boot.into(),
        }
    }

    #[test]
    fn the_restart_table() {
        let gone = |_| false;
        let alive = |_| true;
        // (previous, boot now, me, running) -> restarted
        let rows: &[(Option<Marker>, &str, bool, bool)] = &[
            (None, "B1", false, false), // first start / after a clean stop
            (Some(m(500, "B0")), "B1", false, false), // a new boot
            (Some(m(500, "B1")), "B1", false, true), // same boot, the daemon died
            (Some(m(500, "B1")), "B1", true, false), // same boot, still running: another copy
            (Some(m(500, "B1")), "", false, false), // the boot cannot be read: never a false one
        ];
        for (prev, boot, is_alive, want) in rows {
            let got = if *is_alive {
                restarted(prev.as_ref(), boot, 900, alive)
            } else {
                restarted(prev.as_ref(), boot, 900, gone)
            };
            assert_eq!(got, *want, "{prev:?} at {boot} (alive {is_alive})");
        }
        // Our own pid in the marker is not a restart.
        assert!(!restarted(Some(&m(900, "B1")), "B1", 900, gone));
    }

    #[test]
    fn markers_parse_strictly() {
        assert_eq!(Marker::parse(&m(77, "ABC").to_text()), Some(m(77, "ABC")));
        for bad in ["", "77", "x\nB", "1\nB", "-5\nB", "77\n", "77\nB\nextra"] {
            assert_eq!(Marker::parse(bad), None, "{bad:?}");
        }
    }

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ia-runmarker-{}-{tag}-{}",
            std::process::id(),
            ia_core::rnd::hex(4)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_crash_is_reported_once_and_a_clean_stop_leaves_nothing() {
        let d = dir("seq");
        let gone = |_| false;
        // First start: nothing to report.
        assert!(!on_start(&d, "B1", 100, gone));
        // It dies; launchd starts it again in the same boot: reported.
        assert!(on_start(&d, "B1", 101, gone));
        // The new run is the one in the marker now; a clean stop removes it.
        on_clean_stop(&d, 101);
        assert!(!d.join(MARKER_FILE).exists());
        // So the next start reports nothing.
        assert!(!on_start(&d, "B1", 102, gone));
        // A stop of another pid never removes this run's marker.
        on_clean_stop(&d, 555);
        assert!(d.join(MARKER_FILE).exists());
        // A reboot: not a restart.
        assert!(!on_start(&d, "B2", 103, gone));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_os_reads_work_here() {
        let boot = sys::boot_session();
        assert_eq!(boot.len(), 36, "{boot}");
        let me = std::env::current_exe().unwrap();
        assert!(sys::running_as(std::process::id() as i32, &me));
        assert!(!sys::running_as(
            std::process::id() as i32,
            std::path::Path::new("/bin/ls")
        ));
    }
}
