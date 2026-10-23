/**
 * `421 region_mismatch` handling (contracts section 1.2 R3 / R5, section 6.13 step 2). The web app follows
 * `details.origin` only when it is in the build's `VITE_REGION_ORIGINS` allow-list (and `https:` in
 * production) and differs from the current origin; otherwise it explains where the organisation lives.
 */
import { isRegion, type Region } from '@indiansassist/shared';
import { IS_PROD, REGION_ORIGINS } from '../config';
import { regionLabel } from './format';

export function allowedOrigins(origins: Partial<Record<Region, string>> = REGION_ORIGINS): string[] {
  return [...new Set(Object.values(origins).filter((o): o is string => typeof o === 'string'))];
}

export function isAllowedOrigin(
  origin: unknown,
  origins: Partial<Record<Region, string>> = REGION_ORIGINS,
  prod: boolean = IS_PROD,
): origin is string {
  if (typeof origin !== 'string' || origin === '') return false;
  const clean = origin.replace(/\/+$/, '');
  if (!allowedOrigins(origins).includes(clean)) return false;
  return !prod || clean.startsWith('https://');
}

export type RegionDecision =
  | { kind: 'redirect'; url: string }
  | { kind: 'message'; message: string; manualOrigin: string | null };

/**
 * Decides what to do with a 421. `path` is appended to the target origin (it may carry a fragment, e.g.
 * `/join#t=...`; fragments never reach a server).
 */
export function regionDecision(
  details: Record<string, unknown> | undefined,
  path: string,
  currentOrigin: string = globalThis.location?.origin ?? '',
  origins: Partial<Record<Region, string>> = REGION_ORIGINS,
  prod: boolean = IS_PROD,
): RegionDecision {
  const region = details?.region;
  const origin = details?.origin;
  const label = isRegion(region) ? regionLabel(region) : 'another region';
  const message = `This organisation is hosted in ${label}; open the link on that region's site.`;
  if (isAllowedOrigin(origin, origins, prod)) {
    const clean = origin.replace(/\/+$/, '');
    if (clean !== currentOrigin) return { kind: 'redirect', url: `${clean}${path}` };
  }
  return { kind: 'message', message, manualOrigin: typeof origin === 'string' && origin ? origin : null };
}

/** Navigates the whole window (cross-origin). Wrapped so tests can observe it. */
export function navigateTo(url: string): void {
  globalThis.location.assign(url);
}
