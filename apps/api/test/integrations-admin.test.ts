/**
 * Phase E section 15.3, the integration admin routes (section 4.7): RBAC per section 2.3, credentials sealed and never
 * echoed (no response body, audit entry or captured log line carries the plaintext), `egress_refused` for a private
 * or metadata URL at save, `available` for technicians, the Zoho data-centre table gate, the test route and the
 * `integration.*` chain entries with their actors.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { integrationSchema, type Integration } from '@indiansassist/shared';
import { auditEntry, getIntegration } from '@indiansassist/db';
import { asc, eq } from 'drizzle-orm';
import { addMember, call, captureLogLines, signup, type Account, type TestApp } from './helpers.js';
import { FakeTicketing, freshdeskRoutes, jiraRoutes, servicenowRoutes } from './fake-ticketing.js';
import { configureJira, endedSession, JIRA_CREDS, jiraConfig, makeTicketApp, manualPush } from './tickets-kit.js';
import { createFreshdeskAdapter } from '../src/integrations/adapters/freshdesk.js';
import { INTEGRATION_ADAPTERS } from '../src/integrations/adapter.js';

let t: TestApp;
const listAuditByOrg = (db: TestApp['db'], orgId: string) => db.select().from(auditEntry).where(eq(auditEntry.orgId, orgId)).orderBy(asc(auditEntry.seq));
let f: FakeTicketing;
let logs: string[];
let admin: Account;

beforeAll(async () => {
  t = await makeTicketApp({}, 'info');
  logs = captureLogLines(t.app);
  f = await FakeTicketing.start();
  admin = await signup(t.app);
});
afterAll(async () => {
  await f.close();
  await t.close();
});
beforeEach(() => {
  f.reset();
  jiraRoutes(f);
  servicenowRoutes(f);
});

const put = (acc: Account, type: string, body: unknown) => call(t.app, `/api/v1/integrations/${type}`, { method: 'PUT', cookie: acc.cookie, body });

describe('RBAC (section 2.3)', () => {
  it('org_admin configures; auditor reads; technicians see only what is available; observers nothing', async () => {
    const org = await signup(t.app);
    const tech = await addMember(t.app, org, 'technician');
    const senior = await addMember(t.app, org, 'senior_technician');
    const auditor = await addMember(t.app, org, 'auditor');
    const observer = await addMember(t.app, org, 'observer');
    for (const acc of [tech, senior, auditor, observer]) expect((await put(acc, 'jira', { enabled: true, config: jiraConfig(f.url), credentials: JIRA_CREDS })).statusCode).toBe(403);
    await configureJira(t, org, f.url);
    for (const acc of [tech, senior, observer]) {
      expect((await call(t.app, '/api/v1/integrations', { cookie: acc.cookie })).statusCode).toBe(403);
      expect((await call(t.app, '/api/v1/integrations/jira', { cookie: acc.cookie })).statusCode).toBe(403);
    }
    const listed = await call(t.app, '/api/v1/integrations', { cookie: auditor.cookie });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: Integration[] }).items.map((i) => i.type)).toEqual(['jira']);
    for (const acc of [tech, senior, auditor, org]) expect((await call(t.app, '/api/v1/integrations/available', { cookie: acc.cookie })).json()).toEqual({ items: [{ type: 'jira', enabled: true }] });
    expect((await call(t.app, '/api/v1/integrations/available', { cookie: observer.cookie })).statusCode).toBe(403);
    for (const acc of [tech, auditor]) {
      expect((await call(t.app, '/api/v1/integrations/jira/test', { cookie: acc.cookie, body: {} })).statusCode).toBe(403);
      expect((await call(t.app, '/api/v1/integrations/jira', { method: 'DELETE', cookie: acc.cookie })).statusCode).toBe(403);
      expect((await call(t.app, '/api/v1/integrations/webhook/rotate-secret', { cookie: acc.cookie, body: {} })).statusCode).toBe(403);
    }
    expect((await call(t.app, '/api/v1/integrations/jira')).statusCode).toBe(401);
  });

  it('unknown or unconfigured types are 404; another org sees nothing', async () => {
    expect((await call(t.app, '/api/v1/integrations/nope', { cookie: admin.cookie })).statusCode).toBe(404);
    expect((await put(admin, 'nope', { enabled: true, config: {} })).statusCode).toBe(404);
    expect((await call(t.app, '/api/v1/integrations/freshdesk', { cookie: admin.cookie })).statusCode).toBe(404);
    expect((await call(t.app, '/api/v1/integrations/freshdesk', { method: 'DELETE', cookie: admin.cookie })).statusCode).toBe(404);
    const r = await call(t.app, '/api/v1/integrations/freshdesk/test', { cookie: admin.cookie, body: {} });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'integration_not_configured']);
    const other = await signup(t.app);
    await configureJira(t, other, f.url);
    expect((await call(t.app, '/api/v1/integrations', { cookie: admin.cookie })).json().items.map((i: Integration) => i.type)).not.toContain('jira');
  });
});

describe('credentials are write-only (section 2.1)', () => {
  it('sealed, shown as SecretStatus, never in a response, the chain or a log line', async () => {
    const org = await signup(t.app);
    const r = await put(org, 'servicenow', {
      enabled: true,
      config: { instanceUrl: f.url, callerId: null, assignmentGroup: null, urgency: 2 },
      credentials: { username: 'svc-user', password: 'sn-PASSWORD-plaintext-9' },
    });
    expect(r.statusCode, r.body).toBe(200);
    const i = r.json() as Integration;
    expect(integrationSchema.safeParse(i).success).toBe(true);
    expect(i).toMatchObject({ type: 'servicenow', enabled: true, config: { instanceUrl: f.url, urgency: 2 }, lastTest: null, updatedBy: { id: org.user.id } });
    expect(i.credentials).toEqual({ set: true, setAt: expect.any(String), fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) });
    const row = (await getIntegration(t.db, org.org.id, 'servicenow'))!;
    expect(row.credentialsEnc).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(row.credentialsEnc).not.toContain('sn-PASSWORD');
    // Test and push use them.
    const test = await call(t.app, '/api/v1/integrations/servicenow/test', { cookie: org.cookie, body: {} });
    expect(test.json()).toEqual({ ok: true, cause: null, detail: null, account: null });
    expect(f.last().headers.authorization).toBe(`Basic ${Buffer.from('svc-user:sn-PASSWORD-plaintext-9').toString('base64')}`);
    const sid = await endedSession(t, org);
    expect((await call(t.app, '/api/v1/integrations/servicenow/ticket', { cookie: org.cookie, body: manualPush(sid) })).json().push.state).toBe('delivered');
    // The same fingerprint for the same plaintext; absent credentials keep them; null clears them.
    const keep = await put(org, 'servicenow', { enabled: true, config: { instanceUrl: f.url, callerId: null, assignmentGroup: null, urgency: 1 } });
    expect((keep.json() as Integration).credentials.fingerprint).toBe(i.credentials.fingerprint);
    const cleared = await put(org, 'servicenow', { enabled: true, config: { instanceUrl: f.url, callerId: null, assignmentGroup: null, urgency: 1 }, credentials: null });
    expect((cleared.json() as Integration).credentials).toEqual({ set: false, setAt: null, fingerprint: null });
    const noCreds = await call(t.app, '/api/v1/integrations/servicenow/test', { cookie: org.cookie, body: {} });
    expect(noCreds.json()).toMatchObject({ ok: false, cause: 'misconfigured' });
    const reads = [
      (await call(t.app, '/api/v1/integrations', { cookie: org.cookie })).body,
      (await call(t.app, '/api/v1/integrations/servicenow', { cookie: org.cookie })).body,
      r.body,
      keep.body,
      JSON.stringify(await listAuditByOrg(t.db, org.org.id)),
      logs.join('\n'),
    ];
    for (const text of reads) {
      expect(text).not.toContain('sn-PASSWORD-plaintext-9');
      expect(text).not.toContain(JIRA_CREDS.apiToken);
    }
    // One egress line per call, without path or headers.
    const egressLines = logs.filter((l) => l.includes('"msg":"egress"'));
    expect(egressLines.length).toBeGreaterThan(0);
    for (const l of egressLines) expect(l).not.toContain('/api/now');
  });

  it('validates config and credentials per type', async () => {
    const org = await signup(t.app);
    const bad = await put(org, 'jira', { enabled: true, config: { ...jiraConfig(f.url), projectKey: 'lower' }, credentials: JIRA_CREDS });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'validation_failed']);
    const mismatch = await put(org, 'jira', { enabled: true, config: { ...jiraConfig(f.url), deployment: 'data_center' }, credentials: JIRA_CREDS });
    expect([mismatch.statusCode, mismatch.json().error.code]).toEqual([400, 'validation_failed']);
    const path = await put(org, 'servicenow', { enabled: true, config: { instanceUrl: `${f.url}/path`, callerId: null, assignmentGroup: null, urgency: null } });
    expect(path.statusCode).toBe(400);
    const badCred = await put(org, 'freshdesk', { enabled: true, config: { domain: 'acme', defaultRequesterEmail: 'h@acme.example.test', priority: 2, groupId: null }, credentials: { apiKey: '' } });
    expect(badCred.statusCode).toBe(400);
    // Jira defaults: issueType Task, labels [].
    const ok = await put(org, 'jira', { enabled: false, config: { siteUrl: f.url, deployment: 'cloud', projectKey: 'OPS' }, credentials: JIRA_CREDS });
    expect((ok.json() as Integration).config).toMatchObject({ issueType: 'Task', labels: [] });
  });

  it('Zoho validates only against the verified data-centre table', async () => {
    const org = await signup(t.app);
    const r = await put(org, 'zoho_desk', {
      enabled: true,
      config: { dataCenter: 'com', orgId: '123', departmentId: '456', defaultContactEmail: 'h@acme.example.test', priority: null },
      credentials: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' },
    });
    expect([r.statusCode, r.json().error.code]).toEqual([400, 'validation_failed']);
    expect(r.body).toContain('not a verified Zoho data centre');
  });
});

describe('egress at save (section 4.2)', () => {
  it.each([
    ['private', 'http://10.1.2.3'],
    ['metadata', 'http://169.254.169.254'],
  ])('a %s address is 400 egress_refused', async (_n, url) => {
    const org = await signup(t.app);
    const r = await put(org, 'jira', { enabled: true, config: jiraConfig(url), credentials: JIRA_CREDS });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'egress_refused', details: { cause: 'private_address' } });
    const hook = await put(org, 'webhook', { enabled: true, config: { url: `${url}/hook` } });
    expect(hook.json().error.code).toBe('egress_refused');
    expect(await getIntegration(t.db, org.org.id, 'jira')).toBeNull();
  });

  it('http is refused unless EGRESS_ALLOW_HTTP is set', async () => {
    const strict = await makeTicketApp({ EGRESS_ALLOW_HTTP: '' });
    try {
      const org = await signup(strict.app);
      const r = await call(strict.app, '/api/v1/integrations/jira', { method: 'PUT', cookie: org.cookie, body: { enabled: true, config: jiraConfig(f.url), credentials: JIRA_CREDS } });
      expect(r.json().error).toMatchObject({ code: 'egress_refused', details: { cause: 'scheme' } });
    } finally {
      await strict.close();
    }
  });
});

describe('test, delete and the chain (section 13.3)', () => {
  it('test reports the honest cause and records lastTest; every admin action is chained by the user', async () => {
    const org = await signup(t.app);
    await configureJira(t, org, f.url);
    const ok = await call(t.app, '/api/v1/integrations/jira/test', { cookie: org.cookie, body: {} });
    expect(ok.json()).toEqual({ ok: true, cause: null, detail: null, account: 'IndiansAssist Bot' });
    f.script({ status: 401 });
    const denied = await call(t.app, '/api/v1/integrations/jira/test', { cookie: org.cookie, body: {} });
    expect(denied.json()).toEqual({ ok: false, cause: 'auth', detail: 'HTTP 401', account: null });
    const read = (await call(t.app, '/api/v1/integrations/jira', { cookie: org.cookie })).json() as Integration;
    expect(read.lastTest).toMatchObject({ ok: false, cause: 'auth' });
    expect((await call(t.app, '/api/v1/integrations/jira', { method: 'DELETE', cookie: org.cookie })).statusCode).toBe(204);
    expect(await getIntegration(t.db, org.org.id, 'jira')).toBeNull();
    const entries = (await listAuditByOrg(t.db, org.org.id))
      .filter((e) => e.action.startsWith('integration.'))
      .map((e) => [e.action, e.actorType, e.data, e.sessionId]);
    expect(entries).toEqual([
      ['integration.updated', 'user', { type: 'jira', enabled: true, fields: ['deployment', 'enabled', 'issueType', 'labels', 'projectKey', 'siteUrl'], credentialsChanged: true }, null],
      ['integration.tested', 'user', { type: 'jira', ok: true, cause: null }, null],
      ['integration.tested', 'user', { type: 'jira', ok: false, cause: 'auth' }, null],
      ['integration.deleted', 'user', { type: 'jira' }, null],
    ]);
  });

  it('a changed field is named without its value', async () => {
    const org = await signup(t.app);
    await configureJira(t, org, f.url);
    await put(org, 'jira', { enabled: true, config: { ...jiraConfig(f.url), projectKey: 'SEC' } });
    const last = (await listAuditByOrg(t.db, org.org.id)).filter((e) => e.action === 'integration.updated').at(-1)!;
    expect(last.data).toEqual({ type: 'jira', enabled: true, fields: ['projectKey'], credentialsChanged: false });
  });

  it('freshdesk through an in-process fake (the adapter base URL is injected)', async () => {
    const saved = INTEGRATION_ADAPTERS.freshdesk;
    INTEGRATION_ADAPTERS.freshdesk = createFreshdeskAdapter({ baseUrlOf: () => f.url });
    try {
      freshdeskRoutes(f);
      const org = await signup(t.app);
      const r = await put(org, 'freshdesk', { enabled: true, config: { domain: 'acme', defaultRequesterEmail: 'h@acme.example.test', priority: 2, groupId: null }, credentials: { apiKey: 'fd-key' } });
      expect(r.statusCode).toBe(200);
      expect((await call(t.app, '/api/v1/integrations/freshdesk/test', { cookie: org.cookie, body: {} })).json()).toMatchObject({ ok: true, account: 'Support Agent' });
      const sid = await endedSession(t, org);
      const p = await call(t.app, '/api/v1/integrations/freshdesk/ticket', { cookie: org.cookie, body: manualPush(sid) });
      expect(p.json().push).toMatchObject({ state: 'delivered', externalId: '4321' });
    } finally {
      INTEGRATION_ADAPTERS.freshdesk = saved;
    }
  });
});
