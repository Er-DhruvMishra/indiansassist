//! Phase F §17.3 (stream apple): the macOS unattended service, a LaunchDaemon holding the
//! device identity (System keychain), the `/signal/device` socket, the policy, the queue, the
//! waker and the tamper outbox, serving the LaunchAgent worker over
//! `/var/run/indiansassist/worker.sock`. Feature `macos-service`. Compiled only on macOS;
//! empty until the apple stream fills it. Only the apple stream edits this module.
