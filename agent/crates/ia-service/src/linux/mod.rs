//! The Linux half of `ia-service` (contract F §8): a systemd system service running as root that
//! holds the device identity, the `/signal/device` socket, the policy, the action queue, the
//! waker and the tamper outbox (D §3, §4.1, §6, §8.2, §9, §10), never connects to an X server, and
//! launches the `ia-desktop` worker into the active user's session for each session (§8.4, §8.5).
//!
//! | Module | Owns |
//! |---|---|
//! | [`paths`] | the §8.3a layout (and the dev `--console` one under a temporary root) |
//! | [`sealer`] | the §8.3b `FileModeSealer` and the 0600-root key files |
//! | [`facts`] | §8.3d machine facts and the §8.7 service capabilities |
//! | `logind` | logind over the system bus through zbus (§8.4a), and the signal watch |
//! | `sdnotify` | `READY=1` / `WATCHDOG=1` (§8.8), and systemd's unit API (`NRestarts`) |
//! | `spawn` | the §8.5 worker launch over the socketpair, and the worker's channel |
//! | `runtime` | the loops: the device socket, the heartbeat, logind, integrity, the watchdog |
//!
//! The first three are pure enough to compile without the `linux-service` feature (and are
//! tested by a plain `cargo test -p ia-service` on Linux); the rest need it.

pub mod facts;
pub mod paths;
pub mod sealer;
/// SIGTERM / SIGINT in every state of the service, the unenrolled wait included (§8.8).
pub mod stop;

#[cfg(feature = "linux-service")]
pub mod logind;
#[cfg(feature = "linux-service")]
pub mod runtime;
#[cfg(feature = "linux-service")]
pub mod sdnotify;
#[cfg(feature = "linux-service")]
pub mod spawn;
