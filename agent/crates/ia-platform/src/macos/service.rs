//! The macOS unattended service's decisions (Phase F §17.3, stream apple), the twin of
//! `ia_platform::linux::service`: who the console user is, what the interactive state is, which
//! worker connection is admitted, and what a console change means for a live worker. Every
//! decision is a pure function of observed facts and is tested with a table here; the only OS call
//! is [`sys::console_user`].
//!
//! The model (§17.3): the worker `ia-desktop` is a LaunchAgent that launchd starts in every GUI
//! login session; it connects to the daemon's socket and waits. The daemon admits a connection
//! only when `getpeereid` names **the console user** and the `LOCAL_PEERPID` process is the
//! installed worker (its signature satisfies the daemon's own signer and its path is the installed
//! one), and that pid is the one the worker's `ready` frame names. The worker checks the daemon the
//! same way (root, the installed daemon). Only the console user's worker ever gets a session; a
//! switch to another user ends it.

use ia_core::fleet::InteractiveState;
use ia_core::policy::InteractiveStateName;

/// The console user as the system reports it (`SCDynamicStoreCopyConsoleUser`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleUser {
    pub uid: u32,
    pub name: String,
}

/// The user a session may be served to: the console user, unless nobody is logged in (the login
/// window reports `loginwindow`, and root is never a target, E 7.3d).
pub fn console_target(user: Option<&ConsoleUser>) -> Option<u32> {
    user.filter(|u| u.uid != 0 && !u.name.is_empty() && u.name != "loginwindow")
        .map(|u| u.uid)
}

/// The D §6.2 interactive state: `none` at the login window (or with nobody logged in), `locked`
/// while the console user's screen is locked (as the worker reports it), else `active`.
pub fn interactive_state(target: Option<u32>, locked: bool, at: i64) -> InteractiveState {
    let state = match (target, locked) {
        (None, _) => InteractiveStateName::None,
        (Some(_), true) => InteractiveStateName::Locked,
        (Some(_), false) => InteractiveStateName::Active,
    };
    InteractiveState {
        state,
        idle_sec: None,
        at,
        display: None,
    }
}

/// Why a worker connection was not admitted. The daemon closes the connection without saying
/// which (a stranger learns nothing); the reason is only logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionRefusal {
    /// Nobody is logged in at the console: no worker is admitted.
    NoConsoleUser,
    /// The peer is not the console user (another user's session, or a stranger).
    NotConsoleUser,
    /// The `ready` frame names another pid than the socket's peer.
    ReadyPidMismatch,
    /// The peer's signature does not satisfy the signer, so its image could not be vouched for.
    UnknownImage,
    /// The peer is signed, but it is not the installed binary.
    WrongImage,
}

/// What the daemon observed of one connection, after its `ready` frame.
#[derive(Debug, Clone)]
pub struct WorkerPeer<'a> {
    /// `getpeereid`.
    pub uid: u32,
    /// `LOCAL_PEERPID`.
    pub pid: i32,
    /// The pid the `ready` frame names.
    pub ready_pid: u32,
    /// The peer's image path when its signature checks out (`codesign::same_signer_image`).
    pub image: Option<&'a str>,
}

/// The daemon's admission rule (§17.3). `console` is [`console_target`]; `installed` is the
/// canonical path of the installed worker.
pub fn admit_worker(
    peer: &WorkerPeer<'_>,
    console: Option<u32>,
    installed: &str,
) -> Result<(), AdmissionRefusal> {
    let Some(console) = console else {
        return Err(AdmissionRefusal::NoConsoleUser);
    };
    if peer.uid != console || peer.uid == 0 {
        return Err(AdmissionRefusal::NotConsoleUser);
    }
    if peer.pid <= 1 || i64::from(peer.ready_pid) != i64::from(peer.pid) {
        return Err(AdmissionRefusal::ReadyPidMismatch);
    }
    match peer.image {
        None => Err(AdmissionRefusal::UnknownImage),
        Some(i) if same_path(i, installed) => Ok(()),
        Some(_) => Err(AdmissionRefusal::WrongImage),
    }
}

/// Why the worker would not talk to what answered on the daemon's socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonRefusal {
    /// Not root (or, in a dev run, not this user).
    WrongUser,
    UnknownImage,
    WrongImage,
}

/// The worker's check of the daemon (§17.3): `expected_uid` is 0 (a dev run: the worker's own
/// uid), `installed` the canonical path of the installed daemon.
pub fn admit_daemon(
    uid: u32,
    expected_uid: u32,
    image: Option<&str>,
    installed: &str,
) -> Result<(), DaemonRefusal> {
    if uid != expected_uid {
        return Err(DaemonRefusal::WrongUser);
    }
    match image {
        None => Err(DaemonRefusal::UnknownImage),
        Some(i) if same_path(i, installed) => Ok(()),
        Some(_) => Err(DaemonRefusal::WrongImage),
    }
}

/// Exact path equality (APFS is usually case-insensitive, but the installed paths are fixed, so a
/// case difference means another file was meant).
fn same_path(observed: &str, expected: &str) -> bool {
    !expected.is_empty() && observed == expected
}

/// What a console or lock change means for the live session's worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerFate {
    /// Nothing to do.
    Keep,
    /// Tell it the new interactive state (a lock or an unlock).
    Notify,
    /// Its user is no longer at the console (a fast user switch, a log-out): end the session.
    End,
}

/// `live_uid`: the live session worker's user, if any; `console`: [`console_target`] now.
pub fn worker_fate(live_uid: Option<u32>, console: Option<u32>, state_changed: bool) -> WorkerFate {
    match live_uid {
        None => WorkerFate::Keep,
        Some(u) if console != Some(u) => WorkerFate::End,
        Some(_) if state_changed => WorkerFate::Notify,
        Some(_) => WorkerFate::Keep,
    }
}

/// The `DesktopSwitch` reasons the macOS worker uses to report its screen lock (the existing frame,
/// unchanged; `answer_worker` turns it into `ReconsiderDesktop { reason }`).
pub const REASON_LOCKED: &str = "screen_locked";
pub const REASON_UNLOCKED: &str = "screen_unlocked";

/// The lock state a `DesktopSwitch` reason reports, if it is one of the two.
pub fn lock_report(reason: &str) -> Option<bool> {
    match reason {
        REASON_LOCKED => Some(true),
        REASON_UNLOCKED => Some(false),
        _ => None,
    }
}

/// The calls that need the OS.
pub mod sys {
    use super::ConsoleUser;
    use std::ffi::{c_void, CStr};

    #[link(name = "SystemConfiguration", kind = "framework")]
    extern "C" {
        fn SCDynamicStoreCopyConsoleUser(
            store: *const c_void,
            uid: *mut u32,
            gid: *mut u32,
        ) -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFStringGetCString(s: *const c_void, buf: *mut i8, len: isize, enc: u32) -> u8;
    }

    /// The console user (`SCDynamicStoreCopyConsoleUser`), or `None` when it cannot be read. A
    /// read-only query of the system configuration store; root is not needed.
    pub fn console_user() -> Option<ConsoleUser> {
        let (mut uid, mut gid) = (0u32, 0u32);
        // SAFETY: out-parameters owned here; the returned CFString is +1 and released below.
        unsafe {
            let name = SCDynamicStoreCopyConsoleUser(std::ptr::null(), &mut uid, &mut gid);
            if name.is_null() {
                return None;
            }
            let mut buf = [0i8; 256];
            let ok = CFStringGetCString(name, buf.as_mut_ptr(), buf.len() as isize, 0x0800_0100);
            CFRelease(name);
            (ok != 0).then(|| ConsoleUser {
                uid,
                name: CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned(),
            })
        }
    }
}

/// The network facts the heartbeat and the waker need (rule 8.2a on macOS): the usable IPv4
/// interfaces with their MACs, and the default gateway with its MAC from the ARP cache.
pub mod net {
    use std::ffi::CStr;
    use std::net::Ipv4Addr;

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct NetIface {
        pub name: String,
        pub addr: Ipv4Addr,
        pub prefix_len: u8,
        pub mac: Option<String>,
    }

    /// `(interface, gateway)` from `route -n get default`.
    pub fn default_route(text: &str) -> Option<(String, Ipv4Addr)> {
        let field = |key: &str| {
            text.lines()
                .find_map(|l| l.trim().strip_prefix(key).map(|v| v.trim().to_string()))
        };
        let gw = field("gateway:")?.parse().ok()?;
        Some((field("interface:")?, gw))
    }

    /// The MAC `arp -n <ip>` reports (`? (10.0.0.1) at aa:bb:cc:dd:ee:ff on en0 ...`),
    /// normalised to two lower-case hex digits per byte; `None` for an incomplete entry.
    pub fn arp_mac(text: &str) -> Option<String> {
        let mac = text.split_whitespace().skip_while(|w| *w != "at").nth(1)?;
        let parts: Vec<&str> = mac.split(':').collect();
        if parts.len() != 6
            || !parts
                .iter()
                .all(|p| (1..=2).contains(&p.len()) && p.chars().all(|c| c.is_ascii_hexdigit()))
        {
            return None;
        }
        let m = parts
            .iter()
            .map(|p| format!("{:0>2}", p.to_ascii_lowercase()))
            .collect::<Vec<_>>()
            .join(":");
        (m != "00:00:00:00:00:00").then_some(m)
    }

    /// The up, non-loopback IPv4 interfaces (`getifaddrs`), each with the MAC of its own `AF_LINK`
    /// entry in the same list.
    pub fn ipv4_interfaces() -> Vec<NetIface> {
        let mut v4: Vec<NetIface> = Vec::new();
        let mut macs: Vec<(String, String)> = Vec::new();
        // SAFETY: getifaddrs allocates a list freed by freeifaddrs below; every pointer is checked
        // for null before it is read, and nothing outlives the list.
        unsafe {
            let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
            if libc::getifaddrs(&mut ifap) != 0 {
                return v4;
            }
            let mut cur = ifap;
            while !cur.is_null() {
                let ifa = &*cur;
                cur = ifa.ifa_next;
                if ifa.ifa_addr.is_null() {
                    continue;
                }
                let name = CStr::from_ptr(ifa.ifa_name).to_string_lossy().into_owned();
                let family = i32::from((*ifa.ifa_addr).sa_family);
                if family == libc::AF_LINK {
                    let dl = &*(ifa.ifa_addr as *const libc::sockaddr_dl);
                    if dl.sdl_alen == 6 {
                        let base = dl.sdl_data.as_ptr().cast::<u8>().add(dl.sdl_nlen as usize);
                        let b = std::slice::from_raw_parts(base, 6);
                        let mac = b
                            .iter()
                            .map(|x| format!("{x:02x}"))
                            .collect::<Vec<_>>()
                            .join(":");
                        if mac != "00:00:00:00:00:00" {
                            macs.push((name, mac));
                        }
                    }
                    continue;
                }
                if family != libc::AF_INET || ifa.ifa_netmask.is_null() {
                    continue;
                }
                let flags = ifa.ifa_flags as libc::c_int;
                if flags & libc::IFF_UP == 0 || flags & libc::IFF_LOOPBACK != 0 {
                    continue;
                }
                let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                let mask = &*(ifa.ifa_netmask as *const libc::sockaddr_in);
                v4.push(NetIface {
                    name,
                    addr: Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr)),
                    prefix_len: u32::from_be(mask.sin_addr.s_addr).count_ones() as u8,
                    mac: None,
                });
            }
            libc::freeifaddrs(ifap);
        }
        for i in &mut v4 {
            i.mac = macs
                .iter()
                .find(|(n, _)| *n == i.name)
                .map(|(_, m)| m.clone());
        }
        v4
    }

    /// The default route's interface and gateway, and the gateway's MAC when the ARP cache has it.
    pub fn gateway() -> Option<(String, Ipv4Addr, Option<String>)> {
        let run = |cmd: &str, args: &[&str]| {
            std::process::Command::new(cmd)
                .args(args)
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        };
        let (iface, gw) = default_route(&run("/sbin/route", &["-n", "get", "default"])?)?;
        let mac = run("/usr/sbin/arp", &["-n", &gw.to_string()]).and_then(|t| arp_mac(&t));
        Some((iface, gw, mac))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(uid: u32, name: &str) -> ConsoleUser {
        ConsoleUser {
            uid,
            name: name.into(),
        }
    }

    #[test]
    fn the_login_window_and_root_are_nobody() {
        assert_eq!(console_target(Some(&user(501, "asha"))), Some(501));
        assert_eq!(console_target(Some(&user(0, "loginwindow"))), None);
        assert_eq!(console_target(Some(&user(501, "loginwindow"))), None);
        assert_eq!(console_target(Some(&user(0, "root"))), None);
        assert_eq!(console_target(None), None);
    }

    #[test]
    fn the_interactive_state_is_none_locked_or_active() {
        assert_eq!(
            interactive_state(None, false, 1).state,
            InteractiveStateName::None
        );
        assert_eq!(
            interactive_state(None, true, 1).state,
            InteractiveStateName::None
        );
        assert_eq!(
            interactive_state(Some(501), true, 1).state,
            InteractiveStateName::Locked
        );
        assert_eq!(
            interactive_state(Some(501), false, 1).state,
            InteractiveStateName::Active
        );
        assert_eq!(interactive_state(Some(501), false, 7).at, 7);
        assert_eq!(interactive_state(Some(501), false, 7).display, None);
    }

    const WORKER: &str = "/Library/IndiansAssist/ia-desktop";

    fn peer(uid: u32, pid: i32, ready: u32, image: Option<&str>) -> WorkerPeer<'_> {
        WorkerPeer {
            uid,
            pid,
            ready_pid: ready,
            image,
        }
    }

    #[test]
    fn only_the_console_users_installed_worker_with_its_own_pid_is_admitted() {
        let ok = peer(501, 900, 900, Some(WORKER));
        assert_eq!(admit_worker(&ok, Some(501), WORKER), Ok(()));
        assert_eq!(
            admit_worker(&ok, None, WORKER),
            Err(AdmissionRefusal::NoConsoleUser)
        );
        assert_eq!(
            admit_worker(&ok, Some(502), WORKER),
            Err(AdmissionRefusal::NotConsoleUser)
        );
        assert_eq!(
            admit_worker(&peer(0, 900, 900, Some(WORKER)), Some(0), WORKER),
            Err(AdmissionRefusal::NotConsoleUser),
            "root is never admitted, even if it were the console"
        );
        assert_eq!(
            admit_worker(&peer(501, 900, 901, Some(WORKER)), Some(501), WORKER),
            Err(AdmissionRefusal::ReadyPidMismatch)
        );
        assert_eq!(
            admit_worker(&peer(501, 1, 1, Some(WORKER)), Some(501), WORKER),
            Err(AdmissionRefusal::ReadyPidMismatch)
        );
        assert_eq!(
            admit_worker(&peer(501, 900, 900, None), Some(501), WORKER),
            Err(AdmissionRefusal::UnknownImage),
            "an unsigned binary, even at the installed path"
        );
        assert_eq!(
            admit_worker(
                &peer(501, 900, 900, Some("/tmp/ia-desktop")),
                Some(501),
                WORKER
            ),
            Err(AdmissionRefusal::WrongImage)
        );
        assert_eq!(
            admit_worker(
                &peer(501, 900, 900, Some("/library/indiansassist/ia-desktop")),
                Some(501),
                WORKER
            ),
            Err(AdmissionRefusal::WrongImage)
        );
    }

    #[test]
    fn the_worker_accepts_only_the_installed_daemon_as_the_expected_user() {
        let d = "/Library/IndiansAssist/ia-service";
        assert_eq!(admit_daemon(0, 0, Some(d), d), Ok(()));
        assert_eq!(
            admit_daemon(501, 0, Some(d), d),
            Err(DaemonRefusal::WrongUser)
        );
        assert_eq!(
            admit_daemon(0, 0, None, d),
            Err(DaemonRefusal::UnknownImage)
        );
        assert_eq!(
            admit_daemon(0, 0, Some("/tmp/ia-service"), d),
            Err(DaemonRefusal::WrongImage)
        );
        // A dev run: the daemon runs as the worker's own user.
        assert_eq!(admit_daemon(501, 501, Some(d), d), Ok(()));
    }

    #[test]
    fn a_console_switch_ends_the_session_and_a_lock_change_is_told() {
        assert_eq!(worker_fate(None, Some(501), true), WorkerFate::Keep);
        assert_eq!(worker_fate(Some(501), Some(501), false), WorkerFate::Keep);
        assert_eq!(worker_fate(Some(501), Some(501), true), WorkerFate::Notify);
        assert_eq!(
            worker_fate(Some(501), Some(502), true),
            WorkerFate::End,
            "fast user switch"
        );
        assert_eq!(
            worker_fate(Some(501), None, true),
            WorkerFate::End,
            "the login window"
        );
    }

    #[test]
    fn the_lock_reasons_round_trip() {
        assert_eq!(lock_report(REASON_LOCKED), Some(true));
        assert_eq!(lock_report(REASON_UNLOCKED), Some(false));
        assert_eq!(lock_report("uac"), None);
    }

    #[test]
    fn the_console_user_can_be_read() {
        // This Mac has a logged-in user while the tests run; the call is a read-only query.
        if let Some(u) = sys::console_user() {
            assert!(!u.name.is_empty());
        }
    }

    #[test]
    fn the_default_route_and_the_gateway_mac_are_parsed() {
        let route = "   route to: default\ndestination: default\n       mask: default\n    gateway: 10.255.8.123\n  interface: en1\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>\n";
        assert_eq!(
            net::default_route(route),
            Some(("en1".to_string(), "10.255.8.123".parse().unwrap()))
        );
        assert_eq!(
            net::default_route("route: writing to routing socket: not in table"),
            None
        );
        assert_eq!(
            net::arp_mac("? (10.255.8.123) at a:1b:2c:3d:4e:5f on en1 ifscope [ethernet]")
                .as_deref(),
            Some("0a:1b:2c:3d:4e:5f")
        );
        assert_eq!(
            net::arp_mac("? (10.0.0.1) at (incomplete) on en0 ifscope [ethernet]"),
            None
        );
        assert_eq!(net::arp_mac("? (10.0.0.1) at 0:0:0:0:0:0 on en0"), None);
        // This Mac: the interfaces are readable, and none is loopback.
        assert!(net::ipv4_interfaces().iter().all(|i| !i.addr.is_loopback()));
    }
}
