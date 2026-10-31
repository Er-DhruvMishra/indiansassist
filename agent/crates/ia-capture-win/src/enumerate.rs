//! Monitor enumeration (contract §3.6 convention: `EnumDisplayMonitors` order, primary
//! first, ids 1..16). Compiled under `winapi`; CI-built on Windows.

use ia_core::types::MonitorInfo;
use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;

struct Raw {
    rect: RECT,
    primary: bool,
    device: String,
    scale: f32,
}

unsafe extern "system" fn cb(hmon: HMONITOR, _hdc: HDC, _rc: *mut RECT, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<Raw>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(hmon, &mut info.monitorInfo as *mut _).as_bool() {
        let device = String::from_utf16_lossy(&info.szDevice)
            .trim_end_matches('\u{0}')
            .to_string();
        let primary = info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0;
        let dpi_x = monitor_dpi(hmon).unwrap_or(96);
        out.push(Raw {
            rect: info.monitorInfo.rcMonitor,
            primary,
            device,
            scale: (dpi_x as f32 / 96.0 * 100.0).round() / 100.0,
        });
    }
    TRUE
}

/// `GetDpiForMonitor(MDT_EFFECTIVE_DPI)` from `shcore.dll`, late-bound through
/// `ia_platform::sys_lib` (contract §11.3 / §14: the windows crate would import it from the
/// `api-ms-win-shcore-scaling` API set, which is not a KnownDLL).
fn monitor_dpi(hmon: HMONITOR) -> Option<u32> {
    use std::sync::OnceLock;
    type GetDpiForMonitorFn = unsafe extern "system" fn(HMONITOR, i32, *mut u32, *mut u32) -> i32;
    // The library stays loaded for the process lifetime once resolved.
    static PROC: OnceLock<Option<(ia_platform::win::SysLib, GetDpiForMonitorFn)>> = OnceLock::new();
    let (_, f) = PROC
        .get_or_init(|| {
            let lib = ia_platform::sys_lib("shcore.dll").ok()?;
            let p = lib.proc("GetDpiForMonitor")?;
            // SAFETY: the symbol is GetDpiForMonitor with this documented signature.
            let f: GetDpiForMonitorFn = unsafe { std::mem::transmute(p) };
            Some((lib, f))
        })
        .as_ref()?;
    const MDT_EFFECTIVE_DPI: i32 = 0;
    let (mut x, mut y) = (96u32, 96u32);
    // SAFETY: hmon is a live monitor handle from EnumDisplayMonitors; x/y are valid out params.
    let hr = unsafe { f(hmon, MDT_EFFECTIVE_DPI, &mut x, &mut y) };
    (hr == 0).then_some(x)
}

/// Make the process per-monitor DPI aware (V2) once, before monitors are enumerated or any
/// window exists. A DPI-unaware process sees virtualised monitor rectangles (1536 x 864 for a
/// 1920 x 1080 panel at 125 %) while Desktop Duplication delivers physical pixels, so the
/// monitor geometry, the encoder size and the input mapping would disagree. winit would set the
/// same context when its event loop starts; setting it first changes nothing for the UI.
pub fn ensure_per_monitor_dpi_awareness() {
    use std::sync::Once;
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: a process-wide flag; failure (already set, e.g. by a manifest) is harmless.
        let _ =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    });
}

/// Enumerate monitors into [`MonitorInfo`]s with ids assigned primary-first.
pub fn enumerate() -> Vec<MonitorInfo> {
    ensure_per_monitor_dpi_awareness();
    let mut raws: Vec<Raw> = Vec::new();
    // SAFETY: the callback stores into `raws` through the LPARAM for the call's duration.
    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(cb),
            LPARAM(&mut raws as *mut _ as isize),
        );
    }
    // Primary first (contract convention), then EnumDisplayMonitors order.
    raws.sort_by_key(|r| !r.primary);
    raws.iter()
        .enumerate()
        .map(|(i, r)| MonitorInfo {
            id: (i + 1) as u32,
            name: r.device.clone(),
            primary: r.primary,
            x: r.rect.left,
            y: r.rect.top,
            width: (r.rect.right - r.rect.left).max(0) as u32,
            height: (r.rect.bottom - r.rect.top).max(0) as u32,
            scale: r.scale,
            mid: None,
        })
        .collect()
}

#[cfg(test)]
mod win_tests {
    use super::enumerate;

    /// DXGI/GDI enumeration smoke (contract §15.2): enumerate the real monitors and check
    /// the id/ordering invariants. Skipped on a headless runner with no monitor.
    #[test]
    fn enumeration_ids_are_primary_first_and_contiguous() {
        let monitors = enumerate();
        if monitors.is_empty() {
            eprintln!("no monitor present; skipping enumeration smoke");
            return;
        }
        // Ids are 1..=n in order.
        for (i, m) in monitors.iter().enumerate() {
            assert_eq!(m.id, (i + 1) as u32, "ids are assigned 1..n in order");
            assert!(m.id >= 1 && m.id <= 16);
        }
        // The first monitor is the primary (contract §3.6 convention).
        assert!(monitors[0].primary, "primary monitor sorts first");
        assert_eq!(monitors.iter().filter(|m| m.primary).count(), 1);
    }
}
