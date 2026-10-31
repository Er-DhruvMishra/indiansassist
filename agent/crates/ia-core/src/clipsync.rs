//! Desk -> Assist clipboard preparation (contract §5.6 C2). Pure: the agent's clipboard
//! watcher hands every Desk-originated `CF_UNICODETEXT` change through [`prepare_desk_text`]
//! before it becomes `ctl.event clipboard { text, truncated }`.
//!
//! * every compact token `ia1.<...>` is replaced by `[token removed]`;
//! * when the session was joined by a 12-digit code, every Luhn-valid 12-digit group (with or
//!   without `-` / space separators) is replaced too (PRD 6 clipboard leakage);
//! * the result is truncated at `LIMITS.clipboardMaxBytes` UTF-8 bytes on a char boundary.

use regex::Regex;
use std::sync::OnceLock;

use crate::types::limits;

/// The replacement text (contract §5.6 C2).
pub const TOKEN_REMOVED: &str = "[token removed]";

fn compact_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"ia1\.[A-Za-z0-9_.\-]{8,4000}").unwrap())
}

fn twelve_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[0-9](?:[ \-]?[0-9]){11}").unwrap())
}

/// Luhn check over a run of ASCII digits.
pub fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0u32;
    for (i, c) in digits.bytes().rev().enumerate() {
        if !c.is_ascii_digit() {
            return false;
        }
        let mut d = (c - b'0') as u32;
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    !digits.is_empty() && sum.is_multiple_of(10)
}

/// Redact compact tokens and (when `joined_by_code`) Luhn-valid 12-digit codes.
pub fn redact(text: &str, joined_by_code: bool) -> String {
    let out = compact_re().replace_all(text, TOKEN_REMOVED).into_owned();
    if !joined_by_code {
        return out;
    }
    let bytes = out.as_bytes();
    let mut result = String::with_capacity(out.len());
    let mut last = 0;
    for m in twelve_re().find_iter(&out) {
        // A 12-digit group inside a longer digit run is not a code.
        let before = m.start() > 0 && bytes[m.start() - 1].is_ascii_digit();
        let after = m.end() < bytes.len() && bytes[m.end()].is_ascii_digit();
        let digits: String = m.as_str().chars().filter(|c| c.is_ascii_digit()).collect();
        if before || after || !luhn_valid(&digits) {
            continue;
        }
        result.push_str(&out[last..m.start()]);
        result.push_str(TOKEN_REMOVED);
        last = m.end();
    }
    result.push_str(&out[last..]);
    result
}

/// Truncate to at most `max` UTF-8 bytes on a char boundary; returns whether it was cut.
pub fn truncate_utf8(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// The full C2 preparation: redact, then truncate at `LIMITS.clipboardMaxBytes`.
pub fn prepare_desk_text(text: &str, joined_by_code: bool) -> (String, bool) {
    truncate_utf8(&redact(text, joined_by_code), limits::CLIPBOARD_MAX_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_tokens_are_always_removed() {
        let t = "join with ia1.abcdefgh_ijkl-mn.op please";
        assert_eq!(redact(t, false), "join with [token removed] please");
    }

    #[test]
    fn luhn_codes_removed_only_when_joined_by_code() {
        // 123456789007 is Luhn-valid (checked below); 123456789000 is not.
        assert!(luhn_valid("123456789007"));
        assert!(!luhn_valid("123456789000"));
        for form in [
            "123456789007",
            "1234-5678-9007",
            "1234 5678 9007",
            "123-456-789-007",
        ] {
            let t = format!("code {form}.");
            assert_eq!(redact(&t, true), "code [token removed].", "{form}");
            assert_eq!(redact(&t, false), t);
        }
        // Not Luhn-valid, or part of a longer run: kept.
        assert_eq!(redact("123456789000", true), "123456789000");
        assert_eq!(redact("91234567890071", true), "91234567890071");
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        let (t, cut) = truncate_utf8("aé", 2);
        assert_eq!(t, "a");
        assert!(cut);
        let (t, cut) = truncate_utf8("short", 64);
        assert_eq!(t, "short");
        assert!(!cut);
        let big = "x".repeat(limits::CLIPBOARD_MAX_BYTES + 10);
        let (t, cut) = prepare_desk_text(&big, false);
        assert_eq!(t.len(), limits::CLIPBOARD_MAX_BYTES);
        assert!(cut);
    }
}
