/**
 * Section 3.6 M4 / 13.4 `MonitorPicker`: one button per `MonitorInfo` (name, resolution, scale, primary), single
 * select, and **All monitors** (mosaic). Greyed when the Desk has a single monitor. In floor mode only the first
 * selected monitor streams; the others read "Paused, low bandwidth".
 */
import type { MonitorInfo } from '@indiansassist/shared';
import { Button, cx } from '../../../components/ui';

export function MonitorPicker({
  monitors,
  selected,
  viewed,
  floorMode,
  disabled,
  onView,
}: {
  monitors: MonitorInfo[];
  selected: number[];
  viewed: number | 'all';
  floorMode: boolean;
  disabled?: boolean;
  onView: (v: number | 'all') => void;
}) {
  const single = monitors.length <= 1;
  if (monitors.length === 0) return <p className="text-sm text-slate-600 dark:text-slate-400">Waiting for the Desk&apos;s monitor list.</p>;
  return (
    <div role="group" aria-label="Monitors" className="flex flex-wrap items-center gap-2">
      {monitors.map((m) => {
        const streaming = selected.includes(m.id) && (!floorMode || selected[0] === m.id);
        const pressed = viewed === m.id;
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={pressed}
            disabled={disabled || single}
            onClick={() => onView(m.id)}
            className={cx(
              'rounded-md border px-3 py-1.5 text-left text-xs',
              pressed ? 'border-teal-700 bg-teal-50 dark:bg-teal-950' : 'border-slate-300 dark:border-slate-700',
              (disabled || single) && 'opacity-60',
            )}
          >
            <span className="block font-medium">
              {m.name || `Monitor ${m.id}`}
              {m.primary ? ' (primary)' : ''}
            </span>
            <span className="block text-slate-600 dark:text-slate-400">
              {m.width} x {m.height}, scale {m.scale}
            </span>
            {!streaming && <span className="block text-amber-700 dark:text-amber-300">{floorMode && selected.includes(m.id) ? 'Paused, low bandwidth' : 'Paused'}</span>}
          </button>
        );
      })}
      <Button size="sm" variant={viewed === 'all' ? 'primary' : 'secondary'} aria-pressed={viewed === 'all'} disabled={disabled || single} onClick={() => onView('all')}>
        All monitors
      </Button>
    </div>
  );
}

/** Mosaic layout (section 3.6 M4): each monitor's rect in virtual-desktop pixels as percentages of the bounding box. */
export function mosaicLayout(monitors: MonitorInfo[]): { id: number; left: number; top: number; width: number; height: number }[] {
  if (monitors.length === 0) return [];
  const minX = Math.min(...monitors.map((m) => m.x));
  const minY = Math.min(...monitors.map((m) => m.y));
  const maxX = Math.max(...monitors.map((m) => m.x + m.width));
  const maxY = Math.max(...monitors.map((m) => m.y + m.height));
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  return monitors.map((m) => ({
    id: m.id,
    left: ((m.x - minX) / w) * 100,
    top: ((m.y - minY) / h) * 100,
    width: (m.width / w) * 100,
    height: (m.height / h) * 100,
  }));
}
