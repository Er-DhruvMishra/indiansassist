// The Node side of the Linux signing seam: runs packaging/sign/sign-linux.sh (in WSL on Windows, with bash on a
// Linux runner) over files in one directory and reports whether they were signed. The release scripts call it before
// they hash the files, because the rpm's embedded signature changes its bytes (docs/release.md section 4).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPath, shellCommand } from '../linux/host.mjs';
import { linuxSigningConfig, signingWslEnv } from './sign-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Sign `files` (bare names) in `dir`. `sums` names the checksum list (default SHA256SUMS; 'none' for no list).
 * Returns `{ signed: true, key }` or `{ signed: false, reason }`; throws when signing was configured but failed.
 */
export function signLinuxFiles({
  dir,
  files,
  sums = 'SHA256SUMS',
  distro = 'Ubuntu',
  env = process.env,
  log = console.log,
}) {
  const cfg = linuxSigningConfig(env, { exists: existsSync });
  if (!cfg.ok) {
    log(`sign-linux: not signed (${cfg.reason})`);
    return { signed: false, reason: cfg.reason };
  }
  const childEnv = { ...env, IA_SIGN_SUMS: sums };
  if (process.platform === 'win32') childEnv.WSLENV = signingWslEnv(childEnv);
  const { cmd, args } = shellCommand(process.platform, distro, join(HERE, 'sign-linux.sh'), [
    hostPath(process.platform, dir),
    ...files,
  ]);
  log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env: childEnv });
  if (r.error) throw new Error(`sign-linux: ${r.error.message}`);
  process.stdout.write(r.stdout ?? '');
  if (r.status === 3) return { signed: false, reason: 'sign-linux.sh reported no key' };
  if (r.status !== 0) throw new Error(`sign-linux: signing failed (exit ${r.status})`);
  const key = /^IA_SIGNED_WITH=([0-9A-F]+)$/m.exec(r.stdout ?? '')?.[1];
  return { signed: true, key };
}

/** Run packaging/sign/verify-linux.sh over the signed files with the public key; returns whether all passed. */
export function verifyLinuxFiles({ dir, files, publicKey, distro = 'Ubuntu', log = console.log }) {
  const { cmd, args } = shellCommand(process.platform, distro, join(HERE, 'verify-linux.sh'), [
    hostPath(process.platform, dir),
    hostPath(process.platform, publicKey),
    ...files,
  ]);
  log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status === 0;
}
