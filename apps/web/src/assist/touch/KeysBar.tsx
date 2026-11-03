/**
 * Phase F section 7.3: the on-screen keyboard. A focused, visually hidden `<textarea>` raises the system keyboard;
 * its native `beforeinput` events drive the Desk: `insertText` / `insertCompositionText` become text (through the
 * console's existing `TextBuffer`, `os.text`), `deleteContentBackward` is `Backspace`, `insertLineBreak` is `Enter`.
 * Composition (Android keyboards compose whole words) is diffed so each character reaches the Desk once.
 *
 * The special-keys bar: Esc, Tab, Ctrl, Alt, Shift, Win/Cmd (sticky: one tap latches them for the next key, a double
 * tap locks them), arrows, Home, End, PgUp, PgDn, Del, F1-F12 (an expandable row), Paste (only with clipboard sync on
 * and allowed), Ctrl+Alt+Del (only when the Desk advertises `sas`), and Back, Home, Recents for an Android Desk.
 * Every key is a `<button>` with an accessible name. Keys with modifiers are sent as modifier downs, the key, and
 * modifier ups, because a native Desk's `press` ignores the modifiers field.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../../components/ui';

export type KeyMods = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
export type ModName = keyof KeyMods;
export const NO_KEY_MODS: KeyMods = { ctrl: false, alt: false, shift: false, meta: false };

export type KeysBarActions = {
  /** Plain text (no modifier latched). */
  text: (t: string) => void;
  /** One key press (`key`, `code`) with the modifiers to hold around it. */
  key: (key: string, code: string, mods: KeyMods) => void;
  /** Paste: the technician's clipboard text, to be set on the Desk. Absent = no Paste key. */
  paste?: (text: string) => void;
  /** Ctrl+Alt+Del (`os.sas`). Absent = no key. */
  sas?: () => void;
  /** Android navigation (`os.nav`). Absent = no keys. */
  nav?: (action: 'back' | 'home' | 'recents') => void;
};

type Latch = 'off' | 'latched' | 'locked';
const MODS: { name: ModName; label: string; key: string; code: string }[] = [
  { name: 'ctrl', label: 'Ctrl', key: 'Control', code: 'ControlLeft' },
  { name: 'alt', label: 'Alt', key: 'Alt', code: 'AltLeft' },
  { name: 'shift', label: 'Shift', key: 'Shift', code: 'ShiftLeft' },
  { name: 'meta', label: 'Win', key: 'Meta', code: 'MetaLeft' },
];
export const MOD_KEYS = MODS;

const MAIN: { label: string; name: string; key: string; code: string }[] = [
  { label: 'Esc', name: 'Escape', key: 'Escape', code: 'Escape' },
  { label: 'Tab', name: 'Tab', key: 'Tab', code: 'Tab' },
  { label: '←', name: 'Left arrow', key: 'ArrowLeft', code: 'ArrowLeft' },
  { label: '↑', name: 'Up arrow', key: 'ArrowUp', code: 'ArrowUp' },
  { label: '↓', name: 'Down arrow', key: 'ArrowDown', code: 'ArrowDown' },
  { label: '→', name: 'Right arrow', key: 'ArrowRight', code: 'ArrowRight' },
  { label: 'Home', name: 'Home', key: 'Home', code: 'Home' },
  { label: 'End', name: 'End', key: 'End', code: 'End' },
  { label: 'PgUp', name: 'Page up', key: 'PageUp', code: 'PageUp' },
  { label: 'PgDn', name: 'Page down', key: 'PageDown', code: 'PageDown' },
  { label: 'Del', name: 'Delete', key: 'Delete', code: 'Delete' },
];
const FKEYS = Array.from({ length: 12 }, (_, i) => ({ label: `F${i + 1}`, name: `F${i + 1}`, key: `F${i + 1}`, code: `F${i + 1}` }));

/** The `code` of a printable character, for chords such as Ctrl+C typed on the system keyboard. */
export function codeForChar(ch: string): string {
  const c = ch.toUpperCase();
  if (/^[A-Z]$/.test(c)) return `Key${c}`;
  if (/^[0-9]$/.test(c)) return `Digit${c}`;
  const named: Record<string, string> = { ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote' };
  return named[ch] ?? 'Unidentified';
}

/** A hidden-field sentinel so the system keyboard's backspace always has something to delete. */
const SENTINEL = '  ';
const DOUBLE_TAP_MS = 350;

export function KeysBar({
  actions,
  disabled = false,
  autoFocus = false,
  focusSignal = 0,
  macDesk = false,
  label = 'Keyboard for the remote computer',
}: {
  actions: KeysBarActions;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Changing this number focuses the hidden field (raises the system keyboard), e.g. on a three-finger tap. */
  focusSignal?: number;
  /** Label the Win key as Cmd for a macOS Desk. */
  macDesk?: boolean;
  label?: string;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const fkeysId = useId();
  const [latch, setLatch] = useState<Record<ModName, Latch>>({ ctrl: 'off', alt: 'off', shift: 'off', meta: 'off' });
  const latchRef = useRef(latch);
  latchRef.current = latch;
  const lastTap = useRef<{ name: ModName; at: number } | null>(null);
  const [fkeys, setFkeys] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const composing = useRef('');
  const act = useRef(actions);
  act.current = actions;

  const mods = (): KeyMods => ({
    ctrl: latchRef.current.ctrl !== 'off',
    alt: latchRef.current.alt !== 'off',
    shift: latchRef.current.shift !== 'off',
    meta: latchRef.current.meta !== 'off',
  });
  /** After a key: latched modifiers are released, locked ones stay. */
  const consume = () => {
    const l = latchRef.current;
    if (!Object.values(l).includes('latched')) return;
    const next = { ...l };
    for (const k of Object.keys(next) as ModName[]) if (next[k] === 'latched') next[k] = 'off';
    latchRef.current = next;
    setLatch(next);
  };
  const anyMod = () => Object.values(latchRef.current).some((v) => v !== 'off');

  const sendKey = useCallback((key: string, code: string) => {
    if (disabled) return;
    act.current.key(key, code, mods());
    consume();
  }, [disabled]);

  const sendText = useCallback((t: string) => {
    if (disabled || t === '') return;
    if (anyMod()) {
      // A chord typed on the system keyboard (Ctrl + c): each character as a key with the held modifiers.
      for (const ch of Array.from(t)) act.current.key(ch, codeForChar(ch), mods());
      consume();
      return;
    }
    act.current.text(t);
  }, [disabled]);

  const tapMod = (name: ModName) => {
    const now = Date.now();
    const prev = lastTap.current;
    const cur = latchRef.current[name];
    let next: Latch;
    if (prev && prev.name === name && now - prev.at <= DOUBLE_TAP_MS && cur === 'latched') next = 'locked';
    else next = cur === 'off' ? 'latched' : 'off';
    lastTap.current = { name, at: now };
    const all = { ...latchRef.current, [name]: next };
    latchRef.current = all;
    setLatch(all);
  };

  const resetField = () => {
    const f = field.current;
    if (!f) return;
    f.value = SENTINEL;
    f.setSelectionRange?.(SENTINEL.length, SENTINEL.length);
  };

  useEffect(() => {
    const f = field.current;
    if (!f) return;
    resetField();
    const onBeforeInput = (e: Event) => {
      const ev = e as InputEvent;
      const data = ev.data ?? '';
      switch (ev.inputType) {
        case 'insertText':
        case 'insertReplacementText':
          if (ev.cancelable) e.preventDefault();
          sendText(data);
          composing.current = '';
          if (!ev.cancelable) queueMicrotask(resetField);
          return;
        case 'insertCompositionText': {
          // Not cancelable: diff the composed word against what was already sent.
          const prev = composing.current;
          let common = 0;
          while (common < prev.length && common < data.length && prev[common] === data[common]) common += 1;
          for (let i = common; i < prev.length; i += 1) sendKey('Backspace', 'Backspace');
          sendText(data.slice(common));
          composing.current = data;
          return;
        }
        case 'insertLineBreak':
        case 'insertParagraph':
          if (ev.cancelable) e.preventDefault();
          composing.current = '';
          sendKey('Enter', 'Enter');
          return;
        case 'deleteContentBackward':
          if (ev.cancelable) e.preventDefault();
          if (composing.current) composing.current = composing.current.slice(0, -1);
          sendKey('Backspace', 'Backspace');
          if (!ev.cancelable) queueMicrotask(resetField);
          return;
        case 'deleteContentForward':
          if (ev.cancelable) e.preventDefault();
          sendKey('Delete', 'Delete');
          return;
        default:
          if (ev.cancelable) e.preventDefault();
      }
    };
    const onCompositionEnd = () => {
      composing.current = '';
      resetField();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // A hardware keyboard on a tablet: named keys go through as keys; printable ones arrive as beforeinput.
      if (e.isComposing || e.key === 'Unidentified' || e.key === 'Process' || e.key.length === 1) return;
      if (['Control', 'Shift', 'Alt', 'Meta', 'Backspace', 'Enter', 'Delete'].includes(e.key)) return;
      e.preventDefault();
      act.current.key(e.key, e.code || e.key, { ctrl: e.ctrlKey || mods().ctrl, alt: e.altKey || mods().alt, shift: e.shiftKey || mods().shift, meta: e.metaKey || mods().meta });
      consume();
    };
    f.addEventListener('beforeinput', onBeforeInput);
    f.addEventListener('compositionend', onCompositionEnd);
    f.addEventListener('keydown', onKeyDown);
    return () => {
      f.removeEventListener('beforeinput', onBeforeInput);
      f.removeEventListener('compositionend', onCompositionEnd);
      f.removeEventListener('keydown', onKeyDown);
    };
  }, [sendKey, sendText]);

  useEffect(() => {
    if (autoFocus || focusSignal > 0) field.current?.focus({ preventScroll: true });
  }, [autoFocus, focusSignal]);

  const paste = async () => {
    const p = act.current.paste;
    if (!p) return;
    try {
      const t = await navigator.clipboard.readText();
      if (!t) return setNote('Your clipboard is empty.');
      p(t);
      setNote('Clipboard sent to the remote computer.');
    } catch {
      setNote('The browser did not allow reading your clipboard.');
    }
  };

  const keyBtn = 'min-h-11 min-w-11 rounded-md border border-slate-400 bg-white px-2 text-sm font-medium text-slate-900 active:bg-slate-200 disabled:opacity-50 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100';
  return (
    <section aria-label={label} className="flex flex-col gap-2" data-testid="keys-bar">
      <textarea
        ref={field}
        style={{ fontSize: 16 }}
        aria-label="Type on the remote computer"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        rows={1}
        data-touch-ignore=""
        className="sr-only"
        disabled={disabled}
        onFocus={resetField}
      />
      <div className="flex flex-wrap gap-1" role="group" aria-label="Special keys">
        <button type="button" className={cx(keyBtn, 'bg-teal-700 text-white dark:bg-teal-700')} disabled={disabled} onClick={() => field.current?.focus()}>
          Show keyboard
        </button>
        {MODS.map((m) => (
          <button
            key={m.name}
            type="button"
            className={cx(keyBtn, latch[m.name] !== 'off' && 'border-teal-700 bg-teal-100 dark:bg-teal-900', latch[m.name] === 'locked' && 'underline')}
            aria-pressed={latch[m.name] !== 'off'}
            aria-label={`${m.name === 'meta' && macDesk ? 'Command' : m.name === 'meta' ? 'Windows' : m.label}${latch[m.name] === 'locked' ? ', locked' : latch[m.name] === 'latched' ? ', held for the next key' : ''}`}
            disabled={disabled}
            onClick={() => tapMod(m.name)}
          >
            {m.name === 'meta' && macDesk ? '⌘' : m.label}
          </button>
        ))}
        {MAIN.map((k) => (
          <button key={k.code} type="button" className={keyBtn} aria-label={k.name} disabled={disabled} onClick={() => sendKey(k.key, k.code)}>
            {k.label}
          </button>
        ))}
        <button type="button" className={keyBtn} aria-expanded={fkeys} aria-controls={fkeysId} disabled={disabled} onClick={() => setFkeys((v) => !v)}>
          F1-F12
        </button>
        {actions.paste && (
          <button type="button" className={keyBtn} disabled={disabled} onClick={() => void paste()}>
            Paste
          </button>
        )}
        {actions.sas && (
          <button type="button" className={keyBtn} disabled={disabled} onClick={() => actions.sas?.()}>
            Ctrl+Alt+Del
          </button>
        )}
        {actions.nav &&
          (['back', 'home', 'recents'] as const).map((a) => (
            <button key={a} type="button" className={keyBtn} aria-label={`Phone ${a === 'back' ? 'Back' : a === 'home' ? 'Home' : 'Recents'}`} disabled={disabled} onClick={() => actions.nav?.(a)}>
              {a === 'back' ? 'Back' : a === 'home' ? 'Home' : 'Recents'}
            </button>
          ))}
      </div>
      <div id={fkeysId} hidden={!fkeys} className="flex flex-wrap gap-1" role="group" aria-label="Function keys">
        {FKEYS.map((k) => (
          <button key={k.code} type="button" className={keyBtn} aria-label={k.name} disabled={disabled} onClick={() => sendKey(k.key, k.code)}>
            {k.label}
          </button>
        ))}
      </div>
      {note && (
        <p role="status" aria-live="polite" className="text-sm text-slate-700 dark:text-slate-300">
          {note}
        </p>
      )}
    </section>
  );
}
