// Writes dist/manifest.json from src/manifest.ts (section 9.1) and copies icons/ and managed_schema.json.
// Validates the result: no wildcard host and no path in externally_connectable / bridge matches.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifest } from '../src/manifest.ts';
import { DEV_CONNECT_SRC, OUT_DIR, ROOT, buildEnv } from './env.mjs';

export function validateManifest(manifest) {
  const problems = [];
  const lists = [manifest.externally_connectable?.matches ?? [], ...(manifest.content_scripts ?? []).map((c) => c.matches)];
  for (const list of lists) {
    if (list.length === 0) problems.push('empty match list');
    for (const m of list) {
      const origin = m.replace(/\/\*$/, '');
      if (!m.endsWith('/*') || origin.includes('*') || origin.includes('<')) problems.push(`not an exact-origin match: ${m}`);
      else {
        try {
          if (new URL(origin).origin !== origin) problems.push(`match has a path: ${m}`);
        } catch {
          problems.push(`match does not parse: ${m}`);
        }
      }
    }
  }
  if ((manifest.content_scripts ?? []).some((c) => c.js.includes('content.js'))) problems.push('content.js must not be a static content script');
  return problems;
}

export function writeManifest(cfg = buildEnv(), outDir = OUT_DIR) {
  const manifest = buildManifest({
    version: cfg.version,
    regionOrigins: cfg.regionOrigins,
    devConnectSrc: cfg.dev ? DEV_CONNECT_SRC : [],
    key: cfg.extensionKey,
  });
  const problems = validateManifest(manifest);
  if (problems.length > 0) throw new Error(`manifest validation failed:\n  ${problems.join('\n  ')}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(resolve(ROOT, 'icons'), resolve(outDir, 'icons'), { recursive: true });
  cpSync(resolve(ROOT, 'managed_schema.json'), resolve(outDir, 'managed_schema.json'));
  return manifest;
}
