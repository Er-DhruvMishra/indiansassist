//! Monitor enumeration (contract §3.6 convention: `EnumDisplayMonitors` order, primary
//! first, ids 1..16). Compiled under `winapi`; CI-built on Windows.

use ia_core::types::MonitorInfo;
use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW, MONITORINFOF_PRIMARY,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

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
