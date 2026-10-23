/** Annotation toolbar (A5): keyboard reachable, tools as toggle buttons, Clear works without a pointer. */
import type { AnnotTool } from '../../lib/annotation';
import { Button, cx } from '../../components/ui';

const TOOLS: { tool: AnnotTool; label: string; key: string }[] = [
  { tool: 'arrow', label: 'Arrow', key: 'A' },
  { tool: 'rect', label: 'Rectangle', key: 'R' },
  { tool: 'highlight', label: 'Highlight', key: 'H' },
  { tool: 'pointer', label: 'Pointer', key: 'P' },
];

export const ANNOT_COLORS = ['#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#ffffff'];

export function AnnotToolbar({
  tool,
  color,
  fit,
  disabled,
  onTool,
  onColor,
  onClear,
  onFit,
  onFullscreen,
}: {
  tool: AnnotTool | null;
  color: string;
  fit: boolean;
  disabled: boolean;
  onTool: (t: AnnotTool | null) => void;
  onColor: (c: string) => void;
  onClear: () => void;
  onFit: () => void;
  onFullscreen: () => void;
}) {
  return (
    <div role="toolbar" aria-label="Annotation and view tools" className="flex flex-wrap items-center gap-1">
      {TOOLS.map((t) => (
        <Button
          key={t.tool}
          size="sm"
          variant={tool === t.tool ? 'primary' : 'secondary'}
          aria-pressed={tool === t.tool}
          aria-keyshortcuts={t.key}
          disabled={disabled}
          onClick={() => onTool(tool === t.tool ? null : t.tool)}
        >
          {t.label}
        </Button>
      ))}
      <Button size="sm" variant="secondary" disabled={disabled} onClick={onClear} aria-keyshortcuts="C">
        Clear
      </Button>
      <fieldset className="ml-1 flex items-center gap-1" disabled={disabled}>
        <legend className="sr-only">Annotation colour</legend>
        {ANNOT_COLORS.map((c) => (
          <label key={c} className="relative inline-flex h-7 w-7 cursor-pointer items-center justify-center">
            <input type="radio" name="annot-color" value={c} checked={color === c} onChange={() => onColor(c)} className="peer sr-only" aria-label={`Colour ${c}`} />
            <span
              aria-hidden="true"
              className={cx('h-6 w-6 rounded-full border-2 peer-focus-visible:outline-3 peer-focus-visible:outline-cyan-700', color === c ? 'border-slate-900 dark:border-white' : 'border-slate-400')}
              style={{ background: c }}
            />
          </label>
        ))}
      </fieldset>
      <span className="mx-1 h-6 w-px bg-slate-300 dark:bg-slate-700" aria-hidden="true" />
      <Button size="sm" variant="secondary" onClick={onFit} aria-pressed={!fit} aria-keyshortcuts="Z">
        {fit ? 'Actual size' : 'Fit to window'}
      </Button>
      <Button size="sm" variant="secondary" onClick={onFullscreen} aria-keyshortcuts="F">
        Fullscreen
      </Button>
    </div>
  );
}
