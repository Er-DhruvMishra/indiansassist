// Loads the BUILT @indiansassist/shared package (packages/shared/dist) so the smoke test verifies tokens, server
// frames and the audit chain with exactly the code the api and the web app use. The root package has no
// dependency on the workspace package, so it is imported by path; its own dependencies (@noble/*, zod) resolve
// from packages/shared/node_modules.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHARED_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'shared',
  'dist',
  'index.js',
);

let cached = null;

/** Imports packages/shared/dist/index.js once; throws a readable error when the package is not built. */
export async function loadShared() {
  if (cached) return cached;
  if (!existsSync(SHARED_DIST)) {
    throw new Error(
      `@indiansassist/shared is not built (${SHARED_DIST} missing); run: pnpm --filter @indiansassist/shared build`,
    );
  }
  cached = await import(pathToFileURL(SHARED_DIST).href);
  return cached;
}

/** Validates one server -> client frame with the shared zod union; throws with the issue paths on mismatch. */
export function assertServerFrame(shared, frame, label = frame?.t) {
  const r = shared.parseServerSignal(frame);
  if (r.ok) return r.msg;
  const issues = (r.issues ?? r.error?.issues ?? [])
    .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  throw new Error(
    `${label}: frame does not match the contract schema (${r.code ?? 'bad_payload'}${issues ? `: ${issues}` : ''})`,
  );
}
