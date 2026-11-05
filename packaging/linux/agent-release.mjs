#!/usr/bin/env node
// `pnpm agent:release:linux`: builds the Linux portable pair (Phase E section 7.9, Phase F sections 9.5 and 9.6
// with the revision 3 corrections) on Windows through WSL and publishes it into AGENT_DIST_DIR:
//
//   node packaging/linux/agent-release.mjs [--dist <dir>] [--version 0.3.0] [--distro Ubuntu]
//        [--target-dir <WSL path>]
//
// Steps (the build order matters: the X11 agent embeds the companion's sha256):
//   1. `agent-release-wsl.sh tools`: cargo-zigbuild, Zig, clang and libpipewire-0.3 in WSL (never installed here);
//   2. `agent-release-wsl.sh portal`: the Wayland portal companion (`--features portal`, the libpipewire-only link
//      directory and `--allow-shlib-undefined`, glibc 2.34 floor), staged in packaging/linux/out/agent/;
//   3. Windows Node: scripts/elf-check.mjs on it (`--allow libpipewire-0.3.so.0`, GLIBC_ <= 2.34, <= 25 MiB) and
//      its sha256;
//   4. `agent-release-wsl.sh x11 <sha256>`: the X11 agent with IA_PORTAL_SHA256 embedded (glibc 2.34 floor);
//   5. Windows Node: elf-check on it (the E NEEDED set, GLIBC_ <= 2.34, <= 25 MiB) and a check that it carries the
//      companion's sha256;
//   6. the dist: `IndiansAssist-linux-x64-<v>` and `IndiansAssist-linux-portal-x64-<v>` copied into the dist dir,
//      and its manifest.json updated: every earlier Linux row is replaced by one row with
//      `companion: { sha256, size }` (`agentDistManifestSchema`); the Windows, Android and macOS rows are kept.
//      packaging/linux/out/agent-release-info.json records the elf-check results.
//
// The dist dir defaults to AGENT_DIST_DIR, else ./data/agent-dist (as scripts/agent-manifest.mjs). The WSL cargo
// target directory defaults to $HOME/.cache/ia-agent-target (agent/scripts/linux-env.sh). IA_TOKEN_PUBKEYS and
// IA_API_ORIGIN, when set, are passed to the build (WSLENV). Linux artefacts are not signed: their sha256 is
// published in the manifest and printed by the join page.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkElf } from '../../scripts/elf-check.mjs';
import { toWslPath, workspaceVersion } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/** The glibc floor of both artefacts (F section 8.9 revision 3, section 9.6 revision 3) and the size gate. */
export const MAX_GLIBC = '2.34';
export const MAX_SIZE_MIB = 25;
/** The one library the portal companion may need beyond the E set (section 9.6). */
export const PORTAL_ALLOW = Object.freeze(['libpipewire-0.3.so.0']);
/** `agentBuildSchema.minOs` (at most 64 characters). */
export const MIN_OS = 'glibc 2.34+ x86_64; Wayland needs PipeWire 0.3+';

/** `agentDistFileName('linux', 'x64', v)`: the X11 ELF. */
export function x11DistFileName(version) {
  return `IndiansAssist-linux-x64-${version}`;
}
/** `agentPortalDistFileName(v)`: the portal companion. */
export function portalDistFileName(version) {
  return `IndiansAssist-linux-portal-x64-${version}`;
}

/** The Linux row of AGENT_DIST_DIR/manifest.json (`agentDistManifestSchema`), with its companion. */
export function linuxDistRow(version, x11, portal) {
  return {
    platform: 'linux',
    arch: 'x64',
    version,
    size: x11.size,
    sha256: x11.sha256,
    signed: false,
    minOs: MIN_OS,
    companion: { sha256: portal.sha256, size: portal.size },
  };
}

/**
 * The manifest after a Linux release: the rows of every other platform as they were, each earlier Linux row
 * replaced by `row`. A missing manifest (`null`) starts empty; anything that is not `{ v: 1, builds: [] }` is
 * refused rather than overwritten.
 */
export function mergeDistManifest(existing, row) {
  if (existing !== null && (typeof existing !== 'object' || existing.v !== 1 || !Array.isArray(existing.builds)))
    throw new Error('the existing manifest.json is not { v: 1, builds: [...] }; fix or remove it first');
  const kept = (existing?.builds ?? []).filter((b) => b?.platform !== 'linux');
  return { v: 1, builds: [...kept, row] };
}

/** Whether an X11 image carries the companion's sha256 (IA_PORTAL_SHA256, embedded as text by `option_env!`). */
export function embedsCompanionHash(buf, sha256) {
  return /^[0-9a-f]{64}$/.test(sha256) && buf.includes(Buffer.from(sha256, 'latin1'));
}

/** WSLENV so IA_TOKEN_PUBKEYS and IA_API_ORIGIN, when set, reach the build inside WSL. */
export function wslEnv(env) {
  const names = ['IA_TOKEN_PUBKEYS', 'IA_API_ORIGIN'].filter((n) => (env[n] ?? '') !== '');
  const prior = (env.WSLENV ?? '').split(':').filter((s) => s !== '' && !names.some((n) => s.split('/')[0] === n));
  return [...prior, ...names.map((n) => `${n}/u`)].join(':');
}

function parseArgs(argv) {
  const opts = { distro: 'Ubuntu' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--dist') opts.dist = next();
    else if (a === '--version') opts.version = next();
    else if (a === '--distro') opts.distro = next();
    else if (a === '--target-dir') opts.targetDir = next();
    else if (a === '--help' || a === '-h') {
      const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
      console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).join('\n'));
      process.exit(0);
    } else fail(`unknown argument ${a}`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(opts.distro)) fail('--distro must be a WSL distro name');
  if (opts.version !== undefined && !/^\d+\.\d+\.\d+$/.test(opts.version)) fail('--version must be MAJOR.MINOR.PATCH');
  if (opts.targetDir && (!opts.targetDir.startsWith('/') || opts.targetDir.startsWith('/mnt/')))
    fail('--target-dir must be an absolute path inside WSL (not under /mnt)');
  return opts;
}

function fail(msg) {
  console.error(`agent:release:linux: ${msg}`);
  process.exit(1);
}

function wsl(distro, args) {
  const full = ['-d', distro, '--', 'bash', toWslPath(join(HERE, 'agent-release-wsl.sh')), ...args];
  console.log(`> wsl.exe ${full.join(' ')}`);
  const r = spawnSync('wsl.exe', full, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, WSLENV: wslEnv(process.env) },
  });
  if (r.error) fail(`wsl.exe: ${r.error.message}`);
  return r.status ?? 1;
}

/** Expand a `$HOME/...` WSL path once (wsl.exe passes arguments literally). */
function resolveWslHome(distro, p) {
  const r = spawnSync('wsl.exe', ['-d', distro, '--', 'printenv', 'HOME'], { encoding: 'utf8' });
  const home = (r.stdout ?? '').trim();
  if (r.status !== 0 || !home.startsWith('/')) fail('could not read $HOME in WSL');
  return home + p.slice('$HOME'.length);
}

function gate(name, path, allow) {
  if (!existsSync(path)) fail(`${path} was not written`);
  const buf = readFileSync(path);
  const res = checkElf(buf, { maxGlibc: MAX_GLIBC, maxSizeMib: MAX_SIZE_MIB, allow });
  console.log(`elf-check ${name}: ${JSON.stringify(res)}`);
  if (!res.ok) fail(`${name} fails the elf-check gate: ${res.failures.join('; ')}`);
  return { buf, res, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** Write `data` to `path` through a temporary file, so the api never reads half a manifest. */
function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function main() {
  if (process.platform !== 'win32') fail('run this on Windows: it drives the Linux build through wsl.exe');
  const opts = parseArgs(process.argv.slice(2));
  const version = opts.version ?? workspaceVersion(readFileSync(join(ROOT, 'agent', 'Cargo.toml'), 'utf8'));
  const dist = resolve(ROOT, opts.dist ?? process.env.AGENT_DIST_DIR ?? join('data', 'agent-dist'));
  const out = join(HERE, 'out');
  const stage = join(out, 'agent');
  const targetDir = opts.targetDir ?? resolveWslHome(opts.distro, '$HOME/.cache/ia-agent-target');
  if (!process.env.IA_TOKEN_PUBKEYS)
    console.warn('agent:release:linux: IA_TOKEN_PUBKEYS is empty; the agents will check a token\'s shape and time only');

  // 1. the tools
  if (wsl(opts.distro, ['tools']) !== 0) fail('the release tools are missing in WSL: the release gate is NOT MET');

  // 2-3. the portal companion first, gated, hashed
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const portalPath = join(stage, portalDistFileName(version));
  if (wsl(opts.distro, ['portal', targetDir, toWslPath(portalPath)]) !== 0) fail('the portal build failed');
  const portal = gate('portal', portalPath, PORTAL_ALLOW);
  if (!portal.res.needed.includes('libpipewire-0.3.so.0')) fail('the portal companion does not link libpipewire-0.3.so.0');

  // 4-5. the X11 agent with the companion's hash embedded
  const x11Path = join(stage, x11DistFileName(version));
  if (wsl(opts.distro, ['x11', targetDir, toWslPath(x11Path), portal.sha256]) !== 0) fail('the X11 build failed');
  const x11 = gate('x11', x11Path, []);
  if (!embedsCompanionHash(x11.buf, portal.sha256)) fail('the X11 agent does not carry the companion sha256 (IA_PORTAL_SHA256)');

  // 6. the dist files and manifest row
  mkdirSync(dist, { recursive: true });
  const manifestPath = join(dist, 'manifest.json');
  let existing = null;
  if (existsSync(manifestPath)) {
    try {
      existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      fail(`${manifestPath} is not JSON (${err.message}); fix or remove it first`);
    }
  }
  let manifest;
  try {
    manifest = mergeDistManifest(existing, linuxDistRow(version, x11, portal));
  } catch (err) {
    fail(err.message);
  }
  // The files before the manifest that names them (the api reads both at boot and on SIGHUP).
  copyFileSync(portalPath, join(dist, portalDistFileName(version)));
  copyFileSync(x11Path, join(dist, x11DistFileName(version)));
  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const info = {
    version,
    signed: false,
    minOs: MIN_OS,
    x11: { file: x11DistFileName(version), size: x11.size, sha256: x11.sha256, glibc: x11.res.glibc, needed: x11.res.needed, sizeMiB: x11.res.sizeMiB },
    portal: { file: portalDistFileName(version), size: portal.size, sha256: portal.sha256, glibc: portal.res.glibc, needed: portal.res.needed, sizeMiB: portal.res.sizeMiB },
  };
  writeFileSync(join(out, 'agent-release-info.json'), `${JSON.stringify(info, null, 2)}\n`);

  console.log(`\nagent:release:linux: ${dist}`);
  for (const [k, v] of [['x11', info.x11], ['portal', info.portal]])
    console.log(`  ${k}: ${v.file}  ${v.sizeMiB} MiB  GLIBC ${v.glibc}  NEEDED ${v.needed.join(' ')}  sha256 ${v.sha256}`);
  console.log(`  manifest: ${manifestPath} (${manifest.builds.length} row(s); the Linux row has the companion; unsigned)`);
  console.log('  then reload the api (SIGHUP or restart) on every node of the region');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
