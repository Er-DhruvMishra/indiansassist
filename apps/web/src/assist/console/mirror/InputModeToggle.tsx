/**
 * Input mode toggle (Phase B 10.1): View / Tab control / In-page / Deep control. A segment above the level the
 * Desk granted (`consent.changed.level`) is greyed and reads "Ask the user"; choosing it opens the reason dialog
 * and sends `level.request`. A segment above the organisation's maximum cannot be requested.
 */
import type { ConsentLevel } from '@indiansassist/shared';
import { cx } from '../../../components/ui';
import { INPUT_MODES_UI, LEVEL_LABEL, MODE_LABEL, MODE_LEVEL, segmentState, type InputMode } from './controlBuilders';

export function InputModeToggle({
  mode,
  granted,
  max,
  pendingLevel,
  onSelect,
  onAsk,
}: {
  mode: InputMode;
  granted: ConsentLevel | null;
  max: ConsentLevel;
  pendingLevel: ConsentLevel | null;
  onSelect: (mode: InputMode) => void;
  onAsk: (level: ConsentLevel) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div role="radiogroup" aria-label="Input mode" className="inline-flex flex-wrap overflow-hidden rounded-md border border-slate-400 dark:border-slate-600">
        {INPUT_MODES_UI.map((m) => {
          const st = segmentState(m, mode, granted, max);
          const level = MODE_LEVEL[m];
          const ask = st === 'ask';
          const title =
            st === 'blocked'
              ? "Not allowed by your organisation's policy"
              : ask
                ? `Ask the user for: ${LEVEL_LABEL[level]}`
                : LEVEL_LABEL[level];
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={st === 'selected'}
              aria-disabled={st === 'blocked' || undefined}
              data-state={st}
              disabled={st === 'blocked' || (ask && pendingLevel !== null)}
              title={title}
              onClick={() => (ask ? onAsk(level) : st !== 'blocked' && onSelect(m))}
              className={cx(
                'min-h-9 px-3 text-sm font-medium',
                st === 'selected' && 'bg-teal-700 text-white',
                st === 'available' && 'bg-white text-slate-900 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800',
                (ask || st === 'blocked') && 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                st === 'blocked' && 'cursor-not-allowed line-through',
              )}
            >
              {MODE_LABEL[m]}
              {ask && <span className="ml-1 text-xs">(Ask the user)</span>}
            </button>
          );
        })}
      </div>
      {pendingLevel && <p className="text-xs text-slate-600 dark:text-slate-400" role="status">Waiting for the user to answer your request for: {LEVEL_LABEL[pendingLevel]}.</p>}
      {(mode === 'in_page' || mode === 'deep') && (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          {mode === 'in_page' ? 'Clicks and keys in the mirror are sent to the page. Some sites ignore synthetic input; ask for deep control.' : 'Deep control: Chrome shows the user a debugging bar while it is on.'}
        </p>
      )}
    </div>
  );
}
