/**
 * Desk white label (PRD 12.15, contracts sections 6.7 and 12.1 D1): the org's display name, accent and
 * logo from the public token lookup, kept for the room in `sessionStorage` so the room is branded from
 * its first paint; `desk.hello.ok.org` / `session.created.org` take over once they arrive.
 */
import { brandingPublicSchema } from '@indiansassist/shared';
import { readStore, writeStore } from '../lib/storage';

export type DeskBrand = { displayName: string; accentColor: string | null; logoData: string | null };

/** Not a contract key; a per-tab convenience next to `ia.join.token`. */
export const JOIN_BRAND_KEY = 'ia.join.brand';

export function saveJoinBrand(org: DeskBrand): void {
  writeStore('session', JOIN_BRAND_KEY, JSON.stringify({ displayName: org.displayName, accentColor: org.accentColor, logoData: org.logoData }));
}

export function readJoinBrand(): DeskBrand | null {
  const raw = readStore('session', JOIN_BRAND_KEY);
  if (!raw) return null;
  try {
    const parsed = brandingPublicSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Only inline images are ever rendered on Desk pages (no cross-origin resource, section 12). */
export function safeLogo(logo: string | null | undefined): string | null {
  return logo && /^data:image\/(png|jpeg);base64,/.test(logo) ? logo : null;
}
