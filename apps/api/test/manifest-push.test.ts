/**
 * Rule 9.3 after connect: the playbook manifest reaches a device that is already connected. A device learns the
 * catalogue in `device.hello.ok.playbooks`; every catalogue change (create, update, disable, delete) pushes
 * `device.playbooks { playbooks }` to the org's connected devices with exactly the hello's entries, and a burst of
 * changes is one push per org.
 */
import { parseDeviceServerMessage } from '@indiansassist/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, type Account, type Msg, type SignalClient, type TestApp } from './helpers.js';
import { connectDevice, enrollDevice, makeP4App, p4Admin, type Dev } from './p4-kit.js';
import { MANIFEST_PUSH_COALESCE_MS } from '../src/fleet/manifest-push.js';

type Entry = { id: string; name: string; bodyHash: string };

describe('device.playbooks: the catalogue reaches connected devices without a reconnect', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  const sockets: SignalClient[] = [];

  const create = async (name: string, body = 'Get-Date', interpreter = 'powershell') => {
    const r = await call(t.app, '/api/v1/orgs/current/playbooks', {
      cookie: admin.cookie,
      body: { name, description: 'read-only test playbook', interpreter, body, timeoutSec: 60 },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; bodyHash: string };
  };
  const online = async (d: Dev) => {
    const ws = await connectDevice(url, d, { track: sockets });
    const ok = await ws.next('device.hello.ok');
    return { ws, hello: ok['playbooks'] as Entry[] };
  };
  /** The next push, after checking it is a valid server frame by the shared schema. */
  const nextPush = async (ws: SignalClient): Promise<Entry[]> => {
    const m: Msg = await ws.next('device.playbooks', undefined, 5000);
    const parsed = parseDeviceServerMessage(JSON.stringify(m));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    return m['playbooks'] as Entry[];
  };
  const ids = (es: Entry[]) => es.map((e) => e.id);

  beforeAll(async () => {
    t = await makeP4App();
    url = await listen(t.app);
    admin = await p4Admin(t);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('pushes on create, update, disable and delete, each the same entries a fresh hello would carry', async () => {
    const d = await enrollDevice(t, admin);
    const { ws, hello } = await online(d);

    const pb = await create('Clock check');
    const afterCreate = await nextPush(ws);
    expect(ids(afterCreate)).toContain(pb.id);
    expect(ids(hello)).not.toContain(pb.id);
    expect(afterCreate.length).toBe(hello.length + 1);

    // A body change moves the pin the device verifies against.
    const patched = await call(t.app, `/api/v1/orgs/current/playbooks/${pb.id}`, { method: 'PATCH', cookie: admin.cookie, body: { body: 'Get-Date -Format o' } });
    expect(patched.statusCode, patched.body).toBe(200);
    const newHash = (patched.json() as { bodyHash: string }).bodyHash;
    expect(newHash).not.toBe(pb.bodyHash);
    const afterUpdate = await nextPush(ws);
    expect(afterUpdate.find((e) => e.id === pb.id)?.bodyHash).toBe(newHash);

    // The push is what the next hello would say.
    const again = await online(d);
    expect(again.hello).toEqual(afterUpdate);
    ws.close();
    const live = again.ws;

    // Disabling (the catalogue's archive) takes it out of the manifest.
    const off = await call(t.app, `/api/v1/orgs/current/playbooks/${pb.id}`, { method: 'PATCH', cookie: admin.cookie, body: { enabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    expect(ids(await nextPush(live))).not.toContain(pb.id);

    const second = await create('Uptime check', 'Get-Uptime');
    expect(ids(await nextPush(live))).toContain(second.id);
    const del = await call(t.app, `/api/v1/orgs/current/playbooks/${second.id}`, { method: 'DELETE', cookie: admin.cookie });
    expect(del.statusCode, del.body).toBe(204);
    expect(ids(await nextPush(live))).not.toContain(second.id);
  });

  it('coalesces a burst into one push per org that carries every change', async () => {
    const d = await enrollDevice(t, admin);
    const { ws } = await online(d);
    const a = await create('Burst one');
    const b = await create('Burst two');
    const c = await create('Burst three');
    const pushed = await nextPush(ws);
    expect(ids(pushed)).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    // Nothing else follows for that burst.
    expect(await ws.quiet('device.playbooks', MANIFEST_PUSH_COALESCE_MS + 400)).toBe(true);
  });

  it("filters by the device's interpreters as the hello does, and never reaches another org's devices", async () => {
    const d = await enrollDevice(t, admin);
    const { ws } = await online(d);
    const other = await p4Admin(t);
    const od = await enrollDevice(t, other);
    const otherWs = (await online(od)).ws;
    // An `sh` playbook is not in a powershell-only device's manifest; the push still goes out with the unchanged list.
    const sh = await create('Shell clock', 'date', 'sh');
    const pushed = await nextPush(ws);
    expect(ids(pushed)).not.toContain(sh.id);
    expect(await otherWs.quiet('device.playbooks', MANIFEST_PUSH_COALESCE_MS + 400)).toBe(true);
  });
});
