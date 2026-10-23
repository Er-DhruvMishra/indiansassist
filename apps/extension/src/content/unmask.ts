/**
 * Field privacy in the page (sections 4.1, 8): secrets (`isSecret`, including any input that was ever a password
 * in this document), the unmask store of approved reveals (field or tab scope, each with an expiry), the
 * `field` target rule, and the human label shown in the Desk's prompt.
 */
import { LIMITS, type FieldKind } from '@indiansassist/shared';

const SECRET_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'cc-number', 'cc-csc', 'one-time-code']);

/** Inputs that were ever `type=password` in this document (a "show password" eye never unmasks them). */
export class EverPassword {
  private set = new WeakSet<Element>();
  private observer: MutationObserver | null = null;

  seed(doc: Document): void {
    for (const el of doc.querySelectorAll('input[type=password i]')) this.set.add(el);
  }

  observe(doc: Document): void {
    this.seed(doc);
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element && (r.target as HTMLInputElement).type === 'password') this.set.add(r.target);
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.matches('input[type=password i]')) this.set.add(n);
          for (const el of n.querySelectorAll('input[type=password i]')) this.set.add(el);
        }
      }
    });
    this.observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'] });
  }

  has(el: Element): boolean {
    return this.set.has(el);
  }

  add(el: Element): void {
    this.set.add(el);
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}

export function isSecret(el: Element | null, ever: EverPassword): boolean {
  if (!el) return false;
  if (ever.has(el)) return true;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') {
      ever.add(el);
      return true;
    }
    const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    if (ac.some((t) => SECRET_AUTOCOMPLETE.has(t))) return true;
  }
  return false;
}

export class UnmaskStore {
  private fields = new Map<Element, number>();
  private tabUntil: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  add(el: Element, ttlMs: number): void {
    this.fields.set(el, this.now() + ttlMs);
  }

  addTab(ttlMs: number): void {
    this.tabUntil = this.now() + ttlMs;
  }

  get active(): boolean {
    return this.tabActive() || [...this.fields.values()].some((u) => u > this.now());
  }

  private tabActive(): boolean {
    return this.tabUntil !== null && this.tabUntil > this.now();
  }

  /** A tab reveal matches every node; a field reveal matches the element and its descendants only. */
  isUnmasked(el: Element | null): boolean {
    if (!el) return false;
    if (this.tabActive()) return true;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const until = this.fields.get(n);
      if (until !== undefined && until > this.now()) return true;
    }
    return false;
  }

  clear(): void {
    this.fields.clear();
    this.tabUntil = null;
  }
}

export type TargetCheck = { ok: true; fieldKind: FieldKind; el: Element } | { ok: false; cause: 'bad_target' | 'not_unmaskable' };

/**
 * `field` scope target rule (section 8.4 step 2): a non-secret form control, a `[contenteditable]` element, or a
 * leaf `[data-ia-sensitive]` element whose text is at most 200 characters. Anything else is `bad_target`.
 */
export function checkFieldTarget(node: Node | null | undefined, ever: EverPassword): TargetCheck {
  if (!node || !(node instanceof Element) || !node.isConnected) return { ok: false, cause: 'bad_target' };
  const el = node;
  if (isSecret(el, ever)) return { ok: false, cause: 'not_unmaskable' };
  if (el instanceof HTMLInputElement) return { ok: true, fieldKind: 'input', el };
  if (el instanceof HTMLTextAreaElement) return { ok: true, fieldKind: 'textarea', el };
  if (el instanceof HTMLSelectElement) return { ok: true, fieldKind: 'select', el };
  if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') return { ok: true, fieldKind: 'contenteditable', el };
  if (el.hasAttribute('data-ia-sensitive') && !el.querySelector('[data-ia-sensitive]') && (el.textContent ?? '').length <= LIMITS.revealFieldTextMax)
    return { ok: true, fieldKind: 'text', el };
  return { ok: false, cause: 'bad_target' };
}

/** `<label for>` text, else `aria-label`, else `placeholder`, else `name`, else "a field" (section 8.4 step 3). */
export function fieldLabel(el: Element, doc: Document = document): string {
  const id = el.getAttribute('id');
  if (id) {
    const lbl = [...doc.querySelectorAll('label')].find((l) => l.htmlFor === id);
    const t = lbl?.textContent?.trim();
    if (t) return t.slice(0, 120);
  }
  for (const a of ['aria-label', 'placeholder', 'name']) {
    const v = el.getAttribute(a)?.trim();
    if (v) return v.slice(0, 120);
  }
  return 'a field';
}
