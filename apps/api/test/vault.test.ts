/**
 * Phase D credential vault (docs/specs/phase-d-contracts.md rule 9.8): the api is the only vault client, reads
 * `secret/data/ia/<orgId>/<path>` with one cached AppRole login, refuses a path that could leave the org prefix, and
 * turns every vault defect into `vault_unavailable` rather than a leak. Then the rule the vault exists for, end to
 * end over the real action routes: a secret is read **at dispatch only**, sealed to **one** device, for **one** use,
 * never stored in the queue row, never written to the chain, and a vault that is down fails the action honestly.
 */
import { openSealed, type Sealed } from '@indiansassist/shared';
import { getDeviceAction, listAuditByOrgPaginated } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, type Account, type SignalClient, type TestApp } from './helpers.js';
import { startFakeVault, vaultEnv, type FakeVault } from './fake-vault.js';
import { connectDevice, deviceGroup, enrollDevice, makeP4App, newDev, p4Admin, type Dev } from './p4-kit.js';
import { readVaultSecret, vaultConfigured, VaultUnavailableError } from '../src/fleet/vault.js';

const SECRET = 'sup3r-secret-api-key-not-in-any-log';
const OTHER_SECRET = '{"user":"amt-admin","pass":"n0t-l0gged"}';

describe('the credential vault client (rule 9.8)', () => {
  let t: TestApp;
  let vault: FakeVault;
  let admin: Account;

  beforeAll(async () => {
    vault = await startFakeVault();
    t = await makeP4App(vaultEnv(vault));
    admin = await p4Admin(t);
    vault.secrets.set(`${admin.org.id}/ci/api-key`, { value: SECRET });
    vault.secrets.set(`${admin.org.id}/amt/default`, { user: 'amt-admin', pass: 'n0t-l0gged' });
  });
  afterAll(async () => {
    await t.close();
    await vault.close();
  });

  it('is not configured without VAULT_ADDR, and then never calls out', async () => {
    const bare = await makeP4App();
    try {
      expect(vaultConfigured(bare.ctx)).toBe(false);
      const err = await readVaultSecret(bare.ctx, admin.org.id, 'ci/api-key').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VaultUnavailableError);
      expect((err as VaultUnavailableError).code).toBe('vault_unavailable');
      expect((err as Error).message).toMatch(/not configured/);
    } finally {
      await bare.close();
    }
  });

  it('logs in once with the AppRole credentials and reads secret/data/ia/<orgId>/<path>', async () => {
    expect(vaultConfigured(t.ctx)).toBe(true);
    expect(await readVaultSecret(t.ctx, admin.org.id, 'ci/api-key')).toBe(SECRET);
    // The token is cached, so a second read does not log in again (and the credentials never travel in a URL).
    expect(await readVaultSecret(t.ctx, admin.org.id, 'ci/api-key')).toBe(SECRET);
    expect(vault.logins).toBe(1);
    expect(vault.login).toEqual({ roleId: 'test-role-id', secretId: 'test-secret-id' });
    expect(vault.reads).toEqual([`${admin.org.id}/ci/api-key`, `${admin.org.id}/ci/api-key`]);
    // A KV map without a `value` key comes back whole, so an AMT credential pair survives (rule 8.4c).
    expect(JSON.parse((await readVaultSecret(t.ctx, admin.org.id, 'amt/default'))!)).toEqual(JSON.parse(OTHER_SECRET));
    // An absent secret is null, not an error: the caller decides (a missing AMT path falls back to amt/default).
    expect(await readVaultSecret(t.ctx, admin.org.id, 'amt/00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('refuses a path that could leave the org prefix, before any request is made', async () => {
    const before = vault.reads.length;
    for (const path of ['', '../etc/passwd', 'ci/../../other-org/api-key', 'ci/..', 'ci/%2e%2e/key', 'ci key', `ci/${'x'.repeat(300)}`]) {
      await expect(readVaultSecret(t.ctx, admin.org.id, path)).rejects.toThrow(VaultUnavailableError);
    }
    expect(vault.reads.length).toBe(before);
  });

  it('an unhealthy or unreachable vault is a vault_unavailable, never a partial read', async () => {
    vault.fail = 500;
    await expect(readVaultSecret(t.ctx, admin.org.id, 'ci/api-key')).rejects.toThrow(VaultUnavailableError);
    vault.fail = 503;
    await expect(readVaultSecret(t.ctx, admin.org.id, 'ci/api-key')).rejects.toThrow(/vault read failed \(503\)/);
    vault.fail = null;
    expect(await readVaultSecret(t.ctx, admin.org.id, 'ci/api-key')).toBe(SECRET);

    const dead = await startFakeVault();
    const addr = dead.addr;
    await dead.close();
    const app = await makeP4App(vaultEnv({ addr }));
    try {
      await expect(readVaultSecret(app.ctx, admin.org.id, 'ci/api-key')).rejects.toThrow(VaultUnavailableError);
    } finally {
      await app.close();
    }
  });
});

describe('a vault secret is sealed to one device for one use (rule 9.8)', () => {
  let t: TestApp;
  let url: string;
  let vault: FakeVault;
  let admin: Account;
  let d: Dev;
  let other: Dev;
  let playbookId: string;
  let ws: SignalClient;
  const sockets: SignalClient[] = [];

  const ref = { env: 'IA_API_KEY', path: 'ci/api-key' };
  const actionsPath = () => `/api/v1/devices/${d.deviceId}/actions`;
  const queue = (body: Record<string, unknown>) => call(t.app, actionsPath(), { cookie: admin.cookie, body });
  const runBody = (reason?: string) => ({
    kind: 'playbook_run',
    payload: { playbookId, args: {}, requiresElevation: false },
    ...(reason === undefined ? {} : { reason }),
  });
  const listActions = async () => (await call(t.app, actionsPath(), { cookie: admin.cookie })).json() as { items: { id: string; state: string; result: { error?: string } | null }[] };
  const injected = async () => (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'secret.injected' })).items;

  beforeAll(async () => {
    vault = await startFakeVault();
    t = await makeP4App(vaultEnv(vault));
    url = await listen(t.app);
    admin = await p4Admin(t);
    vault.secrets.set(`${admin.org.id}/${ref.path}`, { value: SECRET });
    const groupId = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false, allowPrivileged: true });
    d = await enrollDevice(t, admin, { groupId });
    other = await enrollDevice(t, admin, { groupId, dev: newDev() });
    const pb = await call(t.app, '/api/v1/orgs/current/playbooks', {
      cookie: admin.cookie,
      body: { name: 'Rotate the API key', interpreter: 'cmd', body: 'echo rotating', vaultRefs: [ref] },
    });
    expect(pb.statusCode, pb.body).toBe(201);
    playbookId = (pb.json() as { id: string }).id;
    expect((pb.json() as { vaultRefs: unknown }).vaultRefs).toEqual([ref]);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
    await vault.close();
  });

  it('needs a typed reason, and the queued row holds no secret because the vault is not read at queue time', async () => {
    expect((await queue(runBody())).statusCode).toBe(400);
    const r = await queue(runBody('rotate the key before the audit'));
    expect(r.statusCode, r.body).toBe(202);
    const { actionId } = r.json() as { actionId: string };
    expect(r.json()).toMatchObject({ state: 'queued' });
    // Rule 9.8: "never at queue time, so secrets never rest in the queue".
    expect(vault.reads).toEqual([]);
    expect(await injected()).toHaveLength(0);
    const row = await getDeviceAction(t.ctx.db, actionId);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain('sealed');
  });

  it('seals the secret to that one device at dispatch, out of band of the queue reply, and chains only the ref', async () => {
    ws = await connectDevice(url, d, { track: sockets });
    const hello = await ws.next('device.hello.ok');
    // A vault-backed action is never part of `hello.ok.queued`; it arrives as its own push with the sealed value.
    expect(hello['queued']).toEqual([]);
    const frame = await ws.next('device.action');
    expect(vault.reads).toEqual([`${admin.org.id}/${ref.path}`]);
    const secrets = frame['secrets'] as { env: string; sealed: Sealed }[];
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.env).toBe(ref.env);
    expect(new TextDecoder().decode(openSealed(d.kexSecret, d.deviceId, 'vault-secret', secrets[0]!.sealed))).toBe(SECRET);
    // Sealed to one device: the sibling device's sealing key, the sibling's id, and any other purpose all fail.
    expect(() => openSealed(other.kexSecret, other.deviceId, 'vault-secret', secrets[0]!.sealed)).toThrow();
    expect(() => openSealed(d.kexSecret, other.deviceId, 'vault-secret', secrets[0]!.sealed)).toThrow();
    expect(() => openSealed(d.kexSecret, d.deviceId, 'amt-cred', secrets[0]!.sealed)).toThrow();
    // The chain records which env name came from which path, with the reason, and never the value itself.
    const entries = await injected();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actorType).toBe('system');
    expect(entries[0]!.data).toMatchObject({ actionId: frame['actionId'], deviceId: d.deviceId, refs: [ref], reason: 'rotate the key before the audit' });
    expect(JSON.stringify(entries[0])).not.toContain(SECRET);
    const all = await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { limit: 200 });
    expect(JSON.stringify(all.items)).not.toContain(SECRET);
    // Nor is the sealed blob kept anywhere: the row carries the dispatch state only.
    const row = await getDeviceAction(t.ctx.db, String(frame['actionId']));
    expect(row?.state).toBe('dispatched');
    expect(JSON.stringify(row)).not.toContain(secrets[0]!.sealed.ct);
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('is for one use: the next dispatch reads the vault again and seals a fresh blob', async () => {
    const before = vault.reads.length;
    const r = await queue(runBody('second rotation'));
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ state: 'dispatched' });
    const frame = await ws.next('device.action', (m) => m['actionId'] === (r.json() as { actionId: string }).actionId);
    expect(vault.reads.length).toBe(before + 1);
    const sealed = (frame['secrets'] as { sealed: Sealed }[])[0]!.sealed;
    const first = (await injected()).map((e) => (e.data as { actionId: string }).actionId);
    expect(new Set(first).size).toBe(2);
    expect(new TextDecoder().decode(openSealed(d.kexSecret, d.deviceId, 'vault-secret', sealed))).toBe(SECRET);
    // A fresh ephemeral key and nonce per dispatch, so a captured blob is never replayable as "the" secret.
    const again = await queue(runBody('third rotation'));
    const third = await ws.next('device.action', (m) => m['actionId'] === (again.json() as { actionId: string }).actionId);
    const sealed3 = (third['secrets'] as { sealed: Sealed }[])[0]!.sealed;
    expect(sealed3.ct).not.toBe(sealed.ct);
    expect(sealed3.nonce).not.toBe(sealed.nonce);
    expect(sealed3.epk).not.toBe(sealed.epk);
  });

  it('a vault that is down or missing the secret fails the action vault_unavailable and chains no injection', async () => {
    const before = (await injected()).length;
    vault.fail = 502;
    const r = await queue(runBody('while the vault is down'));
    expect(r.statusCode, r.body).toBe(202);
    const { actionId } = r.json() as { actionId: string };
    const row = await getDeviceAction(t.ctx.db, actionId);
    expect(row?.state).toBe('failed');
    expect(row?.result).toMatchObject({ error: 'vault_unavailable' });
    vault.fail = null;
    // A reachable vault with nothing at the path is the same honest failure, not a run with an empty secret.
    vault.secrets.delete(`${admin.org.id}/${ref.path}`);
    const gone = await queue(runBody('after the secret was removed'));
    const goneRow = await getDeviceAction(t.ctx.db, (gone.json() as { actionId: string }).actionId);
    expect(goneRow?.state).toBe('failed');
    expect(goneRow?.result).toMatchObject({ error: 'vault_unavailable' });
    expect(await injected()).toHaveLength(before);
    const states = (await listActions()).items.filter((a) => a.result?.error === 'vault_unavailable');
    expect(states.length).toBe(2);
    vault.secrets.set(`${admin.org.id}/${ref.path}`, { value: SECRET });
  });
});
