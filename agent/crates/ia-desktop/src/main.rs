//! `ia-desktop`: the Phase D desktop worker (§4.2, §4.3), and since Phase F the Linux worker the
//! systemd service launches into the user's X11 session (F §8.2, §8.5).
//!
//! It is deliberately thin. Everything about capture, input, consent, the `ia.sec` handshake,
//! the channels, the pill and the teardown is the Phase C `ia-agent` serve loop, unchanged.
//! What this binary does is:
//!
//! 1. reach the service: on Windows, open the pipe named on its command line, verifying that the
//!    server end is its parent running the installed image (§4.2); on Linux, take the inherited
//!    socketpair on fd 3, arm `FD_CLOEXEC` on it first, and check `getppid()` against the blob
//!    (F §8.2);
//! 2. read the launch blob, and refuse to start if it is not one this build understands;
//! 3. serve the duplex channel on a thread — `sign_sas` (rule 3.5b), `os.sas` (§5.4), the
//!    desktop/`SESSIONCHANGE` notifications (§5.3) and the F §8.7 `monitors` report — so the
//!    serve loop can stay unaware that it is talking to a service at all;
//! 4. run the C serve loop with the §4.3 seams installed.
//!
//! It holds **no device key and no token**. Everything privileged is a request to the service.

#[cfg(any(windows, target_os = "linux"))]
mod channel;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod xauth;

fn main() {
    // F §8.2: the Linux worker's first act. fd 3 is the service's channel, and nothing this
    // process spawns (an `sh` playbook, `xdg-open`) may inherit it. A closed fd 3 makes this a
    // harmless EBADF; the entry below then refuses to start.
    #[cfg(target_os = "linux")]
    let _ = ia_session0::unix::set_cloexec(linux::BLOB_FD);

    harden_dll_search();
    // The DPI awareness the capture path needs is set by the serve loop's own start-up (the C
    // agent does it right after this same hardening), so there is nothing to repeat here.

    let args: Vec<String> = std::env::args().skip(1).collect();
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_ansi(false)
        .try_init();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("ia-desktop {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    // apple-owned: begin
    // Phase F §17.3: the macOS LaunchAgent worker reaches the daemon over its Unix socket
    // (`/var/run/indiansassist/worker.sock`) rather than `--service-pipe`; the apple stream
    // fills `macos_entry` (empty until then, so the pipe path below runs unchanged).
    #[cfg(target_os = "macos")]
    macos_entry(&args);
    // apple-owned: end

    #[cfg(windows)]
    windows_main(&args);
    #[cfg(target_os = "linux")]
    linux::main(&args);
}

#[cfg(not(target_os = "linux"))]
const HELP: &str = "ia-desktop - the IndiansAssist desktop worker (Phase D section 4.2)\n\n\
     Launched by the IndiansAssist service, never by hand:\n\
     \x20 --service-pipe <32 hex>   the pipe to read the launch blob from\n\
     \x20 --version                 print the version\n";

#[cfg(target_os = "linux")]
const HELP: &str = "ia-desktop - the IndiansAssist desktop worker (Phase F section 8)\n\n\
     Launched by the IndiansAssist service (indiansassist-agent) into the signed-in user's\n\
     session, never by hand: the launch blob arrives on fd 3.\n\
     \x20 --version                 print the version\n";

#[cfg(windows)]
fn windows_main(args: &[String]) {
    let Some(suffix) = pipe_suffix(args) else {
        eprintln!(
            "ia-desktop is launched by the IndiansAssist service with --service-pipe <32 hex>; \
             it is not something to run by hand."
        );
        std::process::exit(2);
    };
    if let Err(e) = run(&suffix, args) {
        tracing::error!(error = %e, "the worker stopped");
        std::process::exit(1);
    }
}

/// `--service-pipe <32 lower-case hex>`; anything else is refused before a pipe is opened.
#[cfg(windows)]
fn pipe_suffix(args: &[String]) -> Option<String> {
    let value = args
        .iter()
        .position(|a| a == "--service-pipe")
        .and_then(|i| args.get(i + 1))?;
    ia_platform::protocol::valid_pipe_suffix(value).then(|| value.clone())
}

#[cfg(windows)]
fn harden_dll_search() {
    use windows_sys_min::*;
    // SAFETY: process-wide loader flags (C §14): System32 only, and no application directory.
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
        SetDllDirectoryW([0u16].as_ptr());
    }
}

#[cfg(not(windows))]
fn harden_dll_search() {}

// apple-owned: begin
/// Phase F §17.3: the macOS worker entry (apple stream). Empty until then.
#[cfg(target_os = "macos")]
fn macos_entry(_args: &[String]) {}
// apple-owned: end

/// The two loader calls, declared here rather than pulling the whole `windows` crate into a
/// binary whose only other Win32 use is through its dependencies.
#[cfg(windows)]
mod windows_sys_min {
    pub const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;
    #[link(name = "kernel32")]
    extern "system" {
        pub fn SetDefaultDllDirectories(directory_flags: u32) -> i32;
        pub fn SetDllDirectoryW(path: *const u16) -> i32;
    }
}

/// How long the worker waits for the service's pipe (the service accepts within 20 s, §4.2).
#[cfg(windows)]
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

#[cfg(windows)]
fn run(suffix: &str, args: &[String]) -> Result<(), String> {
    use ia_session0::blob::LaunchBlob;
    use ia_session0::pipe::PipeClient;
    use ia_session0::proto::read_frame;

    // The server end must be our parent, running the image we are running (§4.2). A pipe
    // served by anything else is not the service, whatever it has to say.
    let parent =
        ia_session0::pipe::parent_pid().ok_or("the parent process could not be identified")?;
    let mut session = PipeClient::connect(suffix, parent, CONNECT_TIMEOUT)
        .map_err(|e| format!("the service pipe could not be opened: {e}"))?;
    // The blob is the first line; everything after it is a frame.
    let blob: LaunchBlob = read_frame(&mut session.reader)
        .map_err(|e| format!("the launch blob could not be read: {e}"))?;
    blob.validate()
        .map_err(|e| format!("the launch blob is not usable: {e}"))?;
    channel::serve_blob(blob, session.reader, session.writer, args)
}
