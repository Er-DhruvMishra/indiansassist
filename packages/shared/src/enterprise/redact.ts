/**
 * Phase E section 5.4: the one redaction implementation the console and the api share. `redactText` replaces every
 * match of the section 5.4 rules, in order, with a typed placeholder numbered per input (`[email-1]`), counting each
 * kind in `state.counts`. A placeholder already in the text is opaque (never re-matched), and new numbers of a kind
 * start above the highest number already present, so the api's re-redaction never collides with the browser's.
 */
import { z } from 'zod';
import { REDACTION_KINDS, type RedactionKind } from '../enums.js';
import { luhnValid } from '../token/short-code.js';

/** An object keyed by every `REDACTION_KINDS` value, each a non-negative int (section 13.3). */
export type RedactionCounts = Record<RedactionKind, number>;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const redactionCountsSchema = z.strictObject(
  Object.fromEntries(REDACTION_KINDS.map((k) => [k, count])) as Record<RedactionKind, typeof count>,
);

/** All-zero counts. */
export function emptyRedactionCounts(): RedactionCounts {
  return Object.fromEntries(REDACTION_KINDS.map((k) => [k, 0])) as RedactionCounts;
}

/**
 * One state spans one whole input (section 5.4): the same value always maps to the same placeholder number, and
 * numbering of a kind continues above the highest `[<kind>-<n>]` already present.
 */
export type RedactionState = {
  counts: RedactionCounts;
  /** Per kind: matched value -> placeholder number. */
  seen: Record<RedactionKind, Map<string, number>>;
  /** Per kind: the highest placeholder number used so far. */
  next: Record<RedactionKind, number>;
};

/**
 * One ordered rule of section 5.4. `group` names the capture group that is replaced (the whole match when absent),
 * so a rule keeps its context (`password: [secret-1]`, `C:\Users\[user_path-1]\AppData`); `accept` is a check the
 * matched value must pass (Luhn, Verhoeff, "not a date"); `key` is the form of the value used for "the same value
 * always maps to the same number" (digits only for numbers, lower case for emails).
 */
export type RedactionRule = {
  kind: RedactionKind;
  pattern: RegExp;
  group?: number;
  accept?: (value: string) => boolean;
  key?: (value: string) => string;
};

const digitsOnly = (v: string): string => v.replace(/\D/g, '');
const lower = (v: string): string => v.toLowerCase();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOTTED_RE = /^\d+(?:\.\d+)+$/;
const MAC_SHAPE_RE = /^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = `(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}`;

function separatedPhone(v: string): boolean {
  return (
    digitsOnly(v).length >= 10 &&
    /[\s().-]/.test(v) &&
    !/\s{2,}/.test(v) &&
    !v.split(' ').some((t) => DATE_RE.test(t) || DOTTED_RE.test(t) || MAC_SHAPE_RE.test(t))
  );
}

function ipv6(v: string): boolean {
  if (v === '::1' || v === '::' || !/[0-9A-Fa-f]/.test(v)) return false;
  return v.includes('::') || (v.match(/:/g) ?? []).length >= 7;
}

/** The section 5.4 rules in order (several patterns may share a kind; all of a kind run before the next kind). */
export const REDACTION_RULES: readonly RedactionRule[] = [
  // 1. PEM private keys through the matching END line (an unterminated block runs to the end of the text).
  { kind: 'private_key', pattern: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----(?:[\s\S]*?-----END \1PRIVATE KEY-----|[\s\S]*$)/ },
  // 2. JSON Web Tokens.
  { kind: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  // 3. The user:pass part of scheme://user:pass@host.
  { kind: 'url_credential', pattern: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s:@/]+:[^\s@/]*)@/, group: 1 },
  // 4. Secrets: Wi-Fi keys first (so a quoted passphrase is taken whole), the value after a secret keyword, then
  //    well-known token shapes.
  { kind: 'secret', pattern: /Key Content[ \t]*:[ \t]*([^\r\n]*[^\s])/i, group: 1 },
  { kind: 'secret', pattern: /(?<![A-Za-z])(?:psk|wpa_passphrase)=("[^"\r\n]*"|[^\s'"]+)/i, group: 1 },
  {
    kind: 'secret',
    pattern:
      /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|bearer)(?![A-Za-z0-9])(?:\s*[:=]\s*|\s+)(?:(?:bearer|basic)\s+)?([^\s'"]+)/i,
    group: 1,
    // `Authorization: Bearer [secret-1]` on a second pass: the scheme word alone is not a secret.
    accept: (v) => !/^(?:bearer|basic)$/i.test(v),
  },
  { kind: 'secret', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: 'secret', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: 'secret', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'secret', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  // 5. Email addresses.
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, key: lower },
  // 6. Card numbers: 13 to 19 digits, optionally grouped by single spaces or dashes, passing Luhn.
  { kind: 'card', pattern: /(?<![\d.])\d(?:[ -]?\d){12,18}(?!\d)/, accept: (v) => luhnValid(digitsOnly(v)), key: digitsOnly },
  // 7. Aadhaar: 12 digits (optionally dddd dddd dddd), not starting with 0 or 1, passing Verhoeff.
  {
    kind: 'aadhaar',
    pattern: /(?<![\d.])[2-9]\d{3}(?:\d{8}|\s\d{4}\s\d{4})(?!\d)/,
    accept: (v) => verhoeffValid(digitsOnly(v)),
    key: digitsOnly,
  },
  // 8. Indian PAN.
  { kind: 'pan', pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/ },
  // 9. Phones: E.164, Indian mobiles, and separated digit groups of 10+ digits that are not a date, a dotted
  //    version (or address) or a MAC address.
  { kind: 'phone', pattern: /(?<![\w+])\+[1-9]\d{7,14}(?!\d)/, key: digitsOnly },
  { kind: 'phone', pattern: /(?<![\w+])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/, key: digitsOnly },
  { kind: 'phone', pattern: /(?<![\w.+])\+?\(?\d[\d().-]*(?:[ .-]|\) ?)[\d() .-]*\d(?!\w)/, accept: separatedPhone, key: digitsOnly },
  // 10. MAC addresses (before ip, so a MAC is not taken for IPv6).
  { kind: 'mac', pattern: /(?<![0-9A-Fa-f:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])/, key: lower },
  { kind: 'mac', pattern: /(?<![0-9A-Fa-f.])[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}(?![0-9A-Fa-f.])/, key: lower },
  // 11. IP addresses: IPv6 (compressed with `::`, or all eight groups) and IPv4 quads; loopback is kept.
  {
    kind: 'ip',
    pattern: new RegExp(`(?<![0-9A-Fa-f:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:${IPV4}|[0-9A-Fa-f]{0,4})(?![0-9A-Fa-f:]|\\.\\d)`),
    accept: ipv6,
    key: lower,
  },
  { kind: 'ip', pattern: new RegExp(`(?<![\\d.])${IPV4}(?!\\.?\\d)`), accept: (v) => v !== '127.0.0.1' },
  // 12. The account name in user profile paths.
  { kind: 'user_path', pattern: /\b[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'<>|:*?]+)/i, group: 1 },
  { kind: 'user_path', pattern: /(?<!\w)\/(?:home|Users)\/([^/\s"'<>|:*?]+)/, group: 1 },
  // 13. Any unbroken run of 40+ token characters (keys, hashes, cookies).
  { kind: 'long_token', pattern: /[A-Za-z0-9+/_=-]{40,}/ },
];

const PLACEHOLDER_SOURCE = `\\[(${REDACTION_KINDS.join('|')})-(\\d{1,9})\\]`;

export function newRedactionState(): RedactionState {
  return {
    counts: emptyRedactionCounts(),
    seen: Object.fromEntries(REDACTION_KINDS.map((k) => [k, new Map<string, number>()])) as Record<RedactionKind, Map<string, number>>,
    next: emptyRedactionCounts(),
  };
}

/**
 * Raises `state.next` above every `[<kind>-<n>]` placeholder already in `text`, without changing the text. The api
 * runs it over the browser's redacted transcript before it redacts its own event texts, so its new numbers never
 * collide with the browser's (section 5.4).
 */
export function reservePlaceholders(state: RedactionState, text: string): void {
  for (const m of text.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'g'))) {
    const kind = m[1] as RedactionKind;
    const n = Number(m[2]);
    if (n > state.next[kind]) state.next[kind] = n;
  }
}

type Piece = { text: string; opaque: boolean };

function placeholderFor(rule: RedactionRule, value: string, state: RedactionState): string {
  const key = rule.key ? rule.key(value) : value;
  const seen = state.seen[rule.kind];
  let n = seen.get(key);
  if (n === undefined) {
    n = state.next[rule.kind] + 1;
    state.next[rule.kind] = n;
    seen.set(key, n);
  }
  state.counts[rule.kind] += 1;
  return `[${rule.kind}-${n}]`;
}

function globalOf(re: RegExp): RegExp {
  const flags = new Set(re.flags.split(''));
  flags.add('g');
  flags.add('d');
  return new RegExp(re.source, [...flags].join(''));
}
const GLOBAL_RULES = new Map<RedactionRule, RegExp>(REDACTION_RULES.map((r) => [r, globalOf(r.pattern)]));

function applyRule(text: string, rule: RedactionRule, state: RedactionState): Piece[] {
  const re = GLOBAL_RULES.get(rule) ?? globalOf(rule.pattern);
  re.lastIndex = 0;
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const span = rule.group !== undefined ? m.indices?.[rule.group] : ([m.index, m.index + m[0].length] as [number, number]);
    if (!span) continue;
    const [start, end] = span;
    if (start < last || end <= start) continue;
    const value = text.slice(start, end);
    if (rule.accept && !rule.accept(value)) continue;
    if (start > last) out.push({ text: text.slice(last, start), opaque: false });
    out.push({ text: placeholderFor(rule, value, state), opaque: true });
    last = end;
  }
  if (last === 0) return [{ text, opaque: false }];
  if (last < text.length) out.push({ text: text.slice(last), opaque: false });
  return out;
}

/** Splits text into plain runs and the opaque placeholders already present. */
function splitPlaceholders(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'g'))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), opaque: false });
    out.push({ text: m[0], opaque: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), opaque: false });
  return out;
}

/** Replaces every section 5.4 match with a typed placeholder (`[email-1]`), counting each kind in `state.counts`. */
export function redactText(text: string, state: RedactionState): string {
  if (text === '') return text;
  reservePlaceholders(state, text);
  let pieces = splitPlaceholders(text);
  for (const rule of REDACTION_RULES) {
    const next: Piece[] = [];
    for (const p of pieces) {
      if (p.opaque) next.push(p);
      else next.push(...applyRule(p.text, rule, state));
    }
    pieces = next;
  }
  return pieces.map((p) => p.text).join('');
}

/** Sum of every kind's count. */
export function totalRedactions(counts: RedactionCounts): number {
  return REDACTION_KINDS.reduce((n, k) => n + counts[k], 0);
}

/**
 * Luhn check of a digit string (card numbers, section 5.4 rule 6). The Phase A short-code check already is a general
 * Luhn over any run of two or more digits, so the same function is re-exported rather than defined twice.
 */
export { luhnValid } from '../token/short-code.js';

// Verhoeff tables (the dihedral group D5).
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff check of a digit string (Aadhaar numbers, section 5.4 rule 7). */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(digits.length - 1 - i) - 48;
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![d]!]!;
  }
  return c === 0;
}
