//! The macOS input sink (Phase F §17.2): Quartz events posted at `kCGHIDEventTap`, compiled under
//! `cfg(all(target_os = "macos", feature = "macos"))`.
//!
//! * Pointer: `CGEventCreateMouseEvent` at the global point of [`crate::mapping::to_global`],
//!   with drags as their own event types and the click count in `kCGMouseEventClickState`.
//! * Keys: `CGEventCreateKeyboardEvent` with the virtual key of [`crate::keymap`]. Quartz takes a
//!   synthetic event's modifiers from its flags, not from earlier events, so the sink tracks the
//!   modifier keys it holds down and stamps their flags on every key and mouse event (that is
//!   what makes ⌘C and ⌘-click work); a modifier key itself is posted as `kCGEventFlagsChanged`.
//! * Text: Unicode keyboard events of at most 20 UTF-16 units ([`crate::text`]).
//! * Guard (C §3.5, E 7.3c): pointer and scroll are refused over the agent's own on-screen
//!   windows, keys and text while the agent is the active application ([`crate::guard`]).
//!
//! Posting needs the Accessibility grant (`AXIsProcessTrusted`); without it Quartz drops the
//! events silently, which is why the agent advertises `input` only when it is granted (§17.2).
//! `block_local_input` keeps the trait default `false` (no `os.input_lock` on macOS).

use ia_core::types::{Modifiers, MonitorInfo};
use ia_platform::traits::{InputSink, KeyAction, PointerAction};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSRunningApplication;
use objc2_core_foundation::{CFArray, CGPoint};
use objc2_core_graphics::{
    kCGNullWindowID, CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventType,
    CGMouseButton, CGScrollEventUnit, CGWindowListCopyWindowInfo, CGWindowListOption,
};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};

use crate::guard::{keyboard_refused, pointer_refused, AgentWindow};
use crate::keymap::{modifier_for_code, vk_for_code, Modifier};
use crate::mapping::{mac_button, move_type, to_global, wheel, MacButton};
use crate::text::utf16_chunks;

/// The CGEvent input sink. Not `Sync`; the control server owns one per session.
#[derive(Default)]
pub struct MacInput {
    held_buttons: Vec<MacButton>,
    /// Modifier keys held down by this sink, by W3C code (left and right count separately).
    held_modifiers: Vec<(String, Modifier)>,
    last_point: (f64, f64),
}

impl MacInput {
    pub fn new() -> Self {
        Self::default()
    }

    fn flags(&self) -> CGEventFlags {
        let bits = self
            .held_modifiers
            .iter()
            .fold(0u64, |acc, (_, m)| acc | m.flag());
        CGEventFlags(bits)
    }

    fn post_mouse(&self, kind: u32, point: (f64, f64), button: u32, clicks: i64) {
        let at = CGPoint {
            x: point.0,
            y: point.1,
        };
        let Some(ev) = CGEvent::new_mouse_event(None, CGEventType(kind), at, CGMouseButton(button))
        else {
            return;
        };
        CGEvent::set_flags(Some(&ev), self.flags());
        if clicks > 0 {
            CGEvent::set_integer_value_field(Some(&ev), CGEventField::MouseEventClickState, clicks);
        }
        if button > 2 {
            CGEvent::set_integer_value_field(
                Some(&ev),
                CGEventField::MouseEventButtonNumber,
                i64::from(button),
            );
        }
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&ev));
    }

    fn move_to(&mut self, point: (f64, f64)) {
        let button = self.held_buttons.first().map_or(0, |b| b.number);
        self.post_mouse(move_type(&self.held_buttons), point, button, 0);
        self.last_point = point;
    }

    fn press(&mut self, b: MacButton, point: (f64, f64), clicks: i64) {
        self.post_mouse(b.down, point, b.number, clicks);
        if !self.held_buttons.contains(&b) {
            self.held_buttons.push(b);
        }
    }

    fn release(&mut self, b: MacButton, point: (f64, f64), clicks: i64) {
        self.post_mouse(b.up, point, b.number, clicks);
        self.held_buttons.retain(|h| *h != b);
    }

    fn post_key(&self, vk: u16, down: bool, flags_changed: bool) {
        let Some(ev) = CGEvent::new_keyboard_event(None, vk, down) else {
            return;
        };
        if flags_changed {
            CGEvent::set_type(Some(&ev), CGEventType::FlagsChanged);
        }
        CGEvent::set_flags(Some(&ev), self.flags());
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&ev));
    }

    fn key_down(&mut self, code: &str, vk: u16) {
        match modifier_for_code(code) {
            Some(m) => {
                if !self.held_modifiers.iter().any(|(c, _)| c == code) {
                    self.held_modifiers.push((code.to_string(), m));
                }
                self.post_key(vk, true, true);
            }
            None => self.post_key(vk, true, false),
        }
    }

    fn key_up(&mut self, code: &str, vk: u16) {
        match modifier_for_code(code) {
            Some(_) => {
                self.held_modifiers.retain(|(c, _)| c != code);
                self.post_key(vk, false, true);
            }
            None => self.post_key(vk, false, false),
        }
    }
}

impl InputSink for MacInput {
    fn pointer(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32, action: PointerAction) {
        let p = to_global(monitor, nx, ny);
        if p != self.last_point || matches!(action, PointerAction::Move) {
            self.move_to(p);
        }
        match action {
            PointerAction::Move => {}
            PointerAction::Down(b) => {
                if let Some(b) = mac_button(b) {
                    self.press(b, p, 1);
                }
            }
            PointerAction::Up(b) => {
                if let Some(b) = mac_button(b) {
                    self.release(b, p, 1);
                }
            }
            PointerAction::Click(b) => {
                if let Some(b) = mac_button(b) {
                    self.press(b, p, 1);
                    self.release(b, p, 1);
                }
            }
            PointerAction::DblClick(b) => {
                if let Some(b) = mac_button(b) {
                    self.press(b, p, 1);
                    self.release(b, p, 1);
                    self.press(b, p, 2);
                    self.release(b, p, 2);
                }
            }
        }
    }

    fn scroll(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32, dx: i32, dy: i32) {
        let p = to_global(monitor, nx, ny);
        if p != self.last_point {
            self.move_to(p);
        }
        let (w1, w2) = wheel(dx, dy);
        if let Some(ev) =
            CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Line, 2, w1, w2, 0)
        {
            CGEvent::set_flags(Some(&ev), self.flags());
            CGEvent::set_location(Some(&ev), CGPoint { x: p.0, y: p.1 });
            CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&ev));
        }
    }

    fn key(&mut self, code: &str, action: KeyAction, _modifiers: Modifiers) {
        let Some(vk) = vk_for_code(code) else {
            return; // unknown codes are refused upstream with bad_args
        };
        match action {
            KeyAction::Down => self.key_down(code, vk),
            KeyAction::Up => self.key_up(code, vk),
            KeyAction::Press => {
                self.key_down(code, vk);
                self.key_up(code, vk);
            }
        }
    }

    fn text(&mut self, text: &str) {
        for chunk in utf16_chunks(text) {
            for down in [true, false] {
                let Some(ev) = CGEvent::new_keyboard_event(None, 0, down) else {
                    return;
                };
                // Typed text is the characters themselves: held modifiers must not turn it into
                // shortcuts, so the flags are cleared.
                CGEvent::set_flags(Some(&ev), CGEventFlags(0));
                // SAFETY: `chunk` is a live UTF-16 buffer of `chunk.len()` units.
                unsafe {
                    CGEvent::keyboard_set_unicode_string(
                        Some(&ev),
                        chunk.len() as _,
                        chunk.as_ptr(),
                    );
                }
                CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&ev));
            }
        }
    }

    fn refuses_pointer(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32) -> bool {
        let (x, y) = to_global(monitor, nx, ny);
        pointer_refused(x, y, &own_windows())
    }

    fn refuses_keyboard(&mut self) -> bool {
        keyboard_refused(NSRunningApplication::currentApplication().isActive())
    }
}

impl Drop for MacInput {
    /// Never leave a button or modifier stuck down when the session ends.
    fn drop(&mut self) {
        let point = self.last_point;
        for b in std::mem::take(&mut self.held_buttons) {
            self.post_mouse(b.up, point, b.number, 1);
        }
        for (code, _) in std::mem::take(&mut self.held_modifiers) {
            if let Some(vk) = vk_for_code(&code) {
                self.post_key(vk, false, true);
            }
        }
    }
}

/// The on-screen windows of this process in global points, from the window server.
pub fn own_windows() -> Vec<AgentWindow> {
    let pid = std::process::id() as i64;
    on_screen_windows(|owner, _| owner == pid)
}

/// The main window of System Settings (bundle `com.apple.systempreferences`, so any language),
/// in global points, when it is on screen: the consent window's permission guide sits beside it.
/// Window bounds and owners need no grant (titles would).
pub fn settings_window() -> Option<AgentWindow> {
    let pids: Vec<i64> = NSRunningApplication::runningApplicationsWithBundleIdentifier(
        &NSString::from_str("com.apple.systempreferences"),
    )
    .iter()
    // `processIdentifier` sits behind objc2-app-kit's `libc` feature; the message is the same.
    // SAFETY: `-[NSRunningApplication processIdentifier]` takes no argument and returns a pid_t.
    .map(|app| {
        let pid: i32 = unsafe { objc2::msg_send![&*app, processIdentifier] };
        i64::from(pid)
    })
    .collect();
    if pids.is_empty() {
        return None;
    }
    on_screen_windows(|owner, layer| layer == 0 && pids.contains(&owner))
        .into_iter()
        // The main window, not a toolbar strip or a sheet's sliver.
        .find(|w| w.height > 200.0 && w.width > 300.0)
}

/// The on-screen windows the window server lists (front to back), kept when `keep(owner pid,
/// layer)` holds, in global points.
fn on_screen_windows(mut keep: impl FnMut(i64, i64) -> bool) -> Vec<AgentWindow> {
    let option =
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(option, kCGNullWindowID) else {
        return Vec::new();
    };
    // SAFETY: CFArray and NSArray are toll-free bridged, and the window list is an array of
    // dictionaries keyed by strings; `list` outlives the borrow.
    let windows: &NSArray<NSDictionary<NSString, AnyObject>> =
        unsafe { &*(&*list as *const CFArray).cast() };
    let number = |d: &NSDictionary<NSString, AnyObject>, key: &str| -> Option<Retained<NSNumber>> {
        d.objectForKey(&NSString::from_str(key))?
            .downcast::<NSNumber>()
            .ok()
    };
    let mut out = Vec::new();
    for w in windows.iter() {
        let owner = number(&w, "kCGWindowOwnerPID").map_or(-1, |n| n.longLongValue());
        let layer = number(&w, "kCGWindowLayer").map_or(-1, |n| n.longLongValue());
        if !keep(owner, layer) {
            continue;
        }
        let Some(bounds) = w
            .objectForKey(&NSString::from_str("kCGWindowBounds"))
            .and_then(|b| b.downcast::<NSDictionary>().ok())
        else {
            continue;
        };
        // SAFETY: the bounds dictionary is keyed by strings with number values.
        let bounds: &NSDictionary<NSString, AnyObject> =
            unsafe { &*(&*bounds as *const NSDictionary).cast() };
        let f = |k: &str| number(bounds, k).map_or(0.0, |n| n.doubleValue());
        out.push(AgentWindow {
            x: f("X"),
            y: f("Y"),
            width: f("Width"),
            height: f("Height"),
            on_screen: number(&w, "kCGWindowIsOnscreen").is_some_and(|n| n.boolValue()),
        });
    }
    out
}
