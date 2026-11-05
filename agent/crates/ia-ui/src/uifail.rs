//! A Desk UI that cannot run must never take the agent or the worker down with it.
//!
//! The UI thread ([`crate::app::spawn`]) can fail in two ways. eframe can return an error (no
//! display, no GL), which is reported as [`crate::bridge::UiEvent::Failed`] already. Or a library
//! under it can **panic**: on Linux, winit opens `libxkbcommon` and `libxkbcommon-x11` lazily and
//! panics when either is missing. A release build is `panic = "abort"` (contract C §10), so that
//! panic would end the whole process however the thread is joined. Two guards therefore stand in
//! front of eframe:
//!
//! * [`preflight`] checks, before any window code runs, what is known to panic rather than
//!   fail: here, that the xkbcommon libraries winit will open can be opened. A missing one is an
//!   ordinary `Failed` event, which the serve loop turns into a clean end (no indicator, no
//!   sharing, C §3.5).
//! * In unwinding builds (dev and test) the UI entry also runs under `catch_unwind`, so any
//!   other panic in the UI thread becomes the same `Failed` event. Under `abort` that wrapper is
//!   inert, which is why the preflight exists.
//!
//! [`force_failure`] is the test seam: it makes the next UI starts fail on purpose, either as a
//! start error or as a panic inside the guarded entry.

use std::sync::atomic::{AtomicU8, Ordering};

/// How a forced UI start fails (the test seam).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForcedFailure {
    /// The preflight refuses, as when a library is missing.
    StartError,
    /// The guarded UI entry panics, as when a library under eframe panics.
    Panic,
}

static FORCED: AtomicU8 = AtomicU8::new(0);

/// Test seam: every following UI start fails this way (`None` restores normal starts). Dev
/// builds also honour `IA_DEV_UI_FAIL=start|panic` in the environment, for a manual or end to
/// end check against a real worker.
pub fn force_failure(f: Option<ForcedFailure>) {
    let v = match f {
        None => 0,
        Some(ForcedFailure::StartError) => 1,
        Some(ForcedFailure::Panic) => 2,
    };
    FORCED.store(v, Ordering::SeqCst);
}

/// The forced failure in effect, if any.
pub fn forced() -> Option<ForcedFailure> {
    match FORCED.load(Ordering::SeqCst) {
        1 => return Some(ForcedFailure::StartError),
        2 => return Some(ForcedFailure::Panic),
        _ => {}
    }
    #[cfg(feature = "dev")]
    match std::env::var("IA_DEV_UI_FAIL").as_deref() {
        Ok("start") => return Some(ForcedFailure::StartError),
        Ok("panic") => return Some(ForcedFailure::Panic),
        _ => {}
    }
    None
}

/// The libraries winit opens at run time and panics without (xkbcommon-dl's names, in its
/// order: the first of each group that opens is used).
pub const LINUX_UI_LIBRARIES: &[&[&str]] = &[
    &["libxkbcommon.so.0", "libxkbcommon.so"],
    &["libxkbcommon-x11.so.0", "libxkbcommon-x11.so"],
];

/// The library groups none of whose names `loadable` can open, named by their first name.
pub fn missing_libraries(
    groups: &[&[&'static str]],
    loadable: impl Fn(&str) -> bool,
) -> Vec<&'static str> {
    groups
        .iter()
        .filter(|names| !names.iter().any(|n| loadable(n)))
        .filter_map(|names| names.first().copied())
        .collect()
}

/// The reason the Desk UI cannot start, checked before any window code runs; `Ok` to go on.
pub fn preflight() -> Result<(), String> {
    match forced() {
        Some(ForcedFailure::StartError) => {
            return Err("the UI start failed (forced by a test)".into())
        }
        // The seam decides the outcome: the forced panic is reached even on a host that also
        // lacks a library (as WSL does, which has no libxkbcommon-x11).
        Some(ForcedFailure::Panic) => return Ok(()),
        None => {}
    }
    #[cfg(target_os = "linux")]
    {
        let missing = missing_libraries(LINUX_UI_LIBRARIES, linux::loadable);
        if !missing.is_empty() {
            return Err(format!(
                "the UI cannot start: {} could not be loaded",
                missing.join(" and ")
            ));
        }
    }
    Ok(())
}

/// Called first inside the guarded UI entry: the seam's panic.
pub fn panic_point() {
    if forced() == Some(ForcedFailure::Panic) {
        panic!("the UI panicked (forced by a test)");
    }
}

/// The text of a caught panic payload.
pub fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "a panic without a message".to_string()
    }
}

#[cfg(target_os = "linux")]
mod linux {
    /// Whether the dynamic loader can open `name` (opened lazily and closed again at once).
    pub fn loadable(name: &str) -> bool {
        let Ok(c) = std::ffi::CString::new(name) else {
            return false;
        };
        // SAFETY: `c` is a valid NUL-terminated string; a non-null handle is closed exactly once.
        unsafe {
            let h = libc::dlopen(c.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
            if h.is_null() {
                return false;
            }
            libc::dlclose(h);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_group_is_missing_only_when_none_of_its_names_opens() {
        let only = |ok: &'static [&'static str]| move |n: &str| ok.contains(&n);
        assert!(missing_libraries(
            LINUX_UI_LIBRARIES,
            only(&["libxkbcommon.so.0", "libxkbcommon-x11.so"])
        )
        .is_empty());
        assert_eq!(
            missing_libraries(LINUX_UI_LIBRARIES, only(&["libxkbcommon.so.0"])),
            vec!["libxkbcommon-x11.so.0"]
        );
        assert_eq!(
            missing_libraries(LINUX_UI_LIBRARIES, only(&[])),
            vec!["libxkbcommon.so.0", "libxkbcommon-x11.so.0"]
        );
    }

    #[test]
    fn a_panic_payload_reads_as_text() {
        let p = std::panic::catch_unwind(|| panic!("boom")).unwrap_err();
        assert_eq!(panic_text(&*p), "boom");
        let n = 3;
        let p = std::panic::catch_unwind(move || panic!("boom {n}")).unwrap_err();
        assert_eq!(panic_text(&*p), "boom 3");
    }
}
