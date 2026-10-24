/**
 * The recording redaction rule of Phase B 4.7 for a tab whose values are revealed while `policy.recordRevealed` is
 * false: the event is **re-masked**, never stored in clear. A FullSnapshot (the one the Desk takes at reveal start,
 * or one re-taken on a nack during the window) has every text node and every `value` attribute replaced with the
 * fixed mask; Input events are dropped; Mutation `texts`, `attributes.value` and the nodes of `adds` are masked the
 * same way. Node ids and structure are kept so the recorded replay stays in sync. Style text is left alone.
 */
import { MASK_FIXED } from '@indiansassist/shared';

const EV_FULL_SNAPSHOT = 2;
const EV_INCREMENTAL = 3;
const SRC_MUTATION = 0;
const SRC_INPUT = 5;
const NODE_ELEMENT = 2;
const NODE_TEXT = 3;
const NODE_CDATA = 4;
const NODE_COMMENT = 5;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function maskString(v: unknown): unknown {
  return typeof v === 'string' && v.trim() !== '' ? MASK_FIXED : v;
}

function maskAttrs(attrs: Obj): Obj {
  return 'value' in attrs ? { ...attrs, value: maskString(attrs.value) } : attrs;
}

/** Masks every text node and `value` attribute of a serialised rrweb node tree (returns a copy). */
export function maskNode(n: unknown, inStyle = false): unknown {
  if (!isObj(n)) return n;
  const out: Obj = { ...n };
  if ((n.type === NODE_TEXT || n.type === NODE_CDATA || n.type === NODE_COMMENT) && !inStyle && n.isStyle !== true) out.textContent = maskString(n.textContent);
  if (isObj(n.attributes)) out.attributes = maskAttrs(n.attributes);
  if (Array.isArray(n.childNodes)) {
    const style = n.type === NODE_ELEMENT && typeof n.tagName === 'string' && n.tagName.toLowerCase() === 'style';
    out.childNodes = n.childNodes.map((c) => maskNode(c, style));
  }
  return out;
}

/** The re-masked event, or null when it must be dropped (Input). Other event types are kept unchanged. */
export function redact(e: unknown): unknown {
  if (!isObj(e) || !isObj(e.data)) return e;
  const d = e.data;
  if (e.type === EV_FULL_SNAPSHOT) return { ...e, data: { ...d, node: maskNode(d.node) } };
  if (e.type !== EV_INCREMENTAL) return e;
  if (d.source === SRC_INPUT) return null;
  if (d.source !== SRC_MUTATION) return e;
  const data: Obj = { ...d };
  if (Array.isArray(d.texts)) data.texts = d.texts.map((t) => (isObj(t) ? { ...t, value: maskString(t.value) } : t));
  if (Array.isArray(d.attributes)) data.attributes = d.attributes.map((a) => (isObj(a) && isObj(a.attributes) ? { ...a, attributes: maskAttrs(a.attributes) } : a));
  if (Array.isArray(d.adds)) data.adds = d.adds.map((a) => (isObj(a) ? { ...a, node: maskNode(a.node) } : a));
  return { ...e, data };
}
