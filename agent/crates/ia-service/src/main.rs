//! `ia-service`: the installed agent's entry point, one binary name on both platforms.
//!
//! * Windows, feature `service`: the SCM service of Phase D §4.1 ([`main_win`]).
//! * Linux, feature `linux-service`: the systemd service of Phase F §8 ([`main_linux`]).
//! * macOS, feature `macos-service`: the LaunchDaemon of Phase F §17.3 (`main_macos`).
//!
//! Built with neither, the binary says so and exits: there is nothing for it to run.

#[cfg(all(windows, feature = "service"))]
#[path = "main_win.rs"]
mod main_win;

#[cfg(all(target_os = "linux", feature = "linux-service"))]
#[path = "main_linux.rs"]
mod main_linux;

// apple-owned: begin
#[cfg(all(target_os = "macos", feature = "macos-service"))]
#[path = "main_macos.rs"]
mod main_macos;
// apple-owned: end

fn main() {
    #[cfg(all(windows, feature = "service"))]
    main_win::main();

    #[cfg(all(target_os = "linux", feature = "linux-service"))]
    main_linux::main();

    // apple-owned: begin
    #[cfg(all(target_os = "macos", feature = "macos-service"))]
    main_macos::main();
    // apple-owned: end

    #[cfg(not(any(
        all(windows, feature = "service"),
        all(target_os = "linux", feature = "linux-service"),
        all(target_os = "macos", feature = "macos-service")
    )))]
    {
        eprintln!(
            "ia-service was built without its platform feature (`service` on Windows, \
             `linux-service` on Linux); there is nothing to run."
        );
        std::process::exit(2);
    }
}
