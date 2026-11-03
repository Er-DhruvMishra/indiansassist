//! Session runtime teardown (Phase F, coordinator item 1: the Tokio shutdown panic).
//!
//! When a P3/P4 session ends and the serve loop returns `Ok(Stopped)`, the multi-thread runtime
//! that `main` built is dropped on the main thread. The video and REMB pumps, the recorder and
//! webrtc-rs's own ICE/DTLS keepalive tasks all hold `tokio::time` primitives. If one of those
//! tasks is still being cancelled (its future still holding a `Sleep`/`Interval`) at the moment
//! the runtime's time driver is torn down, dropping that timer panics with
//! `A Tokio 1.x context was found, but it is being shutdown`
//! (`tokio-1.x/src/runtime/time/entry.rs`). It showed in every `pnpm e2e:p3` agent log.
//!
//! Two defences, together: `serve`'s teardown now aborts **and awaits** the pumps it spawned, so
//! their timer-holding futures are dropped while the runtime is still live; and `main` never lets
//! the runtime drop implicitly — it calls [`shutdown_session_runtime`], which gives the worker
//! threads a bounded window to park (and so to drop any straggler timer while the driver is still
//! alive) before the runtime is released.

use std::time::Duration;

/// How long to let straggler tasks (webrtc keepalives, a late pump cancel) park before the
/// runtime is released. Well above their timer periods, short enough that exit is not delayed.
const SHUTDOWN_BUDGET: Duration = Duration::from_secs(5);

/// Tear a session runtime down without the time-driver panic.
///
/// Prefer this to letting a [`tokio::runtime::Runtime`] drop at the end of a scope: the implicit
/// drop races the time driver against tasks that outlived the session, while `shutdown_timeout`
/// drains them within [`SHUTDOWN_BUDGET`] while the driver is still alive.
pub fn shutdown_session_runtime(rt: tokio::runtime::Runtime) {
    rt.shutdown_timeout(SHUTDOWN_BUDGET);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A task that outlives the session and is still polling a timer must not panic the main
    /// thread when the runtime is torn down. Before the fix, the implicit `drop(rt)` could drop
    /// the task's `Interval` after the time driver was gone; `shutdown_timeout` drains it while
    /// the driver is alive. The test returning (rather than aborting the process) is the
    /// assertion.
    #[test]
    fn session_end_with_a_live_timer_task_does_not_panic() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("build runtime");
        // A pump that never finishes on its own: it holds an interval timer and is never joined,
        // exactly like a lingering webrtc/REMB task at session end.
        rt.spawn(async {
            let mut tick = tokio::time::interval(Duration::from_millis(5));
            loop {
                tick.tick().await;
            }
        });
        // Let the task register with the time driver before the session "ends".
        rt.block_on(async { tokio::time::sleep(Duration::from_millis(25)).await });
        // The session is over. This must return cleanly, not panic the process.
        shutdown_session_runtime(rt);
    }

    /// Aborting a timer task and awaiting it inside the runtime (serve's teardown pattern) also
    /// drops the timer while the driver is alive, so a following shutdown has nothing to race.
    #[test]
    fn aborting_and_joining_a_timer_task_before_shutdown_is_clean() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("build runtime");
        rt.block_on(async {
            let h = tokio::spawn(async {
                let mut tick = tokio::time::interval(Duration::from_millis(5));
                loop {
                    tick.tick().await;
                }
            });
            tokio::time::sleep(Duration::from_millis(25)).await;
            h.abort();
            // Joining the aborted task yields a cancelled `JoinError`, never a panic.
            let joined = h.await;
            assert!(joined.is_err(), "an aborted task joins as cancelled");
        });
        shutdown_session_runtime(rt);
    }
}
