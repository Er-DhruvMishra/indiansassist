/**
 * Sanitation of every string that enters audit `data`, `reason` or `actor.label` (contracts section 5.3),
 * and `sanitiseFileName` (section 8.3 F5). Lengths are counted in Unicode code points so truncation never
 * splits a surrogate pair. Unpaired surrogates are removed as well (Postgres jsonb rejects them), which is
 * a strict superset of the section 5.3 removal list.
 */

export const SANITISE_LIMITS = {
  userAgent: 512,
  deskLabel: 80,
  label: 80,
  reason: 500,
  name: 200,
  error: 500,
  default: 1000,
} as const;

// C0 (U+0000-U+001F), DEL and C1 (U+007F-U+009F), zero-width and bidi controls, BOM.
// eslint-disable-next-line no-control-regex
const STRIP_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Truncates to at most `max` code points. */
export function truncateCodePoints(s: string, max: number): string {
  let count = 0;
  let i = 0;
  while (i < s.length) {
    if (count === max) return s.slice(0, i);
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1;
    count++;
  }
  return s;
}

export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Removes the section 5.3 control, zero-width and bidi characters (and unpaired surrogates) after NFC. */
export function stripUnsafeChars(s: string): string {
  return s.replace(LONE_SURROGATE_RE, '').normalize('NFC').replace(STRIP_RE, '');
}

/** NFC, strip unsafe characters, truncate to `limit` code points (default 1000). */
export function sanitiseText(s: string, limit: number = SANITISE_LIMITS.default): string {
  return truncateCodePoints(stripUnsafeChars(s), limit);
}

/** Recursively sanitises every string in a JSON-like value with the default limit (keys are left untouched). */
export function sanitiseDeep<T>(value: T, limit: number = SANITISE_LIMITS.default): T {
  if (typeof value === 'string') return sanitiseText(value, limit) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => sanitiseDeep(v, limit)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitiseDeep(v, limit);
    return out as T;
  }
  return value;
}

const RESERVED_WINDOWS_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * Section 8.3 F5: NFC; remove controls, bidi and zero-width characters; replace `/ \ : * ? " < > |` with `_`;
 * strip leading dots and whitespace; collapse whitespace runs; truncate to 200 code points keeping the
 * extension; prefix reserved Windows device names with `_`; an empty result becomes `file-<fileId>`.
 */
export function sanitiseFileName(name: string, fileId: number): string {
  let s = stripUnsafeChars(name);
  s = s.replace(/[/\\:*?"<>|]/g, '_');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^[.\s]+/, '');
  s = s.replace(/\s+$/, '');
  const max = SANITISE_LIMITS.name;
  if (codePointLength(s) > max) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 ? s.slice(dot) : '';
    const extLen = codePointLength(ext);
    if (ext !== '' && extLen < max) {
      s = truncateCodePoints(s.slice(0, dot), max - extLen).replace(/\s+$/, '') + ext;
    } else {
      s = truncateCodePoints(s, max);
    }
  }
  const stem = (s.split('.')[0] ?? '').trim().toUpperCase();
  if (RESERVED_WINDOWS_NAMES.has(stem)) s = truncateCodePoints(`_${s}`, max);
  if (s === '') s = `file-${fileId}`;
  return s;
}
