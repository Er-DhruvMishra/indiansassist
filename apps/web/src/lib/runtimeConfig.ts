/**
 * Runtime configuration of a published image. The all-in-one image (infra/allinone) must work on any domain, so
 * nothing about its host can be compiled into the bundle: its entrypoint writes `/runtime-config.js`, which `index.html`
 * loads before the app and which sets `window.__IA_RUNTIME_CONFIG__`. Every other deployment serves the empty file from
 * `public/`, so this module changes nothing for them.
 *
 * Order (highest first): the build-time `VITE_*` value, the runtime value, then the fallback. These are pure functions
 * over their inputs, so the order is tested without a build (`test/runtimeConfig.test.ts`).
 */

export type RuntimeConfig = { apiUrl: string; regionOrigins: string };

type RuntimeScope = { __IA_RUNTIME_CONFIG__?: unknown };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Reads the global set by `/runtime-config.js`; anything missing or malformed reads as empty. */
export function readRuntimeConfig(scope: RuntimeScope = globalThis as RuntimeScope): RuntimeConfig {
  const raw = scope.__IA_RUNTIME_CONFIG__;
  if (typeof raw !== 'object' || raw === null) return { apiUrl: '', regionOrigins: '' };
  const obj = raw as Record<string, unknown>;
  return { apiUrl: text(obj.apiUrl), regionOrigins: text(obj.regionOrigins) };
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** An origin with no path, query or credentials; `https:` only in production. Returns it without a trailing slash. */
function usableOrigin(raw: string, prod: boolean): string | null {
  if (raw === '') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && (prod || u.protocol !== 'http:')) return null;
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || u.pathname !== '/') return null;
  return u.origin;
}

export type ApiUrlInput = {
  /** `import.meta.env.VITE_API_URL`. */
  buildValue: string | undefined;
  runtimeValue: string;
  prod: boolean;
  /** The page's own origin (`location.origin`), or '' where there is no page. */
  pageOrigin: string;
};

/** The dev fallback of contracts section 11.2. */
export const DEV_API_URL = 'http://localhost:4000';

/**
 * Build-time value first (Compose and dev keep working exactly as before). Otherwise a valid runtime origin. A
 * production bundle built with neither is same-origin (nginx proxies the api there); a development bundle falls back
 * to the dev api.
 */
export function resolveApiUrl({ buildValue, runtimeValue, prod, pageOrigin }: ApiUrlInput): string {
  const build = text(buildValue);
  if (build !== '') return stripSlash(build);
  const runtime = usableOrigin(runtimeValue, prod);
  if (runtime !== null) return runtime;
  if (prod && pageOrigin !== '') return stripSlash(pageOrigin);
  return DEV_API_URL;
}

export type RegionOriginsInput = {
  /** `import.meta.env.VITE_REGION_ORIGINS`. */
  buildValue: string | undefined;
  runtimeValue: string;
  fallback: string;
};

/** The `region=origin,...` list: build-time value, then runtime value, then `fallback`. */
export function resolveRegionOrigins({ buildValue, runtimeValue, fallback }: RegionOriginsInput): string {
  const build = text(buildValue);
  if (build !== '') return build;
  return runtimeValue !== '' ? runtimeValue : fallback;
}
