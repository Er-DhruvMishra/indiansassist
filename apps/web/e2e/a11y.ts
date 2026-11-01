/**
 * Keyboard-and-accessibility helpers for the Package 4 e2e (docs/specs/phase-d-contracts.md section 13.5): mark every
 * focusable control of a region, walk the tab order, read what the browser actually focused (role, accessible name,
 * focus ring) and check that a status is carried by text rather than by colour. Nothing here touches the mouse: the
 * only inputs used are `keyboard.press` and `keyboard.type`.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** What the browser had focused after one Tab. */
export type FocusStop = {
  /** The `data-kbd` marker when the element is one of the marked controls, else null. */
  kbd: number | null;
  tag: string;
  role: string;
  name: string;
  /** True when a focus indicator is actually painted (outline >= 2 px or a box shadow). */
  ring: boolean;
  outline: string;
};

/**
 * The DOM-order list of focusable controls in `scope`, each marked with `data-kbd="<n>"`. `tabbable` is false for a
 * control the browser deliberately keeps out of the tab order while still exposing it: an unchecked radio in a group
 * that has a checked member (a radio group is one tab stop, the arrow keys move inside it). Such a control must
 * still be labelled, so it is listed either way.
 */
export async function markFocusable(scope: Locator): Promise<{ kbd: number; tag: string; name: string; tabbable: boolean }[]> {
  return scope.evaluate((root) => {
    const SEL = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
    const nameOf = (el: HTMLElement): string => {
      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim() !== '') return aria.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by !== null) {
        const t = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (t !== '') return t;
      }
      if (el.id !== '') {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l?.textContent !== undefined && l.textContent.trim() !== '') return l.textContent.trim();
      }
      const wrapping = el.closest('label');
      if (wrapping?.textContent !== undefined && wrapping.textContent.trim() !== '') return wrapping.textContent.trim();
      // Only non-form controls may take their name from their own text (a <select>'s options are not a label).
      if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
        const own = (el.textContent ?? '').trim();
        if (own !== '') return own;
      }
      const title = el.getAttribute('title');
      if (title !== null && title.trim() !== '') return title.trim();
      return '';
    };
    const out: { kbd: number; tag: string; name: string; tabbable: boolean; el: HTMLElement }[] = [];
    let i = 0;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(SEL))) {
      if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true' || el.tabIndex < 0) continue;
      if (el.getClientRects().length === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      el.setAttribute('data-kbd', String(i));
      out.push({ kbd: i, tag: el.tagName.toLowerCase(), name: nameOf(el), tabbable: true, el });
      i += 1;
    }
    const radios = out.filter((c) => c.el instanceof HTMLInputElement && c.el.type === 'radio');
    for (const r of radios) {
      const input = r.el as HTMLInputElement;
      const group = radios.filter((x) => (x.el as HTMLInputElement).name === input.name);
      const checked = group.find((x) => (x.el as HTMLInputElement).checked);
      r.tabbable = checked !== undefined ? input.checked : group[0] === r;
    }
    return out.map(({ kbd, tag, name, tabbable }) => ({ kbd, tag, name, tabbable }));
  });
}

/** Role, accessible name and focus ring of whatever is focused right now. */
export async function focused(page: Page): Promise<FocusStop> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null || el === document.body) return { kbd: null, tag: 'body', role: '', name: '', ring: false, outline: '' };
    const style = getComputedStyle(el);
    const implicit: Record<string, string> = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', MAIN: 'main' };
    const inputRole = (x: HTMLElement) =>
      x instanceof HTMLInputElement ? (x.type === 'checkbox' ? 'checkbox' : x.type === 'radio' ? 'radio' : 'textbox') : '';
    const kbd = el.getAttribute('data-kbd');
    const label = el.getAttribute('aria-label');
    const by = el.getAttribute('aria-labelledby');
    const byText =
      by === null
        ? ''
        : by
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim();
    const forLabel = el.id === '' ? null : document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const wrapping = el.closest('label');
    const own = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ? '' : (el.textContent ?? '').trim();
    return {
      kbd: kbd === null ? null : Number(kbd),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? implicit[el.tagName] ?? inputRole(el),
      name: (label ?? '').trim() || byText || (forLabel?.textContent ?? '').trim() || (wrapping?.textContent ?? '').trim() || own || (el.getAttribute('title') ?? '').trim(),
      ring: (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2) || style.boxShadow !== 'none',
      outline: `${style.outlineStyle} ${style.outlineWidth}`,
    };
  });
}

/** Presses Tab once and reports what the browser focused. */
export async function tab(page: Page): Promise<FocusStop> {
  await page.keyboard.press('Tab');
  return focused(page);
}

/** Tabs until `pred` matches (or `max` presses), returning every stop on the way. */
export async function tabUntil(page: Page, pred: (s: FocusStop) => boolean, max = 80): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  for (let i = 0; i < max; i += 1) {
    const s = await tab(page);
    stops.push(s);
    if (pred(s)) return stops;
  }
  throw new Error(`no focus stop matched within ${max} tabs; saw: ${stops.map((s) => `${s.role}:${s.name.slice(0, 24)}`).join(' | ')}`);
}

/**
 * Tabs `presses` times and returns the stops. Use after `markFocusable` to compare the order the browser walks
 * with the DOM order of the marked controls.
 */
export async function tabThrough(page: Page, presses: number): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  for (let i = 0; i < presses; i += 1) stops.push(await tab(page));
  return stops;
}

/**
 * Asserts, for one region, that the tab order is the DOM order, that every marked control is reached, that each has
 * an accessible name and that each shows a focus ring. The walk starts from wherever focus is now, so bring focus to
 * the top of the region first (the skip link does it in one keystroke).
 */
export async function assertKeyboardReachable(page: Page, scope: Locator, label: string): Promise<FocusStop[]> {
  const controls = await markFocusable(scope);
  expect(controls.length, `${label}: has focusable controls`).toBeGreaterThan(0);
  const unnamed = controls.filter((c) => c.name === '');
  expect(unnamed, `${label}: every control has an accessible name`).toEqual([]);

  const stops = await tabThrough(page, controls.length + 4);
  const visited = stops.map((s) => s.kbd).filter((k): k is number => k !== null);
  const expectedOrder = controls.filter((c) => c.tabbable).map((c) => c.kbd);
  const describe = (ks: number[]) => ks.map((k) => `${k}=${controls.find((c) => c.kbd === k)?.tag}:${controls.find((c) => c.kbd === k)?.name.slice(0, 28)}`).join(' | ');
  const missed = expectedOrder.filter((k) => !visited.includes(k));
  expect(missed, `${label}: every control is reachable by Tab (missed ${describe(missed)})`).toEqual([]);
  expect(visited.slice(0, expectedOrder.length), `${label}: tab order follows the DOM order (walked ${describe(visited)})`).toEqual(expectedOrder);
  const ringless = stops.filter((s) => s.kbd !== null && !s.ring).map((s) => `${s.role}:${s.name.slice(0, 30)} (${s.outline})`);
  expect(ringless, `${label}: every focused control shows a focus ring`).toEqual([]);
  return stops;
}

/**
 * Status must not be carried by colour alone (section 13.5). Flattens every colour on the page (grayscale, and the
 * same colour for text and background) and asserts the wording is still there, with an accessible text node.
 */
export async function assertTextNotColour(page: Page, scope: Locator, texts: string[]): Promise<void> {
  const handle = await page.addStyleTag({
    content: 'html { filter: grayscale(1) !important; } *, *::before, *::after { color: #000 !important; border-color: #000 !important; }',
  });
  for (const t of texts) await expect(scope.getByText(t, { exact: false }).first(), `"${t}" is readable without colour`).toBeVisible();
  await handle.evaluate((el: Node) => (el as HTMLStyleElement).remove());
}
