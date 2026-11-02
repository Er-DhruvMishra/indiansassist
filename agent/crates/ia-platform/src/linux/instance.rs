//! Single instance on Linux (Phase E §7.7, C §11.5): an abstract Unix socket
//! `\0IndiansAssist.<uid>.<16 random hex>` whose random part lives in
//! `$XDG_RUNTIME_DIR/indiansassist/instance`.
//!
//! The abstract namespace is visible to every user of the network namespace, so both ends check
//! the other: the server accepts a client only if `SO_PEERCRED` shows the same uid, and a client
//! forwards only if the server's uid is its own **and** `/proc/<pid>/exe` of the server resolves
//! to its own image path (the pipe-squatting reasoning of C §11.5). The decisions are pure here;
//! the socket is [`super::os`].

use std::path::Path;

/// The abstract socket name **without** the leading NUL (the OS layer adds it).
pub fn socket_name(uid: u32, rand_hex: &str) -> String {
    format!("IndiansAssist.{uid}.{rand_hex}")
}

/// The random part is exactly 16 lower-case hex characters.
pub fn valid_rand(s: &str) -> bool {
    s.len() == 16
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Server side: accept a connecting client only when its peer uid is ours.
pub fn server_accepts(peer_uid: u32, my_uid: u32) -> bool {
    peer_uid == my_uid
}

/// Client side: forward to the listening instance only when it runs as this user and from this
/// very image (so a same-uid process that squats the name with another binary gets nothing).
pub fn client_forwards(
    server_uid: u32,
    my_uid: u32,
    server_exe: Option<&Path>,
    my_exe: &Path,
) -> bool {
    server_uid == my_uid && server_exe.is_some_and(|e| e == my_exe)
}

/// What a second start forwards: one line, the deep link or code it was given (C §2.5), at most
/// this many bytes. The running instance never treats it as a command.
pub const FORWARD_MAX_BYTES: usize = 4096;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_and_its_random_part() {
        assert_eq!(
            socket_name(1000, "0123456789abcdef"),
            "IndiansAssist.1000.0123456789abcdef"
        );
        assert!(valid_rand("0123456789abcdef"));
        for bad in [
            "",
            "0123456789ABCDEF",
            "0123",
            "0123456789abcdef0",
            "../../etc/passw",
        ] {
            assert!(!valid_rand(bad), "{bad}");
        }
    }

    #[test]
    fn the_peer_checks() {
        assert!(server_accepts(1000, 1000));
        assert!(!server_accepts(1001, 1000));
        let me = Path::new("/home/a/Downloads/IndiansAssist-in-mum-4821-9365-7715");
        assert!(client_forwards(1000, 1000, Some(me), me));
        assert!(!client_forwards(1001, 1000, Some(me), me), "another user");
        assert!(
            !client_forwards(1000, 1000, Some(Path::new("/tmp/squatter")), me),
            "same uid, another image"
        );
        assert!(!client_forwards(1000, 1000, None, me), "unreadable exe");
    }
}
