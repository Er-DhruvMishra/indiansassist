// The release signing seam (packaging/sign, docs/release.md section 4): the pure rules (provider switch, key
// handling from the environment, the signtool command line, the manifest `signed` rows against the real shared
// schemas, SHA256SUMS), that nothing is signed without keys, the shell halves as text, the public keys in site/keys,
// the VERSIONINFO build scripts, and the CI workflows parsed (actions pinned by SHA, least privilege, the approval
// environment). Nothing here signs a file or touches a key.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { linuxDistRow } from '../../packaging/linux/agent-release.mjs';
import { distManifest } from '../../packaging/linux/build.mjs';
import { hostPath, shellCommand } from '../../packaging/linux/host.mjs';
import {
  DEFAULT_TIMESTAMP_URL,
  SIGNPATH_ACTION,
  isWindowsSignable,
  linuxSigningConfig,
  markSigned,
  pickSigntool,
  redact,
  sha256sums,
  signingProvider,
  signingWslEnv,
  signtoolSignArgs,
  signtoolVerifyArgs,
  versionInfoProblems,
  windowsSigningConfig,
} from '../../packaging/sign/sign-lib.mjs';
import { signLinuxFiles } from '../../packaging/sign/sign-linux.mjs';
import { acceptable, inspectionEnv, signWindowsFiles } from '../../packaging/sign/sign-windows.mjs';
import { rehashManifest } from '../../packaging/sign/rehash.mjs';
import { MSI_MIN_OS, mergeInstallerRow, msiRow } from '../../packaging/windows/build.mjs';
import { updateSignedList, windowsDistFileName } from '../agent-release-windows.mjs';
import { loadShared } from '../smoke/shared.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const HEX = 'ab'.repeat(32);
const yes = () => true;
const no = () => false;

let shared;
beforeAll(async () => {
  shared = await loadShared();
});

describe('the provider switch', () => {
  it('defaults to selfsigned and reads the per-platform variable first', () => {
    expect(signingProvider({}, 'windows')).toBe('selfsigned');
    expect(signingProvider({ IA_SIGNING_PROVIDER: ' SignPath ' }, 'windows')).toBe('signpath');
    expect(signingProvider({ IA_SIGNING_PROVIDER: 'signpath', IA_SIGNING_PROVIDER_LINUX: 'selfsigned' }, 'linux')).toBe(
      'selfsigned',
    );
    expect(signingProvider({ IA_SIGNING_PROVIDER: '' }, 'linux')).toBe('selfsigned');
  });

  it('refuses an unknown provider rather than ship unsigned files', () => {
    expect(() => signingProvider({ IA_SIGNING_PROVIDER: 'azure' }, 'windows')).toThrow(/selfsigned, signpath/);
  });
});

describe('Windows keys come from the environment only', () => {
  const io = (files = {}) => ({ exists: (p) => p in files, readFile: (p) => files[p] });

  it('is not configured without IA_SIGN_PFX, with a missing file, or without a password', () => {
    expect(windowsSigningConfig({}, io())).toMatchObject({ ok: false, reason: 'IA_SIGN_PFX is not set' });
    expect(windowsSigningConfig({ IA_SIGN_PFX: 'C:\\k.pfx' }, io()).reason).toMatch(/does not exist/);
    expect(windowsSigningConfig({ IA_SIGN_PFX: 'C:\\k.pfx' }, io({ 'C:\\k.pfx': 'x' })).reason).toMatch(
      /IA_SIGN_PFX_PASSWORD/,
    );
  });

  it('takes the password from the variable or from a file, and the default TSA', () => {
    const files = { 'C:\\k.pfx': 'x', 'C:\\pw.txt': 's3cret\r\n' };
    expect(windowsSigningConfig({ IA_SIGN_PFX: 'C:\\k.pfx', IA_SIGN_PFX_PASSWORD: 'p' }, io(files))).toEqual({
      ok: true,
      provider: 'selfsigned',
      pfx: 'C:\\k.pfx',
      password: 'p',
      timestampUrl: DEFAULT_TIMESTAMP_URL,
    });
    const viaFile = windowsSigningConfig(
      { IA_SIGN_PFX: 'C:\\k.pfx', IA_SIGN_PFX_PASSWORD_FILE: 'C:\\pw.txt' },
      io(files),
    );
    expect(viaFile.password).toBe('s3cret');
    expect(DEFAULT_TIMESTAMP_URL).toBe('http://timestamp.digicert.com');
  });

  it('refuses a timestamp URL that is not http(s)', () => {
    const r = windowsSigningConfig(
      { IA_SIGN_PFX: 'k', IA_SIGN_PFX_PASSWORD: 'p', IA_SIGN_TIMESTAMP_URL: 'file:///x' },
      io({ k: 'x' }),
    );
    expect(r.ok).toBe(false);
  });

  it('signs nothing locally under signpath, and names the CI action', () => {
    const r = windowsSigningConfig(
      { IA_SIGNING_PROVIDER: 'signpath', IA_SIGN_PFX: 'k', IA_SIGN_PFX_PASSWORD: 'p' },
      io({ k: 'x' }),
    );
    expect(r).toMatchObject({ ok: false, provider: 'signpath' });
    expect(r.reason).toContain(SIGNPATH_ACTION);
    expect(SIGNPATH_ACTION).toBe('signpath/github-action-submit-signing-request');
  });
});

describe('the Windows PowerShell 5.1 inspection environment', () => {
  it('drops PSModulePath in any casing (a parent pwsh 7 would load its own Security module) and passes the file', () => {
    const env = inspectionEnv({ PSModulePath: 'C:\\pwsh7\\Modules', psmodulepath: 'x', PATH: 'C:\\bin' }, 'C:\\a.exe');
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'psmodulepath')).toEqual([]);
    expect(env.PATH).toBe('C:\\bin');
    expect(env.IA_INSPECT_FILE).toBe('C:\\a.exe');
  });
});

describe('refusing to sign without keys', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('a Windows file stays unsigned, untouched, and no signtool runs', () => {
    dir = mkdtempSync(join(tmpdir(), 'ia-sign-'));
    const f = join(dir, 'IndiansAssist.exe');
    writeFileSync(f, 'MZ not really');
    const logs = [];
    const r = signWindowsFiles([f], { env: {}, log: (m) => logs.push(m) });
    expect(r).toMatchObject({ signed: false, reason: 'IA_SIGN_PFX is not set' });
    expect(logs.join('\n')).toMatch(/not signed/);
    expect(readFileSync(f, 'utf8')).toBe('MZ not really');
  });

  it('a non-PE file is refused outright', () => {
    expect(() => signWindowsFiles(['a.txt'], { env: {} })).toThrow(/not a PE or MSI/);
  });

  it('Linux files stay unsigned without IA_GPG_HOME, and no shell runs', () => {
    const logs = [];
    const r = signLinuxFiles({ dir: tmpdir(), files: ['x.deb'], env: {}, log: (m) => logs.push(m) });
    expect(r).toEqual({ signed: false, reason: 'IA_GPG_HOME is not set' });
    expect(logs.join('\n')).toMatch(/not signed/);
  });

  it('the Linux config checks the home, the passphrase file and the key id', () => {
    expect(linuxSigningConfig({ IA_GPG_HOME: '/nope' }, { exists: no }).reason).toMatch(/does not exist/);
    expect(linuxSigningConfig({ IA_GPG_HOME: '/g', IA_GPG_KEY: 'not-hex' }, { exists: yes }).ok).toBe(false);
    expect(
      linuxSigningConfig(
        { IA_GPG_HOME: '/g', IA_GPG_KEY: '43848FFFF2479CE0DE28CD4FC6E3E6E839D60661' },
        { exists: yes },
      ),
    ).toEqual({ ok: true, provider: 'selfsigned' });
    expect(linuxSigningConfig({ IA_GPG_HOME: '/g', IA_SIGNING_PROVIDER: 'signpath' }, { exists: yes }).ok).toBe(false);
  });

  it('passes the key paths into WSL translated, and keeps unrelated WSLENV entries', () => {
    expect(signingWslEnv({})).toBe('');
    expect(
      signingWslEnv({
        WSLENV: 'FOO/p:IA_GPG_HOME/u',
        IA_GPG_HOME: 'C:\\g',
        IA_GPG_PASSPHRASE_FILE: 'C:\\p',
        IA_SIGN_SUMS: 'S',
      }),
    ).toBe('FOO/p:IA_GPG_HOME/p:IA_GPG_PASSPHRASE_FILE/p:IA_SIGN_SUMS');
  });
});

describe('the signtool command line', () => {
  const cfg = { pfx: 'C:\\k.pfx', password: 'pw', timestampUrl: DEFAULT_TIMESTAMP_URL };

  it('is SHA-256 with an RFC 3161 SHA-256 timestamp and the PFX', () => {
    const args = signtoolSignArgs(cfg, ['a.exe', 'b.msi', 'c.dll']);
    expect(args.slice(0, 13)).toEqual([
      'sign',
      '/fd',
      'SHA256',
      '/f',
      'C:\\k.pfx',
      '/p',
      'pw',
      '/tr',
      DEFAULT_TIMESTAMP_URL,
      '/td',
      'SHA256',
      '/d',
      'IndiansAssist',
    ]);
    expect(args.slice(13)).toEqual(['a.exe', 'b.msi', 'c.dll']);
    expect(() => signtoolSignArgs(cfg, [])).toThrow();
    expect(() => signtoolSignArgs(cfg, ['a.zip'])).toThrow();
    expect(signtoolVerifyArgs(['a.exe'])).toEqual(['verify', '/pa', '/v', 'a.exe']);
    expect(redact(args, 'pw')).not.toContain('pw');
    expect(isWindowsSignable('X.MSI')).toBe(true);
    expect(isWindowsSignable('x.ps1')).toBe(false);
  });

  it('finds the newest x64 signtool, or the explicit one', () => {
    const bin = 'C:\\Kits\\bin';
    const have = new Set([`${bin}\\10.0.17134.0\\x64\\signtool.exe`, `${bin}\\10.0.26100.0\\x64\\signtool.exe`]);
    const exists = (p) => have.has(p);
    expect(pickSigntool({}, bin, ['10.0.17134.0', 'x64', '10.0.26100.0', '10.0.22000.0'], exists)).toBe(
      `${bin}\\10.0.26100.0\\x64\\signtool.exe`,
    );
    expect(pickSigntool({}, bin, [], exists)).toBeNull();
    expect(pickSigntool({ IA_SIGNTOOL: 'D:\\s.exe' }, bin, [], (p) => p === 'D:\\s.exe')).toBe('D:\\s.exe');
  });

  it('accepts a timestamped signature that is valid, or self-signed (untrusted root), and nothing else', () => {
    const base = { signer: 'CN=IndiansAssist (self-signed), O=IndiansAssist Project', timestamper: 'CN=TSA' };
    expect(acceptable({ ...base, status: 'UnknownError' })).toBe(true);
    expect(acceptable({ ...base, status: 'Valid' })).toBe(true);
    expect(acceptable({ ...base, status: 'HashMismatch' })).toBe(false);
    expect(acceptable({ ...base, status: 'NotSigned' })).toBe(false);
    expect(acceptable({ ...base, status: 'Valid', timestamper: null })).toBe(false);
  });
});

describe('the manifest rows (strict shared schemas)', () => {
  it('Linux packages carry signed: true only when signed, and the schema takes both', () => {
    const pkgs = [
      { format: 'deb', size: 1, sha256: HEX, file: 'IndiansAssist-Agent-0.3.0-linux-x64.deb' },
      { format: 'rpm', size: 2, sha256: HEX, file: 'IndiansAssist-Agent-0.3.0-linux-x64.rpm' },
    ];
    expect(distManifest('0.3.0', pkgs).builds.every((b) => b.signed === false)).toBe(true);
    const signed = distManifest('0.3.0', pkgs, true);
    expect(signed.builds.every((b) => b.signed === true)).toBe(true);
    expect(shared.installerDistManifestSchema.safeParse(signed).success).toBe(true);
  });

  it('the Linux portable row carries signed, and the agent schema takes it', () => {
    const row = linuxDistRow('0.3.0', { size: 1, sha256: HEX }, { size: 2, sha256: HEX }, true);
    expect(row.signed).toBe(true);
    expect(shared.agentDistManifestSchema.safeParse({ v: 1, builds: [row] }).success).toBe(true);
    expect(linuxDistRow('0.3.0', { size: 1, sha256: HEX }, { size: 2, sha256: HEX }).signed).toBe(false);
  });

  it('the schemas have no signature field, so none is written (the .asc sits beside its file)', () => {
    const row = linuxDistRow('0.3.0', { size: 1, sha256: HEX }, { size: 2, sha256: HEX }, true);
    expect(shared.agentDistManifestSchema.safeParse({ v: 1, builds: [{ ...row, signature: 'x.asc' }] }).success).toBe(
      false,
    );
    const msi = msiRow({ arch: 'x64', version: '0.3.0', size: 3, sha256: HEX, signed: true, file: 'a.msi' });
    expect(
      shared.installerDistManifestSchema.safeParse({ v: 1, builds: [{ ...msi, signature: 'a.msi.asc' }] }).success,
    ).toBe(false);
  });

  it('the MSI row merges per arch and the installer schema takes it', () => {
    const x64 = msiRow({
      arch: 'x64',
      version: '0.3.0',
      size: 3,
      sha256: HEX,
      signed: true,
      file: 'IndiansAssist-Agent-0.3.0-windows-x64.msi',
    });
    expect(x64.minOs).toBe(MSI_MIN_OS);
    const arm = { ...x64, arch: 'arm64', file: 'IndiansAssist-Agent-0.3.0-windows-arm64.msi', signed: false };
    const old = { ...x64, version: '0.2.0', signed: false };
    const m = mergeInstallerRow({ v: 1, builds: [old, arm] }, x64);
    expect(m.builds.map((b) => `${b.arch}:${b.version}:${b.signed}`)).toEqual(['arm64:0.3.0:false', 'x64:0.3.0:true']);
    expect(shared.installerDistManifestSchema.safeParse(m).success).toBe(true);
    expect(mergeInstallerRow(null, x64).builds).toHaveLength(1);
    expect(() => mergeInstallerRow({ v: 2 }, x64)).toThrow();
  });

  it('markSigned flips only the named files; rehash re-measures named rows', () => {
    const m = {
      v: 1,
      builds: [
        {
          platform: 'windows',
          arch: 'x64',
          version: '0.3.0',
          size: 1,
          sha256: HEX,
          signed: false,
          minOs: '10.0.17763',
        },
        { platform: 'macos', arch: 'arm64', version: '0.3.0', size: 1, sha256: HEX, signed: false, minOs: '12.3' },
      ],
    };
    const out = markSigned(m, ['IndiansAssist-windows-x64-0.3.0.exe'], (b) =>
      shared.agentDistFileName(b.platform, b.arch, b.version),
    );
    expect(out.builds.map((b) => b.signed)).toEqual([true, false]);
    expect(m.builds[0].signed).toBe(false);
    const re = rehashManifest(
      {
        v: 1,
        builds: [
          { arch: 'x64', file: 'a.msi', size: 1, sha256: HEX, signed: false },
          { arch: 'arm64', size: 9, sha256: HEX },
        ],
      },
      () => ({ size: 5, sha256: 'cd'.repeat(32) }),
      () => true,
    );
    expect(re.builds[0]).toMatchObject({ size: 5, sha256: 'cd'.repeat(32), signed: true });
    expect(re.builds[1]).toEqual({ arch: 'arm64', size: 9, sha256: HEX });
  });

  it('the portable Windows publish keeps manifest.signed.json in step with the signing', () => {
    const name = windowsDistFileName('x64', '0.3.0');
    expect(name).toBe('IndiansAssist-windows-x64-0.3.0.exe');
    expect(name).toBe(shared.agentDistFileName('windows', 'x64', '0.3.0'));
    expect(updateSignedList(['b.exe', 7], name, true)).toEqual([name, 'b.exe']);
    expect(updateSignedList([name, 'b.exe'], name, false)).toEqual(['b.exe']);
    expect(updateSignedList(null, name, true)).toEqual([name]);
  });

  it('SHA256SUMS is sorted sha256sum text over bare names', () => {
    expect(
      sha256sums([
        { name: 'b.rpm', sha256: HEX },
        { name: 'a.deb', sha256: 'cd'.repeat(32) },
      ]),
    ).toBe(`${'cd'.repeat(32)}  a.deb\n${HEX}  b.rpm\n`);
    expect(() => sha256sums([{ name: '../x', sha256: HEX }])).toThrow();
    expect(() => sha256sums([{ name: 'x', sha256: 'zz' }])).toThrow();
  });
});

describe('Windows file metadata (agent/build-support/versioninfo.rs)', () => {
  it('names a gap per field', () => {
    const good = {
      productName: 'IndiansAssist',
      companyName: 'IndiansAssist Project',
      fileVersion: '0.3.0',
      productVersion: '0.3.0',
    };
    expect(versionInfoProblems(good, '0.3.0')).toEqual([]);
    expect(versionInfoProblems({}, '0.3.0')).toHaveLength(4);
    expect(versionInfoProblems({ ...good, productVersion: '0.2.0' }, '0.3.0')).toEqual([
      'ProductVersion is "0.2.0", not "0.3.0"',
    ]);
  });

  it('every Windows binary has the build script, and the resource carries the release fields', () => {
    for (const c of ['ia-agent', 'ia-desktop', 'ia-service', 'ia-watchdog']) {
      expect(read('agent', 'crates', c, 'build.rs')).toContain('include!("../../build-support/versioninfo.rs")');
    }
    expect(read('packaging', 'windows', 'ca', 'build.rs')).toContain(
      'include!("../../../agent/build-support/versioninfo.rs")',
    );
    const rs = read('agent', 'build-support', 'versioninfo.rs');
    for (const v of [
      'ProductName\\", \\"IndiansAssist\\"',
      'CompanyName\\", \\"IndiansAssist Project\\"',
      'FileVersion',
      'ProductVersion',
    ])
      expect(rs).toContain(v);
    expect(rs).toContain('IA_REQUIRE_VERSIONINFO');
    const wxs = read('packaging', 'windows', 'IndiansAssist.wxs');
    expect(wxs).toMatch(/Manufacturer="IndiansAssist Project"/);
    expect(wxs).toMatch(/Version="\$\(var\.ProductVersion\)"/);
  });
});

describe('the shell halves, as text', () => {
  const signSh = read('packaging', 'sign', 'sign-linux.sh');
  const verifySh = read('packaging', 'sign', 'verify-linux.sh');

  it('are LF bash and never use the default keyring', () => {
    for (const s of [signSh, verifySh]) {
      expect(s.startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(s).not.toMatch(/\r/);
      const code = s
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(code).not.toMatch(/~\/\.gnupg|\$HOME\/\.gnupg|\bsudo\b|apt-get|apt install/);
    }
    expect(signSh).toMatch(/export GNUPGHOME="\$home"/);
    expect(verifySh).toMatch(/export GNUPGHOME="\$T\/gnupg"/);
  });

  it('sign the rpm embedded first, then detached armored signatures and a signed SHA256SUMS', () => {
    expect(signSh).toMatch(/rpmsign --addsign/);
    expect(signSh.indexOf('rpmsign --addsign')).toBeLessThan(signSh.indexOf('--detach-sign'));
    expect(signSh).toMatch(/--armor --detach-sign --output "\$dir\/\$f\.asc"/);
    expect(signSh).toMatch(/sha256sum -- "\$\{files\[@\]\}"\) > "\$dir\/\$sums"/);
    expect(signSh).toMatch(/command -v rpmsign/);
    expect(signSh).toMatch(/exit 3/);
  });

  it('verify against a temporary rpm database, never the system one', () => {
    expect(verifySh).toMatch(/rpmkeys --dbpath "\$db" --define "_keyringpath \$db\/pubkeys"/);
    expect(verifySh).toMatch(/--checksig/);
    expect(verifySh).toMatch(/sha256sum -c --strict/);
  });

  it('runs through WSL on Windows and with bash on Linux', () => {
    expect(shellCommand('win32', 'Ubuntu', 'C:\\r\\s.sh', ['a'])).toEqual({
      cmd: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--', 'bash', '/mnt/c/r/s.sh', 'a'],
    });
    expect(shellCommand('linux', 'Ubuntu', '/r/s.sh', ['a'])).toEqual({ cmd: 'bash', args: ['/r/s.sh', 'a'] });
    expect(() => shellCommand('darwin', 'Ubuntu', '/r/s.sh', [])).toThrow();
    expect(hostPath('linux', '/a/b')).toBe('/a/b');
  });
});

describe('the published public keys (site/keys)', () => {
  const keys = join(ROOT, 'site', 'keys');

  it('hold only public parts, and the README names the .cer sha256 and the OpenPGP fingerprint', () => {
    const cer = readFileSync(join(keys, 'indiansassist-windows-selfsigned.cer'));
    const asc = readFileSync(join(keys, 'indiansassist-release-signing.asc'), 'utf8');
    const readme = readFileSync(join(keys, 'README.md'), 'utf8');
    expect(asc).toMatch(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/);
    expect(asc).not.toMatch(/PRIVATE KEY/);
    expect(cer[0]).toBe(0x30); // DER, a certificate only
    expect(readme.toUpperCase()).toContain(createHash('sha256').update(cer).digest('hex').toUpperCase());
    expect(readme).toMatch(/43848FFFF2479CE0DE28CD4FC6E3E6E839D60661/);
    expect(readme).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    for (const f of ['indiansassist-windows-selfsigned.pfx', 'pfx-password.txt', 'gpg-passphrase.txt'])
      expect(existsSync(join(keys, f))).toBe(false);
  });

  it('git ignores private key material anywhere in the tree', () => {
    const gi = read('.gitignore');
    for (const p of [
      '*.pfx',
      '*.p12',
      '*.jks',
      '*.keystore',
      '*-secret.asc',
      'keystore.properties',
      'private-keys-v1.d/',
    ])
      expect(gi.split('\n')).toContain(p);
  });
});

describe('the CI workflows (never run here; parsed)', () => {
  const wf = (n) => ({ text: read('.github', 'workflows', n), doc: parseYaml(read('.github', 'workflows', n)) });
  const steps = (doc) => Object.values(doc.jobs).flatMap((j) => j.steps ?? []);

  it('pin every action to a full commit SHA with the version in a comment, GitHub or SignPath only', () => {
    for (const n of ['ci.yml', 'release.yml']) {
      const { text, doc } = wf(n);
      for (const s of steps(doc)) {
        if (!s.uses) continue;
        expect(s.uses, `${n}: ${s.uses}`).toMatch(/^(actions|signpath)\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/);
      }
      for (const line of text.split('\n').filter((l) => /\buses:/.test(l)))
        expect(line, line).toMatch(/@[0-9a-f]{40} # v\d+(\.\d+)*$/);
    }
  });

  it('ci.yml runs the Node gates and the Rust gates on Windows and Linux, read-only', () => {
    const { doc } = wf('ci.yml');
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(doc.on)).toEqual(expect.arrayContaining(['push', 'pull_request']));
    const runs = steps(doc)
      .map((s) => s.run ?? '')
      .join('\n');
    for (const g of [
      'pnpm build',
      'pnpm typecheck',
      'pnpm lint',
      'pnpm test',
      'pnpm test:scripts',
      'cargo fmt --all --check',
    ])
      expect(runs).toContain(g);
    expect(runs).toMatch(/clippy .*--all-features .*-D warnings/);
    expect(runs).toMatch(/source scripts\/linux-env\.sh/);
    expect(doc.jobs.rust.strategy.matrix.os).toEqual(['windows-latest', 'ubuntu-24.04']);
  });

  it('release.yml runs on v* tags, behind the release-signing approval, with least privilege', () => {
    const { text, doc } = wf('release.yml');
    expect(doc.on.push.tags).toEqual(['v*']);
    expect(doc.permissions).toEqual({ contents: 'read' });
    for (const job of ['windows', 'linux', 'publish']) expect(doc.jobs[job].environment).toBe('release-signing');
    expect(doc.jobs.publish.permissions).toEqual({ contents: 'write' });
    expect(doc.jobs.linux.permissions).toEqual({ contents: 'read' });
    for (const s of ['IA_SIGN_PFX_BASE64', 'IA_SIGN_PFX_PASSWORD', 'IA_GPG_PRIVATE_KEY', 'IA_GPG_PASSPHRASE'])
      expect(text).toContain(`secrets.${s}`);
    expect(text).toContain('signpath/github-action-submit-signing-request@');
    expect(text).toMatch(/SHA256SUMS\.asc/);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}(?![A-Za-z0-9/])/);
  });
});
