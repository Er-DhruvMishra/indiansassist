#!/usr/bin/env node
// The Windows half of the release signing seam (docs/release.md section 4): Authenticode SHA-256 with an RFC 3161
// timestamp, by signtool, on PE (.exe, .dll) and MSI files, in place.
//
//   node packaging/sign/sign-windows.mjs [--require] [--verify] [--description <text>] <file>...
//   node packaging/sign/sign-windows.mjs --verify-only <file>...
//
// Keys come from the environment only (sign-lib.mjs `windowsSigningConfig`): IA_SIGN_PFX, IA_SIGN_PFX_PASSWORD or
// IA_SIGN_PFX_PASSWORD_FILE, optional IA_SIGN_TIMESTAMP_URL and IA_SIGNTOOL. Without them it prints "not signed"
// and exits 0 (the caller's manifest row keeps `signed: false`); `--require` makes that an error (CI).
// IA_SIGNING_PROVIDER=signpath signs nothing here: SignPath signs in CI (release.yml).
//
// After signing, each file is checked with Get-AuthenticodeSignature: it must carry a signer certificate and a
// timestamp, and its status must be Valid or, for the interim self-signed certificate, UnknownError (the root is not
// trusted on a machine that never imported it, which is expected; nothing is ever added to a trusted store).
// --verify also prints `signtool verify /pa /v` (which reports the untrusted root for a self-signed build).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isWindowsSignable,
  pickSigntool,
  redact,
  signtoolSignArgs,
  signtoolVerifyArgs,
  windowsSigningConfig,
} from './sign-lib.mjs';

const KITS_BIN = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';

/** signtool.exe on this machine, or null. */
export function findSigntool(env = process.env) {
  let versions = [];
  try {
    versions = readdirSync(KITS_BIN);
  } catch {
    versions = [];
  }
  return pickSigntool(env, KITS_BIN, versions, existsSync);
}

/** Get-AuthenticodeSignature of one file as { status, signer, thumbprint, timestamper }. */
export function inspectAuthenticode(file) {
  const script = [
    '$s = Get-AuthenticodeSignature -LiteralPath $env:IA_INSPECT_FILE;',
    '[pscustomobject]@{ status = [string]$s.Status;',
    '  signer = $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null });',
    '  thumbprint = $(if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { $null });',
    '  timestamper = $(if ($s.TimeStamperCertificate) { $s.TimeStamperCertificate.Subject } else { $null }) }',
    '| ConvertTo-Json -Compress',
  ].join(' ');
  return JSON.parse(windowsPowerShell(script, file, 'Get-AuthenticodeSignature'));
}

/**
 * Windows PowerShell 5.1 environment for one inspection: PSModulePath is dropped, because a parent PowerShell 7 (the
 * GitHub runner's `pwsh` steps) puts its own module folders there and 5.1 then loads the 7.x
 * Microsoft.PowerShell.Security, whose cmdlets fail with a non-terminating error and an exit code of 0.
 */
export function inspectionEnv(env, file) {
  const out = { ...env, IA_INSPECT_FILE: file };
  for (const k of Object.keys(out)) if (k.toLowerCase() === 'psmodulepath') delete out[k];
  return out;
}

function windowsPowerShell(script, file, what) {
  // Stop makes a cmdlet error terminating (exit 1) instead of empty fields and exit 0; progress records would only
  // reach stderr as CLIXML noise.
  const guarded = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${script}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', guarded], {
    encoding: 'utf8',
    env: inspectionEnv(process.env, file),
  });
  if (r.status !== 0) throw new Error(`${what} failed for ${file}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A PE's version resource as FileVersionInfo reads it: { productName, companyName, fileVersion, productVersion }. */
export function readVersionInfo(file) {
  const script = [
    '$v = (Get-Item -LiteralPath $env:IA_INSPECT_FILE).VersionInfo;',
    '[pscustomobject]@{ productName = $v.ProductName; companyName = $v.CompanyName;',
    '  fileVersion = $v.FileVersion; productVersion = $v.ProductVersion;',
    '  fileDescription = $v.FileDescription; originalFilename = $v.OriginalFilename } | ConvertTo-Json -Compress',
  ].join(' ');
  return JSON.parse(windowsPowerShell(script, file, 'reading the version resource'));
}

/** Whether an inspected signature is acceptable for the provider's chain (see the header). */
export function acceptable(info) {
  return (
    (info.status === 'Valid' || info.status === 'UnknownError') &&
    typeof info.signer === 'string' &&
    typeof info.timestamper === 'string'
  );
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Sign `files` in place. Returns `{ signed: true, provider }` or `{ signed: false, provider, reason }` when the
 * keys are absent or the provider signs elsewhere; throws when signing was configured but failed.
 */
export function signWindowsFiles(files, { env = process.env, description = 'IndiansAssist', log = console.log } = {}) {
  if (files.length === 0) return { signed: false, provider: 'selfsigned', reason: 'no files' };
  for (const f of files) {
    if (!isWindowsSignable(f)) throw new Error(`sign-windows: not a PE or MSI file: ${f}`);
    if (!existsSync(f)) throw new Error(`sign-windows: ${f} does not exist`);
  }
  const cfg = windowsSigningConfig(env, { exists: existsSync, readFile: (p) => readFileSync(p, 'utf8') });
  if (!cfg.ok && cfg.provider === 'signpath' && process.platform === 'win32') {
    // SignPath signs in CI before this runs (release.yml); accept files that already carry a trusted, timestamped
    // signature, and sign nothing ourselves.
    const infos = files.map((f) => inspectAuthenticode(f));
    if (infos.every((i) => i.status === 'Valid' && typeof i.timestamper === 'string')) {
      for (const [i, f] of files.entries())
        log(`sign-windows: ${f}: already signed by "${infos[i].signer}" (signpath)`);
      return { signed: true, provider: 'signpath' };
    }
  }
  if (!cfg.ok) {
    log(`sign-windows: not signed (${cfg.reason})`);
    return { signed: false, provider: cfg.provider, reason: cfg.reason };
  }
  if (process.platform !== 'win32') throw new Error('sign-windows: signtool runs on Windows only');
  const signtool = findSigntool(env);
  if (!signtool) throw new Error('sign-windows: signtool.exe not found (Windows SDK); set IA_SIGNTOOL');
  const args = signtoolSignArgs(cfg, files, description);
  log(`> ${[signtool, ...redact(args, cfg.password)].join(' ')}`);
  let status = 1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync(signtool, args, { stdio: 'inherit' });
    if (r.error) throw new Error(`sign-windows: ${r.error.message}`);
    status = r.status ?? 1;
    if (status === 0) break;
    log(`sign-windows: signtool exited ${status} (attempt ${attempt} of 3; the timestamp server may be busy)`);
    if (attempt < 3) sleep(5000 * attempt);
  }
  if (status !== 0) throw new Error(`sign-windows: signtool failed (exit ${status})`);
  for (const f of files) {
    const info = inspectAuthenticode(f);
    log(`sign-windows: ${f}: ${info.status}, signer "${info.signer}", timestamp by "${info.timestamper}"`);
    if (!acceptable(info)) throw new Error(`sign-windows: ${f} does not carry a timestamped signature after signing`);
  }
  return { signed: true, provider: cfg.provider };
}

/** `signtool verify /pa /v` and Get-AuthenticodeSignature, printed; returns whether every file is acceptable. */
export function verifyWindowsFiles(files, { env = process.env, log = console.log } = {}) {
  const signtool = findSigntool(env);
  let ok = true;
  for (const f of files) {
    if (signtool) {
      const r = spawnSync(signtool, signtoolVerifyArgs([f]), { encoding: 'utf8' });
      log(`> signtool verify /pa /v ${f} (exit ${r.status})`);
      log(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim());
    }
    const info = inspectAuthenticode(f);
    log(`Get-AuthenticodeSignature ${f}: ${JSON.stringify(info)}`);
    if (!acceptable(info)) ok = false;
  }
  return ok;
}

function main(argv) {
  const files = [];
  let mustSign = false;
  let verify = false;
  let verifyOnly = false;
  let description = 'IndiansAssist';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--require') mustSign = true;
    else if (a === '--verify') verify = true;
    else if (a === '--verify-only') verifyOnly = true;
    else if (a === '--description') description = argv[++i] ?? description;
    else if (a.startsWith('--')) {
      console.error(`sign-windows: unknown argument ${a}`);
      process.exit(2);
    } else files.push(resolve(a));
  }
  if (files.length === 0) {
    console.error('usage: sign-windows.mjs [--require] [--verify] [--description <text>] <file>...');
    process.exit(2);
  }
  if (verifyOnly) process.exit(verifyWindowsFiles(files) ? 0 : 1);
  let res;
  try {
    res = signWindowsFiles(files, { description });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!res.signed && mustSign) {
    console.error(`sign-windows: --require: ${res.reason}`);
    process.exit(1);
  }
  if (res.signed && verify && !verifyWindowsFiles(files)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
