/**
 * The Desk user's Keep choice, read-only (docs/specs/phase-f-contracts.md section 3.4b, stream fixes), rendered by the
 * foundation's `<DeskKeepSlot/>` in `AgentConsole`. `kept` is the last `ctl.event keep` value of the session (null:
 * none received). The choice is made only on the Desk, by the person in front of it; the console shows it and has no
 * control that sets it (C section 3.5: "tick Keep" is among the things the technician's input must never do). The
 * state is in words, announced politely when it changes; nothing is shown while the agent will be removed.
 */
export const KEEP_STATE_TEXT = 'The user chose to keep IndiansAssist on this computer.';

export function KeepState({ kept }: { kept: boolean | null }) {
  return (
    <p role="status" aria-live="polite" className="text-sm text-slate-700 dark:text-slate-300" data-testid="desk-keep-state">
      {kept === true ? KEEP_STATE_TEXT : null}
    </p>
  );
}
