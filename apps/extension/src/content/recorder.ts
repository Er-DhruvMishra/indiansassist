/**
 * rrweb `record()` with the binding options of section 4.1: every input masked (secrets to the fixed 8-char mask,
 * ordinary inputs same-length), `[data-ia-sensitive]` and `[contenteditable]` text fixed-masked, `[data-ia-block]`
 * and the indicator never captured, no canvas / fonts / inline images / cross-origin iframes, explicit snapshots
 * only. Cross-origin stylesheets are fetched by the offscreen document and injected as `_cssText` into the
 * snapshot's `<link>` nodes.
 */
import { MASK_FIXED } from '@indiansassist/shared';
import { record, type eventWithTime } from 'rrweb';
import type { CaptureSelectors } from './selectors';
import { isSecret, type EverPassword, type UnmaskStore } from './unmask';

export type RecorderOptions = {
  selectors: CaptureSelectors;
  ever: EverPassword;
  unmask: UnmaskStore;
  emit: (e: eventWithTime) => void;
  onError: (message: string) => void;
  /** Cross-origin stylesheet text by absolute URL (already sanitised by the offscreen document). */
  css: Map<string, string>;
};

export type RecordOptions = NonNullable<Parameters<typeof record>[0]>;

/** The options object passed to `record()` (exported for the masking tests). */
export function recordOptions(o: RecorderOptions): RecordOptions {
  return {
    emit: (e: eventWithTime) => o.emit(o.css.size > 0 ? injectCss(e, o.css) : e),
    recordCanvas: false,
    inlineImages: false,
    collectFonts: false,
    inlineStylesheet: true,
    recordCrossOriginIframes: false,
    maskAllInputs: true,
    maskInputFn: (text: string, el: HTMLElement) => (isSecret(el, o.ever) ? MASK_FIXED : o.unmask.isUnmasked(el) ? text : '*'.repeat(text.length)),
    maskTextSelector: o.selectors.mask,
    maskTextFn: (text: string, el: HTMLElement | null) => (el && !isSecret(el, o.ever) && o.unmask.isUnmasked(el) ? text : MASK_FIXED),
    blockSelector: o.selectors.block,
    slimDOMOptions: 'all',
    sampling: {
      mousemove: 50,
      mouseInteraction: { MouseUp: false, MouseDown: false, Click: true, ContextMenu: false, DblClick: true, Focus: true, Blur: true, TouchStart: false, TouchEnd: false },
      scroll: 150,
      media: 800,
      input: 'last',
    },
    checkoutEveryNms: 0,
    errorHandler: (e: unknown) => {
      o.onError(String(e).slice(0, 500));
      return true;
    },
  } as RecordOptions;
}

type SNode = { type?: number; tagName?: string; attributes?: Record<string, unknown>; childNodes?: SNode[] };

/** Sets `_cssText` on snapshot `<link rel=stylesheet>` nodes whose sheet could not be read (cross-origin). */
export function injectCss(e: eventWithTime, css: Map<string, string>): eventWithTime {
  const ev = e as unknown as { type: number; data?: { node?: SNode } };
  if (ev.type !== 2 || !ev.data?.node) return e;
  const walk = (n: SNode) => {
    if (n.type === 2 && n.tagName === 'link' && n.attributes) {
      const rel = String(n.attributes.rel ?? '').toLowerCase();
      const href = typeof n.attributes.href === 'string' ? n.attributes.href : null;
      if (rel.includes('stylesheet') && href && n.attributes._cssText === undefined && css.has(href)) n.attributes._cssText = css.get(href);
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(ev.data.node);
  return e;
}

/** Absolute URLs of `<link rel=stylesheet>` whose rules the page context cannot read. */
export function crossOriginSheets(doc: Document): string[] {
  const out: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    const owner = sheet.ownerNode as Element | null;
    if (!owner || owner.tagName?.toLowerCase() !== 'link' || !sheet.href) continue;
    try {
      void sheet.cssRules;
    } catch {
      out.push(sheet.href);
    }
  }
  return [...new Set(out)];
}

export class Recorder {
  private stopFn: (() => void) | null = null;

  get running(): boolean {
    return this.stopFn !== null;
  }

  start(o: RecorderOptions): void {
    if (this.stopFn) return;
    this.stopFn = record(recordOptions(o)) ?? null;
  }

  takeFullSnapshot(): void {
    if (this.stopFn) record.takeFullSnapshot(true);
  }

  getNode(id: number): Node | null {
    return record.mirror.getNode(id) as Node | null;
  }

  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
  }
}
