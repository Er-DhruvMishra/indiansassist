//! The camera-link QR beside a chat message (Phase F contract §6.1 step 2, W104): when the
//! technician sends "To show me something with your phone's camera, open this on your phone:
//! <url> (code XXXX-XXXX-XXXX)", the Windows and Linux agents draw that URL as a QR code under the
//! message, so the Desk person scans it from their screen. Pure (no egui): [`camera_link_in`]
//! decides whether a message carries exactly one camera link, [`encode`] makes the module matrix
//! with the `qrcode` crate 0.14.1 (MIT OR Apache-2.0, §10), and the panel paints it.
//!
//! The rule mirrors the web's `cameraLinkIn` (`apps/web/src/camera/CameraLinkAccessory.tsx`):
//! exactly one `http(s)://<host>/c/<code>` link whose code is 12 Crockford characters; any other
//! message (no link, two links, a malformed code) draws nothing. The agent does not know
//! `WEB_ORIGIN`, so the link's host must be the api host the agent connects through (production
//! requires `WEB_ORIGIN === API_ORIGIN`; the port is not compared, because a development web app
//! and api share `localhost` on different ports). When the api host is unknown the link must be
//! `https`. The macOS QR is the apple stream's: on macOS [`encode`] returns `None`.

/// A QR code's modules, row-major, `true` = dark. No quiet zone: the painter adds four modules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QrMatrix {
    width: usize,
    dark: Vec<bool>,
}

impl QrMatrix {
    /// Modules per side (21 for version 1, +4 per version).
    pub fn width(&self) -> usize {
        self.width
    }

    /// Whether the module at column `x`, row `y` is dark (`false` outside the symbol).
    pub fn is_dark(&self, x: usize, y: usize) -> bool {
        x < self.width && y < self.width && self.dark[y * self.width + x]
    }

    /// The QR version this width implies (1..=40).
    pub fn version(&self) -> usize {
        (self.width - 17) / 4
    }

    /// Row-major runs of dark modules `(x, y, len)`, so a painter draws one rectangle per run.
    pub fn dark_runs(&self) -> Vec<(usize, usize, usize)> {
        let mut runs = Vec::new();
        for y in 0..self.width {
            let mut x = 0;
            while x < self.width {
                if self.is_dark(x, y) {
                    let start = x;
                    while x < self.width && self.is_dark(x, y) {
                        x += 1;
                    }
                    runs.push((start, y, x - start));
                } else {
                    x += 1;
                }
            }
        }
        runs
    }
}

/// The modules of a quiet zone on every side (ISO/IEC 18004 asks for four).
pub const QUIET_ZONE: usize = 4;
/// The caption under the code (the web accessory's words).
pub const CAPTION: &str = "Scan with your phone's camera app, or open the link on your phone.";

const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn is_camera_code(code: &str) -> bool {
    code.len() == 12 && code.bytes().all(|b| CROCKFORD.contains(&b))
}

/// The host of `host[:port]`, lower-cased (IPv6 literals keep their brackets).
fn hostname(host_port: &str) -> String {
    let h = if host_port.starts_with('[') {
        host_port
            .split(']')
            .next()
            .map(|s| format!("{s}]"))
            .unwrap_or_default()
    } else {
        host_port.split(':').next().unwrap_or("").to_string()
    };
    h.to_ascii_lowercase()
}

/// The camera link a chat text carries, or `None` unless it holds exactly one valid link (see the
/// module doc). `api_host` is `host[:port]` of the api, or empty when unknown.
pub fn camera_link_in(text: &str, api_host: &str) -> Option<String> {
    let mut links = text
        .split(|c: char| c.is_whitespace())
        .filter(|w| w.contains("://") && w.contains("/c/"))
        .map(|w| {
            // The link ends at the first whitespace or `)`, as the web's `[^\s)]+` does.
            let w = &w[w.find("http").unwrap_or(0)..];
            w.split(')').next().unwrap_or(w).to_string()
        });
    let link = links.next()?;
    if links.next().is_some() {
        return None;
    }
    let (scheme, rest) = link.split_once("://")?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let (host, path) = rest.split_once('/')?;
    if host.is_empty() || host.contains('@') {
        return None;
    }
    let code = path.strip_prefix("c/")?;
    if !is_camera_code(code) {
        return None;
    }
    if api_host.is_empty() {
        if scheme != "https" {
            return None;
        }
    } else if hostname(host) != hostname(api_host) {
        return None;
    }
    Some(link)
}

/// The QR code of `url` at error-correction level M, or `None` when it cannot be encoded (or on
/// macOS, whose QR is the apple stream's).
#[cfg(any(windows, target_os = "linux"))]
pub fn encode(url: &str) -> Option<QrMatrix> {
    let code =
        qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::M).ok()?;
    let width = code.width();
    let dark = code
        .to_colors()
        .into_iter()
        .map(|c| c == qrcode::Color::Dark)
        .collect();
    Some(QrMatrix { width, dark })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn encode(_url: &str) -> Option<QrMatrix> {
    None
}

/// What the chat panel draws under a message: the QR of its camera link, for a technician's
/// message only (the Desk's own messages never get one, as on the web).
pub fn for_chat(from_technician: bool, text: &str, api_host: &str) -> Option<QrMatrix> {
    if !from_technician {
        return None;
    }
    camera_link_in(text, api_host).and_then(|url| encode(&url))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "assist.example.test";
    fn message(url: &str) -> String {
        format!("To show me something with your phone's camera, open this on your phone: {url} (code ABCD-EFGH-JKMN)")
    }

    #[test]
    fn the_console_message_carries_its_link() {
        let url = "https://assist.example.test/c/ABCDEFGHJKMN";
        assert_eq!(camera_link_in(&message(url), HOST).as_deref(), Some(url));
        // The port is not compared (a dev web app and api on localhost, different ports).
        let dev = "http://localhost:5330/c/0123456789AB";
        assert_eq!(
            camera_link_in(&message(dev), "localhost:4160").as_deref(),
            Some(dev)
        );
    }

    #[test]
    fn anything_else_draws_nothing() {
        let good = "https://assist.example.test/c/ABCDEFGHJKMN";
        for text in [
            "no link here".to_string(),
            message("https://assist.example.test/c/ABCDEFGHJKM"), // 11 characters
            message("https://assist.example.test/c/ABCDEFGHJKMNP"), // 13
            message("https://assist.example.test/c/ABCDEFGHIJKL"), // I and L are not Crockford
            message("https://assist.example.test/c/abcdefghjkmn"), // the console sends upper case
            message("https://other.example.test/c/ABCDEFGHJKMN"), // another host
            message("https://user@assist.example.test/c/ABCDEFGHJKMN"),
            message("ftp://assist.example.test/c/ABCDEFGHJKMN"),
            message("https://assist.example.test/x/c/ABCDEFGHJKMN"),
            format!("{good} and {good}"), // two links
        ] {
            assert_eq!(camera_link_in(&text, HOST), None, "{text}");
        }
        // Unknown api host: only an https link.
        assert!(camera_link_in(&message(good), "").is_some());
        assert_eq!(
            camera_link_in(&message("http://assist.example.test/c/ABCDEFGHJKMN"), ""),
            None
        );
    }

    #[test]
    fn only_a_technician_message_gets_a_code() {
        let text = message("https://assist.example.test/c/ABCDEFGHJKMN");
        assert!(for_chat(false, &text, HOST).is_none());
        #[cfg(any(windows, target_os = "linux"))]
        assert!(for_chat(true, &text, HOST).is_some());
    }

    /// The fixed structure every QR symbol has, read back from the matrix: the three 7x7 finder
    /// patterns with their light separators, the timing patterns on row and column 6, and the dark
    /// module at (8, 4V + 9). A matrix with these in place is a QR symbol of the version its width
    /// says; the data itself is the `qrcode` crate's (it is deterministic, checked below).
    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn the_matrix_is_a_well_formed_qr_symbol() {
        let url = "https://assist.example.test/c/ABCDEFGHJKMN";
        let m = encode(url).expect("encodes");
        let w = m.width();
        assert_eq!((w - 17) % 4, 0, "width {w} is 17 + 4V");
        assert!((1..=40).contains(&m.version()));
        // 42 bytes fit version 3 at level M, so this URL is version 3 (29 modules).
        assert_eq!((m.version(), w), (3, 29));
        let finder = |ox: usize, oy: usize| {
            for dy in 0..7 {
                for dx in 0..7 {
                    let ring = dx == 0 || dy == 0 || dx == 6 || dy == 6;
                    let core = (2..=4).contains(&dx) && (2..=4).contains(&dy);
                    assert_eq!(
                        m.is_dark(ox + dx, oy + dy),
                        ring || core,
                        "finder at ({ox},{oy}) +({dx},{dy})"
                    );
                }
            }
        };
        finder(0, 0);
        finder(w - 7, 0);
        finder(0, w - 7);
        for i in 0..8 {
            // The separators: light, one module round each finder.
            assert!(
                !m.is_dark(7, i) && !m.is_dark(i, 7),
                "top-left separator {i}"
            );
            assert!(
                !m.is_dark(w - 8, i) && !m.is_dark(w - 1 - i, 7),
                "top-right separator {i}"
            );
            assert!(
                !m.is_dark(7, w - 1 - i) && !m.is_dark(i, w - 8),
                "bottom-left separator {i}"
            );
        }
        for i in 8..w - 8 {
            assert_eq!(m.is_dark(i, 6), i % 2 == 0, "horizontal timing at {i}");
            assert_eq!(m.is_dark(6, i), i % 2 == 0, "vertical timing at {i}");
        }
        assert!(m.is_dark(8, 4 * m.version() + 9), "the dark module");
        assert!(
            !m.is_dark(w, 0) && !m.is_dark(0, w),
            "outside the symbol is light"
        );
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn the_encoding_is_deterministic_and_depends_on_the_url() {
        let a = encode("https://assist.example.test/c/ABCDEFGHJKMN").unwrap();
        let b = encode("https://assist.example.test/c/ABCDEFGHJKMN").unwrap();
        let c = encode("https://assist.example.test/c/ABCDEFGHJKMP").unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
        // The runs cover exactly the dark modules.
        let from_runs: usize = a.dark_runs().iter().map(|r| r.2).sum();
        let dark = (0..a.width())
            .flat_map(|y| (0..a.width()).map(move |x| (x, y)))
            .filter(|&(x, y)| a.is_dark(x, y))
            .count();
        assert_eq!(from_runs, dark);
        assert!(
            dark > a.width() * a.width() / 4,
            "a QR symbol is roughly half dark"
        );
    }
}
