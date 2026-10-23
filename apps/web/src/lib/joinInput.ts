/**
 * Join page input handling (contracts sections 3.3, 3.6 and 6.13). The bearer token travels in the URL
 * fragment; `?t=` is accepted for compatibility. A pasted full join URL has `t` extracted from its
 * fragment or query before `normaliseTokenInput` runs.
 */
import { normaliseTokenInput } from '@indiansassist/shared';

export type JoinCode = { kind: 'compact' | 'short_code'; value: string };

/** Reads `t` from a fragment (`#t=...`) first, then from a query string (`?t=...`). */
export function readTokenParam(hash: string, search: string): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('t');
  if (fromHash) return fromHash;
  const fromQuery = new URLSearchParams(search.replace(/^\?/, '')).get('t');
  return fromQuery || null;
}

/** Accepts a 12-digit code (spaces allowed), a compact token, or a full join / download URL. */
export function parseJoinInput(raw: string): JoinCode | null {
  const s = raw.trim();
  if (s === '') return null;
  if (/^https?:\/\//i.test(s) || s.startsWith('/join') || s.startsWith('/download')) {
    try {
      const url = new URL(s, 'http://placeholder.invalid');
      const t = readTokenParam(url.hash, url.search);
      return t ? normaliseTokenInput(t) : null;
    } catch {
      return null;
    }
  }
  return normaliseTokenInput(s);
}

/** "482193657710" -> "4821 9365 7710" for display. */
export function displayCode(code: JoinCode): string {
  return code.kind === 'short_code' ? code.value.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3') : code.value;
}
