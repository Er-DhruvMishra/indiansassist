/**
 * Phase F section 7.2: the touch toolbar toggles (Trackpad, Scroll while zoomed) and the adapters that send the keys
 * bar's keys through a console's existing input paths.
 */
import { cx } from '../../components/ui';
import { MOD_KEYS, codeForChar, type KeyMods, type KeysBarActions } from './KeysBar';
import { PHONE_MAX } from './useViewport';

/** Section 7.2: Trackpad is on by default on phones narrower than 600 px, off on tablets. */
export function defaultTrackpad(width: number = typeof window === 'undefined' ? 1024 : document.documentElement.clientWidth || window.innerWidth): boolean {
  return width < PHONE_MAX;
}

export function TouchToggles({
  trackpad,
  onTrackpad,
  scroll,
  onScroll,
  disabled = false,
}: {
  trackpad: boolean;
  onTrackpad: (on: boolean) => void;
  scroll: boolean;
  onScroll: (on: boolean) => void;
  disabled?: boolean;
}) {
  const btn = (on: boolean) =>
    cx(
      'min-h-11 min-w-11 rounded-md border px-3 text-sm font-medium disabled:opacity-50',
      on ? 'border-teal-700 bg-teal-700 text-white' : 'border-slate-400 bg-white text-slate-900 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100',
    );
  return (
    <div role="group" aria-label="Touch input" className="flex flex-wrap items-center gap-1">
      <button type="button" className={btn(trackpad)} aria-pressed={trackpad} disabled={disabled} onClick={() => onTrackpad(!trackpad)} title="Move a cursor with one finger; tap to click at the cursor">
        Trackpad
      </button>
      <button type="button" className={btn(scroll)} aria-pressed={scroll} disabled={disabled} onClick={() => onScroll(!scroll)} title="While zoomed, two fingers scroll the remote screen instead of moving the view">
        Scroll
      </button>
    </div>
  );
}

type KeyLike = { key: string; code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean };

/**
 * A native Desk (`os.key`, `os.text`): modifiers go down, the key is pressed, modifiers come up in reverse order
 * (a native `press` ignores the modifiers field).
 */
export function nativeKeyActions(c: {
  key: (kind: 'down' | 'up' | 'press', e: KeyLike) => void;
  typeText: (t: string) => void;
  paste?: (t: string) => void;
  sas?: () => void;
  nav?: (a: 'back' | 'home' | 'recents') => void;
}): KeysBarActions {
  return {
    text: (t) => c.typeText(t),
    key: (key: string, code: string, mods: KeyMods) => {
      const base = { ctrlKey: mods.ctrl, altKey: mods.alt, metaKey: mods.meta, shiftKey: mods.shift };
      const held = MOD_KEYS.filter((m) => mods[m.name]);
      for (const m of held) c.key('down', { key: m.key, code: m.code, ...base });
      c.key('press', { key, code, ...base });
      for (const m of [...held].reverse()) c.key('up', { key: m.key, code: m.code, ...base });
    },
    ...(c.paste ? { paste: c.paste } : {}),
    ...(c.sas ? { sas: c.sas } : {}),
    ...(c.nav ? { nav: c.nav } : {}),
  };
}

/** A P2 Desk: each key as the replayer's `rp.key` capture (down, then up for a non-printable key). */
export function replayerKeyActions(send: (kind: 'down' | 'up', key: string, code: string, mods: KeyMods) => void): KeysBarActions {
  return {
    text: (t) => {
      for (const ch of Array.from(t)) send('down', ch, codeForChar(ch), { ctrl: false, alt: false, shift: false, meta: false });
    },
    key: (key, code, mods) => {
      send('down', key, code, mods);
      if (key.length > 1 || mods.ctrl || mods.meta) send('up', key, code, mods);
    },
  };
}
