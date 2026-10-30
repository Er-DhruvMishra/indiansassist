//! W3C `KeyboardEvent.code` → PS/2 set 1 scan code with the extended flag (contract §5.4).
//! Scan codes make the Desk's keyboard layout decide the character, so printable text
//! never goes through this path (it uses `os.text`, `KEYEVENTF_UNICODE`). Pure; tested.

/// `(scan_code, extended)` for a W3C code, or `None` when the code is not mappable
/// (console sends `bad_args` for an unknown `code`, §5.1).
pub fn scancode(code: &str) -> Option<(u16, bool)> {
    let (sc, ext) = SCANCODES
        .iter()
        .find(|(c, _, _)| *c == code)
        .map(|(_, s, e)| (*s, *e))?;
    Some((sc, ext))
}

/// The scan-code table. `true` = extended (needs `KEYEVENTF_EXTENDEDKEY`).
#[rustfmt::skip]
pub const SCANCODES: &[(&str, u16, bool)] = &[
    ("Escape", 0x01, false),
    ("Digit1", 0x02, false), ("Digit2", 0x03, false), ("Digit3", 0x04, false),
    ("Digit4", 0x05, false), ("Digit5", 0x06, false), ("Digit6", 0x07, false),
    ("Digit7", 0x08, false), ("Digit8", 0x09, false), ("Digit9", 0x0A, false),
    ("Digit0", 0x0B, false),
    ("Minus", 0x0C, false), ("Equal", 0x0D, false), ("Backspace", 0x0E, false),
    ("Tab", 0x0F, false),
    ("KeyQ", 0x10, false), ("KeyW", 0x11, false), ("KeyE", 0x12, false), ("KeyR", 0x13, false),
    ("KeyT", 0x14, false), ("KeyY", 0x15, false), ("KeyU", 0x16, false), ("KeyI", 0x17, false),
    ("KeyO", 0x18, false), ("KeyP", 0x19, false),
    ("BracketLeft", 0x1A, false), ("BracketRight", 0x1B, false), ("Enter", 0x1C, false),
    ("ControlLeft", 0x1D, false),
    ("KeyA", 0x1E, false), ("KeyS", 0x1F, false), ("KeyD", 0x20, false), ("KeyF", 0x21, false),
    ("KeyG", 0x22, false), ("KeyH", 0x23, false), ("KeyJ", 0x24, false), ("KeyK", 0x25, false),
    ("KeyL", 0x26, false),
    ("Semicolon", 0x27, false), ("Quote", 0x28, false), ("Backquote", 0x29, false),
    ("ShiftLeft", 0x2A, false), ("Backslash", 0x2B, false),
    ("KeyZ", 0x2C, false), ("KeyX", 0x2D, false), ("KeyC", 0x2E, false), ("KeyV", 0x2F, false),
    ("KeyB", 0x30, false), ("KeyN", 0x31, false), ("KeyM", 0x32, false),
    ("Comma", 0x33, false), ("Period", 0x34, false), ("Slash", 0x35, false),
    ("ShiftRight", 0x36, false), ("NumpadMultiply", 0x37, false),
    ("AltLeft", 0x38, false), ("Space", 0x39, false), ("CapsLock", 0x3A, false),
    ("F1", 0x3B, false), ("F2", 0x3C, false), ("F3", 0x3D, false), ("F4", 0x3E, false),
    ("F5", 0x3F, false), ("F6", 0x40, false), ("F7", 0x41, false), ("F8", 0x42, false),
    ("F9", 0x43, false), ("F10", 0x44, false),
    ("NumLock", 0x45, false), ("ScrollLock", 0x46, false),
    ("Numpad7", 0x47, false), ("Numpad8", 0x48, false), ("Numpad9", 0x49, false),
    ("NumpadSubtract", 0x4A, false),
    ("Numpad4", 0x4B, false), ("Numpad5", 0x4C, false), ("Numpad6", 0x4D, false),
    ("NumpadAdd", 0x4E, false),
    ("Numpad1", 0x4F, false), ("Numpad2", 0x50, false), ("Numpad3", 0x51, false),
    ("Numpad0", 0x52, false), ("NumpadDecimal", 0x53, false),
    ("IntlBackslash", 0x56, false), ("F11", 0x57, false), ("F12", 0x58, false),
    ("F13", 0x64, false), ("F14", 0x65, false), ("F15", 0x66, false), ("F16", 0x67, false),
    ("F17", 0x68, false), ("F18", 0x69, false), ("F19", 0x6A, false), ("F20", 0x6B, false),
    ("F21", 0x6C, false), ("F22", 0x6D, false), ("F23", 0x6E, false), ("F24", 0x6F, false),
    ("IntlRo", 0x73, false), ("IntlYen", 0x7D, false),
    // Extended (E0-prefixed) keys.
    ("ControlRight", 0x1D, true), ("AltRight", 0x38, true), ("NumpadEnter", 0x1C, true),
    ("NumpadDivide", 0x35, true), ("PrintScreen", 0x37, true),
    ("Home", 0x47, true), ("ArrowUp", 0x48, true), ("PageUp", 0x49, true),
    ("ArrowLeft", 0x4B, true), ("ArrowRight", 0x4D, true),
    ("End", 0x4F, true), ("ArrowDown", 0x50, true), ("PageDown", 0x51, true),
    ("Insert", 0x52, true), ("Delete", 0x53, true),
    ("MetaLeft", 0x5B, true), ("MetaRight", 0x5C, true), ("ContextMenu", 0x5D, true),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_keys_resolve() {
        assert_eq!(scancode("KeyA"), Some((0x1E, false)));
        assert_eq!(scancode("Enter"), Some((0x1C, false)));
        assert_eq!(scancode("Escape"), Some((0x01, false)));
        assert_eq!(scancode("F1"), Some((0x3B, false)));
        assert_eq!(scancode("Digit0"), Some((0x0B, false)));
    }

    #[test]
    fn extended_keys_carry_the_flag() {
        for code in [
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "Delete",
            "Insert",
            "PageUp",
            "PageDown",
            "NumpadEnter",
            "NumpadDivide",
            "ControlRight",
            "AltRight",
            "MetaLeft",
        ] {
            let (_, ext) = scancode(code).unwrap_or_else(|| panic!("{code} missing"));
            assert!(ext, "{code} must be extended");
        }
    }

    #[test]
    fn numpad_vs_navigation_differ_by_extended_flag() {
        // Numpad7 and Home share make code 0x47 but differ by the extended flag.
        assert_eq!(scancode("Numpad7"), Some((0x47, false)));
        assert_eq!(scancode("Home"), Some((0x47, true)));
    }

    #[test]
    fn unknown_code_is_none() {
        assert_eq!(scancode("NotAKey"), None);
        assert_eq!(scancode(""), None);
    }

    #[test]
    fn table_has_no_duplicate_codes_and_is_sizeable() {
        let mut seen = std::collections::HashSet::new();
        for (code, _, _) in SCANCODES {
            assert!(seen.insert(*code), "duplicate code {code}");
        }
        // ~130 entries per the contract; assert we are in that ballpark.
        assert!(
            SCANCODES.len() >= 110,
            "table too small: {}",
            SCANCODES.len()
        );
    }
}
