/** Keyboard shortcut help popover, opened with "?" or the header button. */
import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';

export type Shortcut = { keys: string; action: string };

export const GLOBAL_SHORTCUTS: Shortcut[] = [
  { keys: '?', action: 'Show this help' },
  { keys: 'Esc', action: 'Close a dialog' },
  { keys: 'Tab / Shift+Tab', action: 'Move between controls' },
];

export const CONSOLE_SHORTCUTS: Shortcut[] = [
  { keys: 'A', action: 'Arrow tool' },
  { keys: 'R', action: 'Rectangle tool' },
  { keys: 'H', action: 'Highlight tool' },
  { keys: 'P', action: 'Pointer tool' },
  { keys: 'C', action: 'Clear annotations' },
  { keys: 'F', action: 'Toggle fullscreen' },
  { keys: 'Z', action: 'Toggle fit / actual size' },
  { keys: 'M', action: 'Mute or unmute microphone' },
];

export const DESK_SHORTCUTS: Shortcut[] = [
  { keys: 'Tab', action: 'The Stop sharing button is first in the page' },
  { keys: 'M', action: 'Mute or unmute microphone' },
];

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** True when a keyboard shortcut should be ignored because the user is typing. */
export function shouldIgnoreKey(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target);
}

export function ShortcutHelp({ extra = [] }: { extra?: Shortcut[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !shouldIgnoreKey(e)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const all = [...GLOBAL_SHORTCUTS, ...extra];
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Keyboard shortcuts"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-400 text-sm font-semibold hover:bg-slate-200 dark:border-slate-600 dark:hover:bg-slate-800"
      >
        ?
      </button>
      <Dialog open={open} title="Keyboard shortcuts" onClose={() => setOpen(false)}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {all.map((s) => (
            <div key={s.keys + s.action} className="contents">
              <dt>
                <kbd className="rounded border border-slate-400 bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">
                  {s.keys}
                </kbd>
              </dt>
              <dd>{s.action}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </>
  );
}
