/**
 * The only DOM-building helper of the extension (conventions table: every string that did not originate in the
 * bundle goes in with `textContent` / `setAttribute` of a non-URL attribute). `innerHTML` and friends are lint
 * errors in this package.
 */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'srcdoc', 'data', 'poster', 'background']);

export type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string | null,
  attrs?: Attrs,
  doc: Document = document,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === false) continue;
    const name = k.toLowerCase();
    if (URL_ATTRS.has(name) || name.startsWith('on')) throw new Error(`el(): attribute ${k} is not allowed`);
    node.setAttribute(k, v === true ? '' : String(v));
  }
  return node;
}

/** Removes every child (no markup parsing). */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function append(parent: Node, ...children: (Node | null | undefined | false)[]): void {
  for (const c of children) if (c) parent.appendChild(c);
}

/** A button with bundle-defined label and a click handler. */
export function button(label: string, onClick: (ev: MouseEvent) => void, attrs?: Attrs, doc: Document = document): HTMLButtonElement {
  const b = el('button', label, { type: 'button', ...attrs }, doc);
  b.addEventListener('click', onClick);
  return b;
}
