//! `os.text` on macOS: the text is posted as Unicode keyboard events
//! (`CGEventKeyboardSetUnicodeString`), which carry at most 20 UTF-16 units each. Pure; tested on
//! every host.

/// The most UTF-16 units one Unicode keyboard event carries (Quartz truncates longer strings).
pub const MAX_UNITS_PER_EVENT: usize = 20;

/// `text` as UTF-16 chunks of at most [`MAX_UNITS_PER_EVENT`] units that never split a surrogate
/// pair. `\r\n` and a lone `\r` become `\n`, which apps read as Return.
pub fn utf16_chunks(text: &str) -> Vec<Vec<u16>> {
    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut chunks = Vec::new();
    let mut current: Vec<u16> = Vec::with_capacity(MAX_UNITS_PER_EVENT);
    for ch in normalised.chars() {
        let mut buf = [0u16; 2];
        let units = ch.encode_utf16(&mut buf);
        if current.len() + units.len() > MAX_UNITS_PER_EVENT {
            chunks.push(std::mem::take(&mut current));
        }
        current.extend_from_slice(units);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_one_chunk() {
        assert_eq!(
            utf16_chunks("héllo"),
            vec!["héllo".encode_utf16().collect::<Vec<_>>()]
        );
        assert!(utf16_chunks("").is_empty());
    }

    #[test]
    fn long_text_splits_at_twenty_units_without_breaking_a_surrogate_pair() {
        let text = format!("{}😀tail", "a".repeat(19));
        let chunks = utf16_chunks(&text);
        assert_eq!(chunks[0].len(), 19, "the emoji does not fit after 19 units");
        assert_eq!(String::from_utf16(&chunks[1]).unwrap(), "😀tail");
        assert!(chunks.iter().all(|c| c.len() <= MAX_UNITS_PER_EVENT));
        let joined: String = chunks
            .iter()
            .map(|c| String::from_utf16(c).unwrap())
            .collect();
        assert_eq!(joined, text);
    }

    #[test]
    fn line_endings_become_newlines() {
        let joined: String = utf16_chunks("a\r\nb\rc\n")
            .iter()
            .map(|c| String::from_utf16(c).unwrap())
            .collect();
        assert_eq!(joined, "a\nb\nc\n");
    }
}
