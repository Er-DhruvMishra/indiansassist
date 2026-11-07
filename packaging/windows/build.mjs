#!/usr/bin/env node
// Builds the IndiansAssist Agent MSI (Phase D contracts section 12.2) with WiX v5, then validates it
// with the Windows Installer ICE suite (`wix msi validate`). It never installs, repairs or removes
// the package.
//
//   node packaging/windows/build.mjs [--arch x64|arm64] [--version 0.3.0] [--placeholder]
//        [--service <exe>] [--desktop <exe>] [--watchdog <exe>] [--out <dir>] [--no-validate]
//
// Inputs (section 11.3; the release exes, signed here as staged copies so the install manifest
// hashes the signed bytes, see "Signing" below):
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
// XML as UTF-16, `wix build`, `wix msi validate`, print the MSI sha256.
//
// Signing (docs/release.md section 4; packaging/sign/sign-windows.mjs): with IA_SIGN_PFX and its password in the
// environment, the staged exes and the custom-action DLL are Authenticode-signed (SHA-256, RFC 3161 timestamp)
// before the install manifest hashes them and before WiX packs them, and the MSI is signed after validation.
// Without them everything stays unsigned and build-info.json says so. A placeholder build is never signed.
// A real (non-placeholder) build also lays out out/dist/: the MSI and the installer manifest.json row for its arch
// (`installerDistManifestSchema`), ready to copy to AGENT_MSI_DIST_DIR.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { versionInfoProblems } from '../sign/sign-lib.mjs';
import { readVersionInfo, signWindowsFiles } from '../sign/sign-windows.mjs';

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

/** The minimum Windows of the installed agent (section 12.2; the manifest row's `minOs`). */
export const MSI_MIN_OS = '10.0.17763';

/**
 * AGENT_MSI_DIST_DIR/manifest.json after one MSI build: the earlier Windows MSI row of the same arch replaced by
 * `row`, every other row (the other arch) kept. A missing manifest (`null`) starts empty; another shape is refused.
 */
export function mergeInstallerRow(existing, row) {
  if (existing !== null && (typeof existing !== 'object' || existing.v !== 1 || !Array.isArray(existing.builds)))
    throw new Error('the existing manifest.json is not { v: 1, builds: [...] }; fix or remove it first');
  const sameSlot = (b) =>
    (b?.platform ?? 'windows') === 'windows' && (b?.format ?? 'msi') === 'msi' && b?.arch === row.arch;
  return { v: 1, builds: [...(existing?.builds ?? []).filter((b) => !sameSlot(b)), row] };
}

/** The installer dist row of a built MSI (`installerDistManifestSchema`; platform and format default). */
export function msiRow({ arch, version, size, sha256: digest, signed, file }) {
  return { arch, version, size, sha256: digest, signed, minOs: MSI_MIN_OS, file };
}

function buildCustomActionDll(triple, version) {
  const caDir = join(HERE, 'ca');
  const cargo = tool('cargo', [join(homedir(), '.cargo', 'bin', 'cargo.exe')]);
  // cwd = the crate, so its .cargo/config.toml (static CRT) applies. IA_RELEASE_VERSION puts the MSI's version in the
  // DLL's VERSIONINFO (agent/build-support/versioninfo.rs).
  const status = run(cargo, ['build', '--release', '--locked', '--target', triple], {
    cwd: caDir,
    env: { ...process.env, IA_RELEASE_VERSION: version },
  });
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

  const builtCa = buildCustomActionDll(triple, version);

  const staged = {
    service: join(stage, 'ia-service.exe'),
    desktop: join(stage, 'ia-desktop.exe'),
    watchdog: join(stage, 'ia-watchdog.exe'),
  };
  for (const k of Object.keys(staged)) copyFileSync(paths[k], staged[k]);
  // The DLL is signed as a staged copy too, so the cargo output and the agent/target exes are never modified.
  const caDll = join(stage, 'ia_msi_ca.dll');
  copyFileSync(builtCa, caDll);

  // The file metadata a signing service checks (docs/release.md section 4.4): ProductName, CompanyName and the
  // release version in every PE. A gap is a warning on a dev build and an error with IA_REQUIRE_VERSIONINFO=1 (CI).
  if (!placeholder) {
    for (const f of [staged.service, staged.desktop, staged.watchdog, caDll]) {
      const problems = versionInfoProblems(readVersionInfo(f), version);
      if (problems.length === 0) continue;
      const msg = `${f}: ${problems.join('; ')}`;
      if (process.env.IA_REQUIRE_VERSIONINFO === '1') fail(msg);
      console.warn(`packaging: warning: ${msg}`);
    }
  }

  // Sign the payload before anything hashes or packs it (docs/release.md section 4).
  let payloadSigning;
  if (placeholder) {
    payloadSigning = { signed: false, reason: 'a placeholder build is never signed' };
    console.log(`packaging: not signed (${payloadSigning.reason})`);
  } else {
    try {
      payloadSigning = signWindowsFiles([staged.service, staged.desktop, staged.watchdog, caDll], {
        description: 'IndiansAssist Agent',
      });
    } catch (err) {
      fail(err.message);
    }
  }

  // Install manifest (section 10.1 / 10.4): what the watchdog and the integrity self-check compare
  // the installed binaries against. Hashes are of the staged exes as signed just above.
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

  // The MSI's own signature, after ICE validation (the payload inside is already signed).
  let msiSigning = { signed: false, reason: payloadSigning.reason };
  if (payloadSigning.signed) {
    try {
      msiSigning = signWindowsFiles([msi], { description: 'IndiansAssist Agent installer' });
    } catch (err) {
      fail(err.message);
    }
    // With SignPath the MSI is signed by the next CI step, which then runs packaging/sign/rehash.mjs on out/dist.
    if (!msiSigning.signed && msiSigning.provider !== 'signpath')
      fail(`the payload was signed but the MSI was not: ${msiSigning.reason}`);
  }
  const signed = payloadSigning.signed && msiSigning.signed;

  // The size and sha256 of the MSI as published, i.e. after signing.
  const digest = sha256(msi);
  const size = statSync(msi).size;
  const info = {
    msi: msiName,
    sha256: digest,
    size,
    version,
    arch: opts.arch,
    placeholder,
    substituted,
    inputs: paths,
    validation,
    signed,
    ...(signed ? { signingProvider: msiSigning.provider } : { unsignedReason: msiSigning.reason }),
  };
  writeFileSync(join(outDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);

  // out/dist: the MSI and its manifest row, laid out as AGENT_MSI_DIST_DIR expects (never for a placeholder).
  let distNote = 'not laid out (placeholder)';
  if (!placeholder && validation !== 'skipped' && process.exitCode !== 1) {
    const dist = join(opts.out ?? join(HERE, 'out'), 'dist');
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
      manifest = mergeInstallerRow(
        existing,
        msiRow({ arch: opts.arch, version, size, sha256: digest, signed, file: msiName }),
      );
    } catch (err) {
      fail(err.message);
    }
    copyFileSync(msi, join(dist, msiName));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    distNote = `${dist} (copy it to AGENT_MSI_DIST_DIR)`;
  }
  console.log(
    `\npackaging: ${msi}\n  sha256 ${digest}\n  ICE validation: ${validation}` +
      `\n  signed: ${signed ? `yes (${msiSigning.provider}: exes, custom-action DLL and MSI)` : `no (${msiSigning.reason})`}` +
      `\n  dist: ${distNote}${placeholder ? '\n  PLACEHOLDER payload (not installable)' : ''}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
