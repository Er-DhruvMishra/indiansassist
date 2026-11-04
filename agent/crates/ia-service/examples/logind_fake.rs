//! The fake `org.freedesktop.login1` of F §8.12 "Linux, no root", served on a **private**
//! `dbus-daemon` that `agent/scripts/logind-fake.sh` starts (never the real system bus, S3).
//!
//! ```text
//! logind_fake --bus unix:path=<dir>/system_bus [--uid <n>] [--display :97] [--type x11|wayland]
//!             [--class user|greeter] [--locked] [--nobody] [--control <fifo>]
//! ```
//!
//! It serves `seat0` (`ActiveSession`) and one session (`Id` "2", `User` = `--uid`, default the
//! current uid, so the dev service's worker needs no uid change) with the properties the service
//! reads (`Class`, `Type`, `Active`, `Remote`, `Display`, `LockedHint`, `IdleHint`,
//! `IdleSinceHint`). Commands, one per line, on the `--control` FIFO (reopened after each writer)
//! or else on stdin, change the state and emit `PropertiesChanged`, which the service's watch
//! re-evaluates on (§8.4a):
//!
//! ```text
//! type x11|wayland   class user|greeter   locked true|false   active true|false
//! remote true|false  idle <seconds>|off    nobody             present            quit
//! ```
//!
//! Every accepted command is echoed as `logind-fake: <state>` on stdout.

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("logind_fake is the Linux test fake of F §8.12; it does nothing on this platform");
}

#[cfg(target_os = "linux")]
fn main() {
    if let Err(e) = imp::run() {
        eprintln!("logind-fake: {e}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::io::BufRead;
    use std::sync::{Arc, Mutex};

    use zbus::zvariant::OwnedObjectPath;

    const LOGIND: &str = "org.freedesktop.login1";
    const SEAT0: &str = "/org/freedesktop/login1/seat/seat0";
    const SESSION_ID: &str = "2";
    const SESSION_PATH: &str = "/org/freedesktop/login1/session/_32";

    #[derive(Clone, Debug)]
    struct State {
        present: bool,
        uid: u32,
        display: String,
        kind: String,
        class: String,
        active: bool,
        remote: bool,
        locked: bool,
        /// Seconds idle, or `None` for not idle.
        idle: Option<u64>,
    }

    impl State {
        fn line(&self) -> String {
            if !self.present {
                return "nobody (seat0 has no active session)".into();
            }
            format!(
                "session {SESSION_ID} uid={} class={} type={} active={} remote={} locked={} display={} idle={}",
                self.uid,
                self.class,
                self.kind,
                self.active,
                self.remote,
                self.locked,
                self.display,
                self.idle.map_or("no".to_string(), |s| format!("{s}s")),
            )
        }
    }

    type Shared = Arc<Mutex<State>>;

    struct Seat(Shared);

    #[zbus::interface(name = "org.freedesktop.login1.Seat")]
    impl Seat {
        #[zbus(property)]
        fn active_session(&self) -> (String, OwnedObjectPath) {
            if self.0.lock().unwrap().present {
                (
                    SESSION_ID.to_string(),
                    OwnedObjectPath::try_from(SESSION_PATH).unwrap(),
                )
            } else {
                (String::new(), OwnedObjectPath::try_from("/").unwrap())
            }
        }
    }

    struct Session(Shared);

    #[zbus::interface(name = "org.freedesktop.login1.Session")]
    impl Session {
        #[zbus(property)]
        fn id(&self) -> String {
            SESSION_ID.into()
        }
        #[zbus(property)]
        fn user(&self) -> (u32, OwnedObjectPath) {
            let uid = self.0.lock().unwrap().uid;
            (
                uid,
                OwnedObjectPath::try_from(format!("/org/freedesktop/login1/user/_{uid}")).unwrap(),
            )
        }
        #[zbus(property)]
        fn class(&self) -> String {
            self.0.lock().unwrap().class.clone()
        }
        #[zbus(property, name = "Type")]
        fn kind(&self) -> String {
            self.0.lock().unwrap().kind.clone()
        }
        #[zbus(property)]
        fn active(&self) -> bool {
            self.0.lock().unwrap().active
        }
        #[zbus(property)]
        fn remote(&self) -> bool {
            self.0.lock().unwrap().remote
        }
        #[zbus(property)]
        fn display(&self) -> String {
            let s = self.0.lock().unwrap();
            if s.kind == "x11" {
                s.display.clone()
            } else {
                String::new()
            }
        }
        #[zbus(property)]
        fn locked_hint(&self) -> bool {
            self.0.lock().unwrap().locked
        }
        #[zbus(property)]
        fn idle_hint(&self) -> bool {
            self.0.lock().unwrap().idle.is_some()
        }
        #[zbus(property)]
        fn idle_since_hint(&self) -> u64 {
            match self.0.lock().unwrap().idle {
                Some(secs) => {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_micros() as u64)
                        .unwrap_or(0);
                    now.saturating_sub(secs * 1_000_000)
                }
                None => 0,
            }
        }
    }

    fn value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
    }

    fn boolean(v: Option<&str>) -> Result<bool, String> {
        match v {
            Some("true") | Some("yes") | Some("1") => Ok(true),
            Some("false") | Some("no") | Some("0") => Ok(false),
            other => Err(format!("expected true or false, got {other:?}")),
        }
    }

    /// Apply one command line to the state. `Ok(false)` = quit.
    fn apply(state: &mut State, line: &str) -> Result<bool, String> {
        let mut words = line.split_whitespace();
        let Some(cmd) = words.next() else {
            return Ok(true);
        };
        let arg = words.next();
        match cmd {
            "type" => match arg {
                Some(t @ ("x11" | "wayland" | "tty" | "mir" | "unspecified")) => {
                    state.kind = t.to_string()
                }
                other => return Err(format!("type: x11 or wayland, got {other:?}")),
            },
            "class" => match arg {
                Some(c @ ("user" | "greeter" | "lock-screen" | "background")) => {
                    state.class = c.to_string()
                }
                other => return Err(format!("class: user or greeter, got {other:?}")),
            },
            "locked" => state.locked = boolean(arg)?,
            "active" => state.active = boolean(arg)?,
            "remote" => state.remote = boolean(arg)?,
            "idle" => {
                state.idle = match arg {
                    Some("off") => None,
                    Some(n) => Some(n.parse().map_err(|_| format!("idle: seconds, got {n}"))?),
                    None => return Err("idle: seconds or off".into()),
                }
            }
            "nobody" => state.present = false,
            "present" => state.present = true,
            "quit" => return Ok(false),
            other => return Err(format!("unknown command {other}")),
        }
        Ok(true)
    }

    async fn emit_all(conn: &zbus::Connection) -> zbus::Result<()> {
        let server = conn.object_server();
        let seat = server.interface::<_, Seat>(SEAT0).await?;
        seat.get()
            .await
            .active_session_changed(seat.signal_emitter())
            .await?;
        let session = server.interface::<_, Session>(SESSION_PATH).await?;
        let s = session.get().await;
        let e = session.signal_emitter();
        s.class_changed(e).await?;
        // zbus names the change method after the D-Bus property (`Type`), not the Rust fn.
        s.type_changed(e).await?;
        s.active_changed(e).await?;
        s.remote_changed(e).await?;
        s.display_changed(e).await?;
        s.locked_hint_changed(e).await?;
        s.idle_hint_changed(e).await?;
        s.idle_since_hint_changed(e).await?;
        Ok(())
    }

    pub fn run() -> Result<(), String> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let bus = value(&args, "--bus")
            .ok_or("--bus <address of the private dbus-daemon> is required")?;
        // S3: only a private bus on a socket path; never the system or session bus.
        if !bus.starts_with("unix:path=")
            || bus.contains("/run/dbus/")
            || bus.contains("/run/user/")
        {
            return Err(format!(
                "refusing bus {bus}: only a private unix:path= bus the harness started"
            ));
        }
        // SAFETY: getuid has no preconditions.
        let uid = match value(&args, "--uid") {
            Some(u) => u.parse().map_err(|_| format!("--uid: a number, got {u}"))?,
            None => unsafe { libc::getuid() },
        };
        let mut state = State {
            present: !args.iter().any(|a| a == "--nobody"),
            uid,
            display: value(&args, "--display").unwrap_or(":97").to_string(),
            kind: "x11".into(),
            class: "user".into(),
            active: true,
            remote: false,
            locked: args.iter().any(|a| a == "--locked"),
            idle: None,
        };
        if state.display == ":0" || state.display.starts_with(":0.") {
            return Err("refusing display :0 (the WSLg desktop); use the harness Xvfb".into());
        }
        if let Some(t) = value(&args, "--type") {
            apply(&mut state, &format!("type {t}"))?;
        }
        if let Some(c) = value(&args, "--class") {
            apply(&mut state, &format!("class {c}"))?;
        }
        let control = value(&args, "--control").map(std::path::PathBuf::from);
        let shared: Shared = Arc::new(Mutex::new(state));

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| format!("the runtime: {e}"))?;
        let conn = rt
            .block_on(async {
                zbus::connection::Builder::address(bus)?
                    .name(LOGIND)?
                    .serve_at(SEAT0, Seat(shared.clone()))?
                    .serve_at(SESSION_PATH, Session(shared.clone()))?
                    .build()
                    .await
            })
            .map_err(|e| format!("serving {LOGIND} on {bus}: {e}"))?;
        println!("logind-fake: ready on {bus}");
        println!("logind-fake: {}", shared.lock().unwrap().line());

        let handle_line = |line: &str| -> bool {
            let outcome = {
                let mut s = shared.lock().unwrap();
                apply(&mut s, line).map(|go| (go, s.line()))
            };
            match outcome {
                Ok((false, _)) => false,
                Ok((true, text)) => {
                    if let Err(e) = rt.block_on(emit_all(&conn)) {
                        eprintln!("logind-fake: the change signal failed: {e}");
                    }
                    println!("logind-fake: {text}");
                    true
                }
                Err(e) => {
                    eprintln!("logind-fake: {e}");
                    true
                }
            }
        };
        match control {
            Some(fifo) => loop {
                // Opening a FIFO for reading blocks until a writer opens it; EOF = that writer
                // closed, so reopen and wait for the next one.
                let f = std::fs::File::open(&fifo)
                    .map_err(|e| format!("the control FIFO {}: {e}", fifo.display()))?;
                for line in std::io::BufReader::new(f).lines() {
                    let Ok(line) = line else { break };
                    if !handle_line(line.trim()) {
                        println!("logind-fake: quit");
                        return Ok(());
                    }
                }
            },
            None => {
                for line in std::io::stdin().lock().lines() {
                    let Ok(line) = line else { break };
                    if !handle_line(line.trim()) {
                        break;
                    }
                }
                println!("logind-fake: quit");
                Ok(())
            }
        }
    }
}
