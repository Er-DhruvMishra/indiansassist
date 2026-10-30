//! Token-carrier precedence (contract §2.1) with the §2.4 "filename wins over the sidecar
//! code" exception. Pure; tested. The caller reads the clipboard (rank 4) only when ranks
//! 1-3 yield nothing (§2.1), so clipboard is passed already-resolved-or-None.

use ia_core::join_input::TokenInput;
use ia_core::types::TokenSource;

/// The resolved join credential and which carrier supplied it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub source: TokenSource,
    pub token: TokenInput,
    /// True when the filename code overrode a disagreeing sidecar code (§2.4 message shown).
    pub filename_overrode_sidecar: bool,
}

/// Candidate credentials by carrier. `arg` carries its own source (`Arg` for `--code`,
/// `Deeplink` for `--url`). `clipboard` is `Some` only if the caller already read it
/// (which it does only when ranks 1-3 are empty).
#[derive(Debug, Clone, Default)]
pub struct Candidates {
    pub arg: Option<(TokenSource, TokenInput)>,
    pub sidecar_code: Option<TokenInput>,
    pub filename_code: Option<TokenInput>,
    pub clipboard: Option<TokenInput>,
    pub manual: Option<TokenInput>,
}

/// Resolve the carrier that supplies the join code (contract §2.1 ranks 1-5, §2.4 override).
pub fn resolve(c: &Candidates) -> Option<Resolved> {
    // Rank 1: explicit argument / deep link.
    if let Some((source, token)) = &c.arg {
        return Some(Resolved {
            source: *source,
            token: token.clone(),
            filename_overrode_sidecar: false,
        });
    }

    // Ranks 2-3 with the §2.4 exception: when both the sidecar and the filename carry a
    // code and they disagree, the filename wins; when they agree (or only the sidecar has
    // one), the sidecar (rank 2) supplies it.
    match (&c.sidecar_code, &c.filename_code) {
        (Some(sc), Some(fc)) if sc != fc => {
            return Some(Resolved {
                source: TokenSource::Filename,
                token: fc.clone(),
                filename_overrode_sidecar: true,
            });
        }
        (Some(sc), _) => {
            return Some(Resolved {
                source: TokenSource::Sidecar,
                token: sc.clone(),
                filename_overrode_sidecar: false,
            });
        }
        (None, Some(fc)) => {
            return Some(Resolved {
                source: TokenSource::Filename,
                token: fc.clone(),
                filename_overrode_sidecar: false,
            });
        }
        (None, None) => {}
    }

    // Rank 4: clipboard (only consulted by the caller when 1-3 were empty).
    if let Some(cb) = &c.clipboard {
        return Some(Resolved {
            source: TokenSource::Clipboard,
            token: cb.clone(),
            filename_overrode_sidecar: false,
        });
    }

    // Rank 5: manual entry.
    c.manual.as_ref().map(|m| Resolved {
        source: TokenSource::Manual,
        token: m.clone(),
        filename_overrode_sidecar: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(s: &str) -> TokenInput {
        TokenInput::Compact(s.to_string())
    }

    #[test]
    fn arg_beats_everything() {
        let c = Candidates {
            arg: Some((TokenSource::Deeplink, tok("ia1.arg"))),
            sidecar_code: Some(tok("ia1.side")),
            filename_code: Some(tok("ia1.file")),
            ..Default::default()
        };
        let r = resolve(&c).unwrap();
        assert_eq!(r.source, TokenSource::Deeplink);
        assert_eq!(r.token, tok("ia1.arg"));
    }

    #[test]
    fn filename_wins_over_disagreeing_sidecar_code() {
        let c = Candidates {
            sidecar_code: Some(tok("ia1.side")),
            filename_code: Some(tok("ia1.file")),
            ..Default::default()
        };
        let r = resolve(&c).unwrap();
        assert_eq!(r.source, TokenSource::Filename);
        assert_eq!(r.token, tok("ia1.file"));
        assert!(r.filename_overrode_sidecar);
    }

    #[test]
    fn agreeing_codes_use_sidecar_rank() {
        let c = Candidates {
            sidecar_code: Some(tok("ia1.same")),
            filename_code: Some(tok("ia1.same")),
            ..Default::default()
        };
        let r = resolve(&c).unwrap();
        assert_eq!(r.source, TokenSource::Sidecar);
        assert!(!r.filename_overrode_sidecar);
    }

    #[test]
    fn clipboard_then_manual_fallback() {
        let c = Candidates {
            clipboard: Some(tok("ia1.clip")),
            ..Default::default()
        };
        assert_eq!(resolve(&c).unwrap().source, TokenSource::Clipboard);

        let c = Candidates {
            manual: Some(tok("ia1.man")),
            ..Default::default()
        };
        assert_eq!(resolve(&c).unwrap().source, TokenSource::Manual);

        assert_eq!(resolve(&Candidates::default()), None);
    }

    #[test]
    fn sidecar_only_code() {
        let c = Candidates {
            sidecar_code: Some(tok("ia1.side")),
            ..Default::default()
        };
        let r = resolve(&c).unwrap();
        assert_eq!(r.source, TokenSource::Sidecar);
    }
}
