//! `SendInput`-based injection (contract §5.3-5.4), compiled under `winapi`. Every event
//! carries `dwExtraInfo = IA_INJECT_TAG` so the §3.5 self-defence hooks can recognise it.
//!
//! NOTE: CI-compiled on the Windows targets; not built by the default dev gate here.

use ia_core::types::{Modifiers, MonitorInfo};
use ia_platform::traits::{InputSink, KeyAction, PointerAction};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::mapping::{hwheel_mouse_data, map_to_virtual, wheel_mouse_data, VirtualScreen};
use crate::scancodes::scancode;
use crate::IA_INJECT_TAG;

/// Windows `SendInput` sink.
pub struct WinInput;

impl WinInput {
    fn virtual_screen() -> VirtualScreen {
        // SAFETY: GetSystemMetrics has no preconditions.
        unsafe {
            VirtualScreen {
                x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
            }
        }
    }

    fn send(inputs: &[INPUT]) {
        // SAFETY: inputs is a valid slice of INPUT; size matches.
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: IA_INJECT_TAG,
                },
            },
        }
    }

    fn key_input(scan: u16, extended: bool, up: bool) -> INPUT {
        let mut flags = KEYEVENTF_SCANCODE;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        Self::keybd(0, scan, flags)
    }

    fn unicode_input(unit: u16, up: bool) -> INPUT {
        let mut flags = KEYEVENTF_UNICODE;
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        Self::keybd(0, unit, flags)
    }

    fn keybd(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: IA_INJECT_TAG,
                },
            },
        }
    }

    fn button_flags(button: u8, down: bool) -> MOUSE_EVENT_FLAGS {
        match (button, down) {
            (0, true) => MOUSEEVENTF_LEFTDOWN,
            (0, false) => MOUSEEVENTF_LEFTUP,
            (1, true) => MOUSEEVENTF_MIDDLEDOWN,
            (1, false) => MOUSEEVENTF_MIDDLEUP,
            (2, true) => MOUSEEVENTF_RIGHTDOWN,
            (2, false) => MOUSEEVENTF_RIGHTUP,
            // XBUTTONs would set MOUSEEVENTF_XDOWN/UP with mouseData; left as default here.
            (_, true) => MOUSEEVENTF_LEFTDOWN,
            (_, false) => MOUSEEVENTF_LEFTUP,
        }
    }
}

impl InputSink for WinInput {
    fn pointer(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32, action: PointerAction) {
        let (dx, dy) = map_to_virtual(monitor, nx, ny, Self::virtual_screen());
        let move_flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        let mut inputs = vec![Self::mouse(move_flags, dx, dy, 0)];
        match action {
            PointerAction::Move => {}
            PointerAction::Down(b) => {
                inputs.push(Self::mouse(Self::button_flags(b, true), dx, dy, 0))
            }
            PointerAction::Up(b) => {
                inputs.push(Self::mouse(Self::button_flags(b, false), dx, dy, 0))
            }
            PointerAction::Click(b) => {
                inputs.push(Self::mouse(Self::button_flags(b, true), dx, dy, 0));
                inputs.push(Self::mouse(Self::button_flags(b, false), dx, dy, 0));
            }
            PointerAction::DblClick(b) => {
                for _ in 0..2 {
                    inputs.push(Self::mouse(Self::button_flags(b, true), dx, dy, 0));
                    inputs.push(Self::mouse(Self::button_flags(b, false), dx, dy, 0));
                }
            }
        }
        Self::send(&inputs);
    }

    fn scroll(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32, dx: i32, dy: i32) {
        let (vx, vy) = map_to_virtual(monitor, nx, ny, Self::virtual_screen());
        let move_flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        let mut inputs = vec![Self::mouse(move_flags, vx, vy, 0)];
        if dy != 0 {
            inputs.push(Self::mouse(MOUSEEVENTF_WHEEL, vx, vy, wheel_mouse_data(dy)));
        }
        if dx != 0 {
            inputs.push(Self::mouse(
                MOUSEEVENTF_HWHEEL,
                vx,
                vy,
                hwheel_mouse_data(dx),
            ));
        }
        Self::send(&inputs);
    }

    fn key(&mut self, code: &str, action: KeyAction, _modifiers: Modifiers) {
        let Some((scan, extended)) = scancode(code) else {
            return;
        };
        let inputs: Vec<INPUT> = match action {
            KeyAction::Down => vec![Self::key_input(scan, extended, false)],
            KeyAction::Up => vec![Self::key_input(scan, extended, true)],
            KeyAction::Press => vec![
                Self::key_input(scan, extended, false),
                Self::key_input(scan, extended, true),
            ],
        };
        Self::send(&inputs);
    }

    fn text(&mut self, text: &str) {
        // Each UTF-16 code unit as KEYEVENTF_UNICODE down+up (surrogate pairs = two units).
        for unit in text.encode_utf16() {
            Self::send(&[Self::unicode_input(unit, false)]);
            Self::send(&[Self::unicode_input(unit, true)]);
        }
    }

    /// Phase D §5.4 `os.input_lock`: `BlockInput`, which needs the calling process to be at
    /// least as privileged as the desktop it is blocking — true for the `LocalSystem` worker,
    /// false for a portable agent, where the call simply fails and the op reports
    /// `not_supported`.
    ///
    /// The escape is deliberate and the contract's: the person sitting there can always press
    /// Ctrl+Alt+Del, which Windows itself honours — `BlockInput` does not block the secure
    /// attention sequence. That is why rule 5.4b has the pill say so.
    fn block_local_input(&mut self, locked: bool) -> bool {
        // SAFETY: `BlockInput` takes a BOOL and has no other precondition. A failure (not
        // privileged enough, or already blocked by another process) is reported as `false`.
        unsafe { windows::Win32::UI::Input::KeyboardAndMouse::BlockInput(locked).is_ok() }
    }
}

#[cfg(test)]
mod win_tests {
    use super::WinInput;
    use crate::mapping::map_to_virtual;
    use ia_core::types::MonitorInfo;

    /// SendInput coordinate mapping against the real virtual screen (contract §15.2),
    /// without injecting (no `SendInput` call, so the cursor does not move). Skipped if the
    /// virtual screen has no extent (headless).
    #[test]
    fn maps_a_monitor_corner_into_the_absolute_range() {
        let vs = WinInput::virtual_screen();
        if vs.width <= 0 || vs.height <= 0 {
            eprintln!("no virtual screen; skipping SendInput mapping test");
            return;
        }
        let mon = MonitorInfo {
            id: 1,
            name: "DISPLAY1".into(),
            primary: true,
            x: vs.x,
            y: vs.y,
            width: vs.width as u32,
            height: vs.height as u32,
            scale: 1.0,
            mid: None,
        };
        assert_eq!(map_to_virtual(&mon, 0.0, 0.0, vs), (0, 0));
        let (dx, dy) = map_to_virtual(&mon, 1.0, 1.0, vs);
        assert_eq!((dx, dy), (65535, 65535));
    }
}
