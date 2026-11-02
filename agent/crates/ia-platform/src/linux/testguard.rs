//! The X11 test guard (Phase E §7.10 "Guard", binding): an X11 test refuses to run unless
//! `IA_TEST_X11_DISPLAY` is set, is not the session's display (WSLg exposes the user's real
//! desktop as `:0`), and names an X server the harness started. `agent/scripts/xvfb-test.sh`
//! starts `Xvfb`, exports its display as `IA_TEST_X11_DISPLAY`, its pid as
//! `IA_TEST_X11_XVFB_PID` and the session's original `DISPLAY` as `IA_TEST_SESSION_DISPLAY`.
//!
//! The decision is pure ([`check`]); [`x11_test_display`] reads the environment, the X lock file
//! (`/tmp/.X<n>-lock`, which the X server writes with its pid) and `/proc/<pid>/comm`.

/// What the guard reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GuardInput {
    /// `IA_TEST_X11_DISPLAY`.
    pub test_display: Option<String>,
    /// `IA_TEST_SESSION_DISPLAY`: the `DISPLAY` the session had before the harness ran.
    pub session_display: Option<String>,
    /// `IA_TEST_X11_XVFB_PID`: the pid of the X server the harness started.
    pub harness_pid: Option<u32>,
    /// The pid in `/tmp/.X<n>-lock` for the test display.
    pub lock_pid: Option<u32>,
    /// `/proc/<harness_pid>/comm`.
    pub server_comm: Option<String>,
}

/// `:<n>` or `:<n>.<screen>` → `n`. Anything else (a host name, a TCP display) is refused.
pub fn local_display_number(display: &str) -> Option<u32> {
    let rest = display.strip_prefix(':')?;
    let n = rest.split('.').next()?;
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

/// The guard decision: `Ok(display)` to run against, or `Err(reason)`.
pub fn check(input: &GuardInput) -> Result<String, String> {
    let display = input
        .test_display
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .ok_or(
            "IA_TEST_X11_DISPLAY is not set: run the X11 tests through agent/scripts/xvfb-test.sh",
        )?;
    let n = local_display_number(display)
        .ok_or_else(|| format!("{display} is not a local display (:<n>)"))?;
    // :0 is the WSLg desktop (the user's real one) on the build host: never a test display.
    if n == 0 {
        return Err("display :0 is the session's real desktop; refusing".into());
    }
    if let Some(session) = input.session_display.as_deref() {
        if local_display_number(session) == Some(n) {
            return Err(format!("{display} is the session's display; refusing"));
        }
    }
    let pid = input
        .harness_pid
        .ok_or("IA_TEST_X11_XVFB_PID is not set: the harness did not start this X server")?;
    if input.lock_pid != Some(pid) {
        return Err(format!(
            "{display} is not served by the harness's X server (lock pid {:?}, harness pid {pid})",
            input.lock_pid
        ));
    }
    match input.server_comm.as_deref().map(str::trim) {
        Some("Xvfb") => Ok(display.to_string()),
        other => Err(format!("pid {pid} is not Xvfb ({other:?})")),
    }
}

/// Read the environment and the files the guard checks; `Err` explains why the test must not run.
pub fn x11_test_display() -> Result<String, String> {
    let test_display = std::env::var("IA_TEST_X11_DISPLAY").ok();
    let harness_pid = std::env::var("IA_TEST_X11_XVFB_PID")
        .ok()
        .and_then(|p| p.trim().parse().ok());
    let lock_pid = test_display
        .as_deref()
        .and_then(local_display_number)
        .and_then(|n| std::fs::read_to_string(format!("/tmp/.X{n}-lock")).ok())
        .and_then(|s| s.trim().parse().ok());
    let server_comm =
        harness_pid.and_then(|p: u32| std::fs::read_to_string(format!("/proc/{p}/comm")).ok());
    check(&GuardInput {
        test_display,
        session_display: std::env::var("IA_TEST_SESSION_DISPLAY").ok(),
        harness_pid,
        lock_pid,
        server_comm,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_input() -> GuardInput {
        GuardInput {
            test_display: Some(":99".into()),
            session_display: Some(":0".into()),
            harness_pid: Some(4242),
            lock_pid: Some(4242),
            server_comm: Some("Xvfb\n".into()),
        }
    }

    #[test]
    fn a_harness_started_xvfb_display_passes() {
        assert_eq!(check(&ok_input()), Ok(":99".to_string()));
    }

    #[test]
    fn every_other_case_is_refused() {
        let cases = [
            GuardInput {
                test_display: None,
                ..ok_input()
            },
            GuardInput {
                test_display: Some(":0".into()),
                ..ok_input()
            },
            GuardInput {
                test_display: Some(":0.0".into()),
                ..ok_input()
            },
            GuardInput {
                test_display: Some(":7".into()),
                session_display: Some(":7.0".into()),
                ..ok_input()
            },
            GuardInput {
                test_display: Some("localhost:10".into()),
                ..ok_input()
            },
            GuardInput {
                harness_pid: None,
                ..ok_input()
            },
            GuardInput {
                lock_pid: Some(1),
                ..ok_input()
            },
            GuardInput {
                server_comm: Some("Xorg".into()),
                ..ok_input()
            },
        ];
        for c in cases {
            assert!(check(&c).is_err(), "{c:?} must be refused");
        }
    }

    #[test]
    fn display_numbers() {
        assert_eq!(local_display_number(":99"), Some(99));
        assert_eq!(local_display_number(":1.0"), Some(1));
        assert_eq!(local_display_number("host:1"), None);
        assert_eq!(local_display_number(":"), None);
    }
}
