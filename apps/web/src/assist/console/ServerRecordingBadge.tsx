/**
 * Phase A.2 U4: the console header's server recording badge and the policy note of the Record button.
 * The live region is always rendered so a change of state is announced (polite).
 */
import { Badge } from '../../components/ui';
import type { ServerRecordingState } from './consoleState';

export const CONSOLE_RECORDING_DISABLED_TEXT = 'Console recording is disabled by your organisation';

export function ServerRecordingBadge({ state }: { state: ServerRecordingState }) {
  return (
    <span role="status" aria-live="polite" aria-atomic="true" data-testid="server-recording-badge">
      {state === 'waiting' && <Badge tone="amber">Server recording: waiting</Badge>}
      {state === 'on' && (
        <Badge tone="red" className="gap-1.5">
          <span
            role="img"
            aria-label="Recording in progress"
            className="inline-block h-2.5 w-2.5 rounded-full bg-red-700 dark:bg-red-400"
          />
          Server recording
        </Badge>
      )}
      {state === 'stopped' && <Badge tone="neutral">Server recording stopped</Badge>}
    </span>
  );
}
