//! Monitor enumeration (contract §3.6 convention: `EnumDisplayMonitors` order, primary
//! first, ids 1..16). Compiled under `winapi`; CI-built on Windows.

use ia_core::types::MonitorInfo;
use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
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
        let mut dpi_x = 96u32;
        let mut dpi_y = 96u32;
        let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        out.push(Raw {
            rect: info.monitorInfo.rcMonitor,
            primary,
            device,
            scale: (dpi_x as f32 / 96.0 * 100.0).round() / 100.0,
        });
    }
    TRUE
}

/// Enumerate monitors into [`MonitorInfo`]s with ids assigned primary-first.
pub fn enumerate() -> Vec<MonitorInfo> {
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
