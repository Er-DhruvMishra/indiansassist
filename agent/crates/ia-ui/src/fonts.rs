//! The fonts every agent window draws with (licence audit F2, `docs/LICENSE-REGISTER.md`).
//!
//! egui's built-in fonts are off (`default-features = false` on egui and no `default_fonts` on
//! eframe): one of them, Ubuntu-Light, is under the Ubuntu Font Licence, which is not
//! OSI-approved. In their place the agent embeds two fonts under the SIL Open Font License 1.1,
//! the upstream files byte for byte (`assets/fonts/`, with their `OFL.txt` and
//! `OFL-NotoEmoji.txt`; versions and sha256 in the register):
//!
//! * **Noto Sans Regular** 2.015 (notofonts), the UI's text: Latin, Greek and Cyrillic. The
//!   monospace family uses it too (only the security code asks for monospace, and Noto Sans
//!   digits are tabular, so the groups still line up).
//! * **Noto Emoji** 3.002 (monochrome, google/fonts), the fallback for emoji in chat messages and
//!   the few symbols the UI draws (the consent window's check mark), scaled as egui scaled it.

use eframe::egui::{self, FontData, FontDefinitions, FontFamily, FontTweak};

/// Noto Sans Regular 2.015, unhinted (notofonts.github.io, OFL-1.1).
pub const NOTO_SANS: &[u8] = include_bytes!("../assets/fonts/NotoSans-Regular.ttf");
/// Noto Emoji 3.002, monochrome, upstream `NotoEmoji[wght].ttf` (google/fonts, OFL-1.1).
pub const NOTO_EMOJI: &[u8] = include_bytes!("../assets/fonts/NotoEmoji-wght.ttf");

/// The family names in [`definitions`].
pub const TEXT: &str = "NotoSans";
pub const EMOJI: &str = "NotoEmoji";

/// The agent's font definitions: Noto Sans first, Noto Emoji as the fallback, for both the
/// proportional and the monospace family.
pub fn definitions() -> FontDefinitions {
    let mut d = FontDefinitions::empty();
    d.font_data
        .insert(TEXT.to_owned(), FontData::from_static(NOTO_SANS));
    d.font_data.insert(
        EMOJI.to_owned(),
        // The size egui gave its own Noto Emoji, so emoji sit at the text's height.
        FontData::from_static(NOTO_EMOJI).tweak(FontTweak {
            scale: 0.81,
            ..Default::default()
        }),
    );
    for family in [FontFamily::Proportional, FontFamily::Monospace] {
        d.families
            .insert(family, vec![TEXT.to_owned(), EMOJI.to_owned()]);
    }
    d
}

/// Install [`definitions`] on a new context (from the eframe creator, before the first frame).
pub fn install(ctx: &egui::Context) {
    ctx.set_fonts(definitions());
}

#[cfg(test)]
mod tests {
    use super::*;
    use eframe::egui::epaint::text::Fonts;
    use eframe::egui::FontId;

    fn fonts() -> Fonts {
        Fonts::new(1.0, 2048, definitions())
    }

    #[test]
    fn the_definitions_hold_exactly_the_two_ofl_fonts() {
        let d = definitions();
        let mut names: Vec<_> = d.font_data.keys().cloned().collect();
        names.sort();
        assert_eq!(names, vec![EMOJI.to_owned(), TEXT.to_owned()]);
        for family in [FontFamily::Proportional, FontFamily::Monospace] {
            assert_eq!(
                d.families.get(&family),
                Some(&vec![TEXT.to_owned(), EMOJI.to_owned()]),
                "{family:?}"
            );
        }
        // Nothing of egui's own set is left (its names are not registered).
        for builtin in [
            "Hack",
            "Ubuntu-Light",
            "NotoEmoji-Regular",
            "emoji-icon-font",
        ] {
            assert!(!d.font_data.contains_key(builtin), "{builtin}");
        }
    }

    #[test]
    fn the_embedded_files_are_the_pinned_ones() {
        // The sizes of the upstream files (the sha256 are in docs/LICENSE-REGISTER.md).
        assert_eq!(NOTO_SANS.len(), 431_364);
        assert_eq!(NOTO_EMOJI.len(), 1_982_596);
        // Both are TrueType outlines (sfnt version 1.0).
        assert_eq!(&NOTO_SANS[..4], &[0, 1, 0, 0]);
        assert_eq!(&NOTO_EMOJI[..4], &[0, 1, 0, 0]);
    }

    /// Everything the consent window, pill and panel draw has a glyph: the fixed strings, the
    /// punctuation egui itself adds (the ellipsis of a truncated label, the password bullet),
    /// the check mark of a granted macOS step, and emoji a technician may send in chat.
    #[test]
    fn the_ui_text_has_glyphs() {
        let f = fonts();
        for font_id in [FontId::proportional(13.0), FontId::monospace(13.0)] {
            for s in [
                "IndiansAssist - Share your screen?",
                "Share my screen",
                "Screens to share",
                "What the technician may do",
                "Security code 123 456",
                "Shared screens",
                "Chat",
                "0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz",
                "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
                "\u{2026} \u{2022} \u{2013} \u{2014} \u{2019} \u{201C}\u{201D} \u{00A7} \u{00B1}",
                "Ren\u{00E9}e \u{00D6}zg\u{00FC}r \u{0141}ukasz \u{0391}\u{03B8}\u{03AE}\u{03BD}\u{03B1} \u{041C}\u{043E}\u{0441}\u{043A}\u{0432}\u{0430}",
                "\u{2714}",
                "\u{1F44D} \u{1F600} \u{2764} \u{1F64F}",
            ] {
                assert!(f.has_glyphs(&font_id, s), "{font_id:?}: {s:?}");
            }
        }
    }
}
