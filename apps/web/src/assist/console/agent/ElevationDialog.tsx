/**
 * Section 7 / 13.4 `ElevationDialog`: a mandatory reason (1..500), the honest UAC warning, and the live
 * `ctl.event elevation` states of the request; then the hand-over rebuilds the connection with a new security code.
 */
import { useState } from 'react';
import { Dialog } from '../../../components/Dialog';
import { Alert, Button, Field } from '../../../components/ui';
import type { ElevationUiState } from './agentState';

export const UAC_WARNING = 'Windows will ask the user to confirm; UAC prompts themselves stay invisible.';
export const ELEVATED_NOTE =
  "Administrator windows can now be controlled. Windows' own security prompts (UAC, the lock screen) still cannot be seen or clicked; ask the user to complete those.";

const STATE_TEXT: Record<ElevationUiState, string> = {
  requesting: 'Sending the request to the Desk...',
  prompt_shown: 'The user is being asked on the Desk.',
  uac_shown: 'Windows is asking the user to confirm (UAC).',
  handover: 'Handing over to the administrator instance...',
  denied: 'The user refused the request.',
  failed: 'Elevation failed.',
  granted: ELEVATED_NOTE,
};

export function elevationStateText(state: ElevationUiState, cause?: string): string {
  if ((state === 'denied' || state === 'failed') && cause) return `${STATE_TEXT[state]} (${cause.replace(/_/g, ' ')})`;
  return STATE_TEXT[state];
}

export function ElevationDialog({
  open,
  state,
  onSubmit,
  onClose,
}: {
  open: boolean;
  state: { state: ElevationUiState; cause?: string } | null;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const busy = state !== null && ['requesting', 'prompt_shown', 'uac_shown', 'handover'].includes(state.state);
  return (
    <Dialog open={open} title="Request administrator rights" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed.length < 1 || trimmed.length > 500) return;
          onSubmit(trimmed);
        }}
      >
        <Alert tone="amber">{UAC_WARNING}</Alert>
        <Field label="Why do you need administrator rights?" hint="Required. The user sees this reason; it is recorded in the audit log." error={reason.length > 500 ? 'At most 500 characters.' : null}>
          {(p) => (
            <textarea
              id={p.id}
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid}
              data-autofocus
              rows={3}
              className="w-full rounded-md border border-slate-400 bg-white p-2 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        {state && (
          <p role="status" aria-live="polite" className="text-sm">
            {elevationStateText(state.state, state.cause)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" disabled={busy || trimmed.length < 1 || trimmed.length > 500}>
            Request elevation
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
