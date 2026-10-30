#!/usr/bin/env node
/**
 * Writes the Phase C cross-language name fixtures from the @indiansassist/shared build (contract section 13.1
 * "Ownership of names": every wire enum is defined once in packages/shared and mirrored by Rust and Kotlin):
 *   packages/shared/test/fixtures/agent/agent-names.json   enums, control ops and their minimum levels
 *   packages/shared/test/fixtures/agent/file-lists.json    section 6.1 F3/F4 lists
 * The shared tests assert each file equals the exports (so it cannot drift); ia-core tests/shared_vectors.rs and the
 * Android HelpersParityTest assert their own constants against it. sec-vectors.json has its own generator
 * (apps/android/tools/gen-phase-c-vectors.mjs).
 *
 *   pnpm --filter @indiansassist/shared build && node scripts/gen-agent-fixtures.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const s = await import(pathToFileURL(resolve(root, 'packages/shared/dist/index.js')).href);
const dir = resolve(root, 'packages/shared/test/fixtures/agent');
const { agentNames, fileLists } = await import('./agent-fixtures-lib.mjs');

const check = process.argv.includes('--check');
let stale = 0;
for (const [name, value] of [
  ['agent-names.json', agentNames(s)],
  ['file-lists.json', fileLists(s)],
]) {
  const path = resolve(dir, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== text) {
      stale++;
      console.error(`stale: ${path}`);
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exit(1);
