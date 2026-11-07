// The pure half of the release signing seam (docs/release.md section 4): which provider signs, whether the keys are
// there, the signtool command line, the manifest `signed` rows and the SHA256SUMS text. No file is read or written
// and no process is started here, so every rule is unit-tested (scripts/test/signing.test.mjs).
//
// Providers (IA_SIGNING_PROVIDER, per platform IA_SIGNING_PROVIDER_WINDOWS / IA_SIGNING_PROVIDER_LINUX first):
//   selfsigned  (default) the interim keys: a self-signed Authenticode PFX for Windows, a self-managed OpenPGP key
//               for Linux. Keys come from the environment only; without them the artefact stays `signed: false`.
//   signpath    the SignPath Foundation certificate. Signing then happens in CI, in the SignPath step of
//               .github/workflows/release.yml (signpath/github-action-submit-signing-request); the local seam
//               signs nothing and says so. This is the stub to fill in at the switch-over.

/** The two providers. */
export const PROVIDERS = Object.freeze(['selfsigned', 'signpath']);

/** A free public RFC 3161 time-stamping authority (no account; nothing personal is sent). */
export const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';

/** The CI action that replaces the local Windows seam once the SignPath certificate exists. */
export const SIGNPATH_ACTION = 'signpath/github-action-submit-signing-request';

export const SIGNPATH_STUB_MESSAGE =
  'IA_SIGNING_PROVIDER=signpath: not signed here. SignPath signs in CI only, in the "SignPath" step of ' +
  `.github/workflows/release.yml (${SIGNPATH_ACTION}), after the release-signing approval; see docs/release.md ` +
  'section 4.7.';

/**
 * The provider for `platform` ('windows' or 'linux'): `IA_SIGNING_PROVIDER_<PLATFORM>`, else `IA_SIGNING_PROVIDER`,
 * else `selfsigned`. An unknown value throws, so a typo never silently ships unsigned files.
 */
export function signingProvider(env, platform) {
  const specific = platform ? env[`IA_SIGNING_PROVIDER_${platform.toUpperCase()}`] : undefined;
  const raw = String(specific ?? env.IA_SIGNING_PROVIDER ?? '')
    .trim()
    .toLowerCase();
  const value = raw === '' ? 'selfsigned' : raw;
  if (!PROVIDERS.includes(value)) {
    throw new Error(`IA_SIGNING_PROVIDER must be one of ${PROVIDERS.join(', ')}, got "${value}"`);
  }
  return value;
}

/**
 * Whether Windows signing can run, and with what. `io.exists(path)` and `io.readFile(path)` are injected.
 *   env: IA_SIGN_PFX               the PFX path (required)
 *        IA_SIGN_PFX_PASSWORD      its password, or IA_SIGN_PFX_PASSWORD_FILE, a file holding it (one is required)
 *        IA_SIGN_TIMESTAMP_URL     an RFC 3161 TSA (default DEFAULT_TIMESTAMP_URL)
 * Returns `{ ok: true, provider, pfx, password, timestampUrl }` or `{ ok: false, provider, reason }`.
 */
export function windowsSigningConfig(env, io) {
  const provider = signingProvider(env, 'windows');
  if (provider === 'signpath') return { ok: false, provider, reason: SIGNPATH_STUB_MESSAGE };
  const pfx = (env.IA_SIGN_PFX ?? '').trim();
  if (pfx === '') return { ok: false, provider, reason: 'IA_SIGN_PFX is not set' };
  if (!io.exists(pfx)) return { ok: false, provider, reason: `IA_SIGN_PFX ${pfx} does not exist` };
  let password = env.IA_SIGN_PFX_PASSWORD ?? '';
  const pwFile = (env.IA_SIGN_PFX_PASSWORD_FILE ?? '').trim();
  if (password === '' && pwFile !== '') {
    if (!io.exists(pwFile))
      return { ok: false, provider, reason: `IA_SIGN_PFX_PASSWORD_FILE ${pwFile} does not exist` };
    password = String(io.readFile(pwFile)).replace(/\r?\n$/, '');
  }
  if (password === '') {
    return { ok: false, provider, reason: 'IA_SIGN_PFX_PASSWORD (or IA_SIGN_PFX_PASSWORD_FILE) is not set' };
  }
  const timestampUrl = (env.IA_SIGN_TIMESTAMP_URL ?? '').trim() || DEFAULT_TIMESTAMP_URL;
  if (!/^https?:\/\/[^\s"]+$/.test(timestampUrl)) {
    return { ok: false, provider, reason: `IA_SIGN_TIMESTAMP_URL ${timestampUrl} is not an http(s) URL` };
  }
  return { ok: true, provider, pfx, password, timestampUrl };
}

/**
 * Whether Linux (OpenPGP) signing can run.
 *   env: IA_GPG_HOME              the GNUPGHOME holding the secret key (required; never ~/.gnupg by default)
 *        IA_GPG_KEY               the key fingerprint (optional: the only secret key in IA_GPG_HOME)
 *        IA_GPG_PASSPHRASE_FILE   a file holding the passphrase, or IA_GPG_PASSPHRASE the value (optional)
 * Returns `{ ok: true, provider }` or `{ ok: false, provider, reason }`.
 */
export function linuxSigningConfig(env, io) {
  const provider = signingProvider(env, 'linux');
  if (provider === 'signpath') return { ok: false, provider, reason: SIGNPATH_STUB_MESSAGE };
  const home = (env.IA_GPG_HOME ?? '').trim();
  if (home === '') return { ok: false, provider, reason: 'IA_GPG_HOME is not set' };
  if (!io.exists(home)) return { ok: false, provider, reason: `IA_GPG_HOME ${home} does not exist` };
  const pf = (env.IA_GPG_PASSPHRASE_FILE ?? '').trim();
  if (pf !== '' && !io.exists(pf))
    return { ok: false, provider, reason: `IA_GPG_PASSPHRASE_FILE ${pf} does not exist` };
  const key = (env.IA_GPG_KEY ?? '').trim();
  if (key !== '' && !/^[0-9A-Fa-f]{16,40}$/.test(key)) {
    return { ok: false, provider, reason: 'IA_GPG_KEY must be a key id or fingerprint (hex)' };
  }
  return { ok: true, provider };
}

/**
 * WSLENV for the Linux seam run through wsl.exe: the two paths translated (`/p`), the other values passed as is.
 * Earlier entries for the same names are replaced; unrelated ones are kept.
 */
export function signingWslEnv(env) {
  const wanted = [
    ['IA_GPG_HOME', '/p'],
    ['IA_GPG_PASSPHRASE_FILE', '/p'],
    ['IA_GPG_PASSPHRASE', ''],
    ['IA_GPG_KEY', ''],
    ['IA_SIGN_SUMS', ''],
    ['IA_SIGNING_PROVIDER', ''],
    ['IA_SIGNING_PROVIDER_LINUX', ''],
  ].filter(([n]) => (env[n] ?? '') !== '');
  const names = wanted.map(([n]) => n);
  const prior = (env.WSLENV ?? '').split(':').filter((s) => s !== '' && !names.includes(s.split('/')[0]));
  return [...prior, ...wanted.map(([n, f]) => `${n}${f}`)].join(':');
}

/** PE and MSI files signtool signs here. */
export function isWindowsSignable(file) {
  return /\.(exe|dll|msi)$/i.test(file);
}

/**
 * The newest x64 signtool.exe under a Windows Kits `bin` directory, given its sub-directory names; `null` if none.
 * `exists(path)` is injected. IA_SIGNTOOL (an explicit path) wins when set.
 */
export function pickSigntool(env, kitsBin, versions, exists) {
  const explicit = (env.IA_SIGNTOOL ?? '').trim();
  if (explicit !== '') return exists(explicit) ? explicit : null;
  const numeric = versions
    .filter((v) => /^\d+(\.\d+){3}$/.test(v))
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
  for (const v of numeric) {
    const p = `${kitsBin}\\${v}\\x64\\signtool.exe`;
    if (exists(p)) return p;
  }
  const flat = `${kitsBin}\\x64\\signtool.exe`;
  return exists(flat) ? flat : null;
}

/** `signtool sign` arguments: SHA-256 file digest, RFC 3161 timestamp with a SHA-256 digest, the PFX. */
export function signtoolSignArgs(cfg, files, description = 'IndiansAssist') {
  if (files.length === 0) throw new Error('nothing to sign');
  for (const f of files) if (!isWindowsSignable(f)) throw new Error(`not a PE or MSI file: ${f}`);
  return [
    'sign',
    '/fd',
    'SHA256',
    '/f',
    cfg.pfx,
    '/p',
    cfg.password,
    '/tr',
    cfg.timestampUrl,
    '/td',
    'SHA256',
    '/d',
    description,
    ...files,
  ];
}

/** `signtool verify` arguments: the Authenticode policy, verbose (prints the signer and the timestamp). */
export function signtoolVerifyArgs(files) {
  return ['verify', '/pa', '/v', ...files];
}

/** The same arguments with the secret replaced, for the log. */
export function redact(args, secret) {
  return secret ? args.map((a) => (a === secret ? '***' : a)) : [...args];
}

/**
 * The manifest with `signed: true` on every row whose file is in `signedFiles` (bare names). Rows of other files keep
 * their value. `fileOf(row)` names a row's file when it has no `file` field. No `signature` field is added: the
 * shared dist schemas (`agentDistManifestSchema`, `installerDistManifestSchema`) are strict and have none, so a
 * detached signature sits beside its file as `<file>.asc` by convention.
 */
export function markSigned(manifest, signedFiles, fileOf) {
  const set = new Set(signedFiles);
  return {
    ...manifest,
    builds: manifest.builds.map((b) => {
      const file = b.file ?? fileOf?.(b);
      return file !== undefined && set.has(file) ? { ...b, signed: true } : b;
    }),
  };
}

/** The Windows file metadata every release PE carries (agent/build-support/versioninfo.rs). */
export const VERSION_INFO = Object.freeze({ productName: 'IndiansAssist', companyName: 'IndiansAssist Project' });

/**
 * What is wrong with a PE's version resource (`{ productName, companyName, fileVersion, productVersion }`, as
 * FileVersionInfo reports it) for release `version`: an empty list when it is right.
 */
export function versionInfoProblems(info, version) {
  const problems = [];
  if (info.productName !== VERSION_INFO.productName)
    problems.push(`ProductName is "${info.productName ?? ''}", not "${VERSION_INFO.productName}"`);
  if (info.companyName !== VERSION_INFO.companyName)
    problems.push(`CompanyName is "${info.companyName ?? ''}", not "${VERSION_INFO.companyName}"`);
  if (info.fileVersion !== version) problems.push(`FileVersion is "${info.fileVersion ?? ''}", not "${version}"`);
  if (info.productVersion !== version)
    problems.push(`ProductVersion is "${info.productVersion ?? ''}", not "${version}"`);
  return problems;
}

/** `sha256sum` text over `entries` ({ name, sha256 }), sorted by name, so `sha256sum -c SHA256SUMS` checks them. */
export function sha256sums(entries) {
  for (const e of entries) {
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(`bad sha256 for ${e.name}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.name)) throw new Error(`not a bare file name: ${e.name}`);
  }
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.name}\n`)
    .join('');
}
