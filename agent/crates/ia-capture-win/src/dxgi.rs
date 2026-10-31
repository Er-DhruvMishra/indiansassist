//! DXGI Desktop Duplication capture, the primary path (contract §4.1), with the per-monitor
//! "3 DDA failures in 5 s => GDI" fallback decided by `ia_core::capture_decision`.
//!
//! `dxgi.dll` and `d3d11.dll` are not KnownDLLs, so their two entry points
//! (`CreateDXGIFactory1`, `D3D11CreateDevice`) are late-bound through `ia_platform::sys_lib`
//! (`LOAD_LIBRARY_SEARCH_SYSTEM32`, §14); everything after that is COM vtable calls, so the
//! exe imports neither library. Each consented monitor is matched to its DXGI output by
//! device name (`\\.\DISPLAYn`), duplicated on a D3D11 device of its adapter, and every
//! acquired frame is copied to a CPU-readable staging texture and converted BGRA -> I420.
//! `DXGI_ERROR_WAIT_TIMEOUT` (nothing changed) re-sends the last frame so the stream keeps
//! moving; `DXGI_ERROR_ACCESS_LOST` (mode change, secure desktop, full-screen app) and other
//! failures drop the duplication and count towards the fallback; a monitor that fell back is
//! captured with GDI for the rest of the session.

use std::collections::HashMap;
use std::ffi::c_void;
use std::time::Instant;

use ia_core::capture_decision::DxgiHealth;
use ia_core::types::{CapturePath, MonitorInfo};
use ia_platform::traits::{Capturer, Frame};
use windows::core::{Interface, GUID, HRESULT};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
    IDXGIResource, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};

use crate::convert::bgra_to_i420;
use crate::enumerate::enumerate;
use crate::gdi::GdiCapturer;

type CreateFactory1Fn = unsafe extern "system" fn(*const GUID, *mut *mut c_void) -> HRESULT;
#[allow(clippy::upper_case_acronyms)]
type D3D11CreateDeviceFn = unsafe extern "system" fn(
    *mut c_void,              // IDXGIAdapter*
    i32,                      // D3D_DRIVER_TYPE
    HMODULE,                  // Software
    u32,                      // Flags
    *const D3D_FEATURE_LEVEL, // pFeatureLevels
    u32,                      // FeatureLevels
    u32,                      // SDKVersion
    *mut *mut c_void,         // ID3D11Device**
    *mut D3D_FEATURE_LEVEL,   // pFeatureLevel
    *mut *mut c_void,         // ID3D11DeviceContext**
) -> HRESULT;

/// One monitor's duplication.
struct Dup {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    dup: IDXGIOutputDuplication,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
}

/// The late-bound entry points (the libraries stay loaded while the capturer lives).
struct Entry {
    create_factory: CreateFactory1Fn,
    create_device: D3D11CreateDeviceFn,
    _dxgi: ia_platform::win::SysLib,
    _d3d11: ia_platform::win::SysLib,
}

// SAFETY: module handles and function pointers are process-wide and thread-agnostic.
unsafe impl Send for Entry {}

impl Entry {
    fn load() -> Option<Entry> {
        let dxgi = ia_platform::sys_lib("dxgi.dll").ok()?;
        let d3d11 = ia_platform::sys_lib("d3d11.dll").ok()?;
        let f = dxgi.proc("CreateDXGIFactory1")?;
        let d = d3d11.proc("D3D11CreateDevice")?;
        // SAFETY: the documented signatures of the two exports.
        unsafe {
            Some(Entry {
                create_factory: std::mem::transmute::<*const c_void, CreateFactory1Fn>(f),
                create_device: std::mem::transmute::<*const c_void, D3D11CreateDeviceFn>(d),
                _dxgi: dxgi,
                _d3d11: d3d11,
            })
        }
    }
}

/// DXGI-first capturer with the per-monitor GDI fallback.
pub struct DxgiCapturer {
    monitors: Vec<MonitorInfo>,
    dups: HashMap<u32, Dup>,
    health: HashMap<u32, DxgiHealth>,
    last: HashMap<u32, Frame>,
    gdi: GdiCapturer,
    epoch: Instant,
    // Declared last: dropped after every COM object above.
    entry: Option<Entry>,
}

impl Default for DxgiCapturer {
    fn default() -> Self {
        Self::new()
    }
}

fn clone_frame(f: &Frame) -> Frame {
    Frame {
        width: f.width,
        height: f.height,
        y: f.y.clone(),
        u: f.u.clone(),
        v: f.v.clone(),
        y_stride: f.y_stride,
        uv_stride: f.uv_stride,
    }
}

impl DxgiCapturer {
    pub fn new() -> Self {
        let entry = Entry::load();
        if entry.is_none() {
            tracing::warn!("DXGI / D3D11 not available: every monitor uses GDI");
        }
        Self {
            monitors: enumerate(),
            dups: HashMap::new(),
            health: HashMap::new(),
            last: HashMap::new(),
            gdi: GdiCapturer::new(),
            epoch: Instant::now(),
            entry,
        }
    }

    /// The path a monitor is captured with right now (`agent.stats.capturePath`, §4.4).
    pub fn path(&self, monitor_id: u32) -> CapturePath {
        if self.entry.is_none() {
            return CapturePath::Gdi;
        }
        self.health
            .get(&monitor_id)
            .map(|h| h.path())
            .unwrap_or(CapturePath::Dda)
    }

    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    fn fail(&mut self, id: u32, why: &str) {
        self.dups.remove(&id);
        let now = self.now_ms();
        let h = self.health.entry(id).or_default();
        if h.record_failure(now).is_some() {
            tracing::warn!(
                monitor = id,
                why,
                "desktop duplication failed 3 times in 5 s: GDI fallback"
            );
        } else {
            tracing::debug!(monitor = id, why, "desktop duplication failure");
        }
    }

    /// Create the duplication for the monitor whose device name matches.
    fn open(&self, m: &MonitorInfo) -> Option<Dup> {
        let entry = self.entry.as_ref()?;
        // SAFETY: COM objects are created through the late-bound entry points and owned by
        // the returned wrappers; out-pointers are valid for each call.
        unsafe {
            let mut raw: *mut c_void = std::ptr::null_mut();
            (entry.create_factory)(&IDXGIFactory1::IID, &mut raw)
                .ok()
                .ok()?;
            let factory = IDXGIFactory1::from_raw(raw);
            let mut ai = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(ai) {
                ai += 1;
                let mut oi = 0u32;
                while let Ok(output) = adapter.EnumOutputs(oi) {
                    oi += 1;
                    let Ok(desc) = output.GetDesc() else { continue };
                    let name = String::from_utf16_lossy(&desc.DeviceName)
                        .trim_end_matches('\u{0}')
                        .to_string();
                    if !name.eq_ignore_ascii_case(&m.name) {
                        continue;
                    }
                    let output1: IDXGIOutput1 = output.cast().ok()?;
                    let (device, ctx) = Self::device_for(entry, &adapter)?;
                    let dup = output1.DuplicateOutput(&device).ok()?;
                    return Some(Dup {
                        device,
                        ctx,
                        dup,
                        staging: None,
                    });
                }
            }
            None
        }
    }

    unsafe fn device_for(
        entry: &Entry,
        adapter: &IDXGIAdapter1,
    ) -> Option<(ID3D11Device, ID3D11DeviceContext)> {
        let adapter: IDXGIAdapter = adapter.cast().ok()?;
        let mut dev: *mut c_void = std::ptr::null_mut();
        let mut ctx: *mut c_void = std::ptr::null_mut();
        let mut level = D3D_FEATURE_LEVEL::default();
        (entry.create_device)(
            adapter.as_raw(),
            D3D_DRIVER_TYPE_UNKNOWN.0,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT.0,
            std::ptr::null(),
            0,
            D3D11_SDK_VERSION,
            &mut dev,
            &mut level,
            &mut ctx,
        )
        .ok()
        .ok()?;
        if dev.is_null() || ctx.is_null() {
            return None;
        }
        Some((
            ID3D11Device::from_raw(dev),
            ID3D11DeviceContext::from_raw(ctx),
        ))
    }

    /// Acquire one frame. `Ok(None)` = nothing new (timeout).
    fn acquire(d: &mut Dup) -> windows::core::Result<Option<Frame>> {
        // SAFETY: the acquired frame is released on every path; the staging texture is
        // mapped and unmapped around the copy; the BGRA buffer matches width * height * 4.
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            match d.dup.AcquireNextFrame(16, &mut info, &mut res) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
                Err(e) => return Err(e),
            }
            let result = (|| -> windows::core::Result<Option<Frame>> {
                if info.LastPresentTime == 0 {
                    return Ok(None); // only the pointer moved
                }
                let Some(res) = res.as_ref() else {
                    return Ok(None);
                };
                let tex: ID3D11Texture2D = res.cast()?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                tex.GetDesc(&mut desc);
                let (w, h) = (desc.Width, desc.Height);
                let need_new = !matches!(&d.staging, Some((_, sw, sh)) if *sw == w && *sh == h);
                if need_new {
                    let sdesc = D3D11_TEXTURE2D_DESC {
                        Width: w,
                        Height: h,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_STAGING,
                        BindFlags: 0,
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        MiscFlags: 0,
                    };
                    let mut st: Option<ID3D11Texture2D> = None;
                    d.device.CreateTexture2D(&sdesc, None, Some(&mut st))?;
                    d.staging = st.map(|t| (t, w, h));
                }
                let Some((staging, _, _)) = d.staging.as_ref() else {
                    return Ok(None);
                };
                d.ctx.CopyResource(staging, &tex);
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                d.ctx
                    .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                let pitch = mapped.RowPitch as usize;
                let src = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * h as usize);
                let (ew, eh) = (w & !1, h & !1);
                let frame = bgra_to_i420(src, ew, eh, pitch);
                d.ctx.Unmap(staging, 0);
                Ok(Some(frame))
            })();
            let _ = d.dup.ReleaseFrame();
            result
        }
    }
}

impl Capturer for DxgiCapturer {
    fn enumerate(&self) -> Vec<MonitorInfo> {
        self.monitors.clone()
    }

    fn next_frame(&mut self, monitor_id: u32) -> Option<Frame> {
        if self.path(monitor_id) == CapturePath::Gdi {
            return self.gdi.next_frame(monitor_id);
        }
        if !self.dups.contains_key(&monitor_id) {
            let m = self.monitors.iter().find(|m| m.id == monitor_id)?.clone();
            match self.open(&m) {
                Some(d) => {
                    tracing::info!(monitor = monitor_id, "desktop duplication started");
                    self.dups.insert(monitor_id, d);
                }
                None => {
                    self.fail(monitor_id, "duplicate_output");
                    return self.last.get(&monitor_id).map(clone_frame);
                }
            }
        }
        let d = self.dups.get_mut(&monitor_id)?;
        match Self::acquire(d) {
            Ok(Some(frame)) => {
                self.health.entry(monitor_id).or_default().record_success();
                self.last.insert(monitor_id, clone_frame(&frame));
                Some(frame)
            }
            Ok(None) => self.last.get(&monitor_id).map(clone_frame),
            Err(e) => {
                self.fail(monitor_id, &format!("{:?}", e.code()));
                self.last.get(&monitor_id).map(clone_frame)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captures one frame of the primary monitor into memory (nothing is saved) and checks
    /// its geometry. Skipped when there is no monitor or the desktop cannot be duplicated
    /// (locked workstation, RDP without a console session): then the GDI fallback is used.
    #[test]
    fn primary_monitor_frame_or_gdi_fallback() {
        let mut c = DxgiCapturer::new();
        let Some(primary) = c.enumerate().into_iter().find(|m| m.primary) else {
            eprintln!("no monitor; skipping");
            return;
        };
        let mut got = None;
        for _ in 0..30 {
            if let Some(f) = c.next_frame(primary.id) {
                got = Some(f);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let path = c.path(primary.id);
        eprintln!("capture path: {path:?}");
        if let Some(f) = got {
            assert!(f.width >= 2 && f.height >= 2);
            assert_eq!(f.y.len(), f.y_stride * f.height as usize);
            if path == CapturePath::Dda {
                assert!(
                    f.width.abs_diff(primary.width) <= 1,
                    "{} vs {}",
                    f.width,
                    primary.width
                );
            }
        } else {
            eprintln!("no frame from DXGI or GDI (locked desktop?); skipping");
        }
    }
}
