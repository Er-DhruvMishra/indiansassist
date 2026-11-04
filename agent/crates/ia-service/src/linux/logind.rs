//! logind over the system bus (F §8.4a), through zbus.
//!
//! `seat0` → `ActiveSession`; that session's `Id`, `User`, `Class`, `Type`, `Active`, `Remote`,
//! `Display`, `LockedHint`, `IdleHint`, `IdleSinceHint`. The decision itself (target or not,
//! `active` / `locked` / `none`) is the pure `ia_platform::linux::service::logind_facts` table;
//! this module only reads the properties.
//!
//! Re-evaluation (§8.4a): any signal `org.freedesktop.login1` emits — `PropertiesChanged` on the
//! seat or a session, `SessionNew`, `SessionRemoved` — wakes [`Watch::changed`]; a 2 s poll is the
//! belt to those braces, as the Windows service's session watcher does.
//!
//! The bus is the system bus, or the `--system-bus` address of a dev `--console` run (the fake
//! logind of §8.12 on a private bus); the service never names the real system bus in a test.

use std::time::Duration;

use futures_util::StreamExt;
use ia_platform::linux::service::LogindSession;
use zbus::zvariant::OwnedObjectPath;

pub const LOGIND: &str = "org.freedesktop.login1";
pub const SEAT0: &str = "/org/freedesktop/login1/seat/seat0";

#[zbus::proxy(
    interface = "org.freedesktop.login1.Seat",
    default_service = "org.freedesktop.login1",
    gen_blocking = false
)]
trait Seat {
    #[zbus(property)]
    fn active_session(&self) -> zbus::Result<(String, OwnedObjectPath)>;
}

#[zbus::proxy(
    interface = "org.freedesktop.login1.Session",
    default_service = "org.freedesktop.login1",
    gen_blocking = false
)]
trait Session {
    #[zbus(property)]
    fn id(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn user(&self) -> zbus::Result<(u32, OwnedObjectPath)>;
    #[zbus(property)]
    fn class(&self) -> zbus::Result<String>;
    #[zbus(property, name = "Type")]
    fn kind(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn active(&self) -> zbus::Result<bool>;
    #[zbus(property)]
    fn remote(&self) -> zbus::Result<bool>;
    #[zbus(property)]
    fn display(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn locked_hint(&self) -> zbus::Result<bool>;
    #[zbus(property)]
    fn idle_hint(&self) -> zbus::Result<bool>;
    #[zbus(property)]
    fn idle_since_hint(&self) -> zbus::Result<u64>;
}

/// Connect to the system bus, or to `address` (the dev `--system-bus`).
pub async fn connect(address: Option<&str>) -> zbus::Result<zbus::Connection> {
    match address {
        Some(a) => zbus::connection::Builder::address(a)?.build().await,
        None => zbus::Connection::system().await,
    }
}

/// Seconds idle from `IdleHint` / `IdleSinceHint` (µs of the realtime clock), when idle.
pub fn idle_seconds(idle_hint: bool, idle_since_usec: u64, now_usec: u64) -> Option<u32> {
    if !idle_hint {
        return Some(0);
    }
    if idle_since_usec == 0 || idle_since_usec > now_usec {
        return None;
    }
    Some(((now_usec - idle_since_usec) / 1_000_000).min(u64::from(u32::MAX)) as u32)
}

fn now_usec() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

/// `seat0`'s active session and its properties, or `None` when the seat has none (nobody signed
/// in, or no seat at all — a headless server).
pub async fn active_session(conn: &zbus::Connection) -> zbus::Result<Option<LogindSession>> {
    let seat = SeatProxy::builder(conn)
        .path(SEAT0)?
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
        .await?;
    let (id, path) = match seat.active_session().await {
        Ok(v) => v,
        // A machine without seat0 (a container, a headless server) has no session to attach.
        Err(zbus::Error::MethodError(..)) | Err(zbus::Error::FDO(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    if id.is_empty() || path.as_str() == "/" {
        return Ok(None);
    }
    let s = SessionProxy::builder(conn)
        .path(path)?
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
        .await?;
    let (uid, _) = s.user().await?;
    let idle_hint = s.idle_hint().await.unwrap_or(false);
    let idle_since = s.idle_since_hint().await.unwrap_or(0);
    Ok(Some(LogindSession {
        id: s.id().await.unwrap_or(id),
        uid,
        class: s.class().await?,
        type_: s.kind().await?,
        active: s.active().await?,
        remote: s.remote().await.unwrap_or(false),
        locked_hint: s.locked_hint().await.unwrap_or(false),
        idle_sec: idle_seconds(idle_hint, idle_since, now_usec()),
        display: s.display().await.unwrap_or_default(),
    }))
}

/// A subscription to everything logind signals (§8.4a's re-evaluation triggers).
pub struct Watch {
    stream: zbus::MessageStream,
}

impl Watch {
    pub async fn new(conn: &zbus::Connection) -> zbus::Result<Self> {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender(LOGIND)?
            .build();
        let stream = zbus::MessageStream::for_match_rule(rule, conn, Some(64)).await?;
        Ok(Self { stream })
    }

    /// Wait until logind signals something, or `poll` passes. `false` when the stream ended (the
    /// bus went away): the caller reconnects.
    pub async fn changed(&mut self, poll: Duration) -> bool {
        tokio::select! {
            next = self.stream.next() => next.is_some(),
            _ = tokio::time::sleep(poll) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_seconds_follow_the_hints() {
        assert_eq!(idle_seconds(false, 0, 10_000_000), Some(0));
        assert_eq!(idle_seconds(true, 4_000_000, 10_000_000), Some(6));
        assert_eq!(idle_seconds(true, 0, 10_000_000), None);
        assert_eq!(idle_seconds(true, 20_000_000, 10_000_000), None);
    }
}
