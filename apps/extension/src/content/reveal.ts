/**
 * The time-bounded reveal in the page (section 8.4): while the Desk decides, the target is outlined (a
 * `data-ia-block` overlay following its rect; the whole viewport for `tab` scope) and scrolled into view; on
 * approval the store holds it for the TTL; the reveal ends on blur (field), the TTL, Hide again, navigation,
 * pause, a level drop or the end, each time with a fresh snapshot so the mask is restored on the Assist.
 */
import type { MaskRestoreCause } from '@indiansassist/shared';
import type { UnmaskStore } from './unmask';

export type RevealEnded = (scope: 'field' | 'tab', by: MaskRestoreCause, durationMs: number) => void;

export class RevealController {
  private pending: { scope: 'field' | 'tab'; el: Element | null } | null = null;
  private live: { scope: 'field' | 'tab'; el: Element | null; startedAt: number; timer: ReturnType<typeof setTimeout>; blur?: () => void } | null = null;
  private outline: HTMLElement | null = null;
  private reposition = () => this.placeOutline();

  constructor(
    private readonly doc: Document,
    private readonly store: UnmaskStore,
    private readonly snapshot: () => void,
    private readonly onEnded: RevealEnded,
    private readonly now: () => number = Date.now,
  ) {}

  get active(): boolean {
    return this.live !== null;
  }

  /** Shows the outline while the prompt is open. */
  propose(scope: 'field' | 'tab', el: Element | null): { w: number; h: number } {
    this.cancelProposal();
    this.pending = { scope, el };
    const o = this.doc.createElement('div');
    o.setAttribute('data-ia-block', '');
    const s = o.style;
    s.setProperty('position', 'fixed', 'important');
    s.setProperty('pointer-events', 'none', 'important');
    s.setProperty('z-index', '2147483646', 'important');
    s.setProperty('box-sizing', 'border-box', 'important');
    s.setProperty('border', scope === 'tab' ? '4px solid #f59e0b' : '2px solid #f59e0b', 'important');
    this.outline = o;
    this.doc.documentElement.appendChild(o);
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView?.({ block: 'center' });
    this.placeOutline();
    this.doc.defaultView?.addEventListener('scroll', this.reposition, true);
    this.doc.defaultView?.addEventListener('resize', this.reposition);
    const r = el?.getBoundingClientRect();
    return { w: Math.round(r?.width ?? this.doc.defaultView?.innerWidth ?? 0), h: Math.round(r?.height ?? this.doc.defaultView?.innerHeight ?? 0) };
  }

  private placeOutline(): void {
    const o = this.outline;
    if (!o) return;
    const s = o.style;
    const el = this.pending?.el ?? null;
    if (!el) {
      s.setProperty('inset', '0', 'important');
      return;
    }
    const r = el.getBoundingClientRect();
    s.setProperty('left', `${r.left - 2}px`, 'important');
    s.setProperty('top', `${r.top - 2}px`, 'important');
    s.setProperty('width', `${r.width + 4}px`, 'important');
    s.setProperty('height', `${r.height + 4}px`, 'important');
  }

  cancelProposal(): void {
    this.pending = null;
    this.outline?.remove();
    this.outline = null;
    this.doc.defaultView?.removeEventListener('scroll', this.reposition, true);
    this.doc.defaultView?.removeEventListener('resize', this.reposition);
  }

  /** The Desk decided. On approval the values appear (fresh snapshot) until the first end condition. */
  decide(granted: boolean, ttlMs: number): void {
    const p = this.pending;
    this.cancelProposal();
    if (!granted || !p) return;
    this.end('desk', false);
    if (p.scope === 'tab') this.store.addTab(ttlMs);
    else if (p.el) this.store.add(p.el, ttlMs);
    const timer = setTimeout(() => this.end('ttl'), ttlMs);
    this.live = { scope: p.scope, el: p.el, startedAt: this.now(), timer };
    if (p.scope === 'field' && p.el) {
      const blur = () => this.end('blur');
      p.el.addEventListener('blur', blur, { once: true });
      this.live.blur = blur;
    }
    this.snapshot();
  }

  /** Ends the reveal (if any): store cleared, fresh snapshot, `cs.revealEnded`. */
  end(by: MaskRestoreCause, notify = true): void {
    const l = this.live;
    if (!l) return;
    this.live = null;
    clearTimeout(l.timer);
    if (l.blur && l.el) l.el.removeEventListener('blur', l.blur);
    this.store.clear();
    this.snapshot();
    if (notify) this.onEnded(l.scope, by, Math.max(0, this.now() - l.startedAt));
  }
}
