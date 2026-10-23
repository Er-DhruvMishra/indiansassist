/**
 * The sharing bar in every mirrored tab (section 3.3): `<ia-indicator data-ia-block>` with a closed shadow root and
 * an `!important` fixed position, all text via `textContent`. It defends itself: re-appended when removed, its
 * style re-applied when changed, and when it cannot be kept visible for 3 consecutive seconds the tab is paused.
 * Also the `(Shared) ` title prefix (re-applied after SPA title writes, restored on stop).
 */
import type { BarState } from '../shared/bus-schemas';
import { el } from '../shared/dom';

const HOST_STYLE: [string, string][] = [
  ['position', 'fixed'],
  ['inset', '0 0 auto 0'],
  ['height', '36px'],
  ['z-index', '2147483647'],
  ['display', 'block'],
  ['visibility', 'visible'],
  ['opacity', '1'],
  ['transform', 'none'],
  ['pointer-events', 'auto'],
];

const CSS = `:host{all:initial}
.bar{display:flex;align-items:center;gap:8px;height:36px;padding:0 10px;box-sizing:border-box;background:#0f4c81;color:#fff;font:13px/1.2 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.bar.paused{background:#57534e}.bar.backstage{background:#7c2d12}
.grow{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.chip{padding:2px 6px;border-radius:4px;font-weight:600;font-size:11px}
.dbg{background:#b91c1c}.rev{background:#a16207}.rec{color:#fecaca}
button{font:inherit;font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.6);background:transparent;color:#fff;cursor:pointer}
button.stop{background:#b91c1c;border-color:#b91c1c}
.prompt,.toast{display:flex;gap:6px;align-items:center;background:#fef3c7;color:#1c1917;padding:0 8px;border-radius:4px;height:28px;max-width:55%;overflow:hidden}
.prompt span,.toast span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.prompt button,.toast button{color:#1c1917;border-color:#1c1917}`;

export type BarHandlers = {
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onHide: () => void;
  onPromptAnswer: (id: string, decision: 'allow' | 'refuse') => void;
  onCloseBackstage: () => void;
  onHiddenTooLong: () => void;
};

export const DEFAULT_BAR: BarState = {
  technician: 'your technician',
  org: '',
  relayed: false,
  recording: false,
  debuggerAttached: false,
  backstage: false,
  backstageCount: 0,
  paused: false,
  revealed: false,
};

export function barText(s: BarState): string {
  if (s.paused) return 'Paused: not shared';
  const who = `${s.technician}${s.org ? ` (${s.org})` : ''}`;
  const base = s.backstage ? `Technician's background tab, shared with ${who}` : `Shared with ${who}`;
  const via = s.relayed ? ' via server' : '';
  const extra = s.backstageCount > 0 ? ` (+${s.backstageCount} background tab${s.backstageCount === 1 ? '' : 's'})` : '';
  return `${base}${via}${extra}`;
}

export class IndicatorBar {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private state: BarState = { ...DEFAULT_BAR };
  private prompts = new Map<string, string>();
  private toastText: string | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private hiddenSeconds = 0;
  private reportedHidden = false;

  constructor(
    private readonly doc: Document,
    private readonly h: BarHandlers,
  ) {
    this.host = doc.createElement('ia-indicator');
    this.host.setAttribute('data-ia-block', '');
    this.applyHostStyle();
    this.root = this.host.attachShadow({ mode: 'closed' });
    // A constructed stylesheet is not subject to the page's style-src; a <style> element is the fallback.
    try {
      const Sheet = (doc.defaultView as (Window & typeof globalThis) | null)?.CSSStyleSheet;
      if (!Sheet) throw new Error('no CSSStyleSheet');
      const sheet = new Sheet();
      sheet.replaceSync(CSS);
      this.root.adoptedStyleSheets = [sheet];
    } catch {
      const style = doc.createElement('style');
      style.textContent = CSS;
      this.root.appendChild(style);
    }
  }

  private applyHostStyle(): void {
    for (const [k, v] of HOST_STYLE) this.host.style.setProperty(k, v, 'important');
  }

  mount(state: Partial<BarState>): void {
    this.state = { ...this.state, ...state };
    this.doc.documentElement.appendChild(this.host);
    this.render();
    this.observer = new MutationObserver(() => {
      if (!this.host.isConnected) this.doc.documentElement.appendChild(this.host);
    });
    this.observer.observe(this.doc.documentElement, { childList: true });
    const styleObserver = new MutationObserver(() => {
      if (HOST_STYLE.some(([k, v]) => this.host.style.getPropertyValue(k) !== v || this.host.style.getPropertyPriority(k) !== 'important')) this.applyHostStyle();
    });
    styleObserver.observe(this.host, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
    this.interval = setInterval(() => this.checkVisible(), 1000);
  }

  /** Once per second: visible, >= 30 px high, at the top, in the viewport. 3 failures in a row pause the tab. */
  checkVisible(): void {
    if (!this.host.isConnected) this.doc.documentElement.appendChild(this.host);
    const r = this.host.getBoundingClientRect();
    const visible = (this.host.checkVisibility?.() ?? true) && r.height >= 30 && r.top <= 0 && r.bottom > 0;
    if (visible) {
      this.hiddenSeconds = 0;
      return;
    }
    this.applyHostStyle();
    this.hiddenSeconds++;
    if (this.hiddenSeconds >= 3 && !this.reportedHidden) {
      this.reportedHidden = true;
      this.h.onHiddenTooLong();
    }
  }

  /** Resume clears the hidden-bar pause so the check can trip again. */
  resetHidden(): void {
    this.hiddenSeconds = 0;
    this.reportedHidden = false;
  }

  update(patch: Partial<BarState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  showPrompt(id: string, text: string): void {
    this.prompts.set(id, text);
    this.render();
  }

  clearPrompt(id: string): void {
    if (this.prompts.delete(id)) this.render();
  }

  toast(text: string, ms = 10000): void {
    this.toastText = text;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastText = null;
      this.render();
    }, ms);
    this.render();
  }

  private render(): void {
    const s = this.state;
    const old = this.root.querySelector('.bar');
    const bar = el('div', null, { class: `bar${s.paused ? ' paused' : ''}${s.backstage ? ' backstage' : ''}`, role: 'status' }, this.doc);
    bar.appendChild(el('span', barText(s), { class: 'grow' }, this.doc));
    if (s.recording) bar.appendChild(el('span', '● Recording', { class: 'rec' }, this.doc));
    if (s.debuggerAttached) bar.appendChild(el('span', 'DEEP CONTROL', { class: 'chip dbg' }, this.doc));
    if (s.revealed) {
      bar.appendChild(el('span', 'REVEALED', { class: 'chip rev' }, this.doc));
      bar.appendChild(this.button('Hide again', () => this.h.onHide()));
    }
    for (const [id, text] of this.prompts) {
      const p = el('div', null, { class: 'prompt' }, this.doc);
      p.appendChild(el('span', text, { title: text }, this.doc));
      p.appendChild(this.button('Allow', () => this.h.onPromptAnswer(id, 'allow')));
      p.appendChild(this.button('Refuse', () => this.h.onPromptAnswer(id, 'refuse')));
      bar.appendChild(p);
    }
    if (this.toastText) {
      const t = el('div', null, { class: 'toast' }, this.doc);
      t.appendChild(el('span', this.toastText, undefined, this.doc));
      t.appendChild(this.button('Close it', () => this.h.onCloseBackstage()));
      bar.appendChild(t);
    }
    bar.appendChild(s.paused ? this.button('Resume', () => this.h.onResume()) : this.button('Pause this tab', () => this.h.onPause()));
    bar.appendChild(this.button('Stop sharing', () => this.h.onStop(), 'stop'));
    if (old) this.root.replaceChild(bar, old);
    else this.root.appendChild(bar);
  }

  private button(label: string, onClick: () => void, cls?: string): HTMLButtonElement {
    const b = el('button', label, { type: 'button', ...(cls ? { class: cls } : {}) }, this.doc);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClick();
    });
    return b;
  }

  /** Text of the bar (tests; the shadow root is closed to the page). */
  textForTest(): string {
    return this.root.textContent ?? '';
  }

  rootForTest(): ShadowRoot {
    return this.root;
  }

  destroy(): void {
    this.observer?.disconnect();
    if (this.interval) clearInterval(this.interval);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.host.remove();
  }
}

export const SHARED_PREFIX = '(Shared) ';

/** `(Shared) ` title prefix while mirrored; re-applied after SPA title writes; restored on stop. */
export class TitleGuard {
  private observer: MutationObserver | null = null;

  constructor(private readonly doc: Document) {}

  start(): void {
    this.apply();
    this.observer = new MutationObserver(() => this.apply());
    this.observer.observe(this.doc.head ?? this.doc.documentElement, { childList: true, characterData: true, subtree: true });
  }

  private apply(): void {
    if (!this.doc.title.startsWith(SHARED_PREFIX)) this.doc.title = `${SHARED_PREFIX}${this.doc.title}`;
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    while (this.doc.title.startsWith(SHARED_PREFIX)) this.doc.title = this.doc.title.slice(SHARED_PREFIX.length);
  }
}
