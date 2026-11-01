#!/usr/bin/env node
// `pnpm secrets:reseal` (docs/specs/phase-e-contracts.md section 2.1 Rotation): re-seals every stored org secret
// (org.sso_secret_enc, org.sso_sp_key_enc, integration.credentials_enc) that is not under the current
// ORG_SECRETS_KEY, with the same compare-and-set as the api's lazy re-seal, so a value another request replaced in
// the meantime is left alone. Values that do not open (an unknown key, tampering) are counted and left untouched.
//
//   ORG_SECRETS_KEY=k2:<hex> ORG_SECRETS_KEYS_PREVIOUS=k1:<hex> pnpm secrets:reseal
//
// Reads the api's environment (and the repo .env, as the api does) and its database (DATABASE_URL, else the
// PGlite directory PGLITE_DIR; a PGlite directory can be opened by one process at a time, so stop the api first).
// Needs `pnpm -r build`. Prints one line per column and exits 1 when any value failed to open.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => pathToFileURL(resolve(root, p)).href;

export async function main(env = process.env, log = console.log) {
  for (const p of ['apps/api/dist/config.js', 'apps/api/dist/lib/org-secrets.js', 'packages/db/dist/index.js'])
    if (!existsSync(resolve(root, p))) throw new Error(`${p} is missing; run pnpm -r build first`);
  const { loadConfig } = await import(dist('apps/api/dist/config.js'));
  const { orgSecretKeysFromConfig, resealAllOrgSecrets } = await import(dist('apps/api/dist/lib/org-secrets.js'));
  const { closeDb, createDb } = await import(dist('packages/db/dist/index.js'));
  // Like the api's dotenv: the repo .env fills only variables the environment does not already set.
  if (env === process.env && existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
  const config = loadConfig(env, { repoRoot: root });
  const db = await createDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
  try {
    const report = await resealAllOrgSecrets({ orgSecrets: orgSecretKeysFromConfig(config.orgSecrets) }, db);
    for (const r of report)
      log(`${r.column.padEnd(28)} scanned ${r.scanned}, re-sealed ${r.resealed}, changed meanwhile ${r.lostRace}, failed ${r.failed}`);
    log(`current key: ${config.orgSecrets.keyId}`);
    return report.some((r) => r.failed > 0) ? 1 : 0;
  } finally {
    await closeDb(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`secrets:reseal failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
