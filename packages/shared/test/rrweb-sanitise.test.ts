import { describe, expect, it } from 'vitest';
import { BLOCKED_URL, isAllowedUrl, sanitiseCssText, sanitiseRrwebEvent, sanitiseSnapshotNode } from '../src/index.js';

const el = (tagName: string, attributes: Record<string, unknown> = {}, childNodes: unknown[] = [], id = 10) => ({
  type: 2,
  tagName,
  attributes,
  childNodes,
  id,
});
const full = (node: unknown) => ({ type: 2, data: { node, initialOffset: { left: 0, top: 0 } }, timestamp: 1 });
const inc = (data: unknown) => ({ type: 3, data, timestamp: 2 });

describe('sanitiseRrwebEvent', () => {
  it('round-trips a clean event unchanged', () => {
    const clean = full({
      type: 0,
      childNodes: [el('html', {}, [el('body', { class: 'x', href: '/a' }, [{ type: 3, textContent: 'hello', id: 3 }], 2)], 1)],
      id: 0,
    });
    expect(sanitiseRrwebEvent(structuredClone(clean))).toEqual(clean);
    const move = inc({ source: 1, positions: [{ x: 1, y: 2, id: 3, timeOffset: 0 }] });
    expect(sanitiseRrwebEvent(structuredClone(move))).toEqual(move);
  });

  it('removes scripts, base, meta refresh and preload links; iframes become sized placeholders', () => {
    const doc = el('head', {}, [
      el('script', {}, [{ type: 3, textContent: 'alert(1)', id: 21 }], 20),
      el('base', { href: 'https://evil.test/' }, [], 22),
      el('meta', { 'http-equiv': 'refresh', content: '0;url=javascript:x' }, [], 23),
      el('meta', { name: 'viewport' }, [], 24),
      el('link', { rel: 'preload', href: 'https://x.test/a.js' }, [], 25),
      el('iframe', { src: 'https://a.test', srcdoc: '<script>x</script>', rr_width: '300px', rr_height: '150px' }, [], 26),
      el('noscript', {}, [], 27),
      el('template', {}, [], 28),
    ]);
    const out = sanitiseSnapshotNode(doc) as { childNodes: { tagName: string; attributes: Record<string, string>; id: number }[] };
    expect(out.childNodes.map((c) => c.tagName)).toEqual(['meta', 'div']);
    expect(out.childNodes[1]).toEqual({ type: 2, tagName: 'div', attributes: { 'data-ia-placeholder': 'iframe', rr_width: '300px', rr_height: '150px' }, childNodes: [], id: 26 });
  });

  it('strips on* handlers and dangerous attributes', () => {
    const out = sanitiseSnapshotNode(el('img', { src: 'a.png', onerror: 'x()', ONLOAD: 'y', integrity: 'z', nonce: 'n', ping: 'p', formaction: 'f', allow: 'camera', sandbox: '' })) as { attributes: object };
    expect(out.attributes).toEqual({ src: 'a.png' });
  });

  it('allow-lists URL schemes', () => {
    expect(isAllowedUrl('href', 'javascript:alert(1)')).toBe(false);
    expect(isAllowedUrl('href', ' jav\tascript:alert(1)')).toBe(false);
    expect(isAllowedUrl('src', 'vbscript:x')).toBe(false);
    expect(isAllowedUrl('href', 'data:image/png;base64,AAAA')).toBe(false);
    expect(isAllowedUrl('src', 'data:image/png;base64,AAAA')).toBe(true);
    expect(isAllowedUrl('src', 'data:image/svg+xml;base64,AAAA')).toBe(false);
    expect(isAllowedUrl('src', 'data:text/html,x')).toBe(false);
    expect(isAllowedUrl('src', 'ms-its:mhtml:file://x')).toBe(false);
    expect(isAllowedUrl('src', 'blob:https://a.test/1')).toBe(false);
    for (const okUrl of ['/rel', 'rel.png', '#frag', 'https://a.test', 'http://a.test', 'mailto:a@b.test', 'tel:+911234'])
      expect(isAllowedUrl('href', okUrl), okUrl).toBe(true);
    const a = sanitiseSnapshotNode(el('a', { href: 'data:image/svg+xml;base64,PHN2Zz4=' })) as { attributes: { href: string } };
    expect(a.attributes.href).toBe(BLOCKED_URL);
    const img = sanitiseSnapshotNode(el('img', { srcset: 'a.png 1x, javascript:x 2x' })) as { attributes: { srcset: string } };
    expect(img.attributes.srcset).toBe(`a.png 1x, ${BLOCKED_URL} 2x`);
  });

  it('sanitises CSS in style attributes, style text and _cssText', () => {
    expect(sanitiseCssText('@import url(https://x.test/a.css); a{background:url("javascript:x")} b{width:expression(alert(1))}')).toBe(
      ` a{background:url("${BLOCKED_URL}")} b{width:(alert(1))}`,
    );
    const style = sanitiseSnapshotNode(el('style', {}, [{ type: 3, textContent: 'a{behavior:url(x.htc);-moz-binding:url(x)}', isStyle: true, id: 2 }])) as {
      childNodes: { textContent: string }[];
    };
    expect(style.childNodes[0]!.textContent).not.toMatch(/behavior:|-moz-binding/);
    const link = sanitiseSnapshotNode(el('link', { rel: 'stylesheet', _cssText: '@import "x.css"; p{color:red}' })) as { attributes: { _cssText: string } };
    expect(link.attributes._cssText).toBe(' p{color:red}');
  });

  it('strips query and fragment from Meta href', () => {
    const meta = { type: 4, data: { href: 'https://a.test/p?token=abc#t=ia1.x', width: 1280, height: 720 }, timestamp: 1 };
    expect(sanitiseRrwebEvent(meta)).toEqual({ ...meta, data: { ...meta.data, href: 'https://a.test/p' } });
  });

  it('applies the rules to mutations and style sources; drops source 15, custom and plugin events', () => {
    const mut = sanitiseRrwebEvent(
      inc({
        source: 0,
        texts: [{ id: 1, value: 'plain text' }],
        attributes: [{ id: 2, attributes: { onclick: 'x', href: 'javascript:y', style: { background: 'url(javascript:z)' } } }],
        removes: [],
        adds: [
          { parentId: 1, nextId: null, node: el('script', {}, [], 5) },
          { parentId: 1, nextId: null, node: el('p', { onmouseover: 'x' }, [], 6) },
        ],
      }),
    ) as { data: { attributes: { attributes: Record<string, unknown> }[]; adds: { node: { tagName: string; attributes: object } }[] } };
    expect(mut.data.attributes[0]!.attributes).toEqual({ href: BLOCKED_URL, style: { background: `url(${BLOCKED_URL})` } });
    expect(mut.data.adds).toHaveLength(1);
    expect(mut.data.adds[0]!.node.attributes).toEqual({});
    const rule = sanitiseRrwebEvent(inc({ source: 8, id: 3, adds: [{ rule: '@import url(x.css);', index: 0 }] })) as { data: { adds: { rule: string }[] } };
    expect(rule.data.adds[0]!.rule).toBe('');
    const decl = sanitiseRrwebEvent(inc({ source: 13, id: 3, index: [0], set: { property: 'background', value: 'url(javascript:x)' } })) as {
      data: { set: { value: string } };
    };
    expect(decl.data.set.value).toBe(`url(${BLOCKED_URL})`);
    expect(sanitiseRrwebEvent(inc({ source: 15, id: 1, styleIds: [1], styles: [] }))).toBeNull();
    expect(sanitiseRrwebEvent({ type: 5, data: { tag: 'x', payload: {} }, timestamp: 1 })).toBeNull();
    expect(sanitiseRrwebEvent({ type: 6, data: {}, timestamp: 1 })).toBeNull();
  });

  it('never throws on unknown shapes', () => {
    for (const x of [null, undefined, 1, 'x', [], { type: 'x' }, { type: 2, data: null }, { type: 3, data: 5 }])
      expect(() => sanitiseRrwebEvent(x)).not.toThrow();
    expect(sanitiseRrwebEvent(null)).toBeNull();
  });
});
