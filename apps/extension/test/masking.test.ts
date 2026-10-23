// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { MASK_FIXED } from '@indiansassist/shared';
import { Recorder, injectCss, recordOptions } from '../src/content/recorder';
import { BUILTIN_BLOCK, BUILTIN_MASK, buildSelectors, validSelectors } from '../src/content/selectors';
import { EverPassword, UnmaskStore, checkFieldTarget, fieldLabel, isSecret } from '../src/content/unmask';

afterEach(() => {
  document.body.replaceChildren();
});

function page(): void {
  const add = (tag: string, attrs: Record<string, string>, text?: string) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text) el.textContent = text;
    document.body.appendChild(el);
    return el;
  };
  (add('input', { id: 'name', type: 'text', value: 'Priya Sharma' }) as HTMLInputElement).value = 'Priya Sharma';
  (add('input', { id: 'pw', type: 'password' }) as HTMLInputElement).value = 'hunter2';
  (add('input', { id: 'otp', type: 'text', autocomplete: 'one-time-code' }) as HTMLInputElement).value = '123456';
  add('div', { id: 'acct', 'data-ia-sensitive': '' }, 'Account 99887766');
  add('div', { id: 'editor', contenteditable: 'true' }, 'Dear customer, my PAN is ABCDE1234F');
  add('div', { id: 'blocked', 'data-ia-block': '' }, 'TOP SECRET PANEL');
  add('div', { id: 'org', class: 'org-secret' }, 'Org masked text');
  add('p', { id: 'plain' }, 'Visible paragraph');
}

describe('selectors (section 4.1)', () => {
  it('skips invalid org selectors one by one and keeps the built-ins', () => {
    const { valid, skipped } = validSelectors(['.ok', 'div[', '##bad', '.also-ok']);
    expect(valid).toEqual(['.ok', '.also-ok']);
    expect(skipped).toEqual(['div[', '##bad']);
    const s = buildSelectors({ maskSelectors: ['.org-secret', 'a[[['], blockSelectors: ['#x'] });
    expect(s.mask).toBe([...BUILTIN_MASK, '.org-secret'].join(', '));
    expect(s.block).toBe([...BUILTIN_BLOCK, '#x'].join(', '));
    expect(s.skipped).toEqual(['a[[[']);
    expect(s.mask.endsWith(', ')).toBe(false);
  });
});

describe('masking defaults (sections 4.1, 8.1)', () => {
  it('rrweb snapshot masks inputs, secrets, sensitive and contenteditable text and blocks [data-ia-block]', () => {
    page();
    const events: unknown[] = [];
    const rec = new Recorder();
    rec.start({
      selectors: buildSelectors({ maskSelectors: ['.org-secret'], blockSelectors: [] }),
      ever: new EverPassword(),
      unmask: new UnmaskStore(),
      css: new Map(),
      emit: (e) => events.push(e),
      onError: () => undefined,
    });
    rec.stop();
    const json = JSON.stringify(events);
    expect(events.some((e) => (e as { type: number }).type === 2)).toBe(true);
    for (const secret of ['Priya Sharma', 'hunter2', '123456', '99887766', 'ABCDE1234F', 'TOP SECRET PANEL', 'Org masked text']) expect(json).not.toContain(secret);
    expect(json).toContain('Visible paragraph');
    expect(json).toContain('*'.repeat('Priya Sharma'.length));
    expect(json).toContain(MASK_FIXED);
  });

  it('maskInputFn: secrets get the fixed mask and are never unmasked, even after a type flip', () => {
    page();
    const ever = new EverPassword();
    ever.observe(document);
    const unmask = new UnmaskStore();
    const o = recordOptions({ selectors: buildSelectors({ maskSelectors: [], blockSelectors: [] }), ever, unmask, css: new Map(), emit: () => undefined, onError: () => undefined });
    const pw = document.getElementById('pw') as HTMLInputElement;
    const name = document.getElementById('name') as HTMLInputElement;
    expect(o.maskInputFn!('hunter2', pw)).toBe(MASK_FIXED);
    expect(o.maskInputFn!('Priya', name)).toBe('*****');
    unmask.addTab(60000);
    expect(o.maskInputFn!('Priya', name)).toBe('Priya');
    pw.type = 'text'; // the "show password" eye
    expect(isSecret(pw, ever)).toBe(true);
    expect(o.maskInputFn!('hunter2', pw)).toBe(MASK_FIXED);
    expect(o.maskTextFn!('Account 1', document.getElementById('acct'))).toBe('Account 1');
    unmask.clear();
    expect(o.maskTextFn!('Account 1', document.getElementById('acct'))).toBe(MASK_FIXED);
    ever.disconnect();
  });

  it('field target rule: controls, contenteditable and leaf sensitive elements only; secrets not_unmaskable', () => {
    page();
    const ever = new EverPassword();
    const t = (id: string) => checkFieldTarget(document.getElementById(id), ever);
    expect(t('name')).toMatchObject({ ok: true, fieldKind: 'input' });
    expect(t('editor')).toMatchObject({ ok: true, fieldKind: 'contenteditable' });
    expect(t('acct')).toMatchObject({ ok: true, fieldKind: 'text' });
    expect(t('pw')).toEqual({ ok: false, cause: 'not_unmaskable' });
    expect(t('otp')).toEqual({ ok: false, cause: 'not_unmaskable' });
    expect(t('plain')).toEqual({ ok: false, cause: 'bad_target' });
    expect(checkFieldTarget(document.body, ever)).toEqual({ ok: false, cause: 'bad_target' });
    expect(checkFieldTarget(null, ever)).toEqual({ ok: false, cause: 'bad_target' });
    const outer = document.createElement('div');
    outer.setAttribute('data-ia-sensitive', '');
    const inner = document.createElement('span');
    inner.setAttribute('data-ia-sensitive', '');
    outer.appendChild(inner);
    document.body.appendChild(outer);
    expect(checkFieldTarget(outer, ever)).toEqual({ ok: false, cause: 'bad_target' });
  });

  it('a field reveal unmasks the element and its descendants only, until it expires', () => {
    page();
    let now = 0;
    const store = new UnmaskStore(() => now);
    const editor = document.getElementById('editor')!;
    store.add(editor, 60000);
    const child = document.createElement('b');
    editor.appendChild(child);
    expect(store.isUnmasked(child)).toBe(true);
    expect(store.isUnmasked(document.getElementById('acct'))).toBe(false);
    now = 60001;
    expect(store.isUnmasked(editor)).toBe(false);
  });

  it('labels come from <label for>, aria-label, placeholder, name, else "a field"', () => {
    document.body.innerHTML = '<label for="a">Email address</label><input id="a"><input id="b" aria-label="Phone"><input id="c" placeholder="City"><input id="d" name="zip"><input id="e">';
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => fieldLabel(document.getElementById(id)!))).toEqual(['Email address', 'Phone', 'City', 'zip', 'a field']);
  });

  it('injects fetched cross-origin stylesheet text into snapshot <link> nodes', () => {
    const e = { type: 2, timestamp: 1, data: { node: { type: 0, childNodes: [{ type: 2, tagName: 'link', attributes: { rel: 'stylesheet', href: 'http://127.0.0.1:4175/theme.css' }, childNodes: [] }] } } };
    injectCss(e as never, new Map([['http://127.0.0.1:4175/theme.css', 'body{color:red}']]));
    expect(e.data.node.childNodes[0]!.attributes).toMatchObject({ _cssText: 'body{color:red}' });
  });
});
