//! W3C `KeyboardEvent.code` → Linux evdev scancode (`linux/input-event-codes.h`), and the X
//! keycode the server uses for it (`evdev + 8`, the offset every evdev / `xf86-input-libinput`
//! X server and Xvfb's default XKB `evdev` keycodes apply). Phase E §7.2, the pure part of the
//! `ia-input-x11` row.
//!
//! Like the Windows scancode path (`ia-input-win::scancodes`), a keycode makes the Desk's keyboard
//! layout decide the character, so printable text never goes through here: `os.text` uses the
//! spare-keycode Unicode path ([`crate::unicode`]). Pure; tested on every host against
//! `packages/shared/test/fixtures/agent/x11-keymap.json`.

/// The offset between an evdev scancode and the X keycode (X keycodes start at 8).
pub const X_KEYCODE_OFFSET: u16 = 8;

/// The evdev scancode for a W3C `code`, or `None` when the code is not mappable (the control
/// server answers an unknown `code` with `bad_args` before it reaches the sink, C §5.1).
pub fn evdev_for_code(code: &str) -> Option<u16> {
    EVDEV
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, evdev)| *evdev)
}

/// The X keycode (`evdev + 8`) for a W3C `code`.
pub fn x_keycode_for_code(code: &str) -> Option<u8> {
    evdev_for_code(code).and_then(|e| u8::try_from(e + X_KEYCODE_OFFSET).ok())
}

/// The table: `(W3C code, evdev scancode)`. Every code the Windows table covers, plus the
/// Japanese / Korean keys, `Pause`, the extra numpad keys and the media keys evdev names.
#[rustfmt::skip]
pub const EVDEV: &[(&str, u16)] = &[
    ("Escape", 1),
    ("Digit1", 2), ("Digit2", 3), ("Digit3", 4), ("Digit4", 5), ("Digit5", 6),
    ("Digit6", 7), ("Digit7", 8), ("Digit8", 9), ("Digit9", 10), ("Digit0", 11),
    ("Minus", 12), ("Equal", 13), ("Backspace", 14), ("Tab", 15),
    ("KeyQ", 16), ("KeyW", 17), ("KeyE", 18), ("KeyR", 19), ("KeyT", 20),
    ("KeyY", 21), ("KeyU", 22), ("KeyI", 23), ("KeyO", 24), ("KeyP", 25),
    ("BracketLeft", 26), ("BracketRight", 27), ("Enter", 28), ("ControlLeft", 29),
    ("KeyA", 30), ("KeyS", 31), ("KeyD", 32), ("KeyF", 33), ("KeyG", 34),
    ("KeyH", 35), ("KeyJ", 36), ("KeyK", 37), ("KeyL", 38),
    ("Semicolon", 39), ("Quote", 40), ("Backquote", 41), ("ShiftLeft", 42), ("Backslash", 43),
    ("KeyZ", 44), ("KeyX", 45), ("KeyC", 46), ("KeyV", 47), ("KeyB", 48),
    ("KeyN", 49), ("KeyM", 50),
    ("Comma", 51), ("Period", 52), ("Slash", 53), ("ShiftRight", 54),
    ("NumpadMultiply", 55), ("AltLeft", 56), ("Space", 57), ("CapsLock", 58),
    ("F1", 59), ("F2", 60), ("F3", 61), ("F4", 62), ("F5", 63),
    ("F6", 64), ("F7", 65), ("F8", 66), ("F9", 67), ("F10", 68),
    ("NumLock", 69), ("ScrollLock", 70),
    ("Numpad7", 71), ("Numpad8", 72), ("Numpad9", 73), ("NumpadSubtract", 74),
    ("Numpad4", 75), ("Numpad5", 76), ("Numpad6", 77), ("NumpadAdd", 78),
    ("Numpad1", 79), ("Numpad2", 80), ("Numpad3", 81), ("Numpad0", 82), ("NumpadDecimal", 83),
    ("Lang5", 85),           // KEY_ZENKAKUHANKAKU
    ("IntlBackslash", 86),   // KEY_102ND
    ("F11", 87), ("F12", 88),
    ("IntlRo", 89),          // KEY_RO
    ("Lang3", 90),           // KEY_KATAKANA
    ("Lang4", 91),           // KEY_HIRAGANA
    ("Convert", 92),         // KEY_HENKAN
    ("KanaMode", 93),        // KEY_KATAKANAHIRAGANA
    ("NonConvert", 94),      // KEY_MUHENKAN
    ("NumpadEnter", 96), ("ControlRight", 97), ("NumpadDivide", 98),
    ("PrintScreen", 99),     // KEY_SYSRQ
    ("AltRight", 100),
    ("Home", 102), ("ArrowUp", 103), ("PageUp", 104), ("ArrowLeft", 105), ("ArrowRight", 106),
    ("End", 107), ("ArrowDown", 108), ("PageDown", 109), ("Insert", 110), ("Delete", 111),
    ("AudioVolumeMute", 113), ("AudioVolumeDown", 114), ("AudioVolumeUp", 115),
    ("NumpadEqual", 117), ("Pause", 119),
    ("NumpadComma", 121),    // KEY_KPCOMMA
    ("Lang1", 122),          // KEY_HANGEUL
    ("Lang2", 123),          // KEY_HANJA
    ("IntlYen", 124),        // KEY_YEN
    ("MetaLeft", 125), ("MetaRight", 126),
    ("ContextMenu", 127),    // KEY_COMPOSE
    ("MediaTrackNext", 163), ("MediaPlayPause", 164), ("MediaTrackPrevious", 165),
    ("MediaStop", 166),      // KEY_STOPCD
    ("F13", 183), ("F14", 184), ("F15", 185), ("F16", 186), ("F17", 187), ("F18", 188),
    ("F19", 189), ("F20", 190), ("F21", 191), ("F22", 192), ("F23", 193), ("F24", 194),
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/shared/test/fixtures/agent/x11-keymap.json"
    );

    fn fixture() -> serde_json::Value {
        let text = std::fs::read_to_string(FIXTURE)
            .unwrap_or_else(|e| panic!("cannot read {FIXTURE}: {e}"));
        serde_json::from_str(&text).expect("x11-keymap.json is JSON")
    }

    #[test]
    fn every_fixture_entry_matches_the_table() {
        let fx = fixture();
        assert_eq!(fx["version"], 1);
        let keys = fx["keys"].as_array().expect("keys array");
        assert!(!keys.is_empty());
        for k in keys {
            let code = k["code"].as_str().expect("code");
            let evdev = k["evdev"].as_u64().expect("evdev") as u16;
            let keycode = k["keycode"].as_u64().expect("keycode") as u8;
            assert_eq!(evdev_for_code(code), Some(evdev), "{code}: evdev");
            assert_eq!(x_keycode_for_code(code), Some(keycode), "{code}: keycode");
            assert_eq!(u16::from(keycode), evdev + 8, "{code}: keycode = evdev + 8");
        }
    }

    #[test]
    fn the_table_and_the_fixture_list_the_same_codes() {
        let fx = fixture();
        let in_fixture: Vec<&str> = fx["keys"]
            .as_array()
            .expect("keys array")
            .iter()
            .map(|k| k["code"].as_str().expect("code"))
            .collect();
        let fixture_set: BTreeSet<&str> = in_fixture.iter().copied().collect();
        assert_eq!(
            fixture_set.len(),
            in_fixture.len(),
            "duplicate code in the fixture"
        );
        let table_set: BTreeSet<&str> = EVDEV.iter().map(|(c, _)| *c).collect();
        assert_eq!(table_set.len(), EVDEV.len(), "duplicate code in the table");
        assert_eq!(table_set, fixture_set);
    }

    /// Every code the Windows scancode table maps is mapped here too (read from the Windows
    /// source at compile time, so the check follows that table without a crate dependency).
    #[test]
    fn covers_every_code_of_the_windows_table() {
        let src = include_str!("../../ia-input-win/src/scancodes.rs");
        let start = src
            .find("pub const SCANCODES")
            .expect("SCANCODES in the Windows table");
        let end = start + src[start..].find("];").expect("end of SCANCODES");
        let mut windows_codes = Vec::new();
        let mut rest = &src[start..end];
        while let Some(i) = rest.find("(\"") {
            let after = &rest[i + 2..];
            let j = after.find('"').expect("closing quote");
            windows_codes.push(&after[..j]);
            rest = &after[j..];
        }
        assert!(
            windows_codes.len() >= 110,
            "parsed {} Windows codes",
            windows_codes.len()
        );
        for code in windows_codes {
            assert!(
                evdev_for_code(code).is_some(),
                "{code} is in the Windows table but not here"
            );
        }
    }

    #[test]
    fn known_keys() {
        assert_eq!(evdev_for_code("KeyA"), Some(30));
        assert_eq!(x_keycode_for_code("KeyA"), Some(38));
        assert_eq!(x_keycode_for_code("Escape"), Some(9));
        assert_eq!(x_keycode_for_code("Enter"), Some(36));
        assert_eq!(x_keycode_for_code("Space"), Some(65));
        assert_eq!(x_keycode_for_code("ArrowUp"), Some(111));
        assert_eq!(x_keycode_for_code("NumpadEnter"), Some(104));
        assert_eq!(x_keycode_for_code("MetaLeft"), Some(133));
        assert_eq!(x_keycode_for_code("F13"), Some(191));
        assert_eq!(x_keycode_for_code("F24"), Some(202));
    }

    #[test]
    fn numpad_and_navigation_are_distinct_keys() {
        // On PS/2 they share a make code and differ by the E0 prefix; evdev gives each its own.
        assert_ne!(evdev_for_code("Numpad7"), evdev_for_code("Home"));
        assert_ne!(evdev_for_code("Enter"), evdev_for_code("NumpadEnter"));
        assert_ne!(
            evdev_for_code("ControlLeft"),
            evdev_for_code("ControlRight")
        );
    }

    #[test]
    fn unknown_codes() {
        assert_eq!(evdev_for_code(""), None);
        assert_eq!(evdev_for_code("NotAKey"), None);
        assert_eq!(evdev_for_code("keya"), None, "codes are case-sensitive");
        assert_eq!(x_keycode_for_code("NotAKey"), None);
    }

    #[test]
    fn every_keycode_fits_the_x_range() {
        for (code, evdev) in EVDEV {
            let kc = x_keycode_for_code(code).expect("mapped");
            assert!(kc >= 8, "{code}");
            assert_eq!(u16::from(kc), evdev + 8);
        }
    }
}
