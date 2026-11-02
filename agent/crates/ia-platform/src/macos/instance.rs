//! The single-instance decisions on macOS (Phase F §17.2, the E §7.7 reasoning), pure.
//!
//! The first agent listens on a Unix socket in the per-user temporary directory; a second one
//! started by a deep link connects and forwards its link, then exits. The listener accepts a peer
//! only when `getpeereid` gives this user's uid **and** the peer runs the same executable image
//! (`proc_pidpath`), so another program cannot inject a session link.

use std::path::Path;

/// The listener accepts a connection only from the same user running the same image.
pub fn server_accepts(
    peer_uid: u32,
    my_uid: u32,
    peer_image: Option<&Path>,
    my_image: &Path,
) -> bool {
    peer_uid == my_uid && peer_image.is_some_and(|p| p == my_image)
}

/// A forwarded message is one line of at most 4 KiB with no control characters other than the
/// final newline (it carries a deep link or `focus`).
pub fn forward_message_ok(line: &str) -> bool {
    let body = line.strip_suffix('\n').unwrap_or(line);
    !body.is_empty() && body.len() <= 4096 && !body.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_same_user_running_the_same_image_is_accepted() {
        let me = Path::new("/Users/pat/Downloads/IndiansAssist.app/Contents/MacOS/IndiansAssist");
        assert!(server_accepts(501, 501, Some(me), me));
        assert!(!server_accepts(502, 501, Some(me), me));
        assert!(!server_accepts(
            501,
            501,
            Some(Path::new("/usr/bin/nc")),
            me
        ));
        assert!(!server_accepts(501, 501, None, me));
    }

    #[test]
    fn forwarded_messages_are_one_short_printable_line() {
        assert!(forward_message_ok("indiansassist://join?t=abc\n"));
        assert!(forward_message_ok("focus"));
        assert!(!forward_message_ok(""));
        assert!(!forward_message_ok("a\nb"));
        assert!(!forward_message_ok(&"x".repeat(4097)));
    }
}
