#!/usr/bin/env node
/**
 * Writes AGENT_DIST_DIR/manifest.json for the P3 download flow (Phase C contract §2.2, §2.6).
 *
 * Scans the dist directory for the canonical build files and emits
 *   { v: 1, builds: AgentBuild[] }
 * where AgentBuild = { platform, arch, version, size, sha256, signed, minOs }, as the API reads at boot
 * (apps/api/src/signal/agent-manifest.ts) and `GET /api/v1/download/manifest` serves.
 *
 * File names recognised (§2.2 "the files it names"):
 *   IndiansAssist-windows-x64-<version>.exe
 *   IndiansAssist-windows-arm64-<version>.exe
 *   IndiansAssist-android-universal-<version>.apk
 *   IndiansAssist-macos-<arm64|x64>-<version>.app.zip   (Phase F §17.8, agent/scripts/macos-zip.sh)
 *
 * The Linux row is written by `pnpm agent:release:linux` (packaging/linux/agent-release.mjs), because it carries the
 * portal companion's hash; this script keeps every existing `platform: 'linux'` row as it is.
 *
 * `signed` is left false here: per §2.6 the signed exe's sha256 is computed by CI *after* Authenticode, so CI
 * runs this step on the already-signed artifacts and marks them signed via `manifest.signed.json` (a JSON array
 * of file names) in the dist dir, or `--signed-all`. Local/dev dist dirs stay `signed: false` (the join page then
 * prints the sha256 and the "verify the file" hint, §2.7 / §2.6 "Unsigned (dev)").
 *
 * Read-only except for manifest.json. Usage:
 *   node scripts/agent-manifest.mjs [--dist <dir>] [--signed-all] [--check]
 * Env: AGENT_DIST_DIR (default ./data/agent-dist). --check exits non-zero if manifest.json is stale.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const distDir = resolve(root, opt('--dist', process.env.AGENT_DIST_DIR || 'data/agent-dist'));
const check = flag('--check');
const signedAll = flag('--signed-all');

const NAME_RE = /^IndiansAssist-(windows|android|macos)-(x64|arm64|universal)-(.+?)\.(exe|apk|app\.zip)$/;
const EXT = { windows: 'exe', android: 'apk', macos: 'app.zip' };
const MIN_OS = {
  windows: process.env.IA_MIN_OS_WINDOWS || '10.0.17763',
  android: process.env.IA_MIN_OS_ANDROID || '29',
  macos: process.env.IA_MIN_OS_MACOS || '12.3',
};

if (!existsSync(distDir)) {
  console.error(`agent-manifest: dist dir ${distDir} does not exist (a node without it serves builds: []).`);
  process.exit(check ? 1 : 2);
}

let signedSet = new Set();
const signedManifest = join(distDir, 'manifest.signed.json');
if (!signedAll && existsSync(signedManifest)) {
  try {
    const list = JSON.parse(readFileSync(signedManifest, 'utf8'));
    if (Array.isArray(list)) signedSet = new Set(list);
  } catch {
    console.error(`agent-manifest: ${signedManifest} is not a JSON array; ignoring.`);
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const builds = [];
for (const name of readdirSync(distDir).sort()) {
  const m = NAME_RE.exec(name);
  if (!m) continue;
  const [, platform, arch, version, ext] = m;
  if (EXT[platform] !== ext) continue;
  if (platform === 'android' ? arch !== 'universal' : arch === 'universal') continue;
  const file = join(distDir, name);
  if (!statSync(file).isFile()) continue;
  builds.push({
    platform,
    arch,
    version,
    size: statSync(file).size,
    sha256: sha256(file),
    signed: signedAll || signedSet.has(name),
    minOs: MIN_OS[platform],
  });
}

const out = join(distDir, 'manifest.json');
// Keep the Linux rows of `pnpm agent:release:linux` (the X11 agent and its portal companion's hash).
if (existsSync(out)) {
  try {
    const prior = JSON.parse(readFileSync(out, 'utf8'));
    if (Array.isArray(prior?.builds)) builds.push(...prior.builds.filter((b) => b?.platform === 'linux'));
  } catch {
    console.error(`agent-manifest: ${out} is not JSON; its Linux rows (if any) are not kept.`);
  }
}
const manifest = { v: 1, builds };
const text = `${JSON.stringify(manifest, null, 2)}\n`;

if (check) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (current !== text) {
    console.error(`agent-manifest: ${out} is stale; re-run \`node scripts/agent-manifest.mjs\`.`);
    process.exit(1);
  }
  console.log(`agent-manifest: ${out} up to date (${builds.length} build(s)).`);
  process.exit(0);
}

writeFileSync(out, text);
console.log(`agent-manifest: wrote ${out} with ${builds.length} build(s):`);
for (const b of builds)
  console.log(
    `  ${b.platform}/${b.arch} ${b.version}  ${b.size} B  sha256 ${b.sha256.slice(0, 16)}...  signed=${b.signed}`,
  );
if (builds.length === 0) console.log('  (no build files found; CI publishes them before this step.)');
