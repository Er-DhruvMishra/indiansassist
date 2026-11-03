#!/usr/bin/env node
// Verifies a signed IndiansAssist org erasure certificate offline (docs/specs/phase-f-contracts.md section 5.5).
//
//   node scripts/verify-erasure.mjs <certificate.json> --keys <well-known.json>
//   node scripts/verify-erasure.mjs <certificate.json> --pub <base64url public key>
//   node scripts/verify-erasure.mjs <certificate.json> --keys <well-known.json> --export <audit.jsonl> --digest <digest.json>
//
// The certificate is verified over its RAW parsed JSON minus `signature` (never a schema-parsed copy, which would drop
// a field added after signing); the key is looked up by the signature's `kid` in the keys given, never taken from the
// certificate's own `signature.pub`. `chain.finalEntry` (the `org.erased` entry) must recompute to `chain.tail`.
//
// With `--export` (an audit export taken during cooling-off, `POST /api/v1/audit/export`) and `--digest` (the pages of
// `GET /api/v1/erasures/<id>/chain-digest`, saved as `{ "items": [...] }` or a bare array) it also checks that every
// exported entry recomputes to the hash the digest lists at its `seq`, and that the digest links `prevHash` to `hash`
// from seq 1 without a gap up to `chain.tail`: so the entries you kept are the entries the erased chain still holds.
//
// Prints `OK <kid> <sha256>` and exits 0, or `FAIL <cause>` and exits 1 (causes: unknown_kid, bad_signature,
// malformed, final_entry_mismatch, digest_gap, digest_tail_mismatch, export_mismatch, export_org_mismatch,
// unreadable, usage). Uses the built @indiansassist/shared (`pnpm --filter @indiansassist/shared build`).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadShared } from './smoke/shared.mjs';
import { keysFromDocument } from './verify-residency.mjs';

const USAGE =
  'usage: node scripts/verify-erasure.mjs <certificate.json> (--keys <well-known.json> | --pub <base64url>) [--export <audit.jsonl> --digest <digest.json>]';
const GENESIS = '0'.repeat(64);

/** Parses argv into `{ file, keys?, pub?, export?, digest? }`; throws with the usage line on anything else. */
export function parseArgs(argv) {
  const out = { file: null, keys: null, pub: null, export: null, digest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keys' || a === '--pub' || a === '--export' || a === '--digest') {
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
  if ([out.keys, out.pub].filter(Boolean).length !== 1) throw new Error(`give exactly one of --keys, --pub\n${USAGE}`);
  if (Boolean(out.export) !== Boolean(out.digest)) throw new Error(`--export and --digest go together\n${USAGE}`);
  return out;
}

/** The digest items from a saved document: `{ items: [...] }`, a list of pages, or a bare array. */
export function digestItems(doc) {
  const pages = Array.isArray(doc) && doc.length > 0 && doc[0] && Array.isArray(doc[0].items) ? doc : null;
  const list = pages ? pages.flatMap((p) => p.items) : Array.isArray(doc) ? doc : doc && Array.isArray(doc.items) ? doc.items : null;
  if (!list) throw new Error('the digest file has no "items" array');
  return list;
}

/**
 * Checks the digest against the certificate's chain and the export against the digest. Returns null when every check
 * holds, else the FAIL line's cause.
 */
export function checkExportAndDigest(shared, cert, exportText, digest) {
  const items = [...digest].sort((a, b) => a.seq - b.seq);
  let prev = GENESIS;
  const bySeq = new Map();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it.hash !== 'string' || typeof it.prevHash !== 'string' || it.seq !== i + 1 || it.prevHash !== prev) return `digest_gap (seq ${it?.seq ?? i + 1})`;
    bySeq.set(it.seq, it.hash);
    prev = it.hash;
  }
  if (items.length !== cert.chain.entries || prev !== cert.chain.tail) return 'digest_tail_mismatch';
  const parsed = shared.parseAuditJsonl(exportText);
  if (!parsed.ok) return `malformed (export line ${parsed.line}: ${parsed.message})`;
  if (parsed.header.orgId !== cert.orgId) return 'export_org_mismatch';
  for (const e of parsed.entries) {
    let computed;
    try {
      computed = shared.hashAuditEntry(e);
    } catch {
      return `export_mismatch (seq ${e.seq})`;
    }
    if (computed !== e.hash || bySeq.get(e.seq) !== computed) return `export_mismatch (seq ${e.seq})`;
  }
  return null;
}

/**
 * Verifies `certText` (and optionally an export against a digest). Returns `{ ok, line }` where `line` is what the CLI
 * prints.
 * @param {string} certText
 * @param {{ keys?: string | null, pub?: string | null, exportText?: string | null, digestText?: string | null }} src
 */
export async function verifyCertificateText(certText, src) {
  const shared = await loadShared();
  let raw;
  try {
    raw = JSON.parse(certText);
  } catch {
    return { ok: false, line: 'FAIL malformed (the certificate is not JSON)' };
  }
  let keys;
  try {
    if (src.pub) {
      const entry = shared.publicKeyEntry(src.pub.trim());
      keys = [{ kid: entry.kid, pub: src.pub.trim() }];
    } else {
      keys = keysFromDocument(JSON.parse(src.keys));
    }
  } catch (err) {
    return { ok: false, line: `FAIL unreadable (keys: ${err instanceof Error ? err.message : String(err)})` };
  }
  const r = shared.verifyErasureCertificate(raw, keys);
  if (!r.ok) return { ok: false, line: `FAIL ${r.cause}` };
  const cert = shared.erasureCertificateSchema.safeParse(raw);
  if (!cert.success) return { ok: false, line: 'FAIL malformed (not an erasure certificate)' };
  let final;
  try {
    final = shared.hashAuditEntry(cert.data.chain.finalEntry);
  } catch {
    final = null;
  }
  if (final !== cert.data.chain.tail || cert.data.chain.finalEntry.hash !== cert.data.chain.tail) return { ok: false, line: 'FAIL final_entry_mismatch' };
  if (typeof src.exportText === 'string' && typeof src.digestText === 'string') {
    let items;
    try {
      items = digestItems(JSON.parse(src.digestText));
    } catch (err) {
      return { ok: false, line: `FAIL unreadable (digest: ${err instanceof Error ? err.message : String(err)})` };
    }
    const cause = checkExportAndDigest(shared, cert.data, src.exportText, items);
    if (cause) return { ok: false, line: `FAIL ${cause}` };
  }
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
  let certText;
  let keysText = null;
  let exportText = null;
  let digestText = null;
  try {
    certText = readFileSync(args.file, 'utf8');
    if (args.keys) keysText = readFileSync(args.keys, 'utf8');
    if (args.export) exportText = readFileSync(args.export, 'utf8');
    if (args.digest) digestText = readFileSync(args.digest, 'utf8');
  } catch (err) {
    console.log(`FAIL unreadable (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
  const r = await verifyCertificateText(certText, { keys: keysText, pub: args.pub, exportText, digestText });
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
