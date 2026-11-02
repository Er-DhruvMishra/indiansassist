//! Physical-input self-defence for the agent's own windows (contract §3.5).
//!
//! For the session the agent installs `WH_MOUSE_LL` and `WH_KEYBOARD_LL` hooks on a dedicated
//! thread with its own message loop (a slow UI frame can never stall system input). The hooks
//! **drop** every event whose `dwExtraInfo == IA_1` (the agent's own `SendInput` tag) while
//! the cursor is over a window of this process (mouse) or while one of its windows is the
//! foreground window (keyboard), so the technician's injected input can never press the
//! agent's own prompt buttons. An untagged press over an agent window is recorded; every
//! grant-direction control (Accept a file, Allow control, clipboard on, raise the level)
//! additionally requires such a physical press within the last couple of seconds
//! ([`Guard::physical_press_recent`]). If the hooks cannot be installed, grant-direction
//! controls fail closed while safe-direction ones (Decline, Refuse, Stop, View only) keep
//! working.
//!
//! **Linux (Phase E rule 7.3c).** X11 marks no event as injected, so the guard is applied
//! *before* injection instead: `ia-input-x11` refuses every injected pointer event over an agent
//! window and every key while one holds focus. A press that reaches an agent window is therefore
//! a physical one, so on Linux the guard counts as installed and the egui app records the presses
//! it receives ([`note_physical_press`]). The 750 ms post-map gate (`model::MapGate`) closes the
//! race between the guard's geometry check and a window appearing under the point.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static LAST_PHYSICAL_MS: AtomicU64 = AtomicU64::new(0);
static REFUSED: AtomicU32 = AtomicU32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);

fn epoch() -> Instant {
    static E: OnceLock<Instant> = OnceLock::new();
    *E.get_or_init(Instant::now)
}

fn now_ms() -> u64 {
    // +1 so "never pressed" (0) is distinguishable from a press in the first millisecond.
    epoch().elapsed().as_millis() as u64 + 1
}

/// The installed hooks; dropping it removes them.
pub struct Guard {
    #[cfg(windows)]
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Guard {
    /// Install the hooks (Windows). Elsewhere a no-op guard that never confirms a press.
    pub fn install() -> Guard {
        let _ = epoch();
        #[cfg(windows)]
        {
            let (tx, rx) = std::sync::mpsc::channel();
            let thread = std::thread::Builder::new()
                .name("ia-input-guard".into())
                .spawn(move || win::hook_thread(tx))
                .ok();
            let thread_id = rx.recv_timeout(Duration::from_secs(2)).unwrap_or(0);
            Guard { thread_id, thread }
        }
        #[cfg(target_os = "linux")]
        {
            INSTALLED.store(true, Ordering::SeqCst);
        }
        #[cfg(not(windows))]
        {
            Guard { thread: None }
        }
    }

    /// Whether both hooks are in place.
    pub fn installed(&self) -> bool {
        INSTALLED.load(Ordering::SeqCst)
    }

    /// A physical (untagged) button press over an agent window happened within `within`.
    /// Always `false` when the hooks are not installed (fail closed).
    pub fn physical_press_recent(&self, within: Duration) -> bool {
        if !self.installed() {
            return false;
        }
        let last = LAST_PHYSICAL_MS.load(Ordering::SeqCst);
        last != 0 && now_ms().saturating_sub(last) <= within.as_millis() as u64
    }

    /// Tagged events dropped over agent windows so far (counted as `refused`, §3.8).
    pub fn refused(&self) -> u32 {
        REFUSED.load(Ordering::SeqCst)
    }
}

/// Linux: a pointer press reached one of the agent's windows. Injected input never does (the
/// pre-injection guard of rule 7.3c), so this is a physical press.
#[cfg(target_os = "linux")]
pub fn note_physical_press() {
    LAST_PHYSICAL_MS.store(now_ms(), Ordering::SeqCst);
}

impl Drop for Guard {
    fn drop(&mut self) {
        #[cfg(windows)]
        win::stop(self.thread_id);
        #[cfg(target_os = "linux")]
        INSTALLED.store(false, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::model::{key_hook_drops, mouse_hook_verdict, HookVerdict};
    use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetForegroundWindow, GetMessageW,
        GetWindowThreadProcessId, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, WindowFromPoint, GA_ROOT, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
        WH_KEYBOARD_LL, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
        WM_XBUTTONDOWN,
    };

    fn own_pid() -> u32 {
        static PID: OnceLock<u32> = OnceLock::new();
        *PID.get_or_init(std::process::id)
    }

    fn window_is_own(h: windows::Win32::Foundation::HWND) -> bool {
        if h.is_invalid() {
            return false;
        }
        // SAFETY: queries only.
        unsafe {
            let root = GetAncestor(h, GA_ROOT);
            let mut pid = 0u32;
            GetWindowThreadProcessId(if root.is_invalid() { h } else { root }, Some(&mut pid));
            pid == own_pid()
        }
    }

    fn point_is_own(pt: POINT) -> bool {
        // SAFETY: query only.
        window_is_own(unsafe { WindowFromPoint(pt) })
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            let down = matches!(
                wparam.0 as u32,
                WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
            );
            match mouse_hook_verdict(ms.dwExtraInfo, point_is_own(ms.pt), down) {
                HookVerdict::Drop => {
                    REFUSED.fetch_add(1, Ordering::SeqCst);
                    return LRESULT(1);
                }
                HookVerdict::PassPhysical => LAST_PHYSICAL_MS.store(now_ms(), Ordering::SeqCst),
                HookVerdict::Pass => {}
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    unsafe extern "system" fn key_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            if key_hook_drops(kb.dwExtraInfo, window_is_own(GetForegroundWindow())) {
                REFUSED.fetch_add(1, Ordering::SeqCst);
                return LRESULT(1);
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    pub(super) fn hook_thread(tx: std::sync::mpsc::Sender<u32>) {
        // SAFETY: hooks are installed and removed on this thread, which pumps messages.
        unsafe {
            let _ = tx.send(GetCurrentThreadId());
            let hmod = GetModuleHandleW(None).ok();
            let hinst = windows::Win32::Foundation::HINSTANCE(
                hmod.map(|m| m.0).unwrap_or(std::ptr::null_mut()),
            );
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hinst, 0);
            let key = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_proc), hinst, 0);
            INSTALLED.store(mouse.is_ok() && key.is_ok(), Ordering::SeqCst);
            tracing::info!(
                installed = INSTALLED.load(Ordering::SeqCst),
                "input self-defence hooks (WH_MOUSE_LL, WH_KEYBOARD_LL)"
            );
            if !INSTALLED.load(Ordering::SeqCst) {
                tracing::warn!("input self-defence hooks not installed: grant prompts fail closed");
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            INSTALLED.store(false, Ordering::SeqCst);
            if let Ok(m) = mouse {
                let _ = UnhookWindowsHookEx(m);
            }
            if let Ok(k) = key {
                let _ = UnhookWindowsHookEx(k);
            }
        }
    }

    pub(super) fn stop(thread_id: u32) {
        if thread_id != 0 {
            // SAFETY: posting WM_QUIT to our own hook thread.
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}
