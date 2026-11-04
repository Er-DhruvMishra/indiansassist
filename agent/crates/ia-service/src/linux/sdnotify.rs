//! systemd integration (F §8.8): `READY=1` once the enrollment state is loaded, `WATCHDOG=1`
//! every 20 s from the main loop (a minimal `$NOTIFY_SOCKET` datagram, no libsystemd), and the
//! unit API over the system bus for `query_state`, `start` and `NRestarts`.
//!
//! `NRestarts` read at start and compared with the value the last run stored is the
//! `watchdog_restarted` tamper input; a service that was stopped or disabled cannot observe that
//! itself, and the server infers it from heartbeat loss, as today.

use std::path::Path;
use std::time::Duration;

use ia_platform::linux::service::{sys, SystemdUnits, NOTIFY_WATCHDOG, WATCHDOG_INTERVAL_SEC};
use ia_platform::ServiceError;
use zbus::zvariant::OwnedObjectPath;

#[zbus::proxy(
    interface = "org.freedesktop.systemd1.Manager",
    default_service = "org.freedesktop.systemd1",
    default_path = "/org/freedesktop/systemd1",
    gen_blocking = false
)]
trait Manager {
    fn get_unit(&self, name: &str) -> zbus::Result<OwnedObjectPath>;
    fn start_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
}

#[zbus::proxy(
    interface = "org.freedesktop.systemd1.Unit",
    default_service = "org.freedesktop.systemd1",
    gen_blocking = false
)]
trait Unit {
    #[zbus(property)]
    fn active_state(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn unit_file_state(&self) -> zbus::Result<String>;
}

#[zbus::proxy(
    interface = "org.freedesktop.systemd1.Service",
    default_service = "org.freedesktop.systemd1",
    gen_blocking = false
)]
trait Service {
    #[zbus(property, name = "NRestarts")]
    fn n_restarts(&self) -> zbus::Result<u32>;
}

/// The systemd unit API over a bus. The calls are rare (start-up, a watchdog query), so each one
/// runs on its own short-lived thread and runtime: the trait is synchronous and may be called from
/// inside the service's tokio runtime, where blocking on a future is not allowed.
#[derive(Debug, Clone, Default)]
pub struct SystemdBus {
    /// `None` = the system bus; a dev run never asks (it has no systemd).
    pub address: Option<String>,
}

impl SystemdBus {
    fn call<T, F, Fut>(&self, f: F) -> Result<T, ServiceError>
    where
        T: Send + 'static,
        F: FnOnce(zbus::Connection) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = zbus::Result<T>>,
    {
        let address = self.address.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| ServiceError::Os(e.to_string()))?;
            rt.block_on(async move {
                let conn = super::logind::connect(address.as_deref())
                    .await
                    .map_err(|e| ServiceError::Os(e.to_string()))?;
                f(conn).await.map_err(|e| match e {
                    zbus::Error::MethodError(name, _, _)
                        if name.as_str().ends_with("NoSuchUnit") =>
                    {
                        ServiceError::NotFound(name.to_string())
                    }
                    zbus::Error::MethodError(name, _, _)
                        if name.as_str().ends_with("AccessDenied") =>
                    {
                        ServiceError::AccessDenied
                    }
                    other => ServiceError::Os(other.to_string()),
                })
            })
        })
        .join()
        .map_err(|_| ServiceError::Os("the systemd query thread panicked".into()))?
    }

    async fn unit_path(conn: &zbus::Connection, unit: &str) -> zbus::Result<OwnedObjectPath> {
        ManagerProxy::new(conn).await?.get_unit(unit).await
    }
}

impl SystemdUnits for SystemdBus {
    fn unit_state(&self, unit: &str) -> Result<(String, String), ServiceError> {
        let unit = unit.to_string();
        self.call(move |conn| async move {
            let path = Self::unit_path(&conn, &unit).await?;
            let u = UnitProxy::builder(&conn)
                .path(path)?
                .cache_properties(zbus::proxy::CacheProperties::No)
                .build()
                .await?;
            Ok((u.active_state().await?, u.unit_file_state().await?))
        })
    }

    fn start_unit(&self, unit: &str) -> Result<(), ServiceError> {
        let unit = unit.to_string();
        self.call(move |conn| async move {
            ManagerProxy::new(&conn)
                .await?
                .start_unit(&unit, "replace")
                .await
                .map(|_| ())
        })
    }

    fn n_restarts(&self, unit: &str) -> Result<u32, ServiceError> {
        let unit = unit.to_string();
        self.call(move |conn| async move {
            let path = Self::unit_path(&conn, &unit).await?;
            ServiceProxy::builder(&conn)
                .path(path)?
                .cache_properties(zbus::proxy::CacheProperties::No)
                .build()
                .await?
                .n_restarts()
                .await
        })
    }
}

/// Whether systemd restarted the unit since the last run looked (§8.8 `watchdog_restarted`).
/// The first run (nothing stored) records a baseline and reports nothing.
pub fn restarted_since(previous: Option<u32>, now: u32) -> bool {
    previous.is_some_and(|p| now > p)
}

/// Read the stored `NRestarts`, store `now`, and say whether it grew.
pub fn note_restarts(file: &Path, now: u32) -> bool {
    let previous = std::fs::read_to_string(file)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    let _ = std::fs::write(file, now.to_string());
    restarted_since(previous, now)
}

/// `WATCHDOG=1` every 20 s until `stop` (§8.8). Silent without `$NOTIFY_SOCKET`.
pub async fn watchdog_loop(mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        if let Err(e) = sys::sd_notify(NOTIFY_WATCHDOG) {
            tracing::warn!(error = %e, "the watchdog ping could not be sent");
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(WATCHDOG_INTERVAL_SEC)) => {}
            _ = stop.changed() => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_restart_is_reported_only_when_the_count_grew() {
        assert!(!restarted_since(None, 3), "the first look is a baseline");
        assert!(!restarted_since(Some(3), 3));
        assert!(restarted_since(Some(3), 4));
        // A reboot resets NRestarts; that is not a restart by the watchdog.
        assert!(!restarted_since(Some(5), 0));
    }

    #[test]
    fn the_count_is_stored_between_runs() {
        let f = std::env::temp_dir().join(format!(
            "ia-nrestarts-{}-{}",
            std::process::id(),
            ia_core::rnd::hex(4)
        ));
        assert!(!note_restarts(&f, 2));
        assert!(!note_restarts(&f, 2));
        assert!(note_restarts(&f, 3));
        let _ = std::fs::remove_file(&f);
    }
}
