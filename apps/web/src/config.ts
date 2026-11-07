/**
 * Build-time configuration (contracts section 11.2). Every value has the documented dev default so the
 * app runs with no `.env` at all.
 */
import { parseRegionOrigins, type Region } from '@indiansassist/shared';

const DEFAULT_REGION_ORIGINS =
  'in-mum=http://localhost:5173,eu-fra=http://localhost:5173,us-east=http://localhost:5173';

function stripSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export const API_URL: string = stripSlash(import.meta.env.VITE_API_URL || 'http://localhost:4000');
export const API_BASE = `${API_URL}/api/v1`;
/** Assist WS endpoint. The Desk uses `PublicToken.signalUrl` instead (section 6.13 step 3). */
export const ASSIST_SIGNAL_URL = `${API_URL.replace(/^http/, 'ws')}/signal`;
export const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'IndiansAssist';
/** The project's public repository (AGPL-3.0-only section 13). An operator running a modified build points it at their own source. */
export const DEFAULT_SOURCE_URL = 'https://github.com/Er-DhruvMishra/indiansassist';
export const SOURCE_URL: string = safeHttpsUrl(import.meta.env.VITE_SOURCE_URL) ?? DEFAULT_SOURCE_URL;

function safeHttpsUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function safeOrigins(raw: string): Partial<Record<Region, string>> {
  try {
    return parseRegionOrigins(raw);
  } catch {
    return parseRegionOrigins(DEFAULT_REGION_ORIGINS);
  }
}

/** Compiled allow-list for `421` redirects and the login region picker (R3, T3). */
export const REGION_ORIGINS: Partial<Record<Region, string>> = safeOrigins(
  import.meta.env.VITE_REGION_ORIGINS || DEFAULT_REGION_ORIGINS,
);

export const IS_PROD = import.meta.env.PROD;
export const IS_DEV = import.meta.env.DEV;
