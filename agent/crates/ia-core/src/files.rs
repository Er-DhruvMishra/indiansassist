//! File-name sanitisation and the risk-extension lists (contract §6.1, A F5 ported).
//!
//! The authority is `@indiansassist/shared` (`files.ts`, `audit/sanitise.ts`); the
//! cross-language vectors in `packages/shared/test/fixtures/agent/` (`sec-vectors.json`
//! `fileNames`, `file-lists.json`) are loaded by `tests/shared_vectors.rs`.

/// `RESERVED_DEVICE_STEMS` (contract §6.1 F3): matched on the stem before the first dot.
pub const RESERVED_DEVICE_STEMS: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// `EXECUTABLE_EXTENSIONS` (A F6 base set, extended by contract §6.1 F4), same order as
/// the shared list. Lower-case, no dot.
pub const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe",
    "com",
    "scr",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "msi",
    "msp",
    "msc",
    "dll",
    "hta",
    "cpl",
    "jar",
    "reg",
    "lnk",
    "app",
    "pkg",
    "dmg",
    "sh",
    "command",
    "apk",
    // Phase C §6.1 F4 additions.
    "pif",
    "application",
    "gadget",
    "inf",
    "ins",
    "isp",
    "msh",
    "msh1",
    "msh2",
    "mshxml",
    "msh1xml",
    "msh2xml",
    "ps1xml",
    "psd1",
    "psc1",
    "appref-ms",
    "diagcab",
];

/// `PASSIVE_RISK_EXTENSIONS` (contract §6.1 F4): act when Explorer merely draws the folder;
/// the agent refuses them outright.
pub const PASSIVE_RISK_EXTENSIONS: &[&str] = &[
    "url",
    "scf",
    "library-ms",
    "settingcontent-ms",
    "website",
    "theme",
    "deskthemepack",
    "searchconnector-ms",
];

/// Max code points of a sanitised file name (A §5.3 `SANITISE_LIMITS.name`).
const NAME_MAX: usize = 200;

fn last_segment(raw: &str) -> &str {
    raw.rsplit(['/', '\\']).next().unwrap_or(raw)
}

/// `fileExtension`: last suffix, lower-cased, no dot; `None` for a leading-dot-only or
/// trailing-dot name.
fn extension(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    if dot == 0 || dot + 1 >= name.len() {
        return None;
    }
    Some(name[dot + 1..].to_ascii_lowercase())
}

/// `hasReservedDeviceStem` (contract §6.1 F3): `con.txt`, `aux.log` -> true.
pub fn has_reserved_device_stem(name: &str) -> bool {
    let stem = last_segment(name)
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    RESERVED_DEVICE_STEMS.contains(&stem.as_str())
}

/// `isPassiveRiskName` (contract §6.1 F4).
pub fn is_passive_risk_name(name: &str) -> bool {
    extension(name)
        .map(|e| PASSIVE_RISK_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or(false)
}

/// `isExecutableName`: red warning + second click (§6.1 F4).
pub fn is_executable_name(name: &str) -> bool {
    extension(name)
        .map(|e| EXECUTABLE_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or(false)
}

/// The A §5.3 removal set: C0, DEL, C1, zero-width and bidi controls, BOM.
fn is_unsafe_char(c: char) -> bool {
    matches!(
        c as u32,
        0x00..=0x1F | 0x7F..=0x9F | 0x200B..=0x200F | 0x202A..=0x202E | 0x2066..=0x2069 | 0xFEFF
    )
}

/// JavaScript `\s` (ECMAScript WhiteSpace + LineTerminator), so the collapse rule agrees
/// with the TypeScript `replace(/\s+/g, ' ')`.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

fn truncate_code_points(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn is_reserved_windows_name(stem_upper: &str) -> bool {
    let b = stem_upper.as_bytes();
    matches!(stem_upper, "CON" | "PRN" | "AUX" | "NUL")
        || (b.len() == 4
            && (stem_upper.starts_with("COM") || stem_upper.starts_with("LPT"))
            && (b'1'..=b'9').contains(&b[3]))
}

/// `sanitiseFileName(name, fileId)` (A §8.3 F5), a port of the shared TypeScript function:
/// NFC; remove controls, bidi and zero-width characters; replace `/ \ : * ? " < > |` with
/// `_`; collapse whitespace runs; strip leading dots and whitespace and trailing whitespace;
/// truncate to 200 code points keeping the extension; prefix a reserved Windows device stem
/// with `_`; an empty result becomes `file-<fileId>`.
pub fn sanitise_file_name(name: &str, file_id: u64) -> String {
    let nfc = icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(name);
    let mut collapsed = String::with_capacity(nfc.len());
    let mut in_space = false;
    for c in nfc.chars().filter(|c| !is_unsafe_char(*c)) {
        let c = match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        };
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let mut s = collapsed
        .trim_start_matches(|c: char| c == '.' || is_js_space(c))
        .trim_end_matches(is_js_space)
        .to_string();
    if s.chars().count() > NAME_MAX {
        let ext = match s.rfind('.') {
            Some(dot) if dot > 0 => s[dot..].to_string(),
            _ => String::new(),
        };
        let ext_len = ext.chars().count();
        s = if !ext.is_empty() && ext_len < NAME_MAX {
            let stem = &s[..s.len() - ext.len()];
            let mut out = truncate_code_points(stem, NAME_MAX - ext_len)
                .trim_end_matches(is_js_space)
                .to_string();
            out.push_str(&ext);
            out
        } else {
            truncate_code_points(&s, NAME_MAX)
        };
    }
    let stem = s.split('.').next().unwrap_or("").trim().to_uppercase();
    if is_reserved_windows_name(&stem) {
        s = truncate_code_points(&format!("_{s}"), NAME_MAX);
    }
    if s.is_empty() {
        s = format!("file-{file_id}");
    }
    s
}

/// Validate a received file's declared name into a safe save leaf, or a `bad_name` reason
/// (contract §6.1 F3): a passive-risk type, a reserved device stem of the declared leaf
/// (checked before sanitisation, since A F5 alone would only prefix it), or a residual
/// separator after sanitisation.
pub fn validate_save_leaf(raw: &str, file_id: u64) -> Result<String, &'static str> {
    if is_passive_risk_name(raw) || has_reserved_device_stem(raw) {
        return Err("bad_name");
    }
    let leaf = sanitise_file_name(raw, file_id);
    if leaf.contains('/') || leaf.contains('\\') || has_reserved_device_stem(&leaf) {
        return Err("bad_name");
    }
    Ok(leaf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_device_stems_rejected() {
        assert!(has_reserved_device_stem("con.txt"));
        assert!(has_reserved_device_stem("AUX.log"));
        assert!(has_reserved_device_stem("com1.dat"));
        assert!(!has_reserved_device_stem("console.txt"));
        assert_eq!(validate_save_leaf("con.txt", 1), Err("bad_name"));
    }

    #[test]
    fn passive_risk_extensions_refused() {
        assert!(is_passive_risk_name("evil.url"));
        assert!(is_passive_risk_name("hack.library-ms"));
        assert!(is_passive_risk_name("x.settingcontent-ms"));
        assert_eq!(validate_save_leaf("evil.url", 1), Err("bad_name"));
        assert!(!is_passive_risk_name("photo.png"));
    }

    #[test]
    fn executable_extensions_flagged() {
        assert!(is_executable_name("setup.exe"));
        assert!(is_executable_name("run.ps1xml"));
        assert!(is_executable_name("x.appref-ms"));
        assert!(is_executable_name("install.diagcab"));
        assert!(!is_executable_name("notes.txt"));
    }

    #[test]
    fn sanitise_matches_a_f5() {
        assert_eq!(sanitise_file_name("../../etc/passwd", 2), "_.._etc_passwd");
        assert_eq!(
            sanitise_file_name("a<b>c:\"d|e?f*.txt", 1),
            "a_b_c__d_e_f_.txt"
        );
        assert_eq!(sanitise_file_name("   ", 4), "file-4");
        assert_eq!(sanitise_file_name("con.txt", 5), "_con.txt");
        assert_eq!(sanitise_file_name("e\u{301}te.txt", 6), "\u{e9}te.txt");
    }

    #[test]
    fn good_name_validates() {
        assert_eq!(
            validate_save_leaf("report (2).pdf", 1),
            Ok("report (2).pdf".into())
        );
        assert_eq!(
            validate_save_leaf("logs-2026.zip", 1),
            Ok("logs-2026.zip".into())
        );
    }

    #[test]
    fn traversal_never_yields_a_separator() {
        let leaf = validate_save_leaf("subdir/inner/file.txt", 1).unwrap();
        assert!(!leaf.contains('/') && !leaf.contains('\\'));
        assert_eq!(leaf, "subdir_inner_file.txt");
    }
}
