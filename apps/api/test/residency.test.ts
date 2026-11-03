/**
 * Phase E section 6 (docs/specs/phase-e-contracts.md 6.2-6.4, 15.5): the signed data residency report. Every category
 * with its retention (including a set `recordingRetentionDays`), every flow kind appearing exactly when configured
 * (local and anthropic AI, each integration type, an IdP, SMTP, vault, third-party ICE, the recorder), the
 * `leavesRegion` rules (the Zoho data-centre match), the acknowledgement, `since` / `enabledBy` from the chain, the
 * statement sentences, `erasure`, the signature verifying against `/.well-known/indiansassist.json` (in process and
 * through `scripts/verify-residency.mjs`), an old report verifying after a key rotation, the signed download chained
 * once and rate limited, RBAC, and no secret in the report.
 *
 * The SSO, integration and AI rows belong to other streams; this file inserts them directly, with the chain entries
 * their routes would write, and only reads them back through the report.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_CATEGORIES,
  DEFAULT_AI_POLICY,
  residencyReportSchema,
  verifyResidencyReport,
  type AiPolicy,
  type DataFlow,
  type SsoConfig,
  type ZohoDataCenter,
} from '@indiansassist/shared';
import {
  auditEntry,
  createAuthSession,
  createSession,
  insertSessionSummary,
  insertTicketPush,
  org as orgTable,
  seedToken,
  ssoDomain,
  upsertIntegration,
  user as userTable,
  type OrgRow,
  type UserRow,
} from '@indiansassist/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userActor, writeAudit } from '../src/lib/audit.js';
import { integrationFlow, lastEnabling, recordingRetentionText, type ChainRow } from '../src/services/residency.js';
import { addMember, call, listen, signup, type Account, type TestApp, makeApp } from './helpers.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFY = join(REPO, 'scripts', 'verify-residency.mjs');
const SMTP_PASSWORD = 'smtp-pass-0123456789';
const SEALED = 'k1.c2VhbGVkLW5vbmNl.c2VhbGVkLWNpcGhlcnRleHQ';
const FP = '0a1b2c3d';

type Report = Record<string, unknown> & {
  org: { id: string; name: string };
  statement: string;
  retention: { recordings: string; piiInChain: string; auditEntries: string };
  dataCategories: { category: string; retention: string; count: number | null; bytes: number | null; stores: { kind: string; detail: string }[] }[];
  dataFlows: DataFlow[];
  subprocessors: string[];
  activity30d: { summaries: number; ticketPushes: number; ssoLogins: number };
  sso: { protocol: string | null; enabled: boolean; required: boolean; verifiedDomains: string[] };
  recorder: { enabled: boolean };
  erasure: { available: boolean; state?: string; scheduledFor?: string | null; note: string };
  signature: { kid: string; sha256: string; pub: string; sig: string };
};

const OIDC: SsoConfig = {
  v: 1,
  protocol: 'oidc',
  enabled: true,
  displayName: 'Okta',
  oidc: {
    issuer: 'https://acme.okta.example/oauth2/default',
    clientId: 'client-1',
    tokenEndpointAuth: 'client_secret_basic',
    scopes: ['openid', 'email', 'profile'],
    emailClaim: 'email',
    nameClaim: 'name',
    groupsClaim: null,
    requiredClaims: [],
  },
  saml: null,
  jit: { enabled: false, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [] },
  sessionMaxAgeHours: 12,
};

let t: TestApp;
let admin: Account;
let auditor: Account;
/** Created before the org turns SSO required (the sso stream then refuses invites, section 3.7). */
let others: Account[] = [];
let orgRow: OrgRow;
let adminRow: UserRow;
let tmp: string;

async function report(app: TestApp, acc: Account): Promise<Report> {
  const res = await call(app.app, '/api/v1/orgs/current/residency', { cookie: acc.cookie });
  expect(res.statusCode).toBe(200);
  // The raw JSON as a client would hold it: verification never runs over a schema-parsed copy.
  return JSON.parse(res.body) as Report;
}

async function wellKnown(app: TestApp): Promise<{ keys: { kid: string; pub: string }[] }> {
  const res = await call(app.app, '/.well-known/indiansassist.json');
  expect(res.statusCode).toBe(200);
  return res.json();
}

function flow(r: Report, kind: DataFlow['kind'], name?: string): DataFlow | undefined {
  return r.dataFlows.find((f) => f.kind === kind && (name === undefined || f.name === name));
}

async function chain(action: string, data: Record<string, unknown>, by: UserRow = adminRow): Promise<void> {
  await writeAudit(t.ctx, t.db, orgRow, { actor: userActor(by), action: action as never, data: data as never });
}

async function setAi(policy: AiPolicy): Promise<void> {
  await t.db.update(orgTable).set({ aiPolicy: policy }).where(eq(orgTable.id, orgRow.id));
  await chain('ai.policy_updated', {
    provider: policy.provider,
    autoSummarize: policy.autoSummarize,
    includeTranscript: policy.includeTranscript,
    ackScope: policy.anthropicAck?.scope ?? null,
    ackTextVersion: policy.anthropicAck?.textVersion ?? null,
  });
  orgRow = (await t.db.select().from(orgTable).where(eq(orgTable.id, orgRow.id)))[0]!;
}

function runVerify(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [VERIFY, ...args], { encoding: 'utf8' }).trim() };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, out: String(e.stdout).trim() };
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ia-residency-'));
  t = await makeApp({
    MAIL_DRIVER: 'smtp',
    SMTP_URL: `smtp://mailer:${SMTP_PASSWORD}@mail.acme-relay.example:587`,
    VAULT_ADDR: 'https://vault.acme.example:8200',
    VAULT_ROLE_ID: 'role-id-test',
    VAULT_SECRET_ID: 'secret-id-test',
    RECORDER_TOKEN: 'recorder-token-0123456789abcdef0123456789',
    STUN_URLS: 'stun:turn.example.test:3478,stun:stun.public-ice.example:19302',
    AI_LOCAL_ENDPOINTS: 'in-mum=http://llm.in-mum.example.test:8080',
  });
  admin = await signup(t.app, { name: 'Priya Admin' });
  auditor = await addMember(t.app, admin, 'auditor', 'Arjun Auditor');
  others = [];
  for (const role of ['technician', 'senior_technician', 'observer']) others.push(await addMember(t.app, admin, role));
  orgRow = (await t.db.select().from(orgTable).where(eq(orgTable.id, admin.org.id)))[0]!;
  adminRow = (await t.db.select().from(userTable).where(eq(userTable.id, admin.user.id)))[0]!;
});

afterAll(async () => {
  await t?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('the report before any Phase E flow is configured', () => {
  it('has every category in order, the operator flows only, erasure, and widened retention texts', async () => {
    const r = await report(t, admin);
    expect(residencyReportSchema.safeParse(r).success).toBe(true);
    expect(r.dataCategories.map((c) => c.category)).toEqual([...DATA_CATEGORIES]);
    const cat = Object.fromEntries(r.dataCategories.map((c) => [c.category, c]));
    expect(cat.recordings!.retention).toBe('until deleted by an org_admin');
    expect(cat.recordings!.stores[0]).toMatchObject({ kind: 'object_store', detail: expect.stringContaining(`in-mum/${admin.org.id}/`) });
    expect(cat.audit!.retention).toBe('append-only, never deleted');
    expect(cat.identity!.count).toBe(5);
    expect(cat.files!.stores[0]!.detail).toMatch(/never stored/);
    expect(cat.fleet!.stores.map((s) => s.kind)).toEqual(['database', 'device']);
    expect(cat.summaries!.stores.map((s) => s.kind)).toEqual(['database']);
    expect(r.retention.recordings).toBe('until deleted by an org_admin');
    // Phase F section 5.7: erasure is available, and the chain text says what destroying the pepper does.
    expect(r.retention.piiInChain).toBe(
      'Personal data in the audit chain is stored only as hashes with a per-org pepper; erasure destroys the pepper, after which the hashes cannot be linked to anyone.',
    );
    expect(r.retention.auditEntries).toBe('append-only, never deleted');
    expect(r.erasure).toEqual({
      available: true,
      state: 'none',
      scheduledFor: null,
      note: "Erasure destroys this organisation's personal data and the audit pepper after two administrators approve it and a 7-day cooling-off period (an organisation with a single administrator: a mailed confirmation and a 14-day cooling-off period). Technician display names and typed reasons stay in the audit chain.",
    });
    // No org flow yet; only what the operator configured on this node.
    expect(r.dataFlows.map((f) => f.kind)).toEqual(['mail', 'vault', 'ice', 'recorder']);
    expect(r.sso).toEqual({ protocol: null, enabled: false, required: false, verifiedDomains: [] });
    expect(r.recorder).toEqual({ enabled: true });
    expect(r.activity30d).toEqual({ summaries: 0, ticketPushes: 0, ssoLogins: 0 });
    // Phase B and C fields stay on the wire.
    expect(r).toMatchObject({ extensionPolicy: { allowRelayFallback: true }, relaySessions: 0, relayBytes: 0, recordingRetentionDays: null, agentSessions: 0, elevationGrants: 0, playbookRuns: 0, devices: 0 });
  });

  it('operator flows: SMTP host without its credentials, vault, only the third-party ICE host, the recorder', async () => {
    const r = await report(t, admin);
    expect(flow(r, 'mail')).toEqual({
      kind: 'mail',
      name: 'SMTP relay',
      host: 'mail.acme-relay.example',
      leavesInfrastructure: true,
      leavesRegion: 'unknown',
      dataSent: 'consent receipts, invitations, password-reset links and break-glass and erasure notices',
      enabled: true,
      since: null,
      enabledBy: 'operator',
      acknowledgement: null,
    });
    expect(flow(r, 'vault')).toMatchObject({ host: 'vault.acme.example', leavesInfrastructure: false, enabledBy: 'operator', since: null });
    expect(r.dataFlows.filter((f) => f.kind === 'ice').map((f) => f.host)).toEqual(['stun.public-ice.example']);
    expect(flow(r, 'recorder')).toMatchObject({ leavesInfrastructure: false, leavesRegion: 'no', host: null });
    expect(r.subprocessors).toEqual(['SMTP relay', 'STUN/TURN stun.public-ice.example']);
    expect(r.statement).toMatch(/^All session metadata, recordings and audit entries for .* are stored and served in India \(Mumbai\)\./);
    expect(r.statement).toContain('Consent receipts and break-glass notices are sent through the SMTP relay (mail.acme-relay.example), whose location is not known to this report.');
    expect(r.statement).toContain('Connection candidates (IP addresses) may be sent to the third-party server stun.public-ice.example');
    // The recorder stays in the region, so it adds no sentence.
    expect(r.statement).not.toContain('Server recorder');
    const body = JSON.stringify(r);
    expect(body).not.toContain(SMTP_PASSWORD);
    expect(body).not.toContain('mailer');
    expect(body).not.toContain('secret-id-test');
    expect(body).not.toContain('recorder-token-');
  });

  it('a set recording retention period is reported in words, in both places', async () => {
    const res = await call(t.app, '/api/v1/orgs/current/policy/retention', { method: 'PATCH', cookie: admin.cookie, body: { recordingRetentionDays: 30 } });
    expect(res.statusCode).toBe(200);
    const r = await report(t, admin);
    expect(r.recordingRetentionDays).toBe(30);
    expect(r.retention.recordings).toBe('deleted 30 days after recording (org setting)');
    expect(r.dataCategories.find((c) => c.category === 'recordings')!.retention).toBe('deleted 30 days after recording (org setting)');
    expect(recordingRetentionText(null)).toBe('until deleted by an org_admin');
  });
});

describe('Phase E flows from the rows of the other streams', () => {
  it('an IdP: the sso_idp flow with since and enabledBy from the chain, the sso block and verified domains', async () => {
    await t.db.update(orgTable).set({ ssoConfig: OIDC as unknown as Record<string, unknown>, ssoRequired: true, ssoSecretEnc: SEALED, ssoSecretFp: FP, ssoSecretSetAt: new Date() }).where(eq(orgTable.id, orgRow.id));
    await chain('sso.config_updated', { protocol: 'oidc', enabled: false, fields: ['issuer'], secretChanged: true });
    await chain('sso.config_updated', { protocol: 'oidc', enabled: true, fields: ['enabled'], secretChanged: false });
    await chain('sso.config_updated', { protocol: 'oidc', enabled: true, fields: ['displayName'], secretChanged: false });
    await t.db.insert(ssoDomain).values([
      { orgId: orgRow.id, domain: 'acme.example', status: 'verified', verifyToken: 'a'.repeat(32), verifiedAt: new Date(), createdBy: adminRow.id },
      { orgId: orgRow.id, domain: 'pending.example', status: 'pending', verifyToken: 'b'.repeat(32), createdBy: adminRow.id },
    ]);
    const entries = await t.db.select().from(auditEntry).where(and(eq(auditEntry.orgId, orgRow.id), eq(auditEntry.action, 'sso.config_updated')));
    const enabledAt = entries.sort((a, b) => a.seq - b.seq)[1]!.ts.toISOString();
    const r = await report(t, admin);
    expect(flow(r, 'sso_idp')).toEqual({
      kind: 'sso_idp',
      name: 'Okta (OIDC)',
      host: 'acme.okta.example',
      leavesInfrastructure: true,
      leavesRegion: 'unknown',
      dataSent: "sign-in requests; the IdP returns the user's email and name",
      enabled: true,
      since: enabledAt,
      enabledBy: 'Priya Admin',
      acknowledgement: null,
    });
    expect(r.sso).toEqual({ protocol: 'oidc', enabled: true, required: true, verifiedDomains: ['acme.example'] });
    expect(r.subprocessors).toContain('Okta (OIDC)');
    expect(r.statement).toContain('Sign-in requests are sent to the identity provider Okta (OIDC) (acme.okta.example), whose location is not known to this report.');
    expect(r.dataCategories.find((c) => c.category === 'identity')!.stores[0]!.detail).toContain('SSO identities');
    const body = JSON.stringify(r);
    expect(body).not.toContain(SEALED);
    expect(body).not.toContain(FP);
  });

  it('each integration type is one flow, enabled or not, with hosts only and since from integration.updated', async () => {
    const add = async (type: 'jira' | 'servicenow' | 'freshdesk' | 'webhook' | 'zoho_desk', enabled: boolean, config: Record<string, unknown>) => {
      await upsertIntegration(t.db, { orgId: orgRow.id, type, enabled, config, updatedBy: adminRow.id, credentials: { enc: SEALED, fingerprint: FP } });
      await chain('integration.updated', { type, enabled, fields: Object.keys(config), credentialsChanged: true });
    };
    await add('jira', true, { siteUrl: 'https://acme.atlassian.example', deployment: 'cloud', projectKey: 'OPS', issueType: 'Task', labels: [] });
    await add('servicenow', true, { instanceUrl: 'https://acme.service-now.example', callerId: null, assignmentGroup: null, urgency: null });
    await add('freshdesk', false, { domain: 'acme', defaultRequesterEmail: 'help@acme.example', priority: 1, groupId: null });
    await add('webhook', true, { origin: 'https://hooks.acme.example', pathSet: true });
    await add('zoho_desk', true, { dataCenter: 'xx', orgId: '1', departmentId: '2', defaultContactEmail: 'help@acme.example', priority: null });
    const r = await report(t, admin);
    expect(flow(r, 'ticketing', 'Jira Cloud')).toMatchObject({ host: 'acme.atlassian.example', leavesInfrastructure: true, leavesRegion: 'unknown', enabled: true, enabledBy: 'Priya Admin' });
    expect(flow(r, 'ticketing', 'Jira Cloud')!.since).not.toBeNull();
    expect(flow(r, 'ticketing', 'ServiceNow')).toMatchObject({ host: 'acme.service-now.example', leavesRegion: 'unknown', enabled: true });
    expect(flow(r, 'ticketing', 'Freshdesk')).toMatchObject({ host: 'acme.freshdesk.com', enabled: false, since: null, enabledBy: null });
    expect(flow(r, 'webhook')).toMatchObject({ name: 'Webhook', host: 'hooks.acme.example', leavesRegion: 'unknown', enabled: true });
    // A Zoho data centre this node does not list cannot be placed: unknown, never guessed.
    expect(flow(r, 'ticketing', 'Zoho Desk')).toMatchObject({ host: null, leavesRegion: 'unknown' });
    // Disabled flows are listed but are not subprocessors and add no statement sentence.
    expect(r.subprocessors).not.toContain('Freshdesk');
    expect(r.subprocessors).toEqual(expect.arrayContaining(['Jira Cloud', 'ServiceNow', 'Webhook', 'Zoho Desk']));
    expect(r.statement).toContain('Tickets and notes are sent to Jira Cloud (acme.atlassian.example), whose location is not known to this report.');
    expect(r.statement).not.toContain('Freshdesk');
    expect(r.statement).toContain('Signed ticket notifications are sent to the webhook Webhook (hooks.acme.example)');
    const body = JSON.stringify(r);
    expect(body).not.toContain(SEALED);
    expect(body).not.toContain(FP);
    expect(body).not.toContain('/oauth2/');
  });

  it('a deleted and re-created integration reports the re-creation as since', async () => {
    const rows: ChainRow[] = [
      { action: 'integration.updated', data: { type: 'jira', enabled: true }, actorLabel: 'A', ts: new Date('2026-01-01T00:00:00Z') },
      { action: 'integration.deleted', data: { type: 'jira' }, actorLabel: 'A', ts: new Date('2026-02-01T00:00:00Z') },
      { action: 'integration.updated', data: { type: 'jira', enabled: true }, actorLabel: 'B', ts: new Date('2026-03-01T00:00:00Z') },
      { action: 'integration.updated', data: { type: 'jira', enabled: true }, actorLabel: 'C', ts: new Date('2026-04-01T00:00:00Z') },
      { action: 'integration.updated', data: { type: 'webhook', enabled: false }, actorLabel: 'D', ts: new Date('2026-05-01T00:00:00Z') },
    ];
    const on = (r: ChainRow) =>
      r.data.type !== 'jira' ? undefined : r.action === 'integration.updated' ? r.data.enabled === true : r.action === 'integration.deleted' ? false : undefined;
    expect(lastEnabling(rows, on)).toEqual({ since: '2026-03-01T00:00:00.000Z', enabledBy: 'B' });
    expect(lastEnabling(rows.slice(0, 2), on)).toEqual({ since: null, enabledBy: null });
    expect(lastEnabling([], on)).toEqual({ since: null, enabledBy: null });
  });

  it('Zoho leavesRegion: no when the verified data-centre row is in the org region, yes otherwise', () => {
    const dcs: ZohoDataCenter[] = [
      { id: 'in', deskHost: 'desk.zoho.in', accountsHost: 'accounts.zoho.in', region: 'in-mum' },
      { id: 'eu', deskHost: 'desk.zoho.eu', accountsHost: 'accounts.zoho.eu', region: 'eu-fra' },
      { id: 'com', deskHost: 'desk.zoho.com', accountsHost: 'accounts.zoho.com', region: null },
    ];
    const en = { since: '2026-11-01T00:00:00.000Z', enabledBy: 'Priya Admin' };
    const z = (dataCenter: string, region: 'in-mum' | 'eu-fra' | 'us-east') => integrationFlow({ type: 'zoho_desk', enabled: true, config: { dataCenter } }, region, en, dcs);
    expect(z('in', 'in-mum')).toMatchObject({ name: 'Zoho Desk (in data centre)', host: 'desk.zoho.in', leavesRegion: 'no', since: en.since });
    expect(z('in', 'eu-fra')).toMatchObject({ leavesRegion: 'yes' });
    expect(z('eu', 'eu-fra')).toMatchObject({ host: 'desk.zoho.eu', leavesRegion: 'no' });
    expect(z('com', 'us-east')).toMatchObject({ leavesRegion: 'yes' });
    expect(z('nope', 'in-mum')).toMatchObject({ leavesRegion: 'unknown', host: null });
    expect(integrationFlow({ type: 'jira', enabled: false, config: { siteUrl: 'https://x.example', deployment: 'data_center' } }, 'in-mum', en, dcs)).toMatchObject({
      name: 'Jira Data Center',
      enabled: false,
      since: null,
      enabledBy: null,
    });
  });

  it('the local AI provider: in region, with the endpoint host; the transcript adds a presence store', async () => {
    await setAi({ ...DEFAULT_AI_POLICY, provider: 'local', includeTranscript: true });
    const r = await report(t, admin);
    const f = flow(r, 'ai_provider')!;
    expect(f).toMatchObject({ name: 'Local model (operator-run, in region)', host: 'llm.in-mum.example.test', leavesInfrastructure: false, leavesRegion: 'no', enabled: true, enabledBy: 'Priya Admin', acknowledgement: null });
    expect(f.dataSent).toMatch(/redacted chat/);
    expect(r.subprocessors).not.toContain(f.name);
    expect(r.statement).not.toContain('Local model');
    expect(r.dataCategories.find((c) => c.category === 'summaries')!.stores.map((s) => s.kind)).toEqual(['database', 'presence']);
  });

  it('the anthropic provider: leaves the region, with the acknowledgement and its statement sentence', async () => {
    const at = '2026-10-30T08:15:00.000Z';
    await setAi({ provider: 'anthropic', autoSummarize: true, includeTranscript: false, anthropicAck: { scope: 'outside_region', textVersion: 'ai-ack-v2', userId: adminRow.id, at } });
    const r = await report(t, admin);
    const ai = r.dataFlows.filter((f) => f.kind === 'ai_provider');
    expect(ai).toHaveLength(1);
    const latest = (await t.db.select().from(auditEntry).where(and(eq(auditEntry.orgId, orgRow.id), eq(auditEntry.action, 'ai.policy_updated')))).sort((a, b) => b.seq - a.seq)[0]!;
    expect(ai[0]).toEqual({
      kind: 'ai_provider',
      name: 'Anthropic (Claude)',
      host: 'api.anthropic.com',
      leavesInfrastructure: true,
      leavesRegion: 'yes',
      dataSent: 'redacted session events',
      enabled: true,
      since: latest.ts.toISOString(),
      enabledBy: 'Priya Admin',
      acknowledgement: { scope: 'outside_region', by: 'Priya Admin', at },
    });
    expect(r.subprocessors).toContain('Anthropic (Claude)');
    expect(r.statement).toContain(
      'Redacted session summaries are processed by Anthropic (Claude), outside India (Mumbai), acknowledged by Priya Admin on 2026-10-30.',
    );
    expect(r.dataCategories.find((c) => c.category === 'summaries')!.stores.map((s) => s.kind)).toEqual(['database']);
  });

  it('activity30d and category counts read session_summary, ticket_push and auth_session', async () => {
    const tok = await seedToken(t.db, orgRow, adminRow, { tier: 'p1_browser' });
    const sess = await createSession(t.db, { orgId: orgRow.id, tokenId: tok.id, assistUserId: adminRow.id, deskRef: randomUUID(), tier: 'p1_browser', region: 'in-mum', nodeId: 'test-node' });
    const sum = await insertSessionSummary(t.db, { orgId: orgRow.id, sessionId: sess.id, provider: 'local', model: 'local', version: 1, state: 'ready', trigger: 'session_end', output: { summary: 'x' }, outputSha256: 'c'.repeat(64), completedAt: new Date() });
    await insertSessionSummary(t.db, { orgId: orgRow.id, sessionId: sess.id, provider: 'local', model: 'local', version: 2, state: 'pending', trigger: 'on_demand' });
    const jira = (await upsertIntegration(t.db, { orgId: orgRow.id, type: 'jira', enabled: true, config: { siteUrl: 'https://acme.atlassian.example', deployment: 'cloud' }, updatedBy: adminRow.id }));
    await insertTicketPush(t.db, { orgId: orgRow.id, sessionId: sess.id, integrationId: jira.id, type: 'jira', mode: 'create', source: 'summary', summaryId: sum.id, summaryVersion: 1, content: { title: 't' }, contentSha256: 'd'.repeat(64), createdBy: adminRow.id, state: 'delivered', clientPushId: randomUUID() });
    await createAuthSession(t.db, { userId: adminRow.id, tokenHash: 'e'.repeat(64), region: 'in-mum', loginMethod: 'oidc' });
    await createAuthSession(t.db, { userId: adminRow.id, tokenHash: 'f'.repeat(64), region: 'in-mum', loginMethod: 'saml' });
    const r = await report(t, admin);
    expect(r.activity30d).toEqual({ summaries: 1, ticketPushes: 1, ssoLogins: 2 });
    const cat = Object.fromEntries(r.dataCategories.map((c) => [c.category, c]));
    expect(cat.summaries!.count).toBe(2);
    expect(cat.tickets!.count).toBe(1);
    expect(cat.sessions!.count).toBe(1);
  });
});

describe('signature, offline verification and the signed download', () => {
  it('the report verifies against /.well-known/indiansassist.json, over the raw JSON', async () => {
    const r = await report(t, admin);
    const wk = await wellKnown(t);
    expect(r.signature).toMatchObject({ alg: 'Ed25519', domain: 'ia-residency-v1', kid: t.ctx.keys.kid, pub: t.ctx.keys.pubB64 });
    expect(verifyResidencyReport(r, wk.keys)).toEqual({ ok: true });
    expect(verifyResidencyReport({ ...r, extra: true }, wk.keys)).toEqual({ ok: false, cause: 'bad_signature' });
    expect(verifyResidencyReport({ ...r, statement: `${r.statement} ` }, wk.keys)).toEqual({ ok: false, cause: 'bad_signature' });
    // Every GET is signed afresh (generatedAt is inside the signed bytes).
    const again = await report(t, admin);
    expect(verifyResidencyReport(again, wk.keys)).toEqual({ ok: true });
  });

  it('signed.json: a download with the exact headers, chained once as residency.report_issued', async () => {
    const before = await t.db.select().from(auditEntry).where(and(eq(auditEntry.orgId, orgRow.id), eq(auditEntry.action, 'residency.report_issued')));
    const res = await call(t.app, '/api/v1/orgs/current/residency/signed.json', { cookie: auditor.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    const r = JSON.parse(res.body) as Report;
    expect(res.headers['content-disposition']).toBe(`attachment; filename="residency-${admin.org.slug}-${String(r.generatedAt).slice(0, 10)}.json"`);
    expect(verifyResidencyReport(r, (await wellKnown(t)).keys)).toEqual({ ok: true });
    const after = await t.db.select().from(auditEntry).where(and(eq(auditEntry.orgId, orgRow.id), eq(auditEntry.action, 'residency.report_issued')));
    expect(after.length - before.length).toBe(1);
    const entry = after.sort((a, b) => b.seq - a.seq)[0]!;
    expect(entry.data).toEqual({ sha256: r.signature.sha256, kid: r.signature.kid });
    expect(entry.actorType).toBe('user');
    expect(entry.actorId).toBe(auditor.user.id);
    expect(entry.sessionId).toBeNull();
    // The plain GET does not chain.
    await report(t, admin);
    const later = await t.db.select().from(auditEntry).where(and(eq(auditEntry.orgId, orgRow.id), eq(auditEntry.action, 'residency.report_issued')));
    expect(later.length).toBe(after.length);
  });

  it('scripts/verify-residency.mjs: a fetched report verifies with --keys and --pub; tampered and extra-key copies fail', async () => {
    const res = await call(t.app, '/api/v1/orgs/current/residency/signed.json', { cookie: admin.cookie });
    const file = join(tmp, 'report.json');
    writeFileSync(file, res.body);
    const keys = join(tmp, 'well-known.json');
    writeFileSync(keys, JSON.stringify(await wellKnown(t)));
    const r = JSON.parse(res.body) as Report;
    expect(runVerify([file, '--keys', keys])).toEqual({ code: 0, out: `OK ${r.signature.kid} ${r.signature.sha256}` });
    expect(runVerify([file, '--pub', t.ctx.keys.pubB64])).toEqual({ code: 0, out: `OK ${r.signature.kid} ${r.signature.sha256}` });
    const tampered = join(tmp, 'tampered.json');
    writeFileSync(tampered, res.body.replace('"leavesRegion": "yes"', '"leavesRegion": "no"'));
    expect(runVerify([tampered, '--keys', keys])).toEqual({ code: 1, out: 'FAIL bad_signature' });
    const extra = join(tmp, 'extra.json');
    writeFileSync(extra, JSON.stringify({ ...r, unsignedNote: 'added after signing' }));
    expect(runVerify([extra, '--keys', keys])).toEqual({ code: 1, out: 'FAIL bad_signature' });
    expect(runVerify([file, '--pub', 'A'.repeat(43)])).toEqual({ code: 1, out: 'FAIL unknown_kid' });
  });

  it('RBAC: org_admin and auditor only, for both routes', async () => {
    expect(others.map((m) => m.user.role)).toEqual(['technician', 'senior_technician', 'observer']);
    for (const m of others) {
      for (const path of ['/api/v1/orgs/current/residency', '/api/v1/orgs/current/residency/signed.json'])
        expect((await call(t.app, path, { cookie: m.cookie })).statusCode).toBe(403);
    }
    for (const path of ['/api/v1/orgs/current/residency', '/api/v1/orgs/current/residency/signed.json']) {
      expect((await call(t.app, path, { cookie: auditor.cookie })).statusCode).toBe(200);
      expect((await call(t.app, path)).statusCode).toBe(401);
    }
  });
});

describe('after a key rotation', () => {
  let rotated: TestApp;
  let oldReport: string;

  beforeAll(async () => {
    oldReport = (await call(t.app, '/api/v1/orgs/current/residency/signed.json', { cookie: admin.cookie })).body;
    rotated = await makeApp({
      TOKEN_SIGNING_KEY: '7'.repeat(64),
      TOKEN_SIGNING_KEYS_PREVIOUS: t.ctx.keys.pubB64,
      RATE_LIMIT_DISABLED: 'false',
    });
  });

  afterAll(async () => {
    await rotated?.close();
  });

  it('a report signed by the retired key still verifies against the rotated well-known list, in process and with --fetch', async () => {
    const wk = await wellKnown(rotated);
    expect(wk.keys.map((k) => k.kid)).toEqual([rotated.ctx.keys.kid, t.ctx.keys.kid]);
    const raw = JSON.parse(oldReport) as Report;
    expect(raw.signature.kid).toBe(t.ctx.keys.kid);
    expect(verifyResidencyReport(raw, wk.keys)).toEqual({ ok: true });
    // Without the retired key in the list it does not.
    expect(verifyResidencyReport(raw, wk.keys.slice(0, 1))).toEqual({ ok: false, cause: 'unknown_kid' });
    const file = join(tmp, 'old-report.json');
    writeFileSync(file, oldReport);
    const origin = (await listen(rotated.app)).replace(/^ws:/, 'http:').replace(/\/signal$/, '');
    // The script runs as a child process; execFileSync would block this process's event loop and the server with it.
    const { execFile } = await import('node:child_process');
    const out = await new Promise<{ code: number; out: string }>((done) => {
      execFile(process.execPath, [VERIFY, file, '--fetch', origin], { encoding: 'utf8' }, (err, stdout) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout).trim() }),
      );
    });
    expect(out).toEqual({ code: 0, out: `OK ${t.ctx.keys.kid} ${raw.signature.sha256}` });
    // New reports are signed with the new key.
    const acc = await signup(rotated.app);
    const fresh = await report(rotated, acc);
    expect(fresh.signature.kid).toBe(rotated.ctx.keys.kid);
    expect(verifyResidencyReport(fresh, wk.keys)).toEqual({ ok: true });
  });

  it('the signed download is limited to 10 per minute per org (429 rate_limited)', async () => {
    const acc = await signup(rotated.app);
    for (let i = 0; i < 10; i++) expect((await call(rotated.app, '/api/v1/orgs/current/residency/signed.json', { cookie: acc.cookie })).statusCode).toBe(200);
    const res = await call(rotated.app, '/api/v1/orgs/current/residency/signed.json', { cookie: acc.cookie });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    // The screen route is not limited by the download budget.
    expect((await call(rotated.app, '/api/v1/orgs/current/residency', { cookie: acc.cookie })).statusCode).toBe(200);
  });
});
