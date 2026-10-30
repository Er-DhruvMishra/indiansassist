//! The hard-rule-2 teardown order (contract §3.2: "the agent's teardown additionally stops
//! every capture thread, zeroises the §1.3 keys and clears the clipboard watcher") and the
//! Stop sequence (§3.5). Pure: the binary performs each step; defining the order here lets
//! the loopback test assert it without touching the OS.

/// One teardown step, in the order the agent performs them on Stop / `session.ended` (A hard
/// rule 2 + the §3.2 Phase C additions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeardownStep {
    /// Stop honouring input ops immediately (before anything is sent).
    StopInput,
    /// Release any modifiers the agent believes are down (§5.4).
    ReleaseModifiers,
    /// Stop every capture thread and encoder.
    StopCapture,
    /// Close the data channels and the peer connection(s), including the recorder PC.
    ClosePeer,
    /// Zeroise the §1.3 session keys.
    ZeroiseKeys,
    /// Remove the low-level input hooks and clear the clipboard watcher.
    ClearClipboardWatcher,
    /// Remove the indicator pill / panel / tray.
    RemoveIndicator,
}

/// The teardown order for an ordinary Stop or `session.ended` (contract §3.2/§3.5).
pub fn teardown_order() -> [TeardownStep; 7] {
    [
        TeardownStep::StopInput,
        TeardownStep::ReleaseModifiers,
        TeardownStep::StopCapture,
        TeardownStep::ClosePeer,
        TeardownStep::ZeroiseKeys,
        TeardownStep::ClearClipboardWatcher,
        TeardownStep::RemoveIndicator,
    ]
}

/// The messages the **Stop** button sends, in order, before the receipt (contract §3.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMessage {
    /// `stop.sharing` on `ia.ctrl` if open.
    StopSharing,
    /// Flush the §3.8 attestation outbox (`control.input`, `clipboard.sync` aggregates).
    FlushOutbox,
    /// WS `session.end`.
    SessionEnd,
}

/// The Stop message order (contract §3.5).
pub fn stop_order() -> [StopMessage; 3] {
    [
        StopMessage::StopSharing,
        StopMessage::FlushOutbox,
        StopMessage::SessionEnd,
    ]
}

/// Which process this is at exit, for the self-delete decision (contract §10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessRole {
    /// Ran the whole session unelevated.
    UserStandalone,
    /// The user instance that handed the session to an elevated child.
    UserHandedOver,
    /// The elevated child that holds the session at exit.
    ElevatedChild,
}

/// Whether this process self-deletes on exit (contract §10 D1/D3). Exactly one instance
/// deletes — the one holding the session — and never when the Desk chose Keep (D5).
pub fn deletes_on_exit(role: ProcessRole, kept: bool) -> bool {
    if kept {
        return false; // D5: Keep skips self delete
    }
    match role {
        ProcessRole::UserStandalone => true,  // D1/D2
        ProcessRole::UserHandedOver => false, // D3: the handed-over instance does not delete
        ProcessRole::ElevatedChild => true,   // D3: the child deletes (MOVEFILE_DELAY_UNTIL_REBOOT)
    }
}

/// The elevated child uses `MOVEFILE_DELAY_UNTIL_REBOOT` and runs no user-writable stub
/// (§10 D3); the user instance uses the cmd stub (§10 D2).
pub fn uses_reboot_delete(role: ProcessRole) -> bool {
    role == ProcessRole::ElevatedChild
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_zeroised_after_the_peer_is_closed_and_before_the_watcher_clears() {
        let order = teardown_order();
        let pos = |s| order.iter().position(|x| *x == s).unwrap();
        assert!(pos(TeardownStep::StopInput) < pos(TeardownStep::StopCapture));
        assert!(pos(TeardownStep::ClosePeer) < pos(TeardownStep::ZeroiseKeys));
        assert!(pos(TeardownStep::ZeroiseKeys) < pos(TeardownStep::ClearClipboardWatcher));
        assert_eq!(order[0], TeardownStep::StopInput);
        assert_eq!(*order.last().unwrap(), TeardownStep::RemoveIndicator);
    }

    #[test]
    fn stop_sends_stop_sharing_then_flushes_then_ends() {
        assert_eq!(
            stop_order(),
            [
                StopMessage::StopSharing,
                StopMessage::FlushOutbox,
                StopMessage::SessionEnd
            ]
        );
    }

    #[test]
    fn exactly_one_instance_deletes() {
        // When elevation was used: the child deletes, the handed-over user does not.
        assert!(deletes_on_exit(ProcessRole::ElevatedChild, false));
        assert!(!deletes_on_exit(ProcessRole::UserHandedOver, false));
        // Standalone user deletes.
        assert!(deletes_on_exit(ProcessRole::UserStandalone, false));
        // Keep skips every delete.
        assert!(!deletes_on_exit(ProcessRole::ElevatedChild, true));
        assert!(!deletes_on_exit(ProcessRole::UserStandalone, true));
    }

    #[test]
    fn reboot_delete_only_for_child() {
        assert!(uses_reboot_delete(ProcessRole::ElevatedChild));
        assert!(!uses_reboot_delete(ProcessRole::UserStandalone));
    }
}
