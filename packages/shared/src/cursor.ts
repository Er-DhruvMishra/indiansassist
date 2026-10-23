/** Opaque page cursors (contracts section 6.3 `Page<T>`): base64url of the sort key of the last item. */
import { base64urlDecode, base64urlEncode, utf8Decode, utf8Encode } from './encoding.js';

export function encodeCursor(sortKey: string): string {
  return base64urlEncode(utf8Encode(sortKey));
}

/** Returns the sort key, or null when the cursor is not valid base64url / UTF-8. */
export function decodeCursor(cursor: string): string | null {
  try {
    return utf8Decode(base64urlDecode(cursor));
  } catch {
    return null;
  }
}

/** `<createdAt ISO>|<id>` cursor used by tokens, sessions and users. */
export function encodeTimeIdCursor(createdAt: string, id: string): string {
  return encodeCursor(`${createdAt}|${id}`);
}

export function decodeTimeIdCursor(cursor: string): { createdAt: string; id: string } | null {
  const key = decodeCursor(cursor);
  if (key === null) return null;
  const bar = key.indexOf('|');
  if (bar <= 0 || bar === key.length - 1) return null;
  const createdAt = key.slice(0, bar);
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id: key.slice(bar + 1) };
}

/** `<seq>` cursor used by the audit list. */
export function encodeSeqCursor(seq: number): string {
  return encodeCursor(String(seq));
}

export function decodeSeqCursor(cursor: string): number | null {
  const key = decodeCursor(cursor);
  if (key === null || !/^\d+$/.test(key)) return null;
  const n = Number(key);
  return Number.isSafeInteger(n) ? n : null;
}
