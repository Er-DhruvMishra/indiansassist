#!/usr/bin/env node
// `pnpm downloads:build`: stages every build this Windows machine can make in the layout the api serves
// (docs/release.md section 5), by running the existing release scripts:
//
//   <out>/agent-dist/manifest.json + files   (IndiansAssist-windows-*, IndiansAssist-linux-* and the portal, the apk)
//   <out>/agent-dist/extension/              (the packaged extension zip and its manifest.json)
//   <out>/agent-msi/manifest.json + msi
//   <out>/agent-msi/linux/manifest.json + deb and rpm (and their .sha256, .asc, SHA256SUMS)
//   <out>/downloads-summary.json             (machine-readable: what was built, what was not, and why)
//
//   node scripts/build-downloads.mjs [--out <dir>] [--only <id,...>] [--skip <id,...>] [--allow-unsigned] [--dry-run]
//
// Steps, in order: extension, windows-portable, windows-msi, linux-portable, linux-packages, android.
// Required environment: IA_TOKEN_PUBKEYS, IA_API_ORIGIN (a bare https origin). Signing locations come only from the
// environment (IA_SIGN_PFX, IA_SIGN_PFX_PASSWORD(_FILE); IA_GPG_HOME, IA_GPG_PASSPHRASE(_FILE); IA_ANDROID_KEYSTORE,
// IA_ANDROID_KEYSTORE_PASSWORD(_FILE)) and are required for the steps that use them unless --allow-unsigned is given.
// No secret is printed or written by this script. Any failing step stops the run; the summary still records it.
// --out defaults to ./data/downloads.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TRIPLE = 'x86_64-pc-windows-msvc';

export const STEP_IDS = Object.freeze(['extension', 'windows-portable', 'windows-msi', 'linux-portable', 'linux-packages', 'android']);

/** What cannot be built on this machine, whichever steps run. */
export const NOT_BUILT_HERE = Object.freeze([
  { target: 'windows/arm64', reason: 'the aarch64-pc-windows-msvc Rust target and an arm64 prebuilt libvpx are not installed on this host (docs/release.md section 1.1: an arm64 build needs its own toolchain setup)' },
  { target: 'macos', reason: 'macOS builds need a Mac with Xcode (agent/scripts/macos-bundle.sh, macos-pkg.sh); a macOS app cannot be built or signed here' },
  { target: 'ios', reason: 'the iOS app needs Xcode and an Apple developer account; nothing in the repository builds it from Windows' },
]);

const fail = (msg) => {
  console.error(`build-downloads: ${msg}`);
  process.exit(1);
};

export function parseArgs(argv) {
  const opts = { only: null, skip: new Set(), allowUnsigned: false, dryRun: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--out') opts.out = next();
    else if (a === '--only') opts.only = new Set(next().split(',').filter(Boolean));
    else if (a === '--skip') opts.skip = new Set(next().split(',').filter(Boolean));
    else if (a === '--allow-unsigned') opts.allowUnsigned = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  for (const id of [...(opts.only ?? []), ...opts.skip]) if (!STEP_IDS.includes(id)) throw new Error(`unknown step ${id} (one of ${STEP_IDS.join(', ')})`);
  return opts;
}

/** The problems with the environment, by variable name only (a value is never echoed). */
export function checkEnvironment(env, opts, steps) {
  const problems = [];
  for (const name of ['IA_TOKEN_PUBKEYS', 'IA_API_ORIGIN']) if (!(env[name] ?? '').trim()) problems.push(`${name} is not set`);
  const origin = (env.IA_API_ORIGIN ?? '').trim();
  if (origin !== '') {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = u.protocol === 'https:' && u.origin === origin.replace(/\/+$/, '');
    } catch {
      /* not a URL */
    }
    if (!ok) problems.push('IA_API_ORIGIN must be a bare https origin, for example https://api.indiansassist.com');
  }
  if (!opts.allowUnsigned) {
    if (steps.includes('windows-portable') || steps.includes('windows-msi')) {
      if (!env.IA_SIGN_PFX) problems.push('IA_SIGN_PFX is not set (the Windows files would be unsigned; pass --allow-unsigned to accept that)');
      if (!env.IA_SIGN_PFX_PASSWORD && !env.IA_SIGN_PFX_PASSWORD_FILE) problems.push('IA_SIGN_PFX_PASSWORD or IA_SIGN_PFX_PASSWORD_FILE is not set');
    }
    if (steps.includes('linux-portable') || steps.includes('linux-packages')) {
      if (!env.IA_GPG_HOME) problems.push('IA_GPG_HOME is not set (the Linux files would be unsigned; pass --allow-unsigned to accept that)');
      if (!env.IA_GPG_PASSPHRASE && !env.IA_GPG_PASSPHRASE_FILE) problems.push('IA_GPG_PASSPHRASE or IA_GPG_PASSPHRASE_FILE is not set');
    }
    if (steps.includes('android')) {
      if (!env.IA_ANDROID_KEYSTORE) problems.push('IA_ANDROID_KEYSTORE is not set (an unsigned APK cannot be installed; pass --allow-unsigned to stage it anyway)');
      if (!env.IA_ANDROID_KEYSTORE_PASSWORD && !env.IA_ANDROID_KEYSTORE_PASSWORD_FILE) problems.push('IA_ANDROID_KEYSTORE_PASSWORD or IA_ANDROID_KEYSTORE_PASSWORD_FILE is not set');
    }
  }
  return problems;
}

/** The ordered step ids a run will execute. */
export function selectSteps(opts) {
  return STEP_IDS.filter((id) => (opts.only ? opts.only.has(id) : true) && !opts.skip.has(id));
}

/** The on-server layout under `out`. */
export function stagingLayout(out) {
  return {
    agentDist: join(out, 'agent-dist'),
    extension: join(out, 'agent-dist', 'extension'),
    agentMsi: join(out, 'agent-msi'),
    linuxPackages: join(out, 'agent-msi', 'linux'),
    summary: join(out, 'downloads-summary.json'),
  };
}

/**
 * Checks the staged tree the way the api will read it: every manifest parses and every row's file is there with the
 * manifest's size and sha256. Returns the served files and the problems found.
 */
export function inspectStaged(out) {
  const layout = stagingLayout(out);
  const problems = [];
  const files = [];
  const readManifest = (dir, optional) => {
    const p = join(dir, 'manifest.json');
    if (!existsSync(p)) {
      if (!optional) problems.push(`${p} is missing`);
      return null;
    }
    try {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      if (m.v !== 1 || !Array.isArray(m.builds)) throw new Error('not { v: 1, builds: [...] }');
      return m;
    } catch (err) {
      problems.push(`${p}: ${err.message}`);
      return null;
    }
  };
  const check = (dir, row, name, tier) => {
    const path = join(dir, name);
    if (basename(name) !== name) {
      problems.push(`${name} is not a bare file name`);
      return;
    }
    if (!existsSync(path)) {
      problems.push(`${path} is named by a manifest but missing`);
      return;
    }
    const data = readFileSync(path);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (sha256 !== row.sha256) problems.push(`${path}: sha256 does not match its manifest row`);
    files.push({ tier, file: name, dir: basename(dir), version: row.version, size: data.length, sha256, signed: row.signed === true });
  };
  const agent = readManifest(layout.agentDist, true);
  for (const b of agent?.builds ?? []) {
    const name = b.file ?? (b.platform === 'linux' ? `IndiansAssist-linux-${b.arch}-${b.version}` : b.platform === 'macos' ? `IndiansAssist-macos-${b.arch}-${b.version}.app.zip` : `IndiansAssist-${b.platform}-${b.arch}-${b.version}.${b.platform === 'android' ? 'apk' : 'exe'}`);
    check(layout.agentDist, b, name, 'p3_portable');
    if (b.companion) check(layout.agentDist, { ...b, sha256: b.companion.sha256 }, `IndiansAssist-linux-portal-x64-${b.version}`, 'p3_portable');
  }
  const ext = readManifest(layout.extension, true);
  for (const b of ext?.builds ?? []) check(layout.extension, b, b.file ?? `IndiansAssist-extension-${b.version}.zip`, 'p2_extension');
  for (const dir of [layout.agentMsi, layout.linuxPackages]) {
    const m = readManifest(dir, true);
    for (const b of m?.builds ?? []) {
      const fmt = b.format ?? 'msi';
      const name = b.file ?? `IndiansAssist-Agent-${b.version}-${fmt === 'msi' ? 'windows' : 'linux'}-${b.arch}.${fmt}`;
      check(dir, b, name, 'p4_installed');
    }
  }
  return { files, problems };
}

/** The machine-readable summary; `steps` is the run's step records. */
export function buildSummary({ origin, steps, inspected, generatedAt = new Date().toISOString() }) {
  return {
    v: 1,
    generatedAt,
    apiOrigin: origin,
    ok: steps.every((s) => s.status === 'built' || s.status === 'skipped') && inspected.problems.length === 0,
    steps,
    files: inspected.files,
    problems: inspected.problems,
    notBuilt: [...NOT_BUILT_HERE, ...steps.filter((s) => s.status === 'skipped').map((s) => ({ target: s.id, reason: s.reason }))],
  };
}

/** Copies the regular files of `from` into `to` (a folder a release script wrote its dist to). */
export function copyDist(from, to) {
  if (!existsSync(from)) throw new Error(`${from} does not exist`);
  mkdirSync(to, { recursive: true });
  const copied = [];
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (statSync(src).isFile()) {
      copyFileSync(src, join(to, name));
      copied.push(name);
    }
  }
  if (copied.length === 0) throw new Error(`${from} is empty`);
  return copied;
}

/** The APK's `versionName` from apps/android/build.gradle.kts. */
export function androidVersionName(gradleText) {
  const m = /versionName\s*=\s*"([^"]+)"/.exec(gradleText);
  if (!m) throw new Error('could not find versionName in build.gradle.kts');
  return m[1];
}

/** A run for each step: the commands (for --dry-run and the record), then the function that does it. */
function makeSteps(ctx) {
  const { layout, childEnv, opts } = ctx;
  const node = process.execPath;
  const cargoBuild = (pkg, features = []) => {
    const a = ['build', '--release', '--locked', '--target', TRIPLE, '-p', pkg, ...features];
    return { cmd: 'cargo', args: a, cwd: join(ROOT, 'agent') };
  };
  return {
    extension: {
      commands: [{ shell: 'pnpm --filter @indiansassist/extension build' }],
      run: () => {
        const origin = childEnv.IA_API_ORIGIN;
        exec({ shell: 'pnpm --filter @indiansassist/extension build' }, { ...childEnv, IA_DEV: '0', VITE_REGION_ORIGINS: `in-mum=${origin}`, VITE_DEFAULT_API_ORIGIN: origin });
        exec({ cmd: node, args: [join(ROOT, 'apps/extension/scripts/package-zip.mjs'), '--out', layout.extension, '--require-origin', origin] }, childEnv);
      },
    },
    'windows-portable': {
      commands: [cargoBuild('ia-agent')],
      run: () => {
        exec(cargoBuild('ia-agent'), childEnv);
        const args = [join(ROOT, 'scripts/agent-release-windows.mjs'), '--arch', 'x64', '--dist', layout.agentDist, '--exe', join(ROOT, 'agent/target', TRIPLE, 'release/IndiansAssist.exe')];
        if (!opts.allowUnsigned) args.push('--require-signed');
        exec({ cmd: node, args }, childEnv);
      },
    },
    'windows-msi': {
      commands: [cargoBuild('ia-service', ['--features', 'service']), cargoBuild('ia-watchdog', ['--features', 'service']), cargoBuild('ia-desktop')],
      run: () => {
        exec(cargoBuild('ia-service', ['--features', 'service']), childEnv);
        exec(cargoBuild('ia-watchdog', ['--features', 'service']), childEnv);
        exec(cargoBuild('ia-desktop'), childEnv);
        exec({ cmd: node, args: [join(ROOT, 'packaging/windows/build.mjs'), '--arch', 'x64'] }, childEnv);
        copyDist(join(ROOT, 'packaging/windows/out/dist'), layout.agentMsi);
      },
    },
    'linux-portable': {
      commands: [{ cmd: node, args: ['packaging/linux/agent-release.mjs', '--dist', layout.agentDist] }],
      run: () => exec({ cmd: node, args: [join(ROOT, 'packaging/linux/agent-release.mjs'), '--dist', layout.agentDist] }, childEnv),
    },
    'linux-packages': {
      commands: [{ cmd: node, args: ['packaging/linux/build.mjs'] }],
      run: () => {
        exec({ cmd: node, args: [join(ROOT, 'packaging/linux/build.mjs')] }, childEnv);
        copyDist(join(ROOT, 'packaging/linux/out/dist'), layout.linuxPackages);
      },
    },
    android: {
      commands: [{ cmd: node, args: ['apps/android/tools/gradle.mjs', 'assembleRelease'] }],
      run: () => {
        exec({ cmd: node, args: [join(ROOT, 'apps/android/tools/gradle.mjs'), 'assembleRelease'] }, childEnv);
        const dir = join(ROOT, 'apps/android/build/outputs/apk/release');
        const apk = readdirSync(dir).find((n) => n.endsWith('.apk'));
        if (!apk) throw new Error(`no .apk under ${dir}`);
        const signed = !apk.includes('unsigned');
        if (!signed && !opts.allowUnsigned) throw new Error('the APK was built unsigned (the keystore was not applied)');
        const version = androidVersionName(readFileSync(join(ROOT, 'apps/android/build.gradle.kts'), 'utf8'));
        const name = `IndiansAssist-android-universal-${version}.apk`;
        mkdirSync(layout.agentDist, { recursive: true });
        copyFileSync(join(dir, apk), join(layout.agentDist, name));
        const listPath = join(layout.agentDist, 'manifest.signed.json');
        const list = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')) : [];
        if (signed && !list.includes(name)) list.push(name);
        writeFileSync(listPath, `${JSON.stringify(list, null, 2)}\n`);
        exec({ cmd: node, args: [join(ROOT, 'scripts/agent-manifest.mjs'), '--dist', layout.agentDist] }, childEnv);
      },
    },
  };
}

function exec(c, env) {
  console.log(`\n> ${c.shell ?? [c.cmd, ...c.args].join(' ')}`);
  const r = c.shell ? spawnSync(c.shell, { shell: true, stdio: 'inherit', env, cwd: ROOT }) : spawnSync(c.cmd, c.args, { stdio: 'inherit', env, cwd: c.cwd ?? ROOT });
  if (r.error) throw new Error(`${c.shell ?? c.cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${c.shell ?? c.cmd} exited with code ${r.status}`);
}

function childEnvironment(opts) {
  const env = { ...process.env, CARGO_INCREMENTAL: '0' };
  const cargoBin = join(homedir(), '.cargo', 'bin');
  env.PATH = `${cargoBin};${process.env.PATH ?? process.env.Path ?? ''}`;
  env.IA_API_ORIGIN = (env.IA_API_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (env.IA_ANDROID_KEYSTORE_PASSWORD_FILE && !env.IA_ANDROID_KEYSTORE_PASSWORD) {
    // Read here and passed in the child's environment only; the Gradle script reads the value, not a file.
    env.IA_ANDROID_KEYSTORE_PASSWORD = readFileSync(env.IA_ANDROID_KEYSTORE_PASSWORD_FILE, 'utf8').trim();
    env.IA_ANDROID_KEY_PASSWORD ??= env.IA_ANDROID_KEYSTORE_PASSWORD;
  }
  if (!env.IA_EXPECTED_SIGNER && env.IA_SIGN_PFX && !opts.allowUnsigned) env.IA_EXPECTED_SIGNER = 'IndiansAssist (self-signed)';
  env.IA_REQUIRE_VERSIONINFO = opts.allowUnsigned ? (env.IA_REQUIRE_VERSIONINFO ?? '') : '1';
  // packaging/linux/build.mjs reads the region keys through WSLENV (agent-release.mjs sets its own).
  env.WSLENV = [...new Set([...(env.WSLENV ?? '').split(':').filter(Boolean), 'IA_TOKEN_PUBKEYS/u', 'IA_API_ORIGIN/u'])].join(':');
  return env;
}

function prepareOutDir(out) {
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true });
    return;
  }
  const entries = readdirSync(out);
  if (entries.length === 0) return;
  if (!entries.includes('downloads-summary.json')) fail(`${out} is not empty and is not an earlier staging folder; give an empty --out`);
  // An earlier staging folder of this script: rebuilt from clean so a removed build cannot linger.
  for (const name of entries) rmSync(join(out, name), { recursive: true, force: true });
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }
  if (opts.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).join('\n'));
    process.exit(0);
  }
  const stepIds = selectSteps(opts);
  const problems = checkEnvironment(process.env, opts, stepIds);
  if (problems.length > 0) fail(`environment:\n  ${problems.join('\n  ')}`);

  const out = resolve(ROOT, opts.out ?? join('data', 'downloads'));
  const layout = stagingLayout(out);
  const steps = makeSteps({ layout, childEnv: opts.dryRun ? {} : childEnvironment(opts), opts });
  if (opts.dryRun) {
    console.log(`build-downloads --dry-run: would stage into ${out}`);
    for (const id of stepIds) console.log(`  ${id}`);
    console.log('nothing was built');
    return;
  }

  prepareOutDir(out);
  for (const dir of [layout.agentDist, layout.extension, layout.agentMsi, layout.linuxPackages]) mkdirSync(dir, { recursive: true });

  const records = STEP_IDS.filter((id) => !stepIds.includes(id)).map((id) => ({ id, status: 'skipped', reason: 'not selected for this run' }));
  let failed = false;
  for (const id of stepIds) {
    console.log(`\n===== ${id} =====`);
    try {
      steps[id].run();
      records.push({ id, status: 'built' });
    } catch (err) {
      console.error(`build-downloads: step ${id} failed: ${err.message}`);
      records.push({ id, status: 'failed', reason: err.message.slice(0, 500) });
      failed = true;
      for (const rest of stepIds.slice(stepIds.indexOf(id) + 1)) records.push({ id: rest, status: 'not_run', reason: `stopped after ${id} failed` });
      break;
    }
  }
  const summary = buildSummary({ origin: process.env.IA_API_ORIGIN.trim().replace(/\/+$/, ''), steps: records, inspected: inspectStaged(out) });
  writeFileSync(layout.summary, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nbuild-downloads: summary in ${layout.summary}: ${summary.files.length} file(s); ok=${summary.ok}`);
  for (const p of summary.problems) console.error(`  problem: ${p}`);
  if (failed || !summary.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
