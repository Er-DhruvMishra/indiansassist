//! Windows screen capture (contract §4). The canvas / ladder scaling math ([`canvas`]) and
//! the BGRA->I420 colour conversion ([`convert`]) are pure and tested on any target;
//! monitor enumeration and GDI/DXGI capture ([`enumerate`], [`gdi`]) are compiled under
//! `winapi`.

pub mod canvas;
pub mod convert;

#[cfg(all(windows, feature = "winapi"))]
pub mod enumerate;
#[cfg(all(windows, feature = "winapi"))]
pub mod gdi;
