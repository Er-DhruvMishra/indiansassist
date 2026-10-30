//! IndiansAssist Windows agent entry point (contract §11.1 `ia-agent`).
//!
//! The real build (feature `media`) has no console window and drives the webrtc-rs peer,
//! encoders, egui UI and signaling. The default dev build (no `media` — the only one that
//! compiles on the gnu machine without a C toolchain) resolves the token-source precedence
//! from the command line and reports it; it is the harness for the pure orchestration
//! logic, not a runnable session.
#![cfg_attr(feature = "media", windows_subsystem = "windows")]

use ia_agent::tokensource::{resolve, Candidates};
use ia_core::join_input::normalise_token_input;
use ia_core::types::TokenSource;
use ia_platform::protocol::url_tail;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Rank 1: `--url <tail>` (deep link) or `--code <value>` (§2.1, §2.5 L2).
    let arg = url_tail(&args)
        .and_then(|t| normalise_token_input(&t))
        .map(|t| (TokenSource::Deeplink, t))
        .or_else(|| {
            let pos = args.iter().position(|a| a == "--code")?;
            let v = args.get(pos + 1)?;
            normalise_token_input(v).map(|t| (TokenSource::Arg, t))
        });

    let candidates = Candidates {
        arg,
        ..Default::default()
    };

    match resolve(&candidates) {
        Some(r) => {
            println!("IndiansAssist agent {}", env!("CARGO_PKG_VERSION"));
            println!("token source: {:?}", r.source);
        }
        None => {
            println!("IndiansAssist agent {}", env!("CARGO_PKG_VERSION"));
            println!("No support code supplied; the connect window would prompt for one.");
        }
    }

    #[cfg(not(feature = "media"))]
    {
        eprintln!(
            "This dev build is compiled without the `media` feature: the webrtc peer, \
             encoders, UI and signaling are not linked. Build with `--features media` on a \
             toolchain that has a C compiler + nasm (CI / msvc) to run a session. See \
             agent/README.md."
        );
    }

    #[cfg(feature = "media")]
    {
        ia_agent::peer::run_placeholder();
    }
}
