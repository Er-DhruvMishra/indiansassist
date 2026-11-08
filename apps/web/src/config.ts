/**
 * Build-time configuration (contracts section 11.2). Every value has the documented dev default so the
 * app runs with no `.env` at all. A value compiled in at build time wins; otherwise `lib/runtimeConfig.ts` reads what
 * the container wrote at start (the all-in-one image), so a published bundle holds no domain.
 */
import { parseRegionOrigins, type Region } from '@indiansassist/shared';
import { readRuntimeConfig, resolveApiUrl, resolveRegionOrigins } from './lib/runtimeConfig';

const DEFAULT_REGION_ORIGINS =
  'in-mum=http://localhost:5173,eu-fra=http://localhost:5173,us-east=http://localhost:5173';

const RUNTIME = readRuntimeConfig();

export const API_URL: string = resolveApiUrl({
  buildValue: import.meta.env.VITE_API_URL,
  runtimeValue: RUNTIME.apiUrl,
  prod: import.meta.env.PROD,
  pageOrigin: globalThis.location?.origin ?? '',
});
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

/** Allow-list for `421` redirects and the login region picker (R3, T3): compiled in, or written at container start. */
export const REGION_ORIGINS: Partial<Record<Region, string>> = safeOrigins(
  resolveRegionOrigins({
    buildValue: import.meta.env.VITE_REGION_ORIGINS,
    runtimeValue: RUNTIME.regionOrigins,
    fallback: DEFAULT_REGION_ORIGINS,
  }),
);

export const IS_PROD = import.meta.env.PROD;
export const IS_DEV = import.meta.env.DEV;
