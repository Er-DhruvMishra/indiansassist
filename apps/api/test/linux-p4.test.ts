/**
 * Phase F section 8 (linux-p4 L3) on the api: the platform- and format-generic installer route (section 8.11: the
 * MSI, the deb, the rpm and the macOS PKG from one dist directory and its `linux/` and `macos/` manifests, each with
 * its content type and a `download.served { platform, format }` entry), a `linux` enrollment, rule 8.4f
 * (`409 prelogin_unsupported` for a Linux device nobody is signed in to, whatever `allowLogonScreen` says) and
 * section 8.7 (privileged mode refused with `bad_state` and no `elevation.granted` for a Linux device's worker).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installerFileName, sha256Hex } from '@indiansassist/shared';
import { getDevice, listAuditByOrgPaginated } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRELOGIN_UNSUPPORTED_TEXT } from '../src/fleet/device-sessions.js';
import { INSTALLER_CONTENT_TYPES } from '../src/routes/download.js';
import { call, createToken, listen, SignalClient, type Account, type TestApp } from './helpers.js';
import {
  connectDevice,
  deviceGroup,
  enrollBody,
  enrollConfigFor,
  makeP4App,
  newDev,
  openDeviceSessionVia,
  p4Admin,
  workerConsent,
  workerHelloWith,
  type Dev,
} from './p4-kit.js';

/** Section 8.7: the Linux service's capabilities. */
const LINUX_CAPS = {
  monitors: 1,
  elevation: 'user',
  features: ['screen', 'multi_monitor', 'input', 'input_text', 'clipboard', 'files', 'chat', 'playbooks', 'recorder', 'service_input', 'waker'],
  encoders: ['vp8', 'vp9'],
  hwEncoder: false,
  interpreters: ['sh'],
  serviceVersion: '0.5.0',
};

describe('linux-p4 on the api (Phase F sections 8.4, 8.7, 8.11)', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  const sockets: SignalClient[] = [];

  beforeAll(async () => {
    t = await makeP4App();
    url = await listen(t.app);
    admin = await p4Admin(t);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  /** Enrolls a `linux` device with the section 8.7 capabilities and the given interactive state. */
  async function enrollLinux(interactive: Record<string, unknown>, groupId?: string): Promise<Dev> {
    const d = newDev(['screen', 'input', 'chat', 'service_input']);
    const { cfg, tokenId } = await enrollConfigFor(t, admin, 1, groupId);
    const body = enrollBody(d, cfg, tokenId);
    const machine = body['machine'] as Record<string, unknown>;
    Object.assign(machine, { platform: 'linux', osVersion: 'Ubuntu 24.04.1 LTS', serviceVersion: '0.5.0', capabilities: LINUX_CAPS, interactive });
    const res = await call(t.app, '/api/v1/devices/enroll', { body });
    expect(res.statusCode, res.body).toBe(201);
    d.deviceId = (res.json() as { deviceId: string }).deviceId;
    return d;
  }

  it('serves every platform and format from one dist directory, each with its type and an audited entry', async () => {
    const root = t.ctx.config.fleet.msiDistDir;
    const linux = join(root, 'linux');
    const macos = join(root, 'macos');
    for (const dir of [root, linux, macos]) mkdirSync(dir, { recursive: true });
    const body = (s: string) => Buffer.from(`${s} `.repeat(64));
    const files = { msi: body('msi'), deb: body('deb'), rpm: body('rpm'), pkg: body('pkg') };
    const row = (format: keyof typeof files, extra: Record<string, unknown> = {}) => ({
      arch: 'x64',
      version: '0.5.0',
      size: 1,
      sha256: sha256Hex(files[format]),
      minOs: 'test',
      ...extra,
    });
    writeFileSync(join(root, installerFileName('x64', '0.5.0')), files.msi);
    // A row whose format belongs to another platform is never served.
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ v: 1, builds: [row('msi', { signed: true }), row('deb', { platform: 'windows', format: 'deb', file: 'x.deb' })] }));
    writeFileSync(join(root, 'x.deb'), files.deb);
    // The folder `pnpm linux:pkg` writes, copied as it is (`installerDistManifestSchema` rows with `file`).
    for (const f of ['deb', 'rpm'] as const) writeFileSync(join(linux, installerFileName('x64', '0.5.0', f)), files[f]);
    writeFileSync(
      join(linux, 'manifest.json'),
      JSON.stringify({
        v: 1,
        builds: (['deb', 'rpm'] as const).map((f) => ({ ...row(f, { platform: 'linux', format: f, signed: false }), file: installerFileName('x64', '0.5.0', f) })),
      }),
    );
    // Section 17.3: the macOS PKG, per arch, unsigned until a Developer ID Installer identity exists.
    writeFileSync(join(macos, installerFileName('arm64', '0.5.0', 'pkg')), files.pkg);
    writeFileSync(join(macos, 'manifest.json'), JSON.stringify({ v: 1, builds: [row('pkg', { platform: 'macos', format: 'pkg', arch: 'arm64', signed: false })] }));
    t.ctx.installerDist.load();
    expect(t.ctx.installerDist.lastError).toBeNull();

    const list = (await call(t.app, '/api/v1/download/installer', { cookie: admin.cookie })).json() as { builds: Record<string, unknown>[] };
    expect(list.builds.map((b) => `${b['platform'] ?? 'windows'}/${b['format'] ?? 'msi'}/${String(b['arch'])}`)).toEqual([
      'windows/msi/x64',
      'linux/deb/x64',
      'linux/rpm/x64',
      'macos/pkg/arm64',
    ]);
    expect(list.builds[3]).toMatchObject({ signed: false, sha256: sha256Hex(files.pkg), size: files.pkg.length });

    const tok = await createToken(t.app, admin, { tier: 'p4_installed', typ: 'enrollment', maxDevices: 50 });
    const get = (arch: string, format?: string, method: 'GET' | 'HEAD' = 'GET') =>
      t.app.inject({ method, url: `/api/v1/download/installer/${arch}?tokenId=${tok.token.id}${format ? `&format=${format}` : ''}`, headers: { cookie: admin.cookie } });
    const cases = [
      ['x64', undefined, 'msi', 'windows'],
      ['x64', 'deb', 'deb', 'linux'],
      ['x64', 'rpm', 'rpm', 'linux'],
      ['arm64', 'pkg', 'pkg', 'macos'],
    ] as const;
    for (const [arch, q, format, platform] of cases) {
      const res = await get(arch, q);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe(INSTALLER_CONTENT_TYPES[format]);
      expect(res.headers['content-disposition']).toContain(installerFileName(arch, '0.5.0', format));
      expect(res.rawPayload.equals(files[format])).toBe(true);
      const head = await get(arch, q, 'HEAD');
      expect(head.statusCode).toBe(200);
      const entries = (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'download.served' })).items;
      expect(entries[0]?.data).toMatchObject({ tokenId: tok.token.id, platform, format, arch, version: '0.5.0', sha256: sha256Hex(files[format]) });
    }
    expect(INSTALLER_CONTENT_TYPES).toMatchObject({
      deb: 'application/vnd.debian.binary-package',
      rpm: 'application/x-rpm',
      pkg: 'application/octet-stream',
    });
    // HEAD is free: one entry per GET.
    expect((await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'download.served' })).items).toHaveLength(4);
    // What is not listed is not served, and a bad format is a bad request.
    expect((await get('arm64', 'deb')).json()).toMatchObject({ error: { code: 'download_unavailable' } });
    expect((await get('x64', 'pkg')).json()).toMatchObject({ error: { code: 'download_unavailable' } });
    expect((await get('x64', 'zip')).statusCode).toBe(400);
  });

  it('enrolls a linux device with its own capabilities and display type', async () => {
    const d = await enrollLinux({ state: 'active', idleSec: 0, at: 1, display: 'x11' });
    const row = await getDevice(t.ctx.db, d.deviceId);
    expect(row?.platform).toBe('linux');
    expect(row?.osVersion).toBe('Ubuntu 24.04.1 LTS');
    expect((row?.capabilities as { elevation: string }).elevation).toBe('user');
    expect(row?.interactive).toMatchObject({ state: 'active', display: 'x11' });
    const detail = (await call(t.app, `/api/v1/devices/${d.deviceId}`, { cookie: admin.cookie })).json() as Record<string, unknown>;
    expect(detail).toMatchObject({ platform: 'linux', interactive: { display: 'x11' } });
    const enrolled = (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'device.enrolled' })).items[0];
    expect(enrolled?.data).toMatchObject({ deviceId: d.deviceId, platform: 'linux' });
  });

  it('refuses a session to a linux device nobody is signed in to, whatever allowLogonScreen says (rule 8.4f)', async () => {
    const group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false, allowLogonScreen: true });
    const d = await enrollLinux({ state: 'none', idleSec: null, at: 1, display: null }, group);
    const ws = await connectDevice(url, d, { interactive: 'none', track: sockets });
    await ws.next('device.hello.ok');
    for (const unattended of [true, false]) {
      const r = await call(t.app, `/api/v1/devices/${d.deviceId}/sessions`, { cookie: admin.cookie, body: { unattended, reason: 'check the printer' } });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: { code: 'prelogin_unsupported', message: PRELOGIN_UNSUPPORTED_TEXT } });
    }
    expect(PRELOGIN_UNSUPPORTED_TEXT).toBe('Nobody is signed in to this Linux computer. IndiansAssist can connect only to a signed-in desktop session.');
    ws.close();
  });

  it('refuses privileged mode to a linux device worker with bad_state, and chains no elevation.granted (section 8.7)', async () => {
    const group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false, allowPrivileged: true });
    const d = await enrollLinux({ state: 'locked', idleSec: 10, at: 1, display: 'x11' }, group);
    // A locked session is "not present" (rule 8.4e): an unattended session proceeds as the policy allows.
    const ws = await connectDevice(url, d, { interactive: 'locked', track: sockets });
    await ws.next('device.hello.ok');
    const { sessionId, open } = await openDeviceSessionVia(t, admin, d, ws, { unattended: true, reason: 'linux privileged check' });
    expect(open['decision']).toBe('auto_grant');
    const worker = await workerHelloWith(url, open['workerCredential'], { track: sockets });
    await worker.next('desk.hello.ok');
    expect((await workerConsent(worker))['state']).toBe('active');
    worker.send({ t: 'desk.consent_level', id: 'pm1', sessionId, level: 'elevated', requested: true, opId: '0123456789abcdef' });
    const err = await worker.next('error');
    expect(err).toMatchObject({ code: 'bad_state', re: 'pm1' });
    expect(String(err['message'])).toContain('run as the signed-in user');
    const granted = (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'elevation.granted' })).items.filter((e) => e.sessionId === sessionId);
    expect(granted).toHaveLength(0);
    const s = (await call(t.app, `/api/v1/sessions/${sessionId}`, { cookie: admin.cookie })).json() as Record<string, unknown>;
    expect(s['elevation'] ?? null).not.toBe('admin');
    await call(t.app, `/api/v1/sessions/${sessionId}/end`, { cookie: admin.cookie, body: {} });
  });

  /** An Assist socket signed in as `admin` (the console's `assist.hello`). */
  async function assistSocket(): Promise<SignalClient> {
    const a = await SignalClient.open(url, { cookie: admin.cookie });
    sockets.push(a);
    await a.request({ t: 'assist.hello' }, 'assist.hello.ok');
    return a;
  }

  /** A linux device in an `allow` group, online and locked, with an unattended session the worker took to active. */
  async function activeUnattended(label: string, assistFirst: boolean): Promise<{ sessionId: string; assist: SignalClient | null }> {
    const group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false });
    const d = await enrollLinux({ state: 'locked', idleSec: 10, at: 1, display: 'x11' }, group);
    const ws = await connectDevice(url, d, { interactive: 'locked', track: sockets });
    await ws.next('device.hello.ok');
    const { sessionId, open } = await openDeviceSessionVia(t, admin, d, ws, { unattended: true, reason: label });
    let assist: SignalClient | null = null;
    if (assistFirst) {
      assist = await assistSocket();
      const created = await assist.request({ t: 'assist.resume', sessionId }, 'session.created');
      expect(created['state']).toBe('consent_pending');
    }
    const worker = await workerHelloWith(url, open['workerCredential'], { track: sockets });
    await worker.next('desk.hello.ok');
    expect((await workerConsent(worker))['state']).toBe('active');
    return { sessionId, assist };
  }

  it('replays the consent to an Assist that attaches after the worker consented (no "View only" race)', async () => {
    const { sessionId } = await activeUnattended('consent before attach', false);
    const assist = await assistSocket();
    const created = await assist.request({ t: 'assist.resume', sessionId }, 'session.created');
    expect(created['state']).toBe('active');
    expect(await assist.next('consent.changed')).toMatchObject({ sessionId, state: 'granted', level: 'control', monitors: 1, clipboard: false });
    await call(t.app, `/api/v1/sessions/${sessionId}/end`, { cookie: admin.cookie, body: {} });
  });

  it('replays the consent to an Assist that reconnects after the consent', async () => {
    const { sessionId, assist } = await activeUnattended('consent then reconnect', true);
    // The first socket saw the live change.
    expect(await assist!.next('consent.changed')).toMatchObject({ sessionId, level: 'control' });
    assist!.close();
    const again = await assistSocket();
    expect((await again.request({ t: 'assist.resume', sessionId }, 'session.created'))['state']).toBe('active');
    expect(await again.next('consent.changed')).toMatchObject({ sessionId, state: 'granted', level: 'control' });
    await call(t.app, `/api/v1/sessions/${sessionId}/end`, { cookie: admin.cookie, body: {} });
  });
});