//! Command-line parsing (contract §2.1 carriers, §2.5 L2 `--url` tail rule) plus the
//! dev-only local-testing switches (`--api-origin`, `--signal-url`, `--auto-consent`).
//! Pure and tested; the binary turns the parsed [`Cli`] into a session.
//!
//! Release builds compile without the `dev` feature, so [`Cli::parse`] rejects the dev
//! switches there (the compile-time guarantee the contract asks for in §2.1: "compiled
//! only into dev builds behind `#[cfg(feature = "dev")]`").

use ia_core::join_input::normalise_token_input;
use ia_core::types::{AgentConsentLevel, TokenSource};
use ia_platform::protocol::url_tail;

/// The parsed command line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cli {
    /// `--help` / `-h` was requested.
    pub help: bool,
    /// The rank-1 credential (`--url <tail>` deep link, or `--code <value>`), if any.
    pub arg: Option<(TokenSource, ArgToken)>,
    /// `--api-origin <origin>` (dev only): overrides the compiled API origin.
    pub api_origin: Option<String>,
    /// `--signal-url <ws(s)://.../signal>` (dev only): overrides the signaling URL.
    pub signal_url: Option<String>,
    /// `--auto-consent <view|control|elevated>` (debug builds only): skip the window.
    pub auto_consent: Option<AgentConsentLevel>,
    /// `--synthetic-capture` (dev only): use the generated-frame capturer instead of DXGI/GDI
    /// so a session can run on a headless host (the e2e / loopback path).
    pub synthetic_capture: bool,
    /// `--no-self-delete` (dev only): keep the binary on exit (skip the §10 self-delete spawn);
    /// the decision is still computed and logged.
    pub no_self_delete: bool,
    /// `--stop-after <secs>` (dev only): once the session is live, Stop it after this many
    /// seconds (so an automated run ends the session deterministically without a UI click).
    pub stop_after: Option<u64>,
    /// `--handover-pipe <32 hex>` (§7.3 step 3): this process is the elevated child, and the
    /// suffix names the pipe its parent is holding the blob on. **Not** a dev switch: the
    /// hand-over is a release feature, and the suffix is not a secret (the pipe's pid and image
    /// checks are what authenticate the two ends, §7.2).
    pub handover_pipe: Option<String>,
}

/// A credential captured from the command line, kept as the raw string so it can be
/// re-validated and classified by [`ia_core::join_input`] when the session starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgToken(pub String);

/// A parse failure with a user-facing message (printed to stderr; the binary exits 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliError(pub String);

/// `--url` reassembles the whole command-line tail into one string and ignores every other
/// switch (§2.5 L2). Detect its presence up front so a `--url` wins rank 1 and no switch
/// inside the URL is ever treated as a switch.
fn has_url(args: &[String]) -> bool {
    args.iter().any(|a| a == "--url")
}

fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
}

impl Cli {
    /// Parse already-split arguments (without the program name).
    pub fn parse(args: &[String]) -> Result<Cli, CliError> {
        if args.iter().any(|a| a == "--help" || a == "-h") {
            return Ok(Cli {
                help: true,
                ..Default::default()
            });
        }
        let mut cli = Cli::default();

        if has_url(args) {
            // Rank 1 deep link: the entire tail is the URL; no other switch is honoured.
            if let Some(tail) = url_tail(args) {
                if normalise_token_input(&tail).is_some() {
                    cli.arg = Some((TokenSource::Deeplink, ArgToken(tail)));
                } else {
                    return Err(CliError(
                        "This link is not an IndiansAssist join link".into(),
                    ));
                }
            }
            return Ok(cli);
        }

        if let Some(suffix) = value_after(args, "--handover-pipe") {
            if !ia_platform::protocol::valid_pipe_suffix(suffix) {
                return Err(CliError(
                    "--handover-pipe wants 32 lower-case hex characters".into(),
                ));
            }
            cli.handover_pipe = Some(suffix.clone());
        }

        if let Some(code) = value_after(args, "--code") {
            if normalise_token_input(code).is_some() {
                cli.arg = Some((TokenSource::Arg, ArgToken(code.clone())));
            } else {
                return Err(CliError("This code is not valid".into()));
            }
        }

        // Dev-only switches: accepted only when compiled with the `dev` feature.
        parse_dev_switches(&mut cli, args)?;
        Ok(cli)
    }
}

#[cfg(feature = "dev")]
fn parse_dev_switches(cli: &mut Cli, args: &[String]) -> Result<(), CliError> {
    if let Some(o) = value_after(args, "--api-origin") {
        cli.api_origin = Some(o.clone());
    }
    if let Some(u) = value_after(args, "--signal-url") {
        cli.signal_url = Some(u.clone());
    }
    if let Some(level) = value_after(args, "--auto-consent") {
        cli.auto_consent = Some(parse_level(level)?);
    }
    cli.synthetic_capture = args.iter().any(|a| a == "--synthetic-capture");
    cli.no_self_delete = args.iter().any(|a| a == "--no-self-delete");
    if let Some(v) = value_after(args, "--stop-after") {
        cli.stop_after = Some(
            v.parse()
                .map_err(|_| CliError("--stop-after wants a whole number of seconds".into()))?,
        );
    }
    Ok(())
}

#[cfg(not(feature = "dev"))]
fn parse_dev_switches(_cli: &mut Cli, args: &[String]) -> Result<(), CliError> {
    for dev in [
        "--api-origin",
        "--signal-url",
        "--auto-consent",
        "--synthetic-capture",
        "--no-self-delete",
        "--stop-after",
    ] {
        if args.iter().any(|a| a == dev) {
            return Err(CliError(format!(
                "{dev} is available only in a development build"
            )));
        }
    }
    Ok(())
}

#[cfg(feature = "dev")]
fn parse_level(s: &str) -> Result<AgentConsentLevel, CliError> {
    let level = match s {
        "view" => AgentConsentLevel::View,
        "control" => AgentConsentLevel::Control,
        "elevated" => AgentConsentLevel::Elevated,
        other => return Err(CliError(format!("unknown consent level '{other}'"))),
    };
    // Sanity: the ordering helper is exercised so the enum stays total.
    debug_assert!(ia_core::types::agent_level_at_least(
        level,
        AgentConsentLevel::View
    ));
    Ok(level)
}

/// The `--help` text.
pub const HELP: &str = "\
IndiansAssist support client (Phase C portable agent)

USAGE:
    IndiansAssist [--code <code>] [--url <indiansassist://join?...>]

OPTIONS:
    --code <code>   A 12-digit support code or a compact ia1.* token.
    --url  <link>   An indiansassist://join deep link (takes the whole command tail).
    -h, --help      Print this help.

Development builds also accept --api-origin <origin>, --signal-url <ws-url>,
--auto-consent <view|control|elevated>, --synthetic-capture (generated frames, no
display), --no-self-delete (keep the binary) and --stop-after <secs> for local and
automated testing against `pnpm dev`.

With no code the connect window prompts for one. The agent shows a consent window
before sharing and an always-on-top indicator while a session is live, and removes
itself on exit unless you choose to keep it.";

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<Cli, CliError> {
        Cli::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn the_handover_switch_is_parsed_in_every_build_and_checked() {
        let ok = p(&["--handover-pipe", "0123456789abcdef0123456789abcdef"]).unwrap();
        assert_eq!(
            ok.handover_pipe.as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        // The suffix is not a secret, but a malformed one means something other than our own
        // service launched us, so it is refused rather than tried.
        for bad in ["", "SHOUTY0123456789abcdef0123456789", "short"] {
            assert!(p(&["--handover-pipe", bad]).is_err(), "{bad} must not pass");
        }
        assert!(p(&[]).unwrap().handover_pipe.is_none());
    }

    #[test]
    fn help_wins() {
        assert!(p(&["--help"]).unwrap().help);
        assert!(p(&["-h"]).unwrap().help);
    }

    #[test]
    fn code_arg_is_captured_when_valid() {
        let cli = p(&["--code", "ia1.abcdefgh"]).unwrap();
        assert_eq!(
            cli.arg,
            Some((TokenSource::Arg, ArgToken("ia1.abcdefgh".into())))
        );
    }

    #[test]
    fn invalid_code_errors() {
        assert!(p(&["--code", "not a code"]).is_err());
    }

    #[test]
    fn url_tail_becomes_deeplink_and_ignores_trailing_switches() {
        // The quote-breakout string arrives as one trailing arg; it is not a valid URL.
        let cli = p(&[
            "--url",
            "indiansassist://join?c=1234\" --api-origin \"http://x:4000",
        ]);
        assert!(cli.is_err());
        // A clean deep link parses.
        let ok = p(&["--url", "indiansassist://join?t=ia1.abcdefgh"]).unwrap();
        assert!(matches!(ok.arg, Some((TokenSource::Deeplink, _))));
        assert!(ok.api_origin.is_none());
    }

    #[cfg(not(feature = "dev"))]
    #[test]
    fn release_build_rejects_dev_switches() {
        assert!(p(&["--api-origin", "http://localhost:4000"]).is_err());
        assert!(p(&["--auto-consent", "control"]).is_err());
        assert!(p(&["--synthetic-capture"]).is_err());
        assert!(p(&["--no-self-delete"]).is_err());
        assert!(p(&["--stop-after", "30"]).is_err());
    }

    #[cfg(feature = "dev")]
    #[test]
    fn dev_build_accepts_overrides() {
        let cli = p(&[
            "--api-origin",
            "http://localhost:4000",
            "--auto-consent",
            "control",
            "--synthetic-capture",
            "--no-self-delete",
            "--stop-after",
            "30",
        ])
        .unwrap();
        assert_eq!(cli.api_origin.as_deref(), Some("http://localhost:4000"));
        assert_eq!(cli.auto_consent, Some(AgentConsentLevel::Control));
        assert!(cli.synthetic_capture);
        assert!(cli.no_self_delete);
        assert_eq!(cli.stop_after, Some(30));
    }

    #[cfg(feature = "dev")]
    #[test]
    fn dev_flags_default_off_and_stop_after_rejects_non_numbers() {
        let cli = p(&["--code", "ia1.abcdefgh"]).unwrap();
        assert!(!cli.synthetic_capture);
        assert!(!cli.no_self_delete);
        assert_eq!(cli.stop_after, None);
        assert!(p(&["--stop-after", "soon"]).is_err());
    }
}
