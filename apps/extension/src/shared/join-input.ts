/**
 * Token entry parsing (section 2.3): the 12-digit code, the compact token or a full `/join#t=` URL. Same algorithm
 * as `apps/web/src/lib/joinInput.ts` (copied, not imported: the extension never imports the web app).
 */
import { normaliseTokenInput } from '@indiansassist/shared';

export type JoinCode = { kind: 'compact' | 'short_code'; value: string };

export function readTokenParam(hash: string, search: string): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('t');
  if (fromHash) return fromHash;
  const fromQuery = new URLSearchParams(search.replace(/^\?/, '')).get('t');
  return fromQuery || null;
}

export function parseJoinInput(raw: unknown): JoinCode | null {
  if (typeof raw !== 'string') return null;
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
