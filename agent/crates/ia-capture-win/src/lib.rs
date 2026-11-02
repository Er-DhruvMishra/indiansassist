//! Windows screen capture (contract §4). The canvas / ladder scaling math ([`canvas`]), the
//! BGRA->I420 colour conversion ([`convert`]) and the ladder downscale ([`scale`]) are pure and
//! live in `ia-frame` (Phase E §7.2), re-exported here so no Windows caller changes; monitor
//! enumeration and GDI/DXGI capture ([`enumerate`], [`gdi`], [`dxgi`]) are compiled under
//! `winapi`.

pub use ia_frame::{canvas, convert, scale};

#[cfg(all(windows, feature = "winapi"))]
pub mod dxgi;
#[cfg(all(windows, feature = "winapi"))]
pub mod enumerate;
#[cfg(all(windows, feature = "winapi"))]
pub mod gdi;
