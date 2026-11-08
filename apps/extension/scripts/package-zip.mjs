#!/usr/bin/env node
// Packages a built apps/extension/dist as the public download: the zip, its sha256, and the extension/manifest.json
// the api reads from AGENT_DIST_DIR/extension/ (extensionDistManifestSchema in packages/shared). The zip holds the dist
// folder's files at its root, so `Load unpacked` works on the unzipped folder.
//
//   node apps/extension/scripts/package-zip.mjs [--dist <dir>] --out <dir> [--require-origin <https origin>]
//
// --dist defaults to apps/extension/dist. A dev build (its manifest lists http:// or localhost origins) is refused, so
// a build made for a laptop cannot be published by accident. --require-origin also checks that this origin is in
// externally_connectable and in the bridge content script's matches.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/** Every file under `dir`, sorted, with forward-slash zip names. */
export function listZipEntries(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ name: relative(dir, full).split(sep).join('/'), data: readFileSync(full) });
    }
  };
  walk(dir);
  return out;
}

/** A deterministic zip (DEFLATE, fixed 1980-01-01 timestamps) of `entries` as `{ name, data }` in the given order. */
export function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe zip name: ${name}`);
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10); // time
    head.writeUInt16LE(0x0021, 12); // date: 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(deflated.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, deflated);
    const cdir = Buffer.alloc(46);
    cdir.writeUInt32LE(0x02014b50, 0);
    cdir.writeUInt16LE(20, 4);
    cdir.writeUInt16LE(20, 6);
    cdir.writeUInt16LE(0x0800, 8);
    cdir.writeUInt16LE(8, 10);
    cdir.writeUInt16LE(0, 12);
    cdir.writeUInt16LE(0x0021, 14);
    cdir.writeUInt32LE(crc, 16);
    cdir.writeUInt32LE(deflated.length, 20);
    cdir.writeUInt32LE(data.length, 24);
    cdir.writeUInt16LE(nameBuf.length, 28);
    cdir.writeUInt32LE(offset, 42);
    central.push(cdir, nameBuf);
    offset += head.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Why a built manifest.json must not be published; `[]` when it may. */
export function releaseManifestProblems(manifest, requiredOrigin) {
  const problems = [];
  const lists = [manifest.externally_connectable?.matches ?? [], ...(manifest.content_scripts ?? []).map((c) => c.matches ?? [])];
  const flat = lists.flat();
  if (flat.length === 0) problems.push('the manifest has no externally_connectable or content-script origins');
  for (const m of flat) if (/^http:|localhost|127\.0\.0\.1/.test(m)) problems.push(`dev origin in a release package: ${m}`);
  if (requiredOrigin) {
    const want = `${requiredOrigin.replace(/\/+$/, '')}/*`;
    if (!(manifest.externally_connectable?.matches ?? []).includes(want)) problems.push(`externally_connectable does not include ${want}`);
    if (!(manifest.content_scripts ?? []).some((c) => (c.matches ?? []).includes(want))) problems.push(`the content script matches do not include ${want}`);
  }
  if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? '')) problems.push(`manifest.json has no usable version: ${manifest.version}`);
  return problems;
}

/** Packages `dist` into `out`: the zip and manifest.json. Returns the build row. */
export function packageExtension(distDir, outDir, opts = {}) {
  const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
  const problems = releaseManifestProblems(manifest, opts.requireOrigin);
  if (problems.length > 0) throw new Error(`extension package refused:\n  ${problems.join('\n  ')}`);
  const entries = listZipEntries(distDir);
  if (!entries.some((e) => e.name === 'manifest.json')) throw new Error(`${distDir} has no manifest.json at its root`);
  const zip = buildZip(entries);
  const file = `IndiansAssist-extension-${manifest.version}.zip`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, file), zip);
  const row = {
    version: manifest.version,
    size: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex'),
    minOs: `Chrome or Edge ${manifest.minimum_chrome_version ?? '120'} or later`,
    file,
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({ v: 1, builds: [row] }, null, 2)}\n`);
  return row;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = opt('--out');
  if (!out) {
    console.error('package-zip: --out <dir> is required');
    process.exit(2);
  }
  try {
    const row = packageExtension(resolve(opt('--dist') ?? join(ROOT, 'dist')), resolve(out), { requireOrigin: opt('--require-origin') });
    console.log(`package-zip: ${join(resolve(out), row.file)} ${row.size} B sha256 ${row.sha256}`);
  } catch (err) {
    console.error(`package-zip: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
