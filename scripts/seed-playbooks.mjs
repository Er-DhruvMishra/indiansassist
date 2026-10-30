#!/usr/bin/env node
// Seeds the Phase C starter playbooks (docs/specs/phase-c-contracts.md section 8.6) into an existing org through the
// REST API, as its org_admin. New orgs on a P3 plan get them at signup already; this is for orgs created before.
// The server computes every body hash, so shipped (scripts/playbooks/*) and catalogue hashes agree; a name that
// already exists is skipped (409 playbook_name_taken), so the script is idempotent.
//
//   API_URL=http://localhost:4000 SEED_EMAIL=admin@example.com SEED_PASSWORD=... node scripts/seed-playbooks.mjs
//
// Env: API_URL (default http://localhost:4000), WEB_ORIGIN (default: origin of well-known `join`), SEED_EMAIL,
// SEED_PASSWORD. Exits 1 on any failure.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiClient } from './smoke/http.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'playbooks');

/** The starter catalogue: metadata from catalogue.json, bodies from the files it names (LF line ends). */
export function loadStarterCatalogue(dir = DIR) {
  const cat = JSON.parse(readFileSync(join(dir, 'catalogue.json'), 'utf8'));
  return cat.playbooks.map((p) => ({ ...p, body: readFileSync(join(dir, p.file), 'utf8').replace(/\r\n/g, '\n') }));
}

/** Logs in and creates each starter playbook; returns { created, skipped }. */
export async function seedPlaybooks({ apiUrl, email, password, webOrigin = null, fetchImpl, log = console.log }) {
  const api = new ApiClient(apiUrl, { origin: webOrigin, fetchImpl });
  if (!api.origin) {
    const wk = await api.expect('GET', '/.well-known/indiansassist.json');
    api.origin = new URL(wk.join).origin;
  }
  await api.expect('POST', '/api/v1/auth/login', { email, password });
  let created = 0;
  let skipped = 0;
  for (const p of loadStarterCatalogue()) {
    const r = await api.request('POST', '/api/v1/orgs/current/playbooks', {
      name: p.name,
      description: p.description,
      interpreter: p.interpreter,
      body: p.body,
      requiresElevation: p.requiresElevation,
      timeoutSec: p.timeoutSec,
    });
    if (r.status === 201) {
      created += 1;
      log(`created  ${p.name} (${r.json.bodyHash.slice(0, 12)}...)`);
    } else if (r.status === 409 && r.json?.error?.code === 'playbook_name_taken') {
      skipped += 1;
      log(`exists   ${p.name}`);
    } else {
      throw new Error(`${p.name}: ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.message ?? ''}`);
    }
  }
  return { created, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  if (!env.SEED_EMAIL || !env.SEED_PASSWORD) {
    console.error('set SEED_EMAIL and SEED_PASSWORD (an org_admin of the target org)');
    process.exit(1);
  }
  seedPlaybooks({ apiUrl: env.API_URL || 'http://localhost:4000', email: env.SEED_EMAIL, password: env.SEED_PASSWORD, webOrigin: env.WEB_ORIGIN || null })
    .then((r) => {
      console.log(`seed-playbooks: ${r.created} created, ${r.skipped} already present`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`FAIL  seed-playbooks: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
