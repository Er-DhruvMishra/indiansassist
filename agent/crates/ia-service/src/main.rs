//! `ia-service`: the installed agent's entry point, one binary name on both platforms.
//!
//! * Windows, feature `service`: the SCM service of Phase D §4.1 ([`main_win`]).
//! * Linux, feature `linux-service`: the systemd service of Phase F §8 ([`main_linux`]).
//!
//! Built with neither, the binary says so and exits: there is nothing for it to run.

#[cfg(all(windows, feature = "service"))]
#[path = "main_win.rs"]
mod main_win;

#[cfg(all(target_os = "linux", feature = "linux-service"))]
#[path = "main_linux.rs"]
mod main_linux;

fn main() {
    #[cfg(all(windows, feature = "service"))]
    main_win::main();

    #[cfg(all(target_os = "linux", feature = "linux-service"))]
    main_linux::main();

    #[cfg(not(any(
        all(windows, feature = "service"),
        all(target_os = "linux", feature = "linux-service")
    )))]
    {
        eprintln!(
            "ia-service was built without its platform feature (`service` on Windows, \
             `linux-service` on Linux); there is nothing to run."
        );
        std::process::exit(2);
    }
}
