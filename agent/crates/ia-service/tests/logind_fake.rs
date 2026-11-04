//! F §8.12 "Linux, no root": the logind client against a **fake logind on a private bus**.
//!
//! The test starts its own `dbus-daemon` on a socket in a temporary directory, serves a fake
//! `org.freedesktop.login1` (seat0, one session) on it with zbus, and reads it with the service's
//! real client. It never names the real system bus, the user's session bus or a real runtime
//! directory (S3). Without `dbus-daemon` on the host it says so and passes (nothing to run).
#![cfg(all(target_os = "linux", feature = "linux-service"))]

use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ia_core::policy::InteractiveStateName;
use ia_platform::linux::service::logind_facts;
use ia_service::linux::logind;
use zbus::zvariant::OwnedObjectPath;

const SESSION_PATH: &str = "/org/freedesktop/login1/session/_32";

#[derive(Clone)]
struct State {
    class: String,
    kind: String,
    locked: bool,
    active: bool,
}

struct FakeSeat {
    present: Arc<Mutex<bool>>,
}

#[zbus::interface(name = "org.freedesktop.login1.Seat")]
impl FakeSeat {
    #[zbus(property)]
    fn active_session(&self) -> (String, OwnedObjectPath) {
        if *self.present.lock().unwrap() {
            (
                "2".to_string(),
                OwnedObjectPath::try_from(SESSION_PATH).unwrap(),
            )
        } else {
            (String::new(), OwnedObjectPath::try_from("/").unwrap())
        }
    }
}

struct FakeSession {
    state: Arc<Mutex<State>>,
}

#[zbus::interface(name = "org.freedesktop.login1.Session")]
impl FakeSession {
    #[zbus(property)]
    fn id(&self) -> String {
        "2".into()
    }
    #[zbus(property)]
    fn user(&self) -> (u32, OwnedObjectPath) {
        (
            1000,
            OwnedObjectPath::try_from("/org/freedesktop/login1/user/_1000").unwrap(),
        )
    }
    #[zbus(property)]
    fn class(&self) -> String {
        self.state.lock().unwrap().class.clone()
    }
    #[zbus(property, name = "Type")]
    fn kind(&self) -> String {
        self.state.lock().unwrap().kind.clone()
    }
    #[zbus(property)]
    fn active(&self) -> bool {
        self.state.lock().unwrap().active
    }
    #[zbus(property)]
    fn remote(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn display(&self) -> String {
        ":97".into()
    }
    #[zbus(property)]
    fn locked_hint(&self) -> bool {
        self.state.lock().unwrap().locked
    }
    #[zbus(property)]
    fn idle_hint(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn idle_since_hint(&self) -> u64 {
        0
    }
}

struct Bus {
    child: Child,
    dir: std::path::PathBuf,
    address: String,
}

impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A private `dbus-daemon` on a socket in a fresh temporary directory, or `None` when the host
/// has no `dbus-daemon`.
fn private_bus() -> Option<Bus> {
    let dir = std::env::temp_dir().join(format!(
        "ia-logind-fake-{}-{}",
        std::process::id(),
        ia_core::rnd::hex(4)
    ));
    std::fs::create_dir_all(&dir).ok()?;
    let address = format!("unix:path={}/system_bus", dir.display());
    let child = Command::new("dbus-daemon")
        .args([
            "--session",
            "--nofork",
            "--nopidfile",
            "--address",
            &address,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let socket = dir.join("system_bus");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    Some(Bus {
        child,
        dir,
        address,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_service_reads_the_fake_logind_and_wakes_on_its_signals() {
    let Some(bus) = private_bus() else {
        eprintln!(
            "dbus-daemon is not available on this host; the fake-logind test has nothing to run"
        );
        return;
    };
    let present = Arc::new(Mutex::new(true));
    let state = Arc::new(Mutex::new(State {
        class: "user".into(),
        kind: "x11".into(),
        locked: false,
        active: true,
    }));
    let server = zbus::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .name(logind::LOGIND)
        .unwrap()
        .serve_at(
            logind::SEAT0,
            FakeSeat {
                present: present.clone(),
            },
        )
        .unwrap()
        .serve_at(
            SESSION_PATH,
            FakeSession {
                state: state.clone(),
            },
        )
        .unwrap()
        .build()
        .await
        .expect("the fake logind is served on the private bus");

    let client = logind::connect(Some(&bus.address)).await.unwrap();

    // An active, unlocked X11 user session: the target, `active`, display x11 on :97.
    let s = logind::active_session(&client).await.unwrap().unwrap();
    assert_eq!(
        (s.id.as_str(), s.uid, s.display.as_str()),
        ("2", 1000, ":97")
    );
    let v = logind_facts(Some(&s));
    assert!(v.is_target);
    assert_eq!(v.state, InteractiveStateName::Active);
    assert_eq!(v.interactive_state(1).display.as_deref(), Some("x11"));

    // A lock is signalled; the watch wakes well before its poll, and the session is `locked`
    // and still the target (8.4e).
    let mut watch = logind::Watch::new(&client).await.unwrap();
    state.lock().unwrap().locked = true;
    let iface = server
        .object_server()
        .interface::<_, FakeSession>(SESSION_PATH)
        .await
        .unwrap();
    iface
        .get()
        .await
        .locked_hint_changed(iface.signal_emitter())
        .await
        .unwrap();
    let started = Instant::now();
    assert!(watch.changed(Duration::from_secs(20)).await);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "a logind signal triggers the re-evaluation, not the poll"
    );
    let s = logind::active_session(&client).await.unwrap().unwrap();
    let v = logind_facts(Some(&s));
    assert!(v.is_target);
    assert_eq!(v.state, InteractiveStateName::Locked);

    // Wayland: still a target, no X display (8.4d).
    {
        let mut st = state.lock().unwrap();
        st.locked = false;
        st.kind = "wayland".into();
    }
    let s = logind::active_session(&client).await.unwrap().unwrap();
    let v = logind_facts(Some(&s));
    assert!(v.is_target);
    assert_eq!(v.interactive_state(1).display.as_deref(), Some("wayland"));
    assert_eq!(v.x_display, None);

    // The greeter: never a target, `none` (8.4f).
    state.lock().unwrap().class = "greeter".into();
    let s = logind::active_session(&client).await.unwrap().unwrap();
    assert_eq!(logind_facts(Some(&s)).state, InteractiveStateName::None);

    // Nobody: seat0 has no active session.
    *present.lock().unwrap() = false;
    assert!(logind::active_session(&client).await.unwrap().is_none());
    drop(server);
}
