// Build-time configuration of the extension (docs/specs/phase-b-contracts.md section 9.1): the compiled
// REGION_ORIGINS list, dev additions, API origin overrides and the version. Shared by both Vite passes,
// the manifest generator and the vitest config so every artefact agrees.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_WEB_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
export const DEV_CONNECT_SRC = ['http://localhost:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'ws://127.0.0.1:*'];

/** Minimal .env reader (KEY=VALUE lines) for apps/extension/.env and .env.local; process.env wins. */
function readDotEnv() {
  const out = {};
  for (const name of ['.env', '.env.local']) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

/**
 * Parses `region=origin,...` into exact origins and validates each one: a URL that parses, no `*`, no path,
 * no query, `https:` outside a dev build. Throws with every problem listed.
 */
export function parseRegionOriginList(value, dev) {
  const problems = [];
  const origins = [];
  for (const raw of (value ?? '').split(',')) {
    const pair = raw.trim();
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const origin = (eq > 0 ? pair.slice(eq + 1) : pair).trim().replace(/\/+$/, '');
    if (origin.includes('*')) {
      problems.push(`wildcard in region origin: ${origin}`);
      continue;
    }
    let u;
    try {
      u = new URL(origin);
    } catch {
      problems.push(`region origin does not parse as a URL: ${origin}`);
      continue;
    }
    if (u.origin !== origin) problems.push(`region origin must be a bare origin (no path): ${origin}`);
    else if (u.protocol !== 'https:' && !(dev && u.protocol === 'http:')) problems.push(`region origin must be https: ${origin}`);
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, problems };
}

export function buildEnv(env = { ...readDotEnv(), ...process.env }) {
  // IA_DEV=1 forces a dev build, IA_DEV=0 a production build; unset, a build without VITE_REGION_ORIGINS is a dev
  // build (so `pnpm build` at the root works on a fresh checkout) and a build with it is a production build.
  const dev = env.IA_DEV !== undefined && env.IA_DEV !== '' ? env.IA_DEV === '1' : !env.VITE_REGION_ORIGINS;
  const e2e = env.IA_E2E === '1';
  const { origins, problems } = parseRegionOriginList(env.VITE_REGION_ORIGINS, dev);
  const regionOrigins = [...origins];
  if (dev) for (const o of DEV_WEB_ORIGINS) if (!regionOrigins.includes(o)) regionOrigins.push(o);
  if (regionOrigins.length === 0) problems.push('VITE_REGION_ORIGINS is empty (set it, or build with IA_DEV=1)');
  if (problems.length > 0) throw new Error(`extension build configuration:\n  ${problems.join('\n  ')}`);
  // In dev the web app (:5173) and the api (:4000) are different origins; REST calls go to VITE_API_URL.
  const apiOverrides = {};
  if (dev) {
    const api = (env.VITE_API_URL || 'http://localhost:4000').replace(/\/+$/, '');
    for (const o of DEV_WEB_ORIGINS) apiOverrides[o] = api;
  }
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const defaultApiOrigin = (env.VITE_DEFAULT_API_ORIGIN || (dev ? DEV_WEB_ORIGINS[0] : 'https://indiansassist.com')).replace(/\/+$/, '');
  return {
    dev,
    e2e,
    regionOrigins,
    apiOverrides,
    version: pkg.version,
    defaultApiOrigin: regionOrigins.includes(defaultApiOrigin) ? defaultApiOrigin : regionOrigins[0],
    extensionKey: env.EXTENSION_KEY || null,
  };
}

/** Vite / vitest `define` values (constants.ts reads them). */
export function defines(cfg) {
  return {
    __IA_REGION_ORIGINS__: JSON.stringify(cfg.regionOrigins),
    __IA_API_OVERRIDES__: JSON.stringify(cfg.apiOverrides),
    __IA_DEFAULT_API_ORIGIN__: JSON.stringify(cfg.defaultApiOrigin),
    __IA_VERSION__: JSON.stringify(cfg.version),
    __IA_DEV__: JSON.stringify(cfg.dev),
    __IA_E2E__: JSON.stringify(cfg.e2e),
  };
}
