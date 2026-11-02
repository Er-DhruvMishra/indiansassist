//! W3C `KeyboardEvent.code` → macOS virtual key code (`kVK_*` of Carbon `HIToolbox/Events.h`),
//! the pure part of the `ia-input-mac` row (Phase F §17.2). A virtual key is a physical key
//! position, so the Desk's keyboard layout decides the character, as with the Windows scancode
//! and X11 keycode paths; printable text never goes through here (`os.text` uses
//! `CGEventKeyboardSetUnicodeString`). Tested on every host against
//! `tests/fixtures/mac-keymap.json`.
//!
//! The pairs follow the W3C UI Events KeyboardEvent code table's macOS column. `PrintScreen`,
//! `ScrollLock` and `Pause` have no Mac key and are not mapped; `Insert` is the `Help` key and
//! `NumLock` the keypad `Clear` key, as on an Apple extended keyboard.

/// The virtual key for a W3C `code`, or `None` when the code has no Mac key (the control server
/// answers an unknown `code` with `bad_args` before it reaches the sink, C §5.1).
pub fn vk_for_code(code: &str) -> Option<u16> {
    KVK.iter().find(|(c, _)| *c == code).map(|(_, vk)| *vk)
}

/// The modifier a W3C `code` holds while it is down, or `None` for a non-modifier key.
pub fn modifier_for_code(code: &str) -> Option<Modifier> {
    match code {
        "ShiftLeft" | "ShiftRight" => Some(Modifier::Shift),
        "ControlLeft" | "ControlRight" => Some(Modifier::Control),
        "AltLeft" | "AltRight" => Some(Modifier::Option),
        "MetaLeft" | "MetaRight" => Some(Modifier::Command),
        _ => None,
    }
}

/// The four modifiers a synthetic `CGEvent` carries in its flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Modifier {
    Shift,
    Control,
    Option,
    Command,
}

impl Modifier {
    /// The `CGEventFlags` mask bit (`kCGEventFlagMask*`).
    pub const fn flag(self) -> u64 {
        match self {
            Modifier::Shift => 0x0002_0000,
            Modifier::Control => 0x0004_0000,
            Modifier::Option => 0x0008_0000,
            Modifier::Command => 0x0010_0000,
        }
    }
}

/// The table: `(W3C code, kVK)`. Every code the Windows table covers that a Mac keyboard has,
/// plus the JIS keys and F13-F20.
#[rustfmt::skip]
pub const KVK: &[(&str, u16)] = &[
    ("KeyA", 0x00), ("KeyS", 0x01), ("KeyD", 0x02), ("KeyF", 0x03), ("KeyH", 0x04),
    ("KeyG", 0x05), ("KeyZ", 0x06), ("KeyX", 0x07), ("KeyC", 0x08), ("KeyV", 0x09),
    ("IntlBackslash", 0x0A), // kVK_ISO_Section
    ("KeyB", 0x0B), ("KeyQ", 0x0C), ("KeyW", 0x0D), ("KeyE", 0x0E), ("KeyR", 0x0F),
    ("KeyY", 0x10), ("KeyT", 0x11),
    ("Digit1", 0x12), ("Digit2", 0x13), ("Digit3", 0x14), ("Digit4", 0x15), ("Digit6", 0x16),
    ("Digit5", 0x17), ("Equal", 0x18), ("Digit9", 0x19), ("Digit7", 0x1A), ("Minus", 0x1B),
    ("Digit8", 0x1C), ("Digit0", 0x1D), ("BracketRight", 0x1E), ("KeyO", 0x1F), ("KeyU", 0x20),
    ("BracketLeft", 0x21), ("KeyI", 0x22), ("KeyP", 0x23), ("Enter", 0x24), ("KeyL", 0x25),
    ("KeyJ", 0x26), ("Quote", 0x27), ("KeyK", 0x28), ("Semicolon", 0x29), ("Backslash", 0x2A),
    ("Comma", 0x2B), ("Slash", 0x2C), ("KeyN", 0x2D), ("KeyM", 0x2E), ("Period", 0x2F),
    ("Tab", 0x30), ("Space", 0x31), ("Backquote", 0x32),
    ("Backspace", 0x33),     // kVK_Delete
    ("Escape", 0x35),
    ("MetaRight", 0x36), ("MetaLeft", 0x37), ("ShiftLeft", 0x38), ("CapsLock", 0x39),
    ("AltLeft", 0x3A), ("ControlLeft", 0x3B), ("ShiftRight", 0x3C), ("AltRight", 0x3D),
    ("ControlRight", 0x3E),
    ("Fn", 0x3F), ("F17", 0x40), ("NumpadDecimal", 0x41), ("NumpadMultiply", 0x43),
    ("NumpadAdd", 0x45),
    ("NumLock", 0x47),       // kVK_ANSI_KeypadClear
    ("AudioVolumeUp", 0x48), ("AudioVolumeDown", 0x49), ("AudioVolumeMute", 0x4A),
    ("NumpadDivide", 0x4B), ("NumpadEnter", 0x4C), ("NumpadSubtract", 0x4E), ("F18", 0x4F),
    ("F19", 0x50), ("NumpadEqual", 0x51),
    ("Numpad0", 0x52), ("Numpad1", 0x53), ("Numpad2", 0x54), ("Numpad3", 0x55),
    ("Numpad4", 0x56), ("Numpad5", 0x57), ("Numpad6", 0x58), ("Numpad7", 0x59), ("F20", 0x5A),
    ("Numpad8", 0x5B), ("Numpad9", 0x5C),
    ("IntlYen", 0x5D),       // kVK_JIS_Yen
    ("IntlRo", 0x5E),        // kVK_JIS_Underscore
    ("NumpadComma", 0x5F),   // kVK_JIS_KeypadComma
    ("F5", 0x60), ("F6", 0x61), ("F7", 0x62), ("F3", 0x63), ("F8", 0x64), ("F9", 0x65),
    ("Lang2", 0x66),         // kVK_JIS_Eisu
    ("F11", 0x67),
    ("Lang1", 0x68),         // kVK_JIS_Kana
    ("F13", 0x69), ("F16", 0x6A), ("F14", 0x6B), ("F10", 0x6D),
    ("ContextMenu", 0x6E),   // kVK_ContextualMenu
    ("F12", 0x6F), ("F15", 0x71),
    ("Insert", 0x72),        // kVK_Help
    ("Home", 0x73), ("PageUp", 0x74),
    ("Delete", 0x75),        // kVK_ForwardDelete
    ("F4", 0x76), ("End", 0x77), ("F2", 0x78), ("PageDown", 0x79), ("F1", 0x7A),
    ("ArrowLeft", 0x7B), ("ArrowRight", 0x7C), ("ArrowDown", 0x7D), ("ArrowUp", 0x7E),
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    fn fixture() -> serde_json::Value {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mac-keymap.json"
        );
        let text = std::fs::read_to_string(p).expect("mac-keymap.json");
        serde_json::from_str(&text).expect("mac-keymap.json is JSON")
    }

    #[test]
    fn the_table_is_exactly_the_fixture() {
        let v = fixture();
        let want: BTreeMap<String, u16> = v["keys"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, n)| (k.clone(), n.as_u64().unwrap() as u16))
            .collect();
        let have: BTreeMap<String, u16> = KVK.iter().map(|(c, vk)| (c.to_string(), *vk)).collect();
        assert_eq!(have, want);
        for code in v["unmapped"].as_array().unwrap() {
            assert_eq!(vk_for_code(code.as_str().unwrap()), None, "{code}");
        }
    }

    #[test]
    fn codes_and_virtual_keys_are_unique() {
        let codes: BTreeSet<_> = KVK.iter().map(|(c, _)| *c).collect();
        let vks: BTreeSet<_> = KVK.iter().map(|(_, vk)| *vk).collect();
        assert_eq!(codes.len(), KVK.len(), "a code appears twice");
        assert_eq!(vks.len(), KVK.len(), "a virtual key appears twice");
        assert!(KVK.iter().all(|(_, vk)| *vk <= 0x7F));
    }

    #[test]
    fn the_letters_digits_and_modifiers_are_where_apple_puts_them() {
        assert_eq!(vk_for_code("KeyA"), Some(0x00));
        assert_eq!(vk_for_code("KeyQ"), Some(0x0C));
        assert_eq!(vk_for_code("Digit0"), Some(0x1D));
        assert_eq!(vk_for_code("Enter"), Some(0x24));
        assert_eq!(vk_for_code("MetaLeft"), Some(0x37));
        assert_eq!(vk_for_code("PrintScreen"), None);
        assert_eq!(vk_for_code("NotAKey"), None);
        assert_eq!(modifier_for_code("MetaRight"), Some(Modifier::Command));
        assert_eq!(modifier_for_code("AltLeft"), Some(Modifier::Option));
        assert_eq!(modifier_for_code("KeyA"), None);
        assert_eq!(Modifier::Command.flag(), 1 << 20);
    }
}
