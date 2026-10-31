//! Win32 window treatment for the agent's own windows (contract §3.5): find the eframe HWNDs
//! by title within this process, make the pill a `WS_EX_TOPMOST | WS_EX_TOOLWINDOW |
//! WS_EX_NOACTIVATE` tool window, exclude the pill and the panel from capture
//! (`WDA_EXCLUDEFROMCAPTURE`), re-assert `HWND_TOPMOST` / visibility every 2 s and re-dock the
//! pill top-centre of the primary monitor if it leaves the visible desktop.

use windows::Win32::Foundation::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONULL};
use windows::Win32::System::Diagnostics::Debug::MessageBeep;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, SetWindowDisplayAffinity,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST,
    MB_ICONASTERISK, SM_CXSCREEN, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SW_HIDE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
};

/// An HWND as a plain integer (so UI state stays `Send`-agnostic).
pub type RawHwnd = isize;

fn hwnd(h: RawHwnd) -> HWND {
    HWND(h as *mut core::ffi::c_void)
}

struct FindCtx {
    pid: u32,
    title: Vec<u16>,
    found: Option<RawHwnd>,
}

unsafe extern "system" fn enum_cb(h: HWND, lp: LPARAM) -> BOOL {
    let ctx = &mut *(lp.0 as *mut FindCtx);
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, Some(&mut pid));
    if pid == ctx.pid {
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(h, &mut buf) as usize;
        if buf[..n] == ctx.title[..] {
            ctx.found = Some(h.0 as RawHwnd);
            return false.into();
        }
    }
    true.into()
}

/// The top-level window of this process whose title is exactly `title`.
pub fn find_own_window(title: &str) -> Option<RawHwnd> {
    let mut ctx = FindCtx {
        pid: std::process::id(),
        title: title.encode_utf16().collect(),
        found: None,
    };
    // SAFETY: the callback only touches `ctx`, which outlives the call.
    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut ctx as *mut FindCtx as isize));
    }
    ctx.found
}

fn set_ex_style(h: RawHwnd, add: u32, remove: u32) {
    // SAFETY: plain style read/write on a window of this process.
    unsafe {
        let ex = GetWindowLongPtrW(hwnd(h), GWL_EXSTYLE) as u32;
        let new = (ex | add) & !remove;
        if new != ex {
            SetWindowLongPtrW(hwnd(h), GWL_EXSTYLE, new as isize);
        }
    }
}

/// Whether the pill and panel are excluded from capture. Always in a release build; a `dev`
/// build lets `IA_DEV_SHOW_INDICATOR_IN_CAPTURE=1` turn it off for manual screenshots.
pub fn capture_exclusion_enabled() -> bool {
    #[cfg(feature = "dev")]
    {
        std::env::var_os("IA_DEV_SHOW_INDICATOR_IN_CAPTURE").is_none()
    }
    #[cfg(not(feature = "dev"))]
    {
        true
    }
}

/// `WDA_EXCLUDEFROMCAPTURE` (Windows 10 2004+); `false` on older systems (captured, accepted).
pub fn exclude_from_capture(h: RawHwnd) -> bool {
    if !capture_exclusion_enabled() {
        return false;
    }
    // SAFETY: affinity change on a window of this process.
    unsafe { SetWindowDisplayAffinity(hwnd(h), WDA_EXCLUDEFROMCAPTURE).is_ok() }
}

/// Turn the morphed root window into the pill: a topmost, non-activating tool window (no
/// taskbar button), excluded from capture.
pub fn style_pill(h: RawHwnd) {
    set_ex_style(
        h,
        WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_TOPMOST.0,
        WS_EX_APPWINDOW.0,
    );
    // SAFETY: re-show so the taskbar drops the button; then topmost without activation.
    unsafe {
        let _ = ShowWindow(hwnd(h), SW_HIDE);
        let _ = ShowWindow(hwnd(h), SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(
            hwnd(h),
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
    exclude_from_capture(h);
}

/// Back to a normal window (the ended view).
pub fn unstyle_pill(h: RawHwnd) {
    set_ex_style(
        h,
        WS_EX_APPWINDOW.0,
        WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_TOPMOST.0,
    );
    // SAFETY: as above.
    unsafe {
        let _ = SetWindowPos(
            hwnd(h),
            HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
        );
    }
}

/// The panel: a topmost tool window (activatable: chat text is typed here), excluded from
/// capture.
pub fn style_panel(h: RawHwnd) {
    set_ex_style(h, WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0, WS_EX_APPWINDOW.0);
    exclude_from_capture(h);
    reassert_topmost(h);
}

/// Re-assert `HWND_TOPMOST` (full-screen apps reorder it) and re-show a hidden window.
pub fn reassert_topmost(h: RawHwnd) {
    // SAFETY: z-order / visibility on a window of this process.
    unsafe {
        if !IsWindowVisible(hwnd(h)).as_bool() {
            let _ = ShowWindow(hwnd(h), SW_SHOWNOACTIVATE);
        }
        let _ = SetWindowPos(
            hwnd(h),
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Whether the window is on no monitor at all (dragged off, display removed).
pub fn is_offscreen(h: RawHwnd) -> bool {
    // SAFETY: query only.
    unsafe { MonitorFromWindow(hwnd(h), MONITOR_DEFAULTTONULL).is_invalid() }
}

/// The window rect in physical pixels.
pub fn window_rect(h: RawHwnd) -> Option<(i32, i32, i32, i32)> {
    let mut r = RECT::default();
    // SAFETY: query only.
    unsafe { GetWindowRect(hwnd(h), &mut r).ok()? };
    Some((r.left, r.top, r.right, r.bottom))
}

/// Dock top-centre of the primary monitor (8 px from the top), keeping the size.
pub fn dock_top_centre(h: RawHwnd) {
    let Some((l, _, r, _)) = window_rect(h) else {
        return;
    };
    // SAFETY: metrics query and a move without activation.
    unsafe {
        let screen_w = GetSystemMetrics(SM_CXSCREEN);
        let x = (screen_w - (r - l)) / 2;
        let _ = SetWindowPos(
            hwnd(h),
            HWND_TOPMOST,
            x.max(0),
            8,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Bring the consent window to the front once (a user-started process may steal focus once).
pub fn bring_to_front(h: RawHwnd) {
    // SAFETY: plain call.
    unsafe {
        let _ = SetForegroundWindow(hwnd(h));
    }
}

/// The short system sound at `active` and at hand-over (`MB_ICONASTERISK`, §3.5).
pub fn beep() {
    // SAFETY: plain call.
    unsafe {
        let _ = MessageBeep(MB_ICONASTERISK);
    }
}
