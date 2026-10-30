//! Token / short-code / URL parsing (A §3.3 algorithm, copied here per contract §2.1).
//! Strict grammars only; nothing parsed here is ever executed.

use regex::Regex;
use std::sync::OnceLock;
use url::Url;

/// A normalised join credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenInput {
    /// A compact signed token `ia1.<...>`.
    Compact(String),
    /// A 12-digit Luhn-valid dashboard short code or desk code (digits only).
    ShortCode(String),
}

fn compact_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ia1\.[A-Za-z0-9_.\-]{8,4000}$").unwrap())
}

/// `isValidShortCode`: exactly 12 digits, Luhn-valid (contract §2.1).
pub fn is_valid_short_code(digits: &str) -> bool {
    // First digit 1-9 (shared `isValidShortCode`: `^[1-9][0-9]{11}$` plus Luhn).
    if digits.len() != 12 || !digits.bytes().all(|b| b.is_ascii_digit()) || digits.starts_with('0')
    {
        return false;
    }
    luhn_ok(digits)
}

fn luhn_ok(digits: &str) -> bool {
    let mut sum = 0u32;
    // Rightmost digit is position 1 (not doubled).
    for (i, c) in digits.bytes().rev().enumerate() {
        let mut d = (c - b'0') as u32;
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum.is_multiple_of(10)
}

/// Strip spaces and `-` separators, returning the digit run if it is exactly 12 digits.
fn digits_only_12(text: &str) -> Option<String> {
    let cleaned: String = text
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '\t'))
        .collect();
    if cleaned.len() == 12 && cleaned.bytes().all(|b| b.is_ascii_digit()) {
        Some(cleaned)
    } else {
        None
    }
}

/// `normaliseTokenInput`: accept a 12-digit code, a compact token, a full `/join#t=` URL,
/// or an `indiansassist://join?t=|c=` deep link. Returns `None` for anything else.
pub fn normalise_token_input(text: &str) -> Option<TokenInput> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }

    // 1. A URL of either scheme.
    if let Some(found) = from_url(text) {
        return Some(found);
    }

    // 2. A bare compact token, with all whitespace removed (A §3.3: a token pasted across a
    //    line break still parses, as in the shared `normaliseTokenInput`).
    if text.starts_with("ia1.") {
        let joined: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        return compact_re()
            .is_match(&joined)
            .then_some(TokenInput::Compact(joined));
    }

    // 3. A 12-digit code (with or without separators), Luhn-checked.
    if let Some(digits) = digits_only_12(text) {
        if is_valid_short_code(&digits) {
            return Some(TokenInput::ShortCode(digits));
        }
    }

    None
}

/// Parse an `indiansassist://join?t=|c=` deep link strictly (contract §2.5 L2): only scheme
/// `indiansassist`, host `join`, keys `t`/`c`. Anything else => `None`.
pub fn parse_deep_link(url_str: &str) -> Option<TokenInput> {
    let url = Url::parse(url_str).ok()?;
    if url.scheme() != "indiansassist" {
        return None;
    }
    if url.host_str() != Some("join") {
        return None;
    }
    let mut t = None;
    let mut c = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "t" => t = Some(v.into_owned()),
            "c" => c = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(t) = t {
        if compact_re().is_match(&t) {
            return Some(TokenInput::Compact(t));
        }
    }
    if let Some(c) = c {
        if let Some(d) = digits_only_12(&c) {
            if is_valid_short_code(&d) {
                return Some(TokenInput::ShortCode(d));
            }
        }
    }
    None
}

/// Try both the deep link grammar and an `http(s)` join URL carrying `t=`/`c=`
/// (query or fragment).
fn from_url(text: &str) -> Option<TokenInput> {
    if text.starts_with("indiansassist://") {
        return parse_deep_link(text);
    }
    if !(text.starts_with("http://") || text.starts_with("https://")) {
        return None;
    }
    let url = Url::parse(text).ok()?;
    // Collect t=/c= from the query and from a `#t=...` fragment.
    let mut t = None;
    let mut c = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "t" => t = Some(v.into_owned()),
            "c" => c = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(frag) = url.fragment() {
        for pair in frag.split('&') {
            if let Some(val) = pair.strip_prefix("t=") {
                t.get_or_insert_with(|| val.to_string());
            } else if let Some(val) = pair.strip_prefix("c=") {
                c.get_or_insert_with(|| val.to_string());
            }
        }
    }
    if let Some(t) = t {
        if compact_re().is_match(&t) {
            return Some(TokenInput::Compact(t));
        }
    }
    if let Some(c) = c {
        if let Some(d) = digits_only_12(&c) {
            if is_valid_short_code(&d) {
                return Some(TokenInput::ShortCode(d));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 12-digit code with a valid Luhn check digit, built for the tests.
    fn luhn12(prefix11: &str) -> String {
        assert_eq!(prefix11.len(), 11);
        for d in 0..10u8 {
            let cand = format!("{prefix11}{d}");
            if luhn_ok(&cand) {
                return cand;
            }
        }
        unreachable!()
    }

    #[test]
    fn luhn_accepts_and_rejects() {
        let good = luhn12("48219365771");
        assert!(is_valid_short_code(&good));
        let bad: String = good
            .chars()
            .enumerate()
            .map(|(i, c)| {
                if i == 0 {
                    if c == '9' {
                        '8'
                    } else {
                        '9'
                    }
                } else {
                    c
                }
            })
            .collect();
        assert!(!is_valid_short_code(&bad));
        assert!(!is_valid_short_code("12345")); // wrong length
        assert!(!is_valid_short_code("48219365771a")); // non-digit
    }

    #[test]
    fn bare_compact_token() {
        let t = "ia1.3f9a1c2b4d5e6f70AbCd_-";
        assert_eq!(
            normalise_token_input(t),
            Some(TokenInput::Compact(t.to_string()))
        );
    }

    #[test]
    fn short_code_with_separators() {
        let code = luhn12("48219365771");
        let formatted = format!("{}-{}-{}", &code[..4], &code[4..8], &code[8..]);
        assert_eq!(
            normalise_token_input(&formatted),
            Some(TokenInput::ShortCode(code))
        );
    }

    #[test]
    fn deep_link_grammar_is_strict() {
        let code = luhn12("48219365771");
        assert_eq!(
            parse_deep_link("indiansassist://join?t=ia1.abcdefgh"),
            Some(TokenInput::Compact("ia1.abcdefgh".into()))
        );
        assert_eq!(
            parse_deep_link(&format!("indiansassist://join?c={code}")),
            Some(TokenInput::ShortCode(code))
        );
        // Wrong host / scheme / key => None.
        assert_eq!(parse_deep_link("indiansassist://run?t=ia1.abcdefgh"), None);
        assert_eq!(parse_deep_link("https://join?t=ia1.abcdefgh"), None);
        assert_eq!(parse_deep_link("indiansassist://join?x=ia1.abcdefgh"), None);
    }

    #[test]
    fn quote_breakout_tail_is_not_two_switches() {
        // The §2.5 L2 breakout string parses as one (invalid) URL, never as switches.
        let evil = r#"indiansassist://join?c=1234" --api-origin "http://attacker:4000"#;
        assert_eq!(parse_deep_link(evil), None);
    }

    #[test]
    fn join_url_with_fragment() {
        assert_eq!(
            normalise_token_input("https://in.example.com/join#t=ia1.zzzzzzzz"),
            Some(TokenInput::Compact("ia1.zzzzzzzz".into()))
        );
    }

    #[test]
    fn garbage_is_none() {
        assert_eq!(normalise_token_input("hello world"), None);
        assert_eq!(normalise_token_input(""), None);
    }
}
