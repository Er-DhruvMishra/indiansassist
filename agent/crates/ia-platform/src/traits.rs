//! The platform traits (contract §11.1). Implementations are Windows-only in Phase C.

use ia_core::types::MonitorInfo;

/// A captured frame handed to the encoder (I420 planar; strides in bytes).
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
    pub y_stride: usize,
    pub uv_stride: usize,
}

/// Screen capture of one or more monitors (DXGI/GDI on Windows, §4.1).
pub trait Capturer: Send {
    fn enumerate(&self) -> Vec<MonitorInfo>;
    /// Grab the next frame for `monitor_id`, or `None` if nothing changed (dirty-rect aware).
    fn next_frame(&mut self, monitor_id: u32) -> Option<Frame>;
}

/// OS-level input injection (`SendInput` on Windows, §5).
pub trait InputSink: Send {
    fn pointer(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32, action: PointerAction);
    fn scroll(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32, dx: i32, dy: i32);
    /// Inject a key by W3C `code` (scancode path, §5.4).
    fn key(&mut self, code: &str, action: KeyAction, modifiers: ia_core::types::Modifiers);
    /// Type Unicode text (`KEYEVENTF_UNICODE`, §5.4).
    fn text(&mut self, text: &str);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerAction {
    Move,
    Down(u8),
    Up(u8),
    Click(u8),
    DblClick(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Down,
    Up,
    Press,
}

/// Clipboard text bridge (both ways, §5.6).
pub trait ClipboardBridge: Send {
    fn set_text(&mut self, text: &str);
    /// Poll for a Desk-originated clipboard change (debounced upstream).
    fn take_update(&mut self) -> Option<String>;
}

/// Just-in-time elevation hand-over (§7).
pub trait Elevation {
    /// Current process integrity (`user`/`admin`).
    fn integrity(&self) -> ia_core::types::ElevationLevel;
    /// Relaunch elevated and hand the session over; returns once the child has connected
    /// or the attempt failed.
    fn relaunch_and_handover(&mut self, blob: &HandoverBlob) -> Result<(), ElevationError>;
}

/// The parent→child hand-over blob written over the named pipe (§7.2).
#[derive(Debug, Clone)]
pub struct HandoverBlob {
    pub handover: String,
    pub token: String,
    pub api_origin: String,
    pub signal_url: String,
    pub session_id: String,
    pub image_sha256: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ElevationError {
    #[error("user cancelled UAC")]
    UacCancelled,
    #[error("launch failed")]
    LaunchFailed,
    #[error("image mismatch")]
    ImageMismatch,
    #[error("connect failed")]
    ConnectFailed,
}

/// Self-delete on exit (§10).
pub trait SelfDelete {
    /// Remove the working dir, sidecar and HKCU keys, then schedule the exe for deletion.
    fn self_delete(&self, kept: bool) -> std::io::Result<()>;
}

/// The HKCU `indiansassist://` protocol handler (§2.5 L1).
pub trait ProtocolHandler {
    fn register(&self, exe_path: &str) -> std::io::Result<()>;
    fn unregister(&self) -> std::io::Result<()>;
}

/// Known-folder resolution (`%USERPROFILE%\Downloads`, `%LOCALAPPDATA%`, …, §6.1 F3).
pub trait KnownFolders {
    fn downloads(&self) -> Option<std::path::PathBuf>;
    fn local_app_data(&self) -> Option<std::path::PathBuf>;
}
