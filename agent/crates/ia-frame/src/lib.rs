//! The pure frame code shared by every capturer (Phase E contract §7.2): [`convert`]
//! (BGRA->I420, BT.601), [`scale`] (the I420 ladder downscale) and [`canvas`] (the recorder
//! canvas and letterbox math). It moved here from `ia-capture-win`, which re-exports it
//! (`pub use ia_frame::{canvas, convert, scale};`), so no Windows caller changed; the Linux
//! X11 capturer (`ia-capture-x11`) uses the same code. No platform calls: built and tested on
//! every host.

pub mod canvas;
pub mod convert;
pub mod scale;
