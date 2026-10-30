/**
 * Phase C section 8: catalogue RBAC and body gating, cross-org 404, cursor scoping, server hash, required patterns,
 * the body lint, the run order (bad_state, 404, disabled, changed, elevation, args), the 202 body, a technician run
 * end to end with the audit pair by opId, and the starter catalogue (bodies equal scripts/playbooks).
 */
import { readFileSync } from 'node:fs';
import { opIdFor, sha256Hex } from '@indiansassist/shared';
import { getPlaybookRun, listAuditBySession } from '@indiansassist/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_PLAYBOOKS } from '../src/playbooks/starter.js';
import { addMember, call, createToken, listen, SignalClient, type Account, type TestApp } from './helpers.js';
import { licenceP3, makeP3App, P3Kit, p3Admin } from './p3-kit.js';

let t: TestApp;
let url: string;
let admin: Account;
let other: Account;
let tech: Account;
let kit: P3Kit;

beforeAll(async () => {
  t = await makeP3App();
  url = await listen(t.app);
  admin = await p3Admin(t);
  other = await p3Admin(t);
  tech = await addMember(t.app, admin, 'technician');
  await licenceP3(t, tech, admin);
});
afterAll(async () => {
  await t.close();
});
afterEach(() => kit?.closeAll());

const PB = '/api/v1/orgs/current/playbooks';
type Pb = { id: string; name: string; bodyHash: string; body?: string; enabled: boolean };

async function create(acc: Account, body: Record<string, unknown>) {
  return call(t.app, PB, { cookie: acc.cookie, body });
}

describe('catalogue', () => {
  it('a P3 signup is seeded with the starter catalogue whose bodies equal scripts/playbooks', async () => {
    const list = (await call(t.app, `${PB}?limit=50`, { cookie: admin.cookie })).json().items as Pb[];
    for (const s of STARTER_PLAYBOOKS) {
      const file = readFileSync(new URL(`../../../scripts/playbooks/${s.file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      expect(file).toBe(s.body);
      const row = list.find((p) => p.name === s.name);
      expect(row?.bodyHash).toBe(sha256Hex(s.body));
    }
  });

  it('RBAC: create is org_admin, bodies only for admin / senior / auditor; lint and patterns', async () => {
    const auditor = await addMember(t.app, admin, 'auditor');
    const observer = await addMember(t.app, admin, 'observer');
    expect((await create(tech, { name: 'X', interpreter: 'cmd', body: 'echo x' })).statusCode).toBe(403);
    const r = await create(admin, { name: 'Ping host', interpreter: 'powershell', body: 'Test-Connection $env:IA_PARAM_HOST -Count 1', parameters: [{ name: 'host', label: 'Host', type: 'string', required: true, pattern: '[a-z0-9.-]{1,64}' }] });
    expect(r.statusCode).toBe(201);
    const pb = r.json() as Pb;
    expect(pb.bodyHash).toBe(sha256Hex('Test-Connection $env:IA_PARAM_HOST -Count 1'));
    expect((await create(admin, { name: 'Ping host', interpreter: 'cmd', body: 'x' })).json().error.code).toBe('playbook_name_taken');
    const lint = await create(admin, { name: 'Bad', interpreter: 'cmd', body: 'ping %IA_PARAM_HOST%' });
    expect(lint.statusCode).toBe(400);
    expect(lint.json().error.details.lint.errors).toHaveLength(1);
    const noPattern = await create(admin, { name: 'NoPat', interpreter: 'cmd', body: 'x', parameters: [{ name: 'a', label: 'A', type: 'string', required: true }] });
    expect(noPattern.statusCode).toBe(400);
    const bodyOf = async (acc: Account) => ((await call(t.app, `${PB}?limit=200`, { cookie: acc.cookie })).json().items as Pb[]).find((p) => p.id === pb.id)?.body;
    expect(await bodyOf(admin)).toBeDefined();
    expect(await bodyOf(auditor)).toBeDefined();
    expect(await bodyOf(tech)).toBeUndefined();
    expect(await bodyOf(observer)).toBeUndefined();
  });

  it('PATCH recomputes the hash and is audited; cross-org ids are 404; cursors stay in the org; DELETE 204', async () => {
    const pb = (await create(admin, { name: 'Edit me', interpreter: 'cmd', body: 'echo 1' })).json() as Pb;
    const p = await call(t.app, `${PB}/${pb.id}`, { method: 'PATCH', cookie: admin.cookie, body: { body: 'echo 2' } });
    expect(p.json().bodyHash).toBe(sha256Hex('echo 2'));
    expect((await call(t.app, `${PB}/${pb.id}`, { method: 'PATCH', cookie: other.cookie, body: { enabled: false } })).statusCode).toBe(404);
    expect((await call(t.app, `${PB}/${pb.id}`, { method: 'DELETE', cookie: other.cookie })).statusCode).toBe(404);
    const first = (await call(t.app, `${PB}?limit=2`, { cookie: other.cookie })).json();
    const next = (await call(t.app, `${PB}?limit=200&cursor=${encodeURIComponent(first.nextCursor)}`, { cookie: other.cookie })).json();
    expect([...first.items, ...next.items].some((x: Pb) => x.id === pb.id)).toBe(false);
    expect((await call(t.app, `${PB}/${pb.id}`, { method: 'DELETE', cookie: admin.cookie })).statusCode).toBe(204);
    const audit = await call(t.app, '/api/v1/audit?limit=50', { cookie: admin.cookie });
    const acts = (audit.json().items as { action: string }[]).map((e) => e.action);
    expect(acts).toEqual(expect.arrayContaining(['playbook.created', 'playbook.updated', 'playbook.deleted']));
  });
});

describe('run', () => {
  it('order: p1 session bad_state, cross-org 404, disabled, changed, elevation_required, args; then 202', async () => {
    kit = new P3Kit(t, url);
    const flush = ((await call(t.app, `${PB}?limit=200`, { cookie: admin.cookie })).json().items as Pb[]).find((p) => p.name === 'Flush DNS cache')!;
    const spooler = ((await call(t.app, `${PB}?limit=200`, { cookie: admin.cookie })).json().items as Pb[]).find((p) => p.name === 'Restart Print Spooler')!;
    const toEdit = (await create(admin, { name: 'Mid-session edit', interpreter: 'cmd', body: 'echo a' })).json() as Pb;
    const toDisable = (await create(admin, { name: 'Will be disabled', interpreter: 'cmd', body: 'echo b' })).json() as Pb;
    const ping = ((await call(t.app, `${PB}?limit=200`, { cookie: admin.cookie })).json().items as Pb[]).find((p) => p.name === 'Ping host')!;
    const a = await kit.active(admin);
    const run = (id: string, body: Record<string, unknown> = { args: {} }, acc = admin) => call(t.app, `/api/v1/sessions/${a.sessionId}/playbooks/${id}/run`, { cookie: acc.cookie, body });
    const otherPb = ((await call(t.app, `${PB}?limit=200`, { cookie: other.cookie })).json().items as Pb[])[0]!;
    expect((await run(otherPb.id)).statusCode).toBe(404);
    await call(t.app, `${PB}/${toDisable.id}`, { method: 'PATCH', cookie: admin.cookie, body: { enabled: false } });
    expect((await run(toDisable.id)).json().error.code).toBe('playbook_disabled');
    await call(t.app, `${PB}/${toEdit.id}`, { method: 'PATCH', cookie: admin.cookie, body: { body: 'echo changed' } });
    expect((await run(toEdit.id)).json().error.code).toBe('playbook_changed');
    expect((await run(spooler.id)).json().error.code).toBe('elevation_required');
    expect((await run(ping.id, { args: { host: 'bad host!' } })).statusCode).toBe(400);
    expect((await run(ping.id, { args: { host: 1 } })).statusCode).toBe(400);
    const ok = await run(ping.id, { args: { host: 'example.com' }, reason: 'check reachability' });
    expect(ok.statusCode).toBe(202);
    const r = ok.json();
    expect(r).toMatchObject({ playbookId: ping.id, body: 'Test-Connection $env:IA_PARAM_HOST -Count 1', interpreter: 'powershell', args: { host: 'example.com' } });
    expect(r.opId).toBe(opIdFor(a.sessionId, r.runId));
    expect((await run(flush.id)).statusCode).toBe(202);
    const p1 = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed', ttlMinutes: 30 });
    const assist = await kit.assist(admin);
    const d = await SignalClient.open(url);
    kit.clients.push(d);
    await d.request({ t: 'desk.hello', token: p1.compact }, 'desk.hello.ok');
    const knock = await d.request({ t: 'desk.knock' }, 'knock.ok');
    await assist.next('assist.knock', (m) => m.sessionId === knock.sessionId);
    await assist.request({ t: 'assist.accept', sessionId: knock.sessionId }, 'session.created');
    const bad = await call(t.app, `/api/v1/sessions/${knock.sessionId}/playbooks/${flush.id}/run`, { cookie: admin.cookie, body: { args: {} } });
    expect(bad.json().error.code).toBe('bad_state');
  });

  it('a technician completes a run end to end; the run pairs with the desk attestation by opId', async () => {
    kit = new P3Kit(t, url);
    const a = await kit.active(tech);
    const flush = ((await call(t.app, `${PB}?limit=200`, { cookie: tech.cookie })).json().items as Pb[]).find((p) => p.name === 'Flush DNS cache')!;
    expect(flush.body).toBeUndefined();
    const ok = await call(t.app, `/api/v1/sessions/${a.sessionId}/playbooks/${flush.id}/run`, { cookie: tech.cookie, body: { args: {} } });
    expect(ok.statusCode).toBe(202);
    const r = ok.json();
    expect(r.body).toBe(STARTER_PLAYBOOKS.find((s) => s.name === 'Flush DNS cache')!.body);
    expect((await call(t.app, `/api/v1/sessions/${a.sessionId}/playbooks/${flush.id}/run`, { cookie: admin.cookie, body: { args: {} } })).statusCode).toBe(403);
    const attest = { playbookId: flush.id, bodyHash: r.bodyHash, runId: r.runId, opId: r.opId, exit: 0, durationMs: 120, truncated: false, ranAs: 'user' };
    const bad = await a.desk.request({ t: 'desk.event', sessionId: a.sessionId, action: 'playbook.run', data: { ...attest, opId: 'ffffffffffffffff' } }, 'error');
    expect(bad.code).toBe('bad_payload');
    await a.desk.request({ t: 'desk.event', sessionId: a.sessionId, action: 'playbook.run', data: attest }, 'event.ok');
    const entries = await listAuditBySession(t.db, a.sessionId);
    const pair = entries.filter((e) => (e.data as { opId?: string }).opId === r.opId).map((e) => `${e.action}:${e.actorType}`);
    expect(pair).toEqual(['playbook.run_requested:user', 'playbook.run:desk']);
    expect((await getPlaybookRun(t.db, a.sessionId, r.runId))?.exitCode).toBe(0);
  });
});

describe('scripts/seed-playbooks.mjs', () => {
  it('catalogue.json agrees with the api starter set; seeding is idempotent through the REST API', async () => {
    const { resolve } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const mod = (await import(pathToFileURL(resolve(t.ctx.config.repoRoot, 'scripts', 'seed-playbooks.mjs')).href)) as {
      loadStarterCatalogue: () => { name: string; body: string; interpreter: string; requiresElevation: boolean; timeoutSec: number; description: string; file: string }[];
      seedPlaybooks: (o: Record<string, unknown>) => Promise<{ created: number; skipped: number }>;
    };
    expect(mod.loadStarterCatalogue()).toEqual(STARTER_PLAYBOOKS.map((s) => ({ ...s })));
    const email = `seed-${Date.now()}@example.test`;
    const res = await call(t.app, '/api/v1/auth/signup', { body: { orgName: 'Seed org', name: 'Seed Admin', email, password: 'correct horse battery' } });
    expect(res.statusCode).toBe(201);
    const apiUrl = url.replace(/^ws/, 'http').replace(/\/signal$/, '');
    const first = await mod.seedPlaybooks({ apiUrl, email, password: 'correct horse battery', webOrigin: 'http://localhost:5173', log: () => undefined });
    expect(first).toEqual({ created: 0, skipped: 4 });
  });
});
