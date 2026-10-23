/**
 * Masking indicator (Phase B 8.4, 10.1): "N fields hidden; 1 revealed (42 s left)", **Reveal this tab**, and
 * **Pick a field to reveal** (arms the replayer: the next click on a masked node opens the reason dialog). Shows the
 * recording warning while the console records.
 */
import { useNow } from '../../../hooks/useAsync';
import { Button } from '../../../components/ui';

export function maskSummary(masked: number, revealUntil: number | null, now: number): string {
  const hidden = `${masked} field${masked === 1 ? '' : 's'} hidden`;
  if (revealUntil === null || revealUntil <= now) return hidden;
  return `${hidden}; 1 revealed (${Math.max(0, Math.ceil((revealUntil - now) / 1000))} s left)`;
}

export function MaskIndicator({
  masked,
  revealUntil,
  armed,
  allowUnmask,
  recording,
  recordRevealed,
  disabled,
  onRevealTab,
  onArm,
}: {
  masked: number;
  revealUntil: number | null;
  armed: boolean;
  allowUnmask: boolean;
  recording: boolean;
  recordRevealed: boolean;
  disabled: boolean;
  onRevealTab: () => void;
  onArm: (on: boolean) => void;
}) {
  const now = useNow(1000);
  return (
    <section aria-label="Masking" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Hidden fields</h2>
      <p className="text-sm" data-testid="mask-summary">
        {maskSummary(masked, revealUntil, now)}
      </p>
      <p className="text-xs text-slate-600 dark:text-slate-400">Passwords and card numbers can never be revealed. Everything else is hidden until the user agrees to show it for up to a minute.</p>
      {allowUnmask ? (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant={armed ? 'primary' : 'secondary'} aria-pressed={armed} disabled={disabled} onClick={() => onArm(!armed)}>
            {armed ? 'Click a hidden field...' : 'Pick a field to reveal'}
          </Button>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={onRevealTab}>
            Reveal this tab
          </Button>
        </div>
      ) : (
        <p className="text-xs">Your organisation does not allow revealing hidden fields.</p>
      )}
      {recording && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {recordRevealed ? 'This session is being recorded; a revealed value will be in the recording.' : 'This session is being recorded; the recording skips revealed values.'}
        </p>
      )}
    </section>
  );
}
