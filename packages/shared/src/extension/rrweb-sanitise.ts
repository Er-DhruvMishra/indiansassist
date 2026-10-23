/**
 * `sanitiseRrwebEvent` (docs/specs/phase-b-contracts.md section 12.3, binding): structural sanitation of rrweb
 * `eventWithTime` objects, applied by the extension before send and by the console before replay (and again inside
 * the replayer frame). No rrweb import: it walks the serialized shapes. Never throws; returns null for an event the
 * caller must drop.
 */
import { stripUrlForMirror } from './deny-list.js';

export const BLOCKED_URL = 'about:blank#ia-blocked';

/** rrweb EventType / IncrementalSource / NodeType numbers used here. */
const EV = { FullSnapshot: 2, Incremental: 3, Meta: 4, Custom: 5, Plugin: 6 } as const;
const SRC = { Mutation: 0, StyleSheetRule: 8, StyleDeclaration: 13, AdoptedStyleSheet: 15 } as const;
const NODE = { Element: 2, Text: 3 } as const;

/** Elements removed with their subtree. */
const DROP_TAGS = new Set(['script', 'noscript', 'base', 'template']);
/** Elements replaced by a sized placeholder `div` (layout survives). */
const PLACEHOLDER_TAGS = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal']);
const DROP_ATTRS = new Set(['srcdoc', 'formaction', 'ping', 'integrity', 'nonce', 'sandbox', 'allow']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'xlink:href', 'poster', 'data', 'cite', 'background', 'rr_dataurl']);
/** `data:` is never allowed on these, not even images. */
const NO_DATA_ATTRS = new Set(['href', 'action', 'data', 'cite', 'xlink:href']);
const ANIMATE_TAGS = new Set(['animate', 'set', 'animatetransform', 'animatemotion']);
const LINK_DROP_REL = /\b(import|preload|prefetch|modulepreload)\b/i;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp|avif|bmp|x-icon)[;,]/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000- \u007f-\u009f]/g;
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * URL allow-list (section 12.3): relative, `#...`, `http:`, `https:`, `mailto:`, `tel:`, or a raster `data:image/*`
 * (never `svg+xml`, and no `data:` at all on `href`, `action`, `data`, `cite`).
 */
export function isAllowedUrl(attr: string, value: string): boolean {
  const v = String(value).replace(CONTROL_RE, '');
  if (v === '' || v.startsWith('#')) return true;
  const m = SCHEME_RE.exec(v);
  if (!m) return !v.startsWith('\\\\');
  const scheme = m[1]!.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return true;
  if (scheme === 'data') return !NO_DATA_ATTRS.has(attr.toLowerCase()) && DATA_IMAGE_RE.test(v);
  return false;
}

function safeUrl(attr: string, value: string): string {
  return isAllowedUrl(attr, value) ? value : BLOCKED_URL;
}

function sanitiseSrcset(value: string): string {
  return value
    .split(',')
    .map((entry) => {
      const t = entry.trim();
      if (t === '') return t;
      const sp = t.search(/\s/);
      const url = sp === -1 ? t : t.slice(0, sp);
      return safeUrl('src', url) + (sp === -1 ? '' : t.slice(sp));
    })
    .join(', ');
}

/** CSS text: `expression(`, `-moz-binding`, `behavior:` and `@import` removed; every `url()` allow-listed. */
export function sanitiseCssText(css: string): string {
  if (typeof css !== 'string') return '';
  let out = css.replace(/@import[^;]*;?/gi, '');
  out = out.replace(/expression\s*\(/gi, '(').replace(/-moz-binding/gi, '').replace(/behavior\s*:/gi, '');
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_m, q: string, u: string) => `url(${q}${safeUrl('style', u)}${q})`);
  return out;
}

function sanitiseAttrValue(tag: string, name: string, value: unknown): { keep: boolean; value: unknown } {
  const n = name.toLowerCase();
  if (n.startsWith('on') || DROP_ATTRS.has(n)) return { keep: false, value };
  if (value === null || value === true || typeof value === 'number') return { keep: true, value };
  if (n === 'style' && isObj(value)) {
    const o: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') o[k] = sanitiseCssText(v);
      else if (Array.isArray(v)) o[k] = v.map((x) => (typeof x === 'string' ? sanitiseCssText(x) : x));
      else o[k] = v;
    }
    return { keep: true, value: o };
  }
  if (typeof value !== 'string') return { keep: false, value };
  if (n === 'style' || n === '_csstext') return { keep: true, value: sanitiseCssText(value) };
  if (n === 'srcset') return { keep: true, value: sanitiseSrcset(value) };
  if (URL_ATTRS.has(n)) return { keep: true, value: safeUrl(n, value) };
  if (ANIMATE_TAGS.has(tag) && (n === 'to' || n === 'from' || n === 'values' || n === 'by'))
    return { keep: isAllowedUrl('href', value) || !SCHEME_RE.test(value.replace(CONTROL_RE, '')), value };
  return { keep: true, value };
}

function sanitiseAttributes(tag: string, attrs: unknown): Obj {
  const out: Obj = {};
  if (!isObj(attrs)) return out;
  for (const [k, v] of Object.entries(attrs)) {
    const r = sanitiseAttrValue(tag, k, v);
    if (r.keep) out[k] = r.value;
  }
  return out;
}

function dropElement(tag: string, attrs: Obj): boolean {
  if (DROP_TAGS.has(tag)) return true;
  if (tag === 'link' && typeof attrs['rel'] === 'string' && LINK_DROP_REL.test(attrs['rel'])) return true;
  if (tag === 'meta' && (attrs['http-equiv'] !== undefined || attrs['charset'] !== undefined)) return true;
  return false;
}

/**
 * Sanitises one serialized node and its subtree. Returns null for a node that must be removed; frame-like elements
 * become `div` placeholders that keep `rr_width` / `rr_height` and the node id.
 */
export function sanitiseSnapshotNode(node: unknown, parentTag = ''): unknown {
  if (!isObj(node)) return null;
  const out: Obj = { ...node };
  if (node['type'] === NODE.Element) {
    const tag = typeof node['tagName'] === 'string' ? node['tagName'].toLowerCase() : '';
    const rawAttrs = isObj(node['attributes']) ? node['attributes'] : {};
    if (dropElement(tag, rawAttrs)) return null;
    if (PLACEHOLDER_TAGS.has(tag)) {
      const attrs: Obj = { 'data-ia-placeholder': tag };
      for (const k of ['rr_width', 'rr_height']) if (typeof rawAttrs[k] === 'string') attrs[k] = rawAttrs[k];
      return { type: NODE.Element, tagName: 'div', attributes: attrs, childNodes: [], id: node['id'] };
    }
    if ('attributes' in node) out['attributes'] = sanitiseAttributes(tag, rawAttrs);
    if ('childNodes' in node) out['childNodes'] = sanitiseChildren(node['childNodes'], tag);
    return out;
  }
  if (node['type'] === NODE.Text && typeof node['textContent'] === 'string') {
    if (node['isStyle'] === true || parentTag === 'style') out['textContent'] = sanitiseCssText(node['textContent']);
    return out;
  }
  if (Array.isArray(node['childNodes'])) out['childNodes'] = sanitiseChildren(node['childNodes'], parentTag);
  return out;
}

function sanitiseChildren(children: unknown, tag: string): unknown[] {
  if (!Array.isArray(children)) return [];
  const out: unknown[] = [];
  for (const c of children) {
    const s = sanitiseSnapshotNode(c, tag);
    if (s !== null) out.push(s);
  }
  return out;
}

const CSSY = /url\(|@import|expression\s*\(|-moz-binding|behavior\s*:/i;

function sanitiseMutation(data: Obj): Obj {
  const out: Obj = { ...data };
  if (Array.isArray(data['adds'])) {
    out['adds'] = data['adds']
      .filter(isObj)
      .map((a) => ({ ...a, node: sanitiseSnapshotNode(a['node']) }))
      .filter((a) => a.node !== null);
  }
  if (Array.isArray(data['attributes'])) {
    out['attributes'] = data['attributes'].filter(isObj).map((a) => ({ ...a, attributes: sanitiseAttributes('', a['attributes']) }));
  }
  if (Array.isArray(data['texts'])) {
    out['texts'] = data['texts']
      .filter(isObj)
      .map((t) => (typeof t['value'] === 'string' && CSSY.test(t['value']) ? { ...t, value: sanitiseCssText(t['value']) } : t));
  }
  return out;
}

function sanitiseIncremental(data: Obj): Obj | null {
  const source = data['source'];
  if (source === SRC.AdoptedStyleSheet) return null;
  if (source === SRC.Mutation) return sanitiseMutation(data);
  if (source === SRC.StyleSheetRule) {
    const out: Obj = { ...data };
    if (Array.isArray(data['adds']))
      out['adds'] = data['adds'].filter(isObj).map((a) => (typeof a['rule'] === 'string' ? { ...a, rule: sanitiseCssText(a['rule']) } : a));
    for (const k of ['replace', 'replaceSync']) if (typeof data[k] === 'string') out[k] = sanitiseCssText(data[k]);
    return out;
  }
  if (source === SRC.StyleDeclaration && isObj(data['set'])) {
    const set = data['set'];
    return { ...data, set: typeof set['value'] === 'string' ? { ...set, value: sanitiseCssText(set['value']) } : set };
  }
  return data;
}

/** Section 12.3 on one rrweb event; same shape out, or null to drop (unknown shape, custom / plugin, source 15). */
export function sanitiseRrwebEvent(event: unknown): unknown {
  try {
    if (!isObj(event) || typeof event['type'] !== 'number') return null;
    const type = event['type'];
    if (type === EV.Custom || type === EV.Plugin) return null;
    const data = event['data'];
    if (type === EV.Meta) {
      if (!isObj(data)) return null;
      const href = typeof data['href'] === 'string' ? (stripUrlForMirror(data['href']) ?? BLOCKED_URL) : data['href'];
      return { ...event, data: { ...data, href } };
    }
    if (type === EV.FullSnapshot) {
      if (!isObj(data)) return null;
      const node = sanitiseSnapshotNode(data['node']);
      return node === null ? null : { ...event, data: { ...data, node } };
    }
    if (type === EV.Incremental) {
      if (!isObj(data)) return null;
      const d = sanitiseIncremental(data);
      return d === null ? null : { ...event, data: d };
    }
    return event;
  } catch {
    return null;
  }
}
