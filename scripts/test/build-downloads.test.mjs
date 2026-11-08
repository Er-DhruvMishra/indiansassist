// The staging layout logic of scripts/build-downloads.mjs (argument and environment checks, the step selection, the
// inspection of the staged tree and the summary) and the packaged extension (a real zip, read back; a dev build refused).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildZip, packageExtension, releaseManifestProblems } from '../../apps/extension/scripts/package-zip.mjs';
import { STEP_IDS, buildSummary, checkEnvironment, copyDist, inspectStaged, parseArgs, selectSteps, stagingLayout } from '../build-downloads.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const dirs = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ia-staging-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const goodEnv = {
  IA_TOKEN_PUBKEYS: 'somekey',
  IA_API_ORIGIN: 'https://api.indiansassist.com',
  IA_SIGN_PFX: 'x',
  IA_SIGN_PFX_PASSWORD_FILE: 'y',
  IA_GPG_HOME: 'x',
  IA_GPG_PASSPHRASE_FILE: 'y',
  IA_ANDROID_KEYSTORE: 'x',
  IA_ANDROID_KEYSTORE_PASSWORD: 'y',
};

describe('arguments and environment', () => {
  it('parses flags and refuses an unknown step', () => {
    const o = parseArgs(['--out', 'x', '--only', 'extension,android', '--allow-unsigned']);
    expect(o.out).toBe('x');
    expect(o.allowUnsigned).toBe(true);
    expect(selectSteps(o)).toEqual(['extension', 'android']);
    expect(selectSteps(parseArgs(['--skip', 'android']))).toEqual(STEP_IDS.filter((s) => s !== 'android'));
    expect(() => parseArgs(['--only', 'macos'])).toThrow(/unknown step/);
    expect(() => parseArgs(['--bad'])).toThrow(/unknown argument/);
  });

  it('requires IA_TOKEN_PUBKEYS and a bare https IA_API_ORIGIN, naming only the variable', () => {
    const steps = selectSteps(parseArgs(['--only', 'extension']));
    expect(checkEnvironment(goodEnv, parseArgs([]), steps)).toEqual([]);
    expect(checkEnvironment({}, parseArgs([]), steps).join(' ')).toMatch(/IA_TOKEN_PUBKEYS is not set.*IA_API_ORIGIN is not set/);
    expect(checkEnvironment({ ...goodEnv, IA_API_ORIGIN: 'http://localhost:4000' }, parseArgs([]), steps)[0]).toMatch(/bare https origin/);
    expect(checkEnvironment({ ...goodEnv, IA_API_ORIGIN: 'https://x.example/path' }, parseArgs([]), steps)[0]).toMatch(/bare https origin/);
  });

  it('requires the signing locations for the steps that use them, unless --allow-unsigned; never echoes a value', () => {
    const env = { IA_TOKEN_PUBKEYS: 'k', IA_API_ORIGIN: 'https://a.example', IA_SIGN_PFX_PASSWORD: 'super-secret-value' };
    const opts = parseArgs(['--only', 'windows-portable']);
    const problems = checkEnvironment(env, opts, selectSteps(opts));
    expect(problems.join(' ')).toMatch(/IA_SIGN_PFX is not set/);
    expect(problems.join(' ')).not.toContain('super-secret-value');
    const unsigned = parseArgs(['--only', 'windows-portable', '--allow-unsigned']);
    expect(checkEnvironment(env, unsigned, selectSteps(unsigned))).toEqual([]);
    const linux = parseArgs(['--only', 'linux-packages']);
    expect(checkEnvironment({ ...env, IA_SIGN_PFX: 'x' }, linux, selectSteps(linux)).join(' ')).toMatch(/IA_GPG_HOME/);
  });
});

function stage(out, { dropFile } = {}) {
  const l = stagingLayout(out);
  const portable = Buffer.from('portable');
  const elf = Buffer.from('elf');
  const portal = Buffer.from('portal');
  const msi = Buffer.from('msi');
  const deb = Buffer.from('deb');
  const zip = Buffer.from('zip');
  for (const d of [l.agentDist, l.extension, l.agentMsi, l.linuxPackages]) mkdirSync(d, { recursive: true });
  writeFileSync(join(l.agentDist, 'IndiansAssist-windows-x64-0.3.1.exe'), portable);
  writeFileSync(join(l.agentDist, 'IndiansAssist-linux-x64-0.3.1'), elf);
  writeFileSync(join(l.agentDist, 'IndiansAssist-linux-portal-x64-0.3.1'), portal);
  writeFileSync(
    join(l.agentDist, 'manifest.json'),
    JSON.stringify({
      v: 1,
      builds: [
        { platform: 'windows', arch: 'x64', version: '0.3.1', size: portable.length, sha256: sha(portable), signed: true, minOs: '1' },
        { platform: 'linux', arch: 'x64', version: '0.3.1', size: elf.length, sha256: sha(elf), signed: false, minOs: '1', companion: { sha256: sha(portal), size: portal.length } },
      ],
    }),
  );
  writeFileSync(join(l.extension, 'IndiansAssist-extension-0.2.0.zip'), zip);
  writeFileSync(join(l.extension, 'manifest.json'), JSON.stringify({ v: 1, builds: [{ version: '0.2.0', size: zip.length, sha256: sha(zip), minOs: 'Chrome' }] }));
  writeFileSync(join(l.agentMsi, 'IndiansAssist-Agent-0.3.1-windows-x64.msi'), msi);
  writeFileSync(join(l.agentMsi, 'manifest.json'), JSON.stringify({ v: 1, builds: [{ arch: 'x64', version: '0.3.1', size: msi.length, sha256: sha(msi), signed: true, minOs: '1' }] }));
  writeFileSync(join(l.linuxPackages, 'IndiansAssist-Agent-0.3.1-linux-x64.deb'), deb);
  writeFileSync(join(l.linuxPackages, 'manifest.json'), JSON.stringify({ v: 1, builds: [{ platform: 'linux', format: 'deb', arch: 'x64', version: '0.3.1', size: deb.length, sha256: sha(deb), signed: false, minOs: '1' }] }));
  if (dropFile) rmSync(join(l.agentDist, dropFile));
  return l;
}

describe('the staged layout', () => {
  it('uses the on-server paths', () => {
    const l = stagingLayout(join('x', 'y'));
    expect(l.agentDist).toBe(join('x', 'y', 'agent-dist'));
    expect(l.extension).toBe(join('x', 'y', 'agent-dist', 'extension'));
    expect(l.agentMsi).toBe(join('x', 'y', 'agent-msi'));
    expect(l.linuxPackages).toBe(join('x', 'y', 'agent-msi', 'linux'));
  });

  it('inspects a good tree: every served file, with its tier and hash', () => {
    const out = temp();
    stage(out);
    const r = inspectStaged(out);
    expect(r.problems).toEqual([]);
    expect(r.files.map((f) => f.file).sort()).toEqual(
      [
        'IndiansAssist-Agent-0.3.1-linux-x64.deb',
        'IndiansAssist-Agent-0.3.1-windows-x64.msi',
        'IndiansAssist-extension-0.2.0.zip',
        'IndiansAssist-linux-portal-x64-0.3.1',
        'IndiansAssist-linux-x64-0.3.1',
        'IndiansAssist-windows-x64-0.3.1.exe',
      ].sort(),
    );
    expect(r.files.find((f) => f.file.endsWith('.msi'))?.tier).toBe('p4_installed');
    expect(r.files.find((f) => f.file.endsWith('.zip'))?.tier).toBe('p2_extension');
  });

  it('reports a file a manifest names that is missing or changed', () => {
    const missing = temp();
    stage(missing, { dropFile: 'IndiansAssist-linux-portal-x64-0.3.1' });
    expect(inspectStaged(missing).problems.join(' ')).toMatch(/portal.*missing/);
    const changed = temp();
    const l = stage(changed);
    writeFileSync(join(l.agentDist, 'IndiansAssist-windows-x64-0.3.1.exe'), 'other');
    expect(inspectStaged(changed).problems.join(' ')).toMatch(/sha256 does not match/);
  });

  it('copyDist copies files only and fails when there is nothing', () => {
    const from = temp();
    const to = join(temp(), 'to');
    mkdirSync(join(from, 'sub'));
    writeFileSync(join(from, 'a.deb'), 'x');
    writeFileSync(join(from, 'manifest.json'), '{}');
    expect(copyDist(from, to).sort()).toEqual(['a.deb', 'manifest.json']);
    expect(() => copyDist(temp(), join(temp(), 'x'))).toThrow(/empty/);
    expect(() => copyDist(join(temp(), 'nope'), join(temp(), 'x'))).toThrow(/does not exist/);
  });

  it('the summary records what was and was not built and why', () => {
    const inspected = { files: [{ tier: 'p3_portable', file: 'a', size: 1, sha256: 's', signed: true }], problems: [] };
    const ok = buildSummary({
      origin: 'https://a.example',
      steps: [
        { id: 'extension', status: 'built' },
        { id: 'android', status: 'skipped', reason: 'not selected for this run' },
      ],
      inspected,
      generatedAt: 'now',
    });
    expect(ok.ok).toBe(true);
    expect(ok.generatedAt).toBe('now');
    expect(ok.notBuilt.map((n) => n.target)).toEqual(['windows/arm64', 'macos', 'ios', 'android']);
    expect(ok.notBuilt.find((n) => n.target === 'macos')?.reason).toMatch(/Mac/);
    const bad = buildSummary({ origin: 'x', steps: [{ id: 'android', status: 'failed', reason: 'boom' }], inspected });
    expect(bad.ok).toBe(false);
    expect(buildSummary({ origin: 'x', steps: [], inspected: { files: [], problems: ['p'] } }).ok).toBe(false);
  });
});

function readZip(buf) {
  const entries = {};
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtra;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe('the packaged extension zip', () => {
  const prodManifest = {
    version: '0.2.0',
    minimum_chrome_version: '120',
    externally_connectable: { matches: ['https://api.indiansassist.com/*'] },
    content_scripts: [{ matches: ['https://api.indiansassist.com/*'], js: ['bridge.js'] }],
  };

  it('buildZip writes a readable zip with the files at its root and forward-slash names; refuses a traversing name', () => {
    const zip = buildZip([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'icons/16.png', data: Buffer.from('png-bytes'.repeat(50)) },
    ]);
    const files = readZip(zip);
    expect(files['manifest.json'].toString()).toBe('{}');
    expect(files['icons/16.png'].toString()).toBe('png-bytes'.repeat(50));
    expect(() => buildZip([{ name: '../evil', data: Buffer.alloc(0) }])).toThrow(/unsafe/);
    // Deterministic: the same input gives the same bytes.
    expect(buildZip([{ name: 'a', data: Buffer.from('x') }]).equals(buildZip([{ name: 'a', data: Buffer.from('x') }]))).toBe(true);
  });

  it('packages a production build: zip, sha256 and manifest for the api; refuses a dev build', () => {
    const dist = temp();
    mkdirSync(join(dist, 'icons'));
    writeFileSync(join(dist, 'manifest.json'), JSON.stringify(prodManifest));
    writeFileSync(join(dist, 'icons', '16.png'), 'p');
    const out = join(temp(), 'ext');
    const row = packageExtension(dist, out, { requireOrigin: 'https://api.indiansassist.com' });
    expect(row.file).toBe('IndiansAssist-extension-0.2.0.zip');
    expect(row.minOs).toBe('Chrome or Edge 120 or later');
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(m).toEqual({ v: 1, builds: [row] });
    expect(() => packageExtension(dist, join(temp(), 'x'), { requireOrigin: 'https://other.example' })).toThrow(/does not include/);
    expect(releaseManifestProblems({ ...prodManifest, externally_connectable: { matches: ['http://localhost:5173/*'] } }).join(' ')).toMatch(/dev origin/);
  });
});
