// `pnpm agent:release:linux` (packaging/linux/agent-release.mjs; Phase F sections 9.5 and 9.6, revision 3): the
// AGENT_DIST_DIR manifest it writes is checked against the real `agentDistManifestSchema` and the api's file names,
// the Linux row carries the companion, the other platforms' rows survive, and `scripts/agent-manifest.mjs` keeps
// the Linux row when it rewrites the Windows, Android and macOS rows. The build itself runs only by hand (WSL).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_GLIBC,
  MIN_OS,
  PORTAL_ALLOW,
  embedsCompanionHash,
  linuxDistRow,
  mergeDistManifest,
  portalDistFileName,
  wslEnv,
  x11DistFileName,
} from '../../packaging/linux/agent-release.mjs';
import { loadShared } from '../smoke/shared.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const X11 = { size: 17_500_000, sha256: 'a1'.repeat(32) };
const PORTAL = { size: 18_270_000, sha256: 'b2'.repeat(32) };
const WIN = { platform: 'windows', arch: 'x64', version: '0.3.0', size: 9, sha256: 'c3'.repeat(32), signed: true, minOs: '10.0.17763' };
const MAC = { platform: 'macos', arch: 'arm64', version: '0.3.0', size: 7, sha256: 'd4'.repeat(32), signed: false, minOs: '12.3' };

let shared;
beforeAll(async () => {
  shared = await loadShared();
});

describe('the Linux dist row (agentDistManifestSchema)', () => {
  it('names the files the api looks for', () => {
    expect(x11DistFileName('0.3.0')).toBe(shared.agentDistFileName('linux', 'x64', '0.3.0'));
    expect(portalDistFileName('0.3.0')).toBe(shared.agentPortalDistFileName('0.3.0'));
  });

  it('is one unsigned Linux x64 row with the companion, valid for the api and the wire', () => {
    const row = linuxDistRow('0.3.0', X11, PORTAL);
    expect(row).toEqual({
      platform: 'linux',
      arch: 'x64',
      version: '0.3.0',
      size: X11.size,
      sha256: X11.sha256,
      signed: false,
      minOs: MIN_OS,
      companion: { sha256: PORTAL.sha256, size: PORTAL.size },
    });
    expect(MIN_OS.length).toBeLessThanOrEqual(64);
    expect(shared.agentDistManifestSchema.safeParse({ v: 1, builds: [row] }).success).toBe(true);
    expect(shared.downloadManifestSchema.safeParse({ v: 1, builds: [row] }).success).toBe(true);
  });

  it('gates at the 2.34 floor and allows libpipewire for the companion only', () => {
    expect(MAX_GLIBC).toBe('2.34');
    expect(PORTAL_ALLOW).toEqual(['libpipewire-0.3.so.0']);
  });
});

describe('mergeDistManifest', () => {
  it('starts a missing manifest with the Linux row', () => {
    const m = mergeDistManifest(null, linuxDistRow('0.3.0', X11, PORTAL));
    expect(m.builds).toHaveLength(1);
    expect(shared.agentDistManifestSchema.safeParse(m).success).toBe(true);
  });

  it('replaces every earlier Linux row and keeps the other platforms in order', () => {
    const old = { platform: 'linux', arch: 'x64', version: '0.2.0', size: 1, sha256: 'e5'.repeat(32), signed: false, minOs: 'glibc 2.35' };
    const m = mergeDistManifest({ v: 1, builds: [WIN, old, MAC] }, linuxDistRow('0.3.0', X11, PORTAL));
    expect(m.builds.map((b) => `${b.platform}:${b.version}`)).toEqual(['windows:0.3.0', 'macos:0.3.0', 'linux:0.3.0']);
    expect(m.builds.filter((b) => b.platform === 'linux')).toHaveLength(1);
    expect(m.builds.at(-1).companion).toEqual({ sha256: PORTAL.sha256, size: PORTAL.size });
    expect(shared.agentDistManifestSchema.safeParse(m).success).toBe(true);
  });

  it('refuses a manifest of another shape rather than overwrite it', () => {
    expect(() => mergeDistManifest({ v: 2, builds: [] }, linuxDistRow('0.3.0', X11, PORTAL))).toThrow(/not \{ v: 1/);
    expect(() => mergeDistManifest([], linuxDistRow('0.3.0', X11, PORTAL))).toThrow();
  });
});

describe('the build checks', () => {
  it('finds the embedded companion hash in the X11 image', () => {
    const img = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]), Buffer.from(PORTAL.sha256), Buffer.from([0, 9])]);
    expect(embedsCompanionHash(img, PORTAL.sha256)).toBe(true);
    expect(embedsCompanionHash(img, X11.sha256)).toBe(false);
    expect(embedsCompanionHash(img, '')).toBe(false);
  });

  it('passes the release keys into WSL only when they are set', () => {
    expect(wslEnv({})).toBe('');
    expect(wslEnv({ IA_TOKEN_PUBKEYS: 'k1', WSLENV: 'FOO/p' })).toBe('FOO/p:IA_TOKEN_PUBKEYS/u');
    expect(wslEnv({ IA_TOKEN_PUBKEYS: 'k1', IA_API_ORIGIN: 'https://x.example.test', WSLENV: 'IA_API_ORIGIN/u' })).toBe(
      'IA_TOKEN_PUBKEYS/u:IA_API_ORIGIN/u',
    );
  });

  it('the WSL half builds the companion first and embeds its hash in the X11 build', () => {
    const sh = readFileSync(join(ROOT, 'packaging', 'linux', 'agent-release-wsl.sh'), 'utf8');
    expect(sh).not.toMatch(/\r/);
    expect(sh).toMatch(/floor="2\.34"/);
    expect(sh).toMatch(/SYSTEM_DEPS_LIBPIPEWIRE_SEARCH_NATIVE="\$linkdir"/);
    expect(sh).toMatch(/--features portal -- -C link-arg=-Wl,--allow-shlib-undefined/);
    expect(sh).toMatch(/export IA_PORTAL_SHA256="\$3"/);
    expect(sh).not.toMatch(/\b(sudo|apt|apt-get|cargo install)\b/);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['agent:release:linux']).toBe('node packaging/linux/agent-release.mjs');
  });
});

describe('scripts/agent-manifest.mjs keeps the Linux row', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('rewrites Windows and macOS from the files and keeps the Linux row of agent:release:linux', () => {
    dir = mkdtempSync(join(tmpdir(), 'ia-agent-dist-'));
    writeFileSync(join(dir, 'IndiansAssist-windows-x64-0.3.0.exe'), 'exe');
    writeFileSync(join(dir, 'IndiansAssist-macos-arm64-0.3.0.app.zip'), 'zip');
    const linux = linuxDistRow('0.3.0', X11, PORTAL);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ v: 1, builds: [linux] }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'agent-manifest.mjs'), '--dist', dir], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(m.builds.map((b) => b.platform)).toEqual(['macos', 'windows', 'linux']);
    expect(m.builds[0]).toMatchObject({ arch: 'arm64', version: '0.3.0', size: 3, signed: false, minOs: '12.3' });
    expect(m.builds[2]).toEqual(linux);
    expect(shared.agentDistManifestSchema.safeParse(m).success).toBe(true);
    const check = spawnSync(process.execPath, [join(ROOT, 'scripts', 'agent-manifest.mjs'), '--dist', dir, '--check'], { encoding: 'utf8' });
    expect(check.status, check.stderr).toBe(0);
  });
});
