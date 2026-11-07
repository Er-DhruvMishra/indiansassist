#!/usr/bin/env node
// `pnpm linux:pkg`: builds the IndiansAssist Agent .deb and .rpm (Phase F contract section 8.9) on
// Windows through WSL, gates the two binaries with scripts/elf-check.mjs, and writes the packages,
// their sha256 files and the installer manifest rows the api reads (section 8.11
// `installerBuildSchema`, `platform: 'linux'`) into a dist folder. It never installs a package.
//
//   node packaging/linux/build.mjs [--version 0.3.0] [--distro Ubuntu]
//        [--target-dir <WSL path>] [--skip-build] [--no-check] [--sandbox]
//
// Steps:
//   1. `build-wsl.sh tools`: cargo-deb 3.8.0, cargo-generate-rpm 0.21.1, cargo-zigbuild and Zig in
//      WSL, or the package gates are "not met" (they are never installed by this script);
//   2. `build-wsl.sh build`: the E section 7.9 zigbuild (glibc 2.34 floor, F section 8.9) of
//      `-p ia-service --features linux-service` and `-p ia-desktop --no-default-features
//      --features linux`, staged in packaging/linux/out/stage/ (`--skip-build` stages the release
//      binaries already in the target directory);
//   3. Windows Node: scripts/elf-check.mjs on both staged binaries (NEEDED subset, GLIBC_ <= 2.34,
//      <= 25 MiB), then stage/manifest.json, the installed-file list and sha256 the section 8.8
//      integrity check reads at /usr/lib/indiansassist/manifest.json;
//   4. `build-wsl.sh package`: cargo-deb and cargo-generate-rpm with --no-build over the stage;
//   5. the signing seam (packaging/sign/sign-linux.mjs, docs/release.md section 4): with IA_GPG_HOME
//      set, rpmsign embeds the rpm's signature, each package gets a detached `.asc` and the dist a
//      SHA256SUMS with SHA256SUMS.asc; without a key the packages stay unsigned;
//   6. Windows Node: out/dist/<package>.sha256, out/dist/manifest.json (the installer dist
//      manifest: `installerDistManifestSchema` rows with platform, format, file and `signed`) and
//      out/build-info.json (the elf-check results), all over the signed bytes;
//   7. unless --no-check, `check-wsl.sh`: the section 8.12 package checks (read-only);
//      with --sandbox, also `agent/scripts/pkg-sandbox-test.sh` (the T1 sandbox install).
//
// The WSL target directory defaults to $HOME/.cache/ia-agent-target (agent/scripts/linux-env.sh).
// On a Linux host (CI) the shell halves run with bash directly instead of through wsl.exe.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkElf } from '../../scripts/elf-check.mjs';
import { signLinuxFiles } from '../sign/sign-linux.mjs';
import { hostPath, shellCommand, toWslPath } from './host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/** The only arch Phase F builds (section 8.13: no arm64). */
export const ARCH = 'x64';
/** The glibc floor (E section 7.9, F section 8.9) and the size gate. */
export const MAX_GLIBC = '2.34';
export const MAX_SIZE_MIB = 25;
/** `installerBuildSchema.minOs` (at most 64 characters). */
export const MIN_OS = 'glibc 2.34+ x86_64: Ubuntu 22.04+, Debian 12+, EL 9+, Fedora 35+';
/** The two binaries, as installed under /usr/lib/indiansassist/. */
export const BINARIES = Object.freeze(['ia-service', 'ia-desktop']);

/** Section 8.9 names (`installerFileName(arch, version, format)`). */
export function packageFileName(version, format, arch = ARCH) {
  if (format !== 'deb' && format !== 'rpm') throw new Error(`format must be deb or rpm, got ${format}`);
  return `IndiansAssist-Agent-${version}-linux-${arch}.${format}`;
}

export { toWslPath };

/** MAJOR.MINOR.PATCH from `[workspace.package]` of agent/Cargo.toml. */
export function workspaceVersion(cargoToml) {
  const m = /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(cargoToml);
  if (!m) throw new Error('could not read [workspace.package] version from agent/Cargo.toml');
  if (!/^\d+\.\d+\.\d+$/.test(m[1])) throw new Error(`the workspace version ${m[1]} is not MAJOR.MINOR.PATCH`);
  return m[1];
}

/**
 * The installed-file manifest (`ia_service::config::InstallManifest`): what the section 8.8 integrity
 * check compares /usr/lib/indiansassist/<name> against.
 */
export function installManifest(version, files) {
  return {
    v: 1,
    version,
    arch: ARCH,
    placeholder: false,
    files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  };
}

/**
 * The installer dist manifest the api serves from (`installerDistManifestSchema`, section 8.11):
 * one row per package, `platform: 'linux'`, `format`, and the bare `file` name. `signed` is true only when the
 * signing seam signed the packages (packaging/sign; the rpm carries an embedded signature, both a detached `.asc`).
 */
export function distManifest(version, packages, signed = false) {
  return {
    v: 1,
    builds: packages.map(({ format, size, sha256, file }) => ({
      platform: 'linux',
      format,
      arch: ARCH,
      version,
      size,
      sha256,
      signed,
      minOs: MIN_OS,
      file,
    })),
  };
}

/** `sha256sum` format, so `sha256sum -c <file>.sha256` checks the package. */
export function sha256Line(hex, file) {
  return `${hex}  ${file}\n`;
}

function parseArgs(argv) {
  const opts = { distro: 'Ubuntu', build: true, check: true, sandbox: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--version') opts.version = next();
    else if (a === '--distro') opts.distro = next();
    else if (a === '--target-dir') opts.targetDir = next();
    else if (a === '--skip-build') opts.build = false;
    else if (a === '--no-check') opts.check = false;
    else if (a === '--sandbox') opts.sandbox = true;
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
  if (opts.distro !== 'Ubuntu' && !/^[A-Za-z0-9._-]{1,64}$/.test(opts.distro))
    fail('--distro must be a WSL distro name');
  if (opts.targetDir && (!opts.targetDir.startsWith('/') || opts.targetDir.startsWith('/mnt/')))
    fail('--target-dir must be an absolute path inside WSL (not under /mnt)');
  return opts;
}

function fail(msg) {
  console.error(`linux:pkg: ${msg}`);
  process.exit(1);
}

/** Run a shell half: through wsl.exe on Windows, with bash on Linux (CI). */
function wsl(distro, script, args) {
  const { cmd, args: full } = shellCommand(process.platform, distro, script, args);
  console.log(`> ${cmd} ${full.join(' ')}`);
  const r = spawnSync(cmd, full, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  process.stdout.write(r.stdout ?? '');
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sourceDateEpoch() {
  const r = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' });
  const v = (r.stdout ?? '').trim();
  return /^\d+$/.test(v) ? v : String(Math.floor(Date.now() / 1000));
}

function main() {
  if (process.platform !== 'win32' && process.platform !== 'linux')
    fail('run this on Windows (it drives the Linux build through wsl.exe) or on a Linux host');
  const opts = parseArgs(process.argv.slice(2));
  const version = opts.version ?? workspaceVersion(readFileSync(join(ROOT, 'agent', 'Cargo.toml'), 'utf8'));
  const out = join(HERE, 'out');
  const stage = join(out, 'stage');
  const dist = join(out, 'dist');
  const wslScript = join(HERE, 'build-wsl.sh');
  const targetDir = opts.targetDir ?? '$HOME/.cache/ia-agent-target';
  const hp = (p) => hostPath(process.platform, p);

  // 1. the tools
  const tools = wsl(opts.distro, wslScript, ['tools']);
  if (tools.status !== 0) fail('the packaging tools are missing in WSL: the section 8.9 package gates are NOT MET');

  // 2. the binaries (wsl.exe passes arguments literally, so a `$HOME/...` default is expanded here)
  const resolvedTarget = targetDir.startsWith('$HOME/') ? resolveWslHome(opts.distro, targetDir) : targetDir;
  rmSync(stage, { recursive: true, force: true });
  if (wsl(opts.distro, wslScript, [opts.build ? 'build' : 'stage', resolvedTarget, hp(stage)]).status !== 0)
    fail(opts.build ? 'the release build failed' : 'staging the release binaries failed');

  // 3. the elf-check gate and the installed-file manifest
  const elf = {};
  const files = [];
  for (const name of BINARIES) {
    const path = join(stage, name);
    const buf = readFileSync(path);
    const res = checkElf(buf, { maxGlibc: MAX_GLIBC, maxSizeMib: MAX_SIZE_MIB });
    elf[name] = res;
    console.log(`elf-check ${name}: ${JSON.stringify(res)}`);
    if (!res.ok) fail(`${name} fails the elf-check gate: ${res.failures.join('; ')}`);
    files.push({ name, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
  }
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(installManifest(version, files), null, 2)}\n`);

  // 4. the packages
  const debName = packageFileName(version, 'deb');
  const rpmName = packageFileName(version, 'rpm');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const pkg = wsl(opts.distro, wslScript, ['package', hp(stage), hp(dist), debName, rpmName, sourceDateEpoch()]);
  if (pkg.status !== 0) fail('cargo-deb / cargo-generate-rpm failed');
  for (const file of [debName, rpmName]) if (!existsSync(join(dist, file))) fail(`${file} was not written`);

  // 5. the signing seam (packaging/sign, docs/release.md section 4), before anything is hashed: rpmsign embeds the
  //    rpm's signature, then each package gets a detached <file>.asc and the dist a signed SHA256SUMS. Without a
  //    key configured the packages stay unsigned and their rows say `signed: false`.
  let signing;
  try {
    signing = signLinuxFiles({ dir: dist, files: [debName, rpmName], distro: opts.distro });
  } catch (err) {
    fail(err.message);
  }

  // 6. sha256 files and the installer manifest (over the signed bytes)
  const packages = [];
  for (const [format, file] of [
    ['deb', debName],
    ['rpm', rpmName],
  ]) {
    const path = join(dist, file);
    const digest = sha256(path);
    writeFileSync(join(dist, `${file}.sha256`), sha256Line(digest, file));
    packages.push({ format, file, size: statSync(path).size, sha256: digest });
  }
  writeFileSync(
    join(dist, 'manifest.json'),
    `${JSON.stringify(distManifest(version, packages, signing.signed), null, 2)}\n`,
  );
  const info = {
    version,
    arch: ARCH,
    packages,
    binaries: Object.fromEntries(
      BINARIES.map((n) => [
        n,
        { size: elf[n].size, sizeMiB: elf[n].sizeMiB, glibc: elf[n].glibc, needed: elf[n].needed },
      ]),
    ),
    signed: signing.signed,
    ...(signing.signed ? { signingKey: signing.key } : { unsignedReason: signing.reason }),
  };
  writeFileSync(join(out, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);

  // 7. the read-only package checks, and the T1 sandbox when asked
  let checks = 'skipped';
  if (opts.check) {
    const c = wsl(opts.distro, join(HERE, 'check-wsl.sh'), [hp(dist), debName, rpmName]);
    checks = c.status === 0 ? 'passed' : 'FAILED';
    if (c.status !== 0) process.exitCode = 1;
  }
  let sandbox = 'not run (pass --sandbox)';
  if (opts.sandbox) {
    const s = wsl(opts.distro, join(ROOT, 'agent', 'scripts', 'pkg-sandbox-test.sh'), [hp(join(dist, debName))]);
    sandbox = s.status === 0 ? 'passed' : 'FAILED';
    if (s.status !== 0) process.exitCode = 1;
  }

  console.log(`\nlinux:pkg: ${dist}`);
  for (const p of packages) console.log(`  ${p.file}  ${(p.size / 1048576).toFixed(2)} MiB  sha256 ${p.sha256}`);
  for (const n of BINARIES)
    console.log(`  ${n}: ${elf[n].sizeMiB} MiB, GLIBC ${elf[n].glibc}, NEEDED ${elf[n].needed.join(' ')}`);
  console.log(`  package checks: ${checks}; T1 sandbox: ${sandbox}`);
  console.log(
    `  installer manifest: ${join(dist, 'manifest.json')} ` +
      (signing.signed
        ? `(signed with OpenPGP key ${signing.key}: rpm embedded, .asc beside each package, SHA256SUMS.asc)`
        : `(unsigned: ${signing.reason})`),
  );
}

/** Expand a `$HOME/...` path once (wsl.exe passes arguments literally); on Linux, this process's HOME. */
function resolveWslHome(distro, p) {
  if (process.platform !== 'win32') {
    const home = process.env.HOME ?? '';
    if (!home.startsWith('/')) fail('HOME is not set');
    return home + p.slice('$HOME'.length);
  }
  const r = spawnSync('wsl.exe', ['-d', distro, '--', 'printenv', 'HOME'], { encoding: 'utf8' });
  const home = (r.stdout ?? '').trim();
  if (r.status !== 0 || !home.startsWith('/')) fail('could not read $HOME in WSL');
  return home + p.slice('$HOME'.length);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
