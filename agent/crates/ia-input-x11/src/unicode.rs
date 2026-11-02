//! `os.text` on X11, the pure half (Phase E §7.2): characters → keysyms, spare-keycode
//! discovery, and the batch plan the X11 sink executes with `ChangeKeyboardMapping`.
//!
//! X has no `KEYEVENTF_UNICODE`. The sink binds each character's keysym to a keycode that has no
//! keysyms in the current keyboard mapping (a "spare" keycode), presses and releases it, and
//! restores the mapping. Keysyms: Latin-1 characters are their own keysym (`U+0020..=U+007E`,
//! `U+00A0..=U+00FF`), every other character is `0x0100_0000 + codepoint` (the X11 Unicode keysym
//! convention, which Xlib and xkbcommon both decode). Newline, carriage return, tab and backspace
//! become the `Return`, `Tab` and `BackSpace` keysyms (`\r\n` is one `Return`); other control
//! characters are dropped. Pure; tested on every host.

/// `XK_BackSpace`.
pub const XK_BACKSPACE: u32 = 0xff08;
/// `XK_Tab`.
pub const XK_TAB: u32 = 0xff09;
/// `XK_Return`.
pub const XK_RETURN: u32 = 0xff0d;
/// `NoSymbol`.
pub const NO_SYMBOL: u32 = 0;
/// The base of the Unicode keysym range (`0x0100_0000 + codepoint`).
pub const UNICODE_KEYSYM_BASE: u32 = 0x0100_0000;

/// The most spare keycodes one text call uses (each distinct character of a batch takes one).
pub const MAX_SPARE_KEYCODES: usize = 64;

/// The keysym that types `c`, or `None` for a control character with no key.
pub fn keysym_for_char(c: char) -> Option<u32> {
    match c {
        '\n' | '\r' => Some(XK_RETURN),
        '\t' => Some(XK_TAB),
        '\u{8}' => Some(XK_BACKSPACE),
        c if c.is_control() => None,
        ' '..='~' | '\u{a0}'..='\u{ff}' => Some(c as u32),
        c => Some(UNICODE_KEYSYM_BASE + c as u32),
    }
}

/// The character a keysym types (the inverse of [`keysym_for_char`], also used by the X11 tests
/// to decode what arrived). `Return` decodes as `'\n'`.
pub fn char_for_keysym(keysym: u32) -> Option<char> {
    match keysym {
        XK_RETURN => Some('\n'),
        XK_TAB => Some('\t'),
        XK_BACKSPACE => Some('\u{8}'),
        0x20..=0x7e | 0xa0..=0xff => char::from_u32(keysym),
        0x0100_0100..=0x0110_ffff => char::from_u32(keysym - UNICODE_KEYSYM_BASE),
        _ => None,
    }
}

/// The keysyms to type for `text`, in order (`\r\n` collapses to one `Return`).
pub fn text_keysyms(text: &str) -> Vec<u32> {
    let mut out = Vec::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' && chars.peek() == Some(&'\n') {
            continue; // the '\n' that follows produces the Return
        }
        if let Some(ks) = keysym_for_char(c) {
            out.push(ks);
        }
    }
    out
}

/// The spare keycodes of a core keyboard mapping (`GetKeyboardMapping` from `min_keycode`, with
/// `keysyms_per_keycode` entries per keycode): those whose every entry is `NoSymbol`. Highest
/// keycode first (high keycodes are the least likely to be a physical key), at most
/// [`MAX_SPARE_KEYCODES`].
pub fn spare_keycodes(min_keycode: u8, keysyms_per_keycode: u8, keysyms: &[u32]) -> Vec<u8> {
    let per = usize::from(keysyms_per_keycode);
    if per == 0 {
        return Vec::new();
    }
    let mut spare: Vec<u8> = keysyms
        .chunks(per)
        .enumerate()
        .filter(|(_, syms)| syms.iter().all(|&s| s == NO_SYMBOL))
        .filter_map(|(i, _)| u8::try_from(usize::from(min_keycode) + i).ok())
        .collect();
    spare.reverse();
    spare.truncate(MAX_SPARE_KEYCODES);
    spare
}

/// One mapping change: bind `bindings` (keycode → keysym), press and release `presses` in order,
/// then restore those keycodes to `NoSymbol`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Batch {
    pub bindings: Vec<(u8, u32)>,
    pub presses: Vec<u8>,
}

/// Split `keysyms` into batches over the `spare` keycodes: a batch binds each distinct keysym to
/// its own spare keycode (a repeated character reuses its keycode) and is closed when a new
/// keysym needs a keycode and none is left. Empty when there is nothing to type or no spare key.
pub fn plan_batches(keysyms: &[u32], spare: &[u8]) -> Vec<Batch> {
    let mut out = Vec::new();
    if spare.is_empty() {
        return out;
    }
    let mut cur = Batch {
        bindings: Vec::new(),
        presses: Vec::new(),
    };
    for &ks in keysyms {
        let kc = match cur.bindings.iter().find(|(_, s)| *s == ks) {
            Some((kc, _)) => *kc,
            None => {
                if cur.bindings.len() == spare.len() {
                    out.push(std::mem::replace(
                        &mut cur,
                        Batch {
                            bindings: Vec::new(),
                            presses: Vec::new(),
                        },
                    ));
                }
                let kc = spare[cur.bindings.len()];
                cur.bindings.push((kc, ks));
                kc
            }
        };
        cur.presses.push(kc);
    }
    if !cur.presses.is_empty() {
        out.push(cur);
    }
    out
}

/// Group bindings into runs of consecutive keycodes, `(first_keycode, keysyms)`, so each run is
/// one `ChangeKeyboardMapping` request. Sorted by keycode.
pub fn binding_runs(bindings: &[(u8, u32)]) -> Vec<(u8, Vec<u32>)> {
    let mut sorted = bindings.to_vec();
    sorted.sort_unstable_by_key(|(kc, _)| *kc);
    let mut runs: Vec<(u8, Vec<u32>)> = Vec::new();
    for (kc, ks) in sorted {
        match runs.last_mut() {
            Some((first, syms)) if usize::from(*first) + syms.len() == usize::from(kc) => {
                syms.push(ks)
            }
            _ => runs.push((kc, vec![ks])),
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latin1_characters_are_their_own_keysym() {
        assert_eq!(keysym_for_char('a'), Some(0x61));
        assert_eq!(keysym_for_char('Z'), Some(0x5a));
        assert_eq!(keysym_for_char(' '), Some(0x20));
        assert_eq!(keysym_for_char('~'), Some(0x7e));
        assert_eq!(keysym_for_char('\u{a0}'), Some(0xa0));
        assert_eq!(keysym_for_char('é'), Some(0xe9));
        assert_eq!(keysym_for_char('ÿ'), Some(0xff));
    }

    #[test]
    fn other_characters_use_the_unicode_keysym_range() {
        assert_eq!(keysym_for_char('€'), Some(0x0100_20ac));
        assert_eq!(keysym_for_char('ह'), Some(0x0100_0939));
        assert_eq!(keysym_for_char('Ā'), Some(0x0100_0100));
        assert_eq!(keysym_for_char('😀'), Some(0x0101_f600));
        assert_eq!(keysym_for_char('\u{10ffff}'), Some(0x0110_ffff));
    }

    #[test]
    fn control_characters() {
        assert_eq!(keysym_for_char('\n'), Some(XK_RETURN));
        assert_eq!(keysym_for_char('\r'), Some(XK_RETURN));
        assert_eq!(keysym_for_char('\t'), Some(XK_TAB));
        assert_eq!(keysym_for_char('\u{8}'), Some(XK_BACKSPACE));
        for c in ['\0', '\u{7}', '\u{1b}', '\u{7f}', '\u{85}', '\u{9f}'] {
            assert_eq!(keysym_for_char(c), None, "{:?}", c);
        }
    }

    #[test]
    fn keysyms_round_trip() {
        for c in ['a', '0', '~', 'é', '€', 'ह', '中', '😀', '\n', '\t'] {
            let ks = keysym_for_char(c).expect("typeable");
            assert_eq!(char_for_keysym(ks), Some(c), "{c:?}");
        }
        assert_eq!(char_for_keysym(NO_SYMBOL), None);
        assert_eq!(char_for_keysym(0xffe1), None, "Shift_L is not a character");
        assert_eq!(
            char_for_keysym(0x0100_0050),
            None,
            "below the Unicode keysym range"
        );
    }

    #[test]
    fn text_collapses_crlf_and_drops_unknown_controls() {
        assert_eq!(text_keysyms("a\r\nb"), vec![0x61, XK_RETURN, 0x62]);
        assert_eq!(
            text_keysyms("a\rb\n"),
            vec![0x61, XK_RETURN, 0x62, XK_RETURN]
        );
        assert_eq!(text_keysyms("x\u{1b}y"), vec![0x78, 0x79]);
        assert!(text_keysyms("").is_empty());
    }

    #[test]
    fn spare_keycodes_are_the_all_nosymbol_ones_highest_first() {
        // min 8, two keysyms per keycode: 8 = a/A, 9 = empty, 10 = 0/empty, 11 = empty.
        let syms = [0x61, 0x41, 0, 0, 0x30, 0, 0, 0];
        assert_eq!(spare_keycodes(8, 2, &syms), vec![11, 9]);
        assert!(spare_keycodes(8, 0, &syms).is_empty());
        assert!(spare_keycodes(8, 2, &[]).is_empty());
    }

    #[test]
    fn spare_keycodes_are_capped() {
        let syms = vec![0u32; 248 * 4];
        let spare = spare_keycodes(8, 4, &syms);
        assert_eq!(spare.len(), MAX_SPARE_KEYCODES);
        assert_eq!(spare[0], 255);
        assert_eq!(
            spare[MAX_SPARE_KEYCODES - 1],
            255 - (MAX_SPARE_KEYCODES as u8 - 1)
        );
    }

    #[test]
    fn a_batch_reuses_the_keycode_of_a_repeated_character() {
        let ks = text_keysyms("abab");
        let plan = plan_batches(&ks, &[200, 199]);
        assert_eq!(
            plan,
            vec![Batch {
                bindings: vec![(200, 0x61), (199, 0x62)],
                presses: vec![200, 199, 200, 199],
            }]
        );
    }

    #[test]
    fn batches_split_when_the_spare_keycodes_run_out() {
        let ks = text_keysyms("abcab");
        let plan = plan_batches(&ks, &[201, 200]);
        assert_eq!(
            plan,
            vec![
                Batch {
                    bindings: vec![(201, 0x61), (200, 0x62)],
                    presses: vec![201, 200],
                },
                Batch {
                    bindings: vec![(201, 0x63), (200, 0x61)],
                    presses: vec![201, 200],
                },
                Batch {
                    bindings: vec![(201, 0x62)],
                    presses: vec![201],
                },
            ]
        );
        // Every character is typed exactly once, in order.
        let typed: Vec<u32> = plan
            .iter()
            .flat_map(|b| {
                b.presses
                    .iter()
                    .map(move |kc| b.bindings.iter().find(|(k, _)| k == kc).expect("bound").1)
            })
            .collect();
        assert_eq!(typed, ks);
    }

    #[test]
    fn no_spare_keycode_or_no_text_plans_nothing() {
        assert!(plan_batches(&[0x61], &[]).is_empty());
        assert!(plan_batches(&[], &[200]).is_empty());
    }

    #[test]
    fn runs_group_consecutive_keycodes() {
        let runs = binding_runs(&[(200, 1), (198, 2), (199, 3), (150, 4)]);
        assert_eq!(runs, vec![(150, vec![4]), (198, vec![2, 3, 1])]);
        assert!(binding_runs(&[]).is_empty());
    }
}
