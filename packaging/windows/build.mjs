#!/usr/bin/env node
// Builds the IndiansAssist Agent MSI (Phase D contracts section 12.2) with WiX v5, then validates it
// with the Windows Installer ICE suite (`wix msi validate`). It never installs, repairs or removes
// the package.
//
//   node packaging/windows/build.mjs [--arch x64|arm64] [--version 0.3.0] [--placeholder]
//        [--service <exe>] [--desktop <exe>] [--watchdog <exe>] [--out <dir>] [--no-validate]
//
// Inputs (section 11.3; in CI these are the already Authenticode-signed release exes, so the
// install manifest hashes the signed bytes):
//   ia-service.exe   agent/target/<triple>/release/ia-service.exe  (crate ia-service)
//   ia-desktop.exe   agent/target/<triple>/release/ia-desktop.exe  (the C ia-agent renamed)
//   ia-watchdog.exe  agent/target/<triple>/release/ia-watchdog.exe
// (`agent/target/release/` is also searched, for a host build without --target.)
//
// --placeholder: until the ia-service crate exists, every missing exe is replaced by the Phase C
// agent release build (agent/target/.../IndiansAssist.exe, `pnpm agent:release`). The package is
// then named "...-placeholder.msi", its product name says so, and a launch condition makes it
// refuse to install: it exists to exercise the WiX authoring and the ICE validation only.
//
// Steps: build the custom-action DLL (packaging/windows/ca), stage the exes under their install
// names, write the install manifest (sha256 per exe, section 10.1), re-encode the watchdog task
// XML as UTF-16, `wix build`, `wix msi validate`, print the MSI sha256. Signing the MSI is a CI
// step after this script (docs/release.md section 3).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const TRIPLES = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };

function parseArgs(argv) {
  const opts = { arch: 'x64', placeholder: false, validate: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--arch') opts.arch = next();
    else if (a === '--version') opts.version = next();
    else if (a === '--service') opts.service = resolve(next());
    else if (a === '--desktop') opts.desktop = resolve(next());
    else if (a === '--watchdog') opts.watchdog = resolve(next());
    else if (a === '--out') opts.out = resolve(next());
    else if (a === '--placeholder') opts.placeholder = true;
    else if (a === '--no-validate') opts.validate = false;
    else if (a === '--help' || a === '-h') {
      console.log(
        readFileSync(fileURLToPath(import.meta.url), 'utf8')
          .split('\n')
          .slice(1, 20)
          .join('\n'),
      );
      process.exit(0);
    } else fail(`unknown argument ${a}`);
  }
  if (!TRIPLES[opts.arch]) fail(`--arch must be x64 or arm64, got ${opts.arch}`);
  return opts;
}

function fail(msg) {
  console.error(`packaging: ${msg}`);
  process.exit(1);
}

function tool(name, fallbacks) {
  for (const f of fallbacks) if (existsSync(f)) return f;
  return name; // rely on PATH
}

function run(cmd, args, opts = {}) {
  console.log(`> ${[cmd, ...args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  return r.status ?? 1;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** MSI ProductVersion: MAJOR.MINOR.BUILD (<256, <256, <65536); a -pre suffix is dropped. */
function productVersion(explicit) {
  let v = explicit;
  if (!v) {
    const toml = readFileSync(join(ROOT, 'agent', 'Cargo.toml'), 'utf8');
    const m = /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(toml);
    if (!m) fail('could not read [workspace.package] version from agent/Cargo.toml; pass --version');
    v = m[1];
  }
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m || +m[1] > 255 || +m[2] > 255 || +m[3] > 65535) fail(`version ${v} is not a valid MSI ProductVersion`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

function findBinary(triple, name) {
  const candidates = [
    join(ROOT, 'agent', 'target', triple, 'release', name),
    join(ROOT, 'agent', 'target', 'release', name),
  ];
  return candidates.find((p) => existsSync(p));
}

function resolvePayload(opts, triple) {
  const want = [
    ['service', 'ia-service.exe'],
    ['desktop', 'ia-desktop.exe'],
    ['watchdog', 'ia-watchdog.exe'],
  ];
  const placeholderExe = findBinary(triple, 'IndiansAssist.exe');
  const out = {};
  const substituted = [];
  for (const [key, name] of want) {
    let p = opts[key] ?? findBinary(triple, name);
    if (p && !existsSync(p)) fail(`--${key} ${p} does not exist`);
    if (!p) {
      if (!opts.placeholder) {
        fail(
          `${name} not found under agent/target/${triple}/release or agent/target/release. ` +
            `Build the service crates (section 11.1) or pass --${key} <exe>; ` +
            `use --placeholder to stand the Phase C agent in for missing binaries (validation only).`,
        );
      }
      if (!placeholderExe) fail('--placeholder needs the Phase C agent release build: run `pnpm agent:release` first');
      p = placeholderExe;
      substituted.push(name);
    }
    out[key] = p;
  }
  return { paths: out, substituted };
}

function buildCustomActionDll(triple) {
  const caDir = join(HERE, 'ca');
  const cargo = tool('cargo', [join(homedir(), '.cargo', 'bin', 'cargo.exe')]);
  // cwd = the crate, so its .cargo/config.toml (static CRT) applies.
  const status = run(cargo, ['build', '--release', '--locked', '--target', triple], { cwd: caDir });
  if (status !== 0) fail('building the custom-action DLL failed');
  const dll = join(caDir, 'target', triple, 'release', 'ia_msi_ca.dll');
  if (!existsSync(dll)) fail(`custom-action DLL missing at ${dll}`);
  return dll;
}

/** The watchdog task XML as UTF-16 LE with BOM, as schtasks /XML expects. */
function stageTaskXml(stage) {
  const src = readFileSync(join(HERE, 'watchdog-task.xml'), 'utf8').replace(
    /^<\?xml version="1.0" encoding="UTF-8"\?>/,
    '<?xml version="1.0" encoding="UTF-16"?>',
  );
  const dest = join(stage, 'watchdog-task.xml');
  writeFileSync(
    dest,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(src.replace(/\r?\n/g, '\r\n'), 'utf16le')]),
  );
  return dest;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const triple = TRIPLES[opts.arch];
  const version = productVersion(opts.version);
  const outDir = opts.out ?? join(HERE, 'out', opts.arch);
  const stage = join(outDir, 'stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const { paths, substituted } = resolvePayload(opts, triple);
  const placeholder = substituted.length > 0;
  if (placeholder) {
    console.warn(
      `packaging: PLACEHOLDER payload: ${substituted.join(', ')} replaced by the Phase C agent ` +
        `(${findBinary(triple, 'IndiansAssist.exe')}). The MSI refuses to install; validation only.`,
    );
  }

  const caDll = buildCustomActionDll(triple);

  const staged = {
    service: join(stage, 'ia-service.exe'),
    desktop: join(stage, 'ia-desktop.exe'),
    watchdog: join(stage, 'ia-watchdog.exe'),
  };
  for (const k of Object.keys(staged)) copyFileSync(paths[k], staged[k]);

  // Install manifest (section 10.1 / 10.4): what the watchdog and the integrity self-check compare
  // the installed binaries against. Hashes are of the signed exes (CI signs before this script).
  const manifest = {
    v: 1,
    version,
    arch: opts.arch,
    placeholder,
    files: Object.values(staged).map((p) => ({
      name: p.slice(stage.length + 1),
      size: statSync(p).size,
      sha256: sha256(p),
    })),
  };
  const manifestPath = join(stage, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const taskXml = stageTaskXml(stage);

  const msiName = `IndiansAssist-Agent-${version}-windows-${opts.arch}${placeholder ? '-placeholder' : ''}.msi`;
  const msi = join(outDir, msiName);
  const wix = tool('wix', [join(homedir(), '.dotnet', 'tools', 'wix.exe')]);
  const defines = {
    ProductVersion: version,
    ServiceExe: staged.service,
    DesktopExe: staged.desktop,
    WatchdogExe: staged.watchdog,
    ManifestJson: manifestPath,
    TaskXml: taskXml,
    CaDll: caDll,
    Placeholder: placeholder ? '1' : '0',
  };
  const buildArgs = ['build', join(HERE, 'IndiansAssist.wxs'), '-arch', opts.arch, '-o', msi];
  for (const [k, v] of Object.entries(defines)) buildArgs.push('-d', `${k}=${v}`);
  if (run(wix, buildArgs) !== 0) fail('wix build failed');

  let validation = 'skipped';
  if (opts.validate) {
    // ICE validation runs the package's tables through the ICE cub file; it does not install.
    const status = run(wix, ['msi', 'validate', msi]);
    validation = status === 0 ? 'passed' : `failed (exit ${status})`;
    if (status !== 0) {
      console.error('packaging: ICE validation failed');
      process.exitCode = 1;
    }
  }

  const digest = sha256(msi);
  const info = {
    msi: msiName,
    sha256: digest,
    size: statSync(msi).size,
    version,
    arch: opts.arch,
    placeholder,
    substituted,
    inputs: paths,
    validation,
    signed: false,
  };
  writeFileSync(join(outDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  console.log(
    `\npackaging: ${msi}\n  sha256 ${digest}\n  ICE validation: ${validation}${placeholder ? '\n  PLACEHOLDER payload (not installable)' : ''}`,
  );
}

main();
