#!/usr/bin/env node
// Verifies a signed IndiansAssist data residency report offline (docs/specs/phase-e-contracts.md section 6.3c).
//
//   node scripts/verify-residency.mjs <report.json> --keys <well-known.json>
//   node scripts/verify-residency.mjs <report.json> --pub <base64url public key>
//   node scripts/verify-residency.mjs <report.json> --fetch <api origin>     # the only mode that uses the network
//
// The report is verified over its RAW parsed JSON minus `signature` (never a schema-parsed copy, which would drop a
// field added after signing). The key is looked up by the signature's `kid` in the keys given; the report's own
// `signature.pub` is never trusted alone. `--keys` takes a saved `/.well-known/indiansassist.json` (or a bare array
// of `{ kid, pub }`), which lists retired keys too, so a report signed before a key rotation still verifies.
//
// Prints `OK <kid> <sha256>` and exits 0, or `FAIL <cause>` and exits 1 (causes: unknown_kid, bad_signature,
// malformed, unreadable, usage). Uses the built @indiansassist/shared (`pnpm --filter @indiansassist/shared build`).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadShared } from './smoke/shared.mjs';

const USAGE = 'usage: node scripts/verify-residency.mjs <report.json> (--keys <well-known.json> | --pub <base64url> | --fetch <origin>)';

/** Parses argv into `{ file, keys?, pub?, fetch? }`; throws with the usage line on anything else. */
export function parseArgs(argv) {
  const out = { file: null, keys: null, pub: null, fetch: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keys' || a === '--pub' || a === '--fetch') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value\n${USAGE}`);
      out[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}\n${USAGE}`);
    } else if (out.file === null) {
      out.file = a;
    } else {
      throw new Error(`unexpected argument ${a}\n${USAGE}`);
    }
  }
  if (!out.file) throw new Error(USAGE);
  if ([out.keys, out.pub, out.fetch].filter(Boolean).length !== 1) throw new Error(`give exactly one of --keys, --pub, --fetch\n${USAGE}`);
  return out;
}

/** `{ kid, pub }[]` from a well-known document (`{ keys: [...] }`) or a bare array. */
export function keysFromDocument(doc) {
  const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.keys) ? doc.keys : null;
  if (!list) throw new Error('the keys file has no "keys" array');
  return list
    .filter((k) => k && typeof k.kid === 'string' && typeof k.pub === 'string' && (k.alg === undefined || k.alg === 'Ed25519'))
    .map((k) => ({ kid: k.kid, pub: k.pub }));
}

/**
 * Verifies `reportText` against keys from one source. Returns `{ ok, line }` where `line` is what the CLI prints.
 * @param {string} reportText
 * @param {{ keys?: string | null, pub?: string | null, fetch?: string | null }} src  file text of --keys, --pub, or --fetch origin
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 */
export async function verifyReportText(reportText, src, deps = {}) {
  const shared = await loadShared();
  let raw;
  try {
    raw = JSON.parse(reportText);
  } catch {
    return { ok: false, line: 'FAIL malformed (the report is not JSON)' };
  }
  let keys;
  try {
    if (src.pub) {
      const entry = shared.publicKeyEntry(src.pub.trim());
      keys = [{ kid: entry.kid, pub: src.pub.trim() }];
    } else if (src.keys) {
      keys = keysFromDocument(JSON.parse(src.keys));
    } else {
      const origin = String(src.fetch).replace(/\/+$/, '');
      const res = await (deps.fetchImpl ?? fetch)(`${origin}/.well-known/indiansassist.json`, { redirect: 'error' });
      if (!res.ok) throw new Error(`GET ${origin}/.well-known/indiansassist.json answered ${res.status}`);
      keys = keysFromDocument(await res.json());
    }
  } catch (err) {
    return { ok: false, line: `FAIL unreadable (keys: ${err instanceof Error ? err.message : String(err)})` };
  }
  const r = shared.verifyResidencyReport(raw, keys);
  if (!r.ok) return { ok: false, line: `FAIL ${r.cause}` };
  return { ok: true, line: `OK ${raw.signature.kid} ${raw.signature.sha256}` };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.log('FAIL usage');
    return 1;
  }
  let reportText;
  let keysText = null;
  try {
    reportText = readFileSync(args.file, 'utf8');
    if (args.keys) keysText = readFileSync(args.keys, 'utf8');
  } catch (err) {
    console.log(`FAIL unreadable (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
  const r = await verifyReportText(reportText, { keys: keysText, pub: args.pub, fetch: args.fetch });
  console.log(r.line);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.log(`FAIL unreadable (${err instanceof Error ? err.message : String(err)})`);
      process.exit(1);
    });
}
