/**
 * The Desk user's Keep choice, read-only (docs/specs/phase-f-contracts.md section 3.4b, stream fixes), rendered by the
 * foundation's `<DeskKeepSlot/>` in `AgentConsole`. `kept` is the last `ctl.event keep` value of the session (null:
 * none received). The console can never set Keep (C section 3.5). The foundation lands it empty.
 */
export function KeepState(_props: { kept: boolean | null }) {
  return null;
}
