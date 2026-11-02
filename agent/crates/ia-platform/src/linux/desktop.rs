//! The `indiansassist://` deep-link handler on Linux (Phase E §7.7, C §2.5): the `.desktop`
//! file and the `mimeapps.list` edit with its restore. Pure text transforms, tested on every host;
//! the file I/O around them is [`super::os`].

/// The handler's desktop-entry file name under `$XDG_DATA_HOME/applications/`.
pub const DESKTOP_FILE_NAME: &str = "indiansassist-handler.desktop";
/// The MIME type of the scheme.
pub const SCHEME_MIME: &str = "x-scheme-handler/indiansassist";
const DEFAULT_APPS: &str = "[Default Applications]";

/// Quote an `Exec` argument per the Desktop Entry spec: inside double quotes, `"`, `` ` ``, `$`
/// and `\` are escaped with a backslash; `%` is doubled (a literal percent in `Exec`).
pub fn quote_exec_arg(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    for c in arg.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The desktop entry (§7.7): `Type=Application`, `NoDisplay=true`, the scheme MIME type and
/// `Exec="<exe>" --url %u`. The C §2.5 L2 rule (everything after `--url` is one URL, no other
/// switch honoured) is unchanged, so a crafted link cannot smuggle a switch in.
pub fn desktop_entry(exe_path: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=IndiansAssist\nComment=IndiansAssist remote support link handler\nNoDisplay=true\nTerminal=false\nMimeType={SCHEME_MIME};\nExec={} --url %u\n",
        quote_exec_arg(exe_path)
    )
}

/// The result of setting our handler as the scheme default in a `mimeapps.list` text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MimeappsEdit {
    /// The new file text.
    pub text: String,
    /// The value `x-scheme-handler/indiansassist` had before (to restore on exit), if any.
    pub previous: Option<String>,
}

fn is_section(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('[') && t.ends_with(']')
}

fn key_of(line: &str) -> Option<&str> {
    let t = line.trim_start();
    if t.starts_with('#') {
        return None;
    }
    t.split_once('=').map(|(k, _)| k.trim())
}

/// Set `x-scheme-handler/indiansassist=<desktop file>` in `[Default Applications]`, keeping
/// every other line and section, and report the previous value. A value that already names our
/// handler is not reported as "previous" (nothing to restore).
pub fn set_default(text: &str) -> MimeappsEdit {
    let ours = DESKTOP_FILE_NAME;
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    let mut previous = None;
    let start = lines.iter().position(|l| l.trim() == DEFAULT_APPS);
    match start {
        Some(s) => {
            let end = lines[s + 1..]
                .iter()
                .position(|l| is_section(l))
                .map(|i| s + 1 + i)
                .unwrap_or(lines.len());
            let existing = (s + 1..end).find(|&i| key_of(&lines[i]) == Some(SCHEME_MIME));
            match existing {
                Some(i) => {
                    let old = lines[i].split_once('=').map(|(_, v)| v.trim().to_string());
                    if old.as_deref() != Some(ours) {
                        previous = old.filter(|v| !v.is_empty());
                    }
                    lines[i] = format!("{SCHEME_MIME}={ours}");
                }
                None => lines.insert(s + 1, format!("{SCHEME_MIME}={ours}")),
            }
        }
        None => {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push(DEFAULT_APPS.to_string());
            lines.push(format!("{SCHEME_MIME}={ours}"));
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    MimeappsEdit {
        text: out,
        previous,
    }
}

/// Undo [`set_default`] on exit: put the remembered previous value back, or remove our line
/// when there was none. A line that no longer names our handler (the user changed it while we
/// ran) is left alone. Returns the new text.
pub fn restore_default(text: &str, previous: Option<&str>) -> String {
    let mut in_defaults = false;
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        if is_section(line) {
            in_defaults = line.trim() == DEFAULT_APPS;
            out.push(line.to_string());
            continue;
        }
        if in_defaults && key_of(line) == Some(SCHEME_MIME) {
            let value = line.split_once('=').map(|(_, v)| v.trim()).unwrap_or("");
            if value == DESKTOP_FILE_NAME {
                if let Some(p) = previous {
                    out.push(format!("{SCHEME_MIME}={p}"));
                }
                continue;
            }
        }
        out.push(line.to_string());
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_entry_is_the_contract_one() {
        let e = desktop_entry("/home/asha/Downloads/IndiansAssist-in-mum-4821-9365-7715");
        assert!(e.starts_with("[Desktop Entry]\n"));
        for line in [
            "Type=Application",
            "NoDisplay=true",
            "MimeType=x-scheme-handler/indiansassist;",
            "Exec=\"/home/asha/Downloads/IndiansAssist-in-mum-4821-9365-7715\" --url %u",
        ] {
            assert!(e.lines().any(|l| l == line), "missing {line}: {e}");
        }
    }

    #[test]
    fn exec_arguments_are_quoted_so_a_path_cannot_break_out() {
        assert_eq!(
            quote_exec_arg("/tmp/a b/$x`y\"z\\%u"),
            "\"/tmp/a b/\\$x\\`y\\\"z\\\\%%u\""
        );
    }

    #[test]
    fn setting_the_default_in_an_empty_or_missing_file() {
        let edit = set_default("");
        assert_eq!(
            edit.text,
            "[Default Applications]\nx-scheme-handler/indiansassist=indiansassist-handler.desktop\n"
        );
        assert_eq!(edit.previous, None);
        // Restoring with nothing remembered removes our line and keeps the section header.
        assert_eq!(
            restore_default(&edit.text, None),
            "[Default Applications]\n"
        );
    }

    #[test]
    fn a_previous_handler_is_remembered_and_restored_and_other_lines_kept() {
        let before = "[Added Associations]\ntext/plain=gedit.desktop;\n\n[Default Applications]\ntext/html=firefox.desktop\nx-scheme-handler/indiansassist=other-agent.desktop\n# a comment\n";
        let edit = set_default(before);
        assert_eq!(edit.previous.as_deref(), Some("other-agent.desktop"));
        assert!(edit
            .text
            .contains("x-scheme-handler/indiansassist=indiansassist-handler.desktop"));
        assert!(edit.text.contains("text/html=firefox.desktop"));
        assert!(edit.text.contains("text/plain=gedit.desktop;"));
        let after = restore_default(&edit.text, edit.previous.as_deref());
        assert_eq!(after, before);
    }

    #[test]
    fn a_section_without_our_key_gets_it_and_a_re_run_reports_no_previous() {
        let before = "[Default Applications]\ntext/html=firefox.desktop\n[Removed Associations]\n";
        let edit = set_default(before);
        assert_eq!(edit.previous, None);
        let lines: Vec<&str> = edit.text.lines().collect();
        assert_eq!(
            lines[1],
            "x-scheme-handler/indiansassist=indiansassist-handler.desktop"
        );
        // Running again (a second start) does not mistake our own value for a previous one.
        assert_eq!(set_default(&edit.text).previous, None);
        assert_eq!(restore_default(&edit.text, None), before);
    }

    #[test]
    fn a_value_the_user_changed_meanwhile_is_left_alone() {
        let text = "[Default Applications]\nx-scheme-handler/indiansassist=their-choice.desktop\n";
        assert_eq!(restore_default(text, Some("old.desktop")), text);
    }
}
