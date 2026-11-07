#!/usr/bin/env node
// `pnpm agent:release:windows`: publishes the Windows portable agent into AGENT_DIST_DIR (docs/release.md sections
// 1.4 and 4): copies the built IndiansAssist.exe under its canonical name, signs it through the signing seam
// (packaging/sign/sign-windows.mjs), records it in manifest.signed.json when it was signed (and removes it from that
// list when it was not), then runs scripts/agent-manifest.mjs so the manifest's sha256 covers the signed bytes.
//
//   node scripts/agent-release-windows.mjs [--exe <IndiansAssist.exe>] [--arch x64|arm64] [--version 0.3.0]
//        [--dist <dir>] [--require-signed]
//
// --exe defaults to agent/target/<triple>/release/IndiansAssist.exe, else agent/target/release/IndiansAssist.exe.
// The dist dir defaults to AGENT_DIST_DIR, else ./data/agent-dist. The exe is signed as a copy in a temporary
// directory and only then copied into the dist dir, so the cargo output is never modified and the api never sees a
// half-signed file. Keys: IA_SIGN_PFX and IA_SIGN_PFX_PASSWORD (or _FILE); without them the build is published
// unsigned (`signed: false`), or refused with --require-signed.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { versionInfoProblems } from '../packaging/sign/sign-lib.mjs';
import { readVersionInfo, signWindowsFiles } from '../packaging/sign/sign-windows.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRIPLES = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };

/** `agentDistFileName('windows', arch, version)`. */
export function windowsDistFileName(arch, version) {
  return `IndiansAssist-windows-${arch}-${version}.exe`;
}

/** manifest.signed.json after a publish: `name` added when signed, removed when not; sorted, no duplicates. */
export function updateSignedList(list, name, signed) {
  const set = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  if (signed) set.add(name);
  else set.delete(name);
  return [...set].sort();
}

function fail(msg) {
  console.error(`agent:release:windows: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { arch: 'x64', requireSigned: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--exe') opts.exe = resolve(next());
    else if (a === '--arch') opts.arch = next();
    else if (a === '--version') opts.version = next();
    else if (a === '--dist') opts.dist = next();
    else if (a === '--require-signed') opts.requireSigned = true;
    else if (a === '--help' || a === '-h') {
      const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(1);
      console.log(
        lines
          .slice(
            0,
            lines.findIndex((l) => !l.startsWith('//')),
          )
          .join('\n'),
      );
      process.exit(0);
    } else fail(`unknown argument ${a}`);
  }
  if (!TRIPLES[opts.arch]) fail('--arch must be x64 or arm64');
  if (opts.version !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(opts.version))
    fail('--version must be MAJOR.MINOR.PATCH');
  return opts;
}

function workspaceVersion() {
  const toml = readFileSync(join(ROOT, 'agent', 'Cargo.toml'), 'utf8');
  const m = /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(toml);
  if (!m) fail('could not read [workspace.package] version from agent/Cargo.toml; pass --version');
  return m[1];
}

function main() {
  if (process.platform !== 'win32') fail('run this on Windows (signtool)');
  const opts = parseArgs(process.argv.slice(2));
  const version = opts.version ?? workspaceVersion();
  const exe =
    opts.exe ??
    [
      join(ROOT, 'agent', 'target', TRIPLES[opts.arch], 'release', 'IndiansAssist.exe'),
      join(ROOT, 'agent', 'target', 'release', 'IndiansAssist.exe'),
    ].find((p) => existsSync(p));
  if (!exe || !existsSync(exe)) fail('IndiansAssist.exe not found; build it (`pnpm agent:release`) or pass --exe');
  const dist = resolve(ROOT, opts.dist ?? process.env.AGENT_DIST_DIR ?? join('data', 'agent-dist'));
  const name = windowsDistFileName(opts.arch, version);

  const problems = versionInfoProblems(readVersionInfo(exe), version);
  if (problems.length > 0) {
    const msg = `${exe}: ${problems.join('; ')}`;
    if (process.env.IA_REQUIRE_VERSIONINFO === '1') fail(msg);
    console.warn(`agent:release:windows: warning: ${msg}`);
  }

  const work = mkdtempSync(join(tmpdir(), 'ia-win-release-'));
  try {
    const copy = join(work, name);
    copyFileSync(exe, copy);
    let res;
    try {
      res = signWindowsFiles([copy], { description: 'IndiansAssist Agent' });
    } catch (err) {
      fail(err.message);
    }
    if (!res.signed && opts.requireSigned) fail(`--require-signed: ${res.reason}`);

    mkdirSync(dist, { recursive: true });
    copyFileSync(copy, join(dist, name));
    const listPath = join(dist, 'manifest.signed.json');
    let list = [];
    if (existsSync(listPath)) {
      try {
        list = JSON.parse(readFileSync(listPath, 'utf8'));
      } catch {
        fail(`${listPath} is not JSON; fix or remove it first`);
      }
    }
    writeFileSync(listPath, `${JSON.stringify(updateSignedList(list, name, res.signed), null, 2)}\n`);
    const m = spawnSync(process.execPath, [join(ROOT, 'scripts', 'agent-manifest.mjs'), '--dist', dist], {
      stdio: 'inherit',
    });
    if (m.status !== 0) fail('scripts/agent-manifest.mjs failed');
    console.log(
      `agent:release:windows: ${join(dist, name)} ${res.signed ? `signed (${res.provider})` : `NOT signed (${res.reason})`}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
