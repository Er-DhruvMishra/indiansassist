#!/usr/bin/env node
// Re-hashes a dist manifest after its files were signed by something outside the release scripts (the SignPath step
// of .github/workflows/release.yml signs the MSI after packaging/windows/build.mjs wrote the row):
//
//   node packaging/sign/rehash.mjs <dist-dir> [--mark-signed]
//
// Every row of <dist-dir>/manifest.json that names a `file` gets that file's current size and sha256. With
// --mark-signed each such Windows file (.exe, .dll, .msi) must carry a timestamped Authenticode signature
// (Get-AuthenticodeSignature), and its row is set `signed: true`; a file without one is an error.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isWindowsSignable } from './sign-lib.mjs';
import { acceptable, inspectAuthenticode } from './sign-windows.mjs';

/** The manifest with each named file's size and sha256 replaced by `measure(file)`; `signed` set per `signedOf`. */
export function rehashManifest(manifest, measure, signedOf) {
  return {
    ...manifest,
    builds: manifest.builds.map((b) => {
      if (typeof b.file !== 'string') return b;
      const { size, sha256 } = measure(b.file);
      const signed = signedOf ? signedOf(b.file, b.signed) : b.signed;
      return { ...b, size, sha256, ...(signed === undefined ? {} : { signed }) };
    }),
  };
}

function main(argv) {
  const dir = argv.find((a) => !a.startsWith('--'));
  const markSigned = argv.includes('--mark-signed');
  if (!dir) {
    console.error('usage: rehash.mjs <dist-dir> [--mark-signed]');
    process.exit(2);
  }
  const dist = resolve(dir);
  const path = join(dist, 'manifest.json');
  if (!existsSync(path)) {
    console.error(`rehash: ${path} does not exist`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const measure = (file) => {
    const p = join(dist, file);
    return { size: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') };
  };
  const signedOf = markSigned
    ? (file) => {
        if (!isWindowsSignable(file)) throw new Error(`rehash: --mark-signed checks Windows files only: ${file}`);
        const info = inspectAuthenticode(join(dist, file));
        if (!acceptable(info)) throw new Error(`rehash: ${file} carries no timestamped signature (${info.status})`);
        return true;
      }
    : undefined;
  let next;
  try {
    next = rehashManifest(manifest, measure, signedOf);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
  for (const b of next.builds)
    if (b.file) console.log(`rehash: ${b.file} ${b.size} B sha256 ${b.sha256} signed=${b.signed}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
