//! Phase F §17.3 (stream apple): the macOS half of `ia-service`, a LaunchDaemon running as root
//! that holds the device identity (System keychain), the `/signal/device` socket, the policy, the
//! action queue, the waker and the tamper outbox, and serves the LaunchAgent worker `ia-desktop`
//! over `/var/run/indiansassist/worker.sock`. Compiled only on macOS; only the apple stream edits
//! this module.
//!
//! | Module | Owns |
//! |---|---|
//! | [`paths`] | the layout (and the dev `--console` one under a temporary root) |
//! | [`keychain`] | the device keys in the System keychain (a file keychain in a dev run) |
//! | [`facts`] | the machine facts and the service capabilities |
//! | [`runmarker`] | the restart signal (`watchdog_restarted`), from a run marker |
//! | `workersock` | the worker socket: accept, the handshake deadline, the peer checks, the cap |
//! | `runtime` | the loops: the device socket, the heartbeat, the console watch, integrity |
//!
//! The decisions (who the console user is, which worker is admitted, what a switch means) are
//! pure, in `ia_platform::macos::service`. The first four modules build without the
//! `macos-service` feature (and are tested by a plain `cargo test -p ia-service`); the rest need it.

use ia_core::fleet::InteractiveState;
use ia_core::policy::InteractiveStateName;

pub mod facts;
pub mod keychain;
pub mod paths;
pub mod runmarker;

#[cfg(feature = "macos-service")]
pub mod runtime;
#[cfg(feature = "macos-service")]
pub mod workersock;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The state reported before the console has been read (and whenever it cannot be).
pub fn facts_nobody() -> InteractiveState {
    InteractiveState {
        state: InteractiveStateName::None,
        idle_sec: None,
        at: now_ms(),
        display: None,
    }
}
