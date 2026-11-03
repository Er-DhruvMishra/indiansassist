/**
 * Phase F sections 7.3 and 15.6: the keys bar. Sticky modifiers (one tap latches for the next key, a double tap
 * locks), the hidden field's `beforeinput` mapping (text, composition, Backspace, Enter), Ctrl+Alt+Del only with
 * `sas`, the navigation keys only for an Android Desk, Paste only when allowed, every key a named button, and the
 * native adapter's modifier order.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KeysBar, codeForChar, type KeysBarActions } from '../src/assist/touch/KeysBar';
import { nativeKeyActions, replayerKeyActions } from '../src/assist/touch/TouchControls';

const NONE = { ctrl: false, alt: false, shift: false, meta: false };

function setup(extra: Partial<KeysBarActions> = {}) {
  const text = vi.fn();
  const key = vi.fn();
  const view = render(<KeysBar actions={{ ...extra, text, key }} />);
  const actions = { text, key };
  const field = screen.getByLabelText('Type on the remote computer') as HTMLTextAreaElement;
  const input = (inputType: string, data: string | null = null, cancelable = true) =>
    fireEvent(field, new InputEvent('beforeinput', { inputType, data, cancelable, bubbles: true }));
  return { actions, field, input, view };
}

describe('special keys and sticky modifiers', () => {
  it('a modifier tap latches for the next key only', () => {
    const { actions } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    expect(screen.getByRole('button', { name: /Ctrl, held for the next key/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Left arrow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Left arrow' }));
    expect(actions.key.mock.calls).toEqual([
      ['ArrowLeft', 'ArrowLeft', { ...NONE, ctrl: true }],
      ['ArrowLeft', 'ArrowLeft', NONE],
    ]);
    expect(screen.getByRole('button', { name: 'Ctrl' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('a double tap locks a modifier until it is tapped again; modifiers combine', () => {
    const { actions } = setup();
    const shift = screen.getByRole('button', { name: 'Shift' });
    fireEvent.click(shift);
    fireEvent.click(screen.getByRole('button', { name: /Shift, held/ }));
    expect(screen.getByRole('button', { name: 'Shift, locked' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Alt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }));
    expect(actions.key.mock.calls).toEqual([
      ['Tab', 'Tab', { ...NONE, shift: true, alt: true }],
      ['Tab', 'Tab', { ...NONE, shift: true }],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Shift, locked' }));
    expect(screen.getByRole('button', { name: 'Shift' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('has Esc, Tab, arrows, Home, End, PgUp, PgDn, Del and an expandable F1-F12 row', () => {
    const { actions } = setup();
    for (const name of ['Escape', 'Tab', 'Left arrow', 'Up arrow', 'Down arrow', 'Right arrow', 'Home', 'End', 'Page up', 'Page down', 'Delete'])
      expect(screen.getByRole('button', { name })).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'F1-F12' });
    const row = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(row.getAttribute('aria-label')).toBe('Function keys');
    expect(row.hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'F1-F12' }));
    expect(row.hidden).toBe(false);
    fireEvent.click(within(row).getByRole('button', { name: 'F5' }));
    expect(actions.key).toHaveBeenCalledWith('F5', 'F5', NONE);
    expect(within(row).getAllByRole('button')).toHaveLength(12);
  });

  it('every key is a button with an accessible name', () => {
    setup({ paste: vi.fn(), sas: vi.fn(), nav: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'F1-F12' }));
    for (const b of screen.getAllByRole('button')) expect((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).not.toBe('');
  });
});

describe('Desk-dependent keys', () => {
  it('Ctrl+Alt+Del only when the Desk advertises sas', () => {
    const { view } = setup();
    expect(screen.queryByRole('button', { name: 'Ctrl+Alt+Del' })).toBeNull();
    view.unmount();
    const sas = vi.fn();
    setup({ sas });
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+Alt+Del' }));
    expect(sas).toHaveBeenCalledTimes(1);
  });

  it('Back, Home and Recents only for an Android Desk', () => {
    const { view } = setup();
    expect(screen.queryByRole('button', { name: 'Phone Back' })).toBeNull();
    view.unmount();
    const nav = vi.fn();
    setup({ nav });
    fireEvent.click(screen.getByRole('button', { name: 'Phone Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Phone Home' }));
    fireEvent.click(screen.getByRole('button', { name: 'Phone Recents' }));
    expect(nav.mock.calls).toEqual([['back'], ['home'], ['recents']]);
  });

  it('Paste only when clipboard sync is allowed; it reads the clipboard on the tap and sets the Desk clipboard', async () => {
    const { view } = setup();
    expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull();
    view.unmount();
    const paste = vi.fn();
    const readText = vi.fn(async () => 'from my phone');
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
    setup({ paste });
    expect(readText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    await screen.findByText('Clipboard sent to the remote computer.');
    expect(paste).toHaveBeenCalledWith('from my phone');
  });
});

describe('the hidden field (beforeinput)', () => {
  it('maps text, Backspace and Enter', () => {
    const { actions, input } = setup();
    input('insertText', 'ab');
    input('deleteContentBackward');
    input('insertLineBreak');
    input('insertParagraph');
    expect(actions.text).toHaveBeenCalledWith('ab');
    expect(actions.key.mock.calls).toEqual([
      ['Backspace', 'Backspace', NONE],
      ['Enter', 'Enter', NONE],
      ['Enter', 'Enter', NONE],
    ]);
  });

  it('diffs a composed word so each character reaches the Desk once (and corrections become Backspace)', () => {
    const { actions, input, field } = setup();
    input('insertCompositionText', 'h', false);
    input('insertCompositionText', 'he', false);
    input('insertCompositionText', 'hep', false);
    input('insertCompositionText', 'hel', false);
    fireEvent(field, new CompositionEvent('compositionend', { data: 'hel' }));
    input('insertCompositionText', 'x', false);
    expect(actions.text.mock.calls.map((c) => c[0])).toEqual(['h', 'e', 'p', 'l', 'x']);
    expect(actions.key.mock.calls).toEqual([['Backspace', 'Backspace', NONE]]);
  });

  it('a character typed while Ctrl is latched is a chord (Ctrl+C), not text', () => {
    const { actions, input } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    input('insertText', 'c');
    input('insertText', 'd');
    expect(actions.key).toHaveBeenCalledWith('c', 'KeyC', { ...NONE, ctrl: true });
    expect(actions.text).toHaveBeenCalledWith('d');
    expect(codeForChar('7')).toBe('Digit7');
    expect(codeForChar(' ')).toBe('Space');
  });

  it('is configured for raw typing', () => {
    const { field } = setup();
    expect(field.getAttribute('autocapitalize')).toBe('off');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('autocorrect')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(field.getAttribute('inputmode')).toBe('text');
  });

  it('a disabled bar sends nothing', () => {
    const actions = { text: vi.fn(), key: vi.fn() };
    render(<KeysBar actions={actions} disabled />);
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('adapters', () => {
  it('native: modifiers down, the key pressed, modifiers up in reverse order', () => {
    const calls: string[] = [];
    const a = nativeKeyActions({ key: (k, e) => calls.push(`${k}:${e.code}`), typeText: (t) => calls.push(`text:${t}`) });
    a.key('c', 'KeyC', { ...NONE, ctrl: true, shift: true });
    a.text('hi');
    expect(calls).toEqual(['down:ControlLeft', 'down:ShiftLeft', 'press:KeyC', 'up:ShiftLeft', 'up:ControlLeft', 'text:hi']);
    expect(a.paste).toBeUndefined();
    expect(a.sas).toBeUndefined();
    expect(a.nav).toBeUndefined();
  });

  it('P2: text as one rp.key down per character; named keys down and up', () => {
    const calls: string[] = [];
    const a = replayerKeyActions((kind, key, code) => calls.push(`${kind}:${key}:${code}`));
    a.text('ab');
    a.key('Enter', 'Enter', NONE);
    expect(calls).toEqual(['down:a:KeyA', 'down:b:KeyB', 'down:Enter:Enter', 'up:Enter:Enter']);
  });
});
