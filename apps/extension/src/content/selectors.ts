/**
 * Masking and blocking selectors of `record()` (section 4.1). Built-ins always apply; each org selector is
 * validated on its own and skipped when invalid; if the joined selector still throws the content script falls back
 * to the built-ins alone (`selectors_dropped`). One bad selector can never disable the built-in masking.
 */
export const BUILTIN_MASK = ['[data-ia-sensitive]', '[data-ia-sensitive] *', '[contenteditable]', '[contenteditable] *'] as const;
export const BUILTIN_BLOCK = ['[data-ia-block]', 'ia-indicator'] as const;

export function isValidSelector(sel: string, doc: Document = document): boolean {
  if (typeof sel !== 'string' || sel.trim() === '') return false;
  try {
    doc.createDocumentFragment().querySelector(sel);
    doc.documentElement.matches(sel);
    return true;
  } catch {
    return false;
  }
}

export function validSelectors(list: readonly string[], doc: Document = document): { valid: string[]; skipped: string[] } {
  const valid: string[] = [];
  const skipped: string[] = [];
  for (const s of list) (isValidSelector(s, doc) ? valid : skipped).push(s);
  return { valid, skipped };
}

export type CaptureSelectors = { mask: string; block: string; skipped: string[]; dropped: boolean };

export function buildSelectors(policy: { maskSelectors: readonly string[]; blockSelectors: readonly string[] }, doc: Document = document): CaptureSelectors {
  const m = validSelectors(policy.maskSelectors, doc);
  const b = validSelectors(policy.blockSelectors, doc);
  let mask = [...BUILTIN_MASK, ...m.valid].join(', ');
  let block = [...BUILTIN_BLOCK, ...b.valid].join(', ');
  let dropped = false;
  try {
    doc.documentElement.matches(mask);
    doc.documentElement.matches(block);
  } catch {
    mask = BUILTIN_MASK.join(', ');
    block = BUILTIN_BLOCK.join(', ');
    dropped = true;
  }
  return { mask, block, skipped: [...m.skipped, ...b.skipped], dropped };
}
