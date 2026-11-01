/**
 * Phase E schema (docs/specs/phase-e-contracts.md section 13.2, migration 0008_phase_e) and the section 13.2a repo
 * functions: the new enums and tables round-trip, the verified-domain partial unique index, `(org_id, client_push_id)`
 * and `(session_id, version)` uniqueness, the `login_method` check, the org / user / integration column defaults,
 * getSessionSummary's ready rule, the due lists, the residency counts and the sealed-column compare-and-set.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_AI_POLICY, type SsoConfig } from '@indiansassist/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compareAndSetSealed,
  countSsoLoginsSince,
  countSummariesSince,
  countTicketPushesSince,
  createAuthSession,
  createOrgWithAdmin,
  createSession,
  findSsoIdentity,
  findVerifiedDomain,
  getIntegration,
  getOrgSsoState,
  getSessionSummary,
  getTicketPush,
  insertSessionSummary,
  insertSsoIdentity,
  insertTicketPush,
  listDueSummaries,
  listDueTicketPushes,
  listIntegrations,
  listSealed,
  listSessionSummaries,
  listTicketPushesBySession,
  listVerifiedDomainsByOrg,
  org as orgTable,
  seedToken,
  sessionSummary,
  ssoDomain,
  SummaryNotReadyError,
  ticketPush,
  updateOrg,
  upsertIntegration,
  user as userTable,
  type Db,
  type IntegrationRow,
  type SeededOrg,
  type SessionRow,
} from '../src/index.js';
import { closeDb, freshDb, rejectionText } from './helpers.js';

const H = 'b'.repeat(64);
const TOKEN32 = '0123456789abcdef0123456789abcdef';

const OIDC: SsoConfig = {
  v: 1,
  protocol: 'oidc',
  enabled: true,
  displayName: 'Okta',
  oidc: {
    issuer: 'https://example.okta.com',
    clientId: 'c1',
    tokenEndpointAuth: 'client_secret_basic',
    scopes: ['openid', 'email'],
    emailClaim: 'email',
    nameClaim: 'name',
    groupsClaim: null,
    requiredClaims: [],
  },
  saml: null,
  jit: { enabled: false, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [] },
  sessionMaxAgeHours: 12,
};

describe('phase E schema', () => {
  let db: Db;
  let a: SeededOrg;
  let b: SeededOrg;
  let sess: SessionRow;
  let jira: IntegrationRow;

  beforeAll(async () => {
    db = await freshDb();
    a = await createOrgWithAdmin(db, { planTier: 'p3_portable', seatTier: 'p3_portable' });
    b = await createOrgWithAdmin(db, { planTier: 'p3_portable', seatTier: 'p3_portable' });
    const tok = await seedToken(db, a.org, a.user, { tier: 'p3_portable' });
    sess = await createSession(db, {
      orgId: a.org.id,
      tokenId: tok.id,
      assistUserId: a.user.id,
      deskRef: randomUUID(),
      tier: 'p3_portable',
      region: a.org.dataRegion,
      nodeId: 'n1',
    });
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('org, user and integration columns default so behaviour is unchanged (rule 12.1)', async () => {
    expect(a.org.ssoRequired).toBe(false);
    expect(a.org.aiPolicy).toEqual(DEFAULT_AI_POLICY);
    expect(a.org.ssoSecretEnc).toBeNull();
    expect(a.org.ssoSpCert).toBeNull();
    expect(a.user.ssoBreakGlass).toBe(false);
    const st = await getOrgSsoState(db, a.org.id);
    expect(st).toMatchObject({ config: null, required: false, spCertPem: null, lastTest: null, breakGlassUserIds: [] });
    expect(st!.clientSecret).toEqual({ setAt: null, fingerprint: null });
    expect(await getOrgSsoState(db, randomUUID())).toBeNull();
  });

  it('getOrgSsoState parses a stored config and ignores a legacy value', async () => {
    await updateOrg(db, a.org.id, { ssoConfig: OIDC as unknown as Record<string, unknown> });
    await db.update(userTable).set({ ssoBreakGlass: true }).where(eq(userTable.id, a.user.id));
    const at = new Date('2026-11-01T10:00:00.000Z');
    await db
      .update(orgTable)
      .set({ ssoRequired: true, ssoSecretEnc: 'k1.n.c', ssoSecretSetAt: at, ssoSecretFp: '0a1b2c3d', ssoLastTest: { at: at.toISOString(), ok: true, cause: null, userId: a.user.id, matchedSelf: true } })
      .where(eq(orgTable.id, a.org.id));
    const st = (await getOrgSsoState(db, a.org.id))!;
    expect(st.config?.protocol).toBe('oidc');
    expect(st.required).toBe(true);
    expect(st.clientSecret).toEqual({ setAt: at, fingerprint: '0a1b2c3d' });
    expect(st.lastTest?.matchedSelf).toBe(true);
    expect(st.breakGlassUserIds).toEqual([a.user.id]);
    await updateOrg(db, b.org.id, { ssoConfig: { issuer: 'legacy' } });
    expect((await getOrgSsoState(db, b.org.id))!.config).toBeNull();
  });

  it('a domain is verified by at most one org of the region; pending claims may repeat', async () => {
    const dom = (o: SeededOrg, domain: string, status: 'pending' | 'verified' | 'lapsed') =>
      db.insert(ssoDomain).values({ orgId: o.org.id, domain, status, verifyToken: TOKEN32, createdBy: o.user.id }).returning();
    await dom(a, 'acme.test', 'verified');
    await dom(b, 'acme.test', 'pending');
    expect(await rejectionText(db.update(ssoDomain).set({ status: 'verified' }).where(eq(ssoDomain.orgId, b.org.id)))).toContain('sso_domain_verified_unique');
    expect(await rejectionText(dom(a, 'acme.test', 'pending'))).toContain('sso_domain_org_domain_unique');
    await dom(b, 'other.test', 'lapsed');
    expect((await findVerifiedDomain(db, 'acme.test'))?.orgId).toBe(a.org.id);
    expect(await findVerifiedDomain(db, 'other.test')).toBeNull();
    expect((await listVerifiedDomainsByOrg(db, a.org.id)).map((d) => d.domain)).toEqual(['acme.test']);
    expect(await listVerifiedDomainsByOrg(db, b.org.id)).toEqual([]);
    expect(await rejectionText(db.execute(sql`insert into sso_domain (org_id, domain, status, verify_token, created_by) values (${a.org.id}, 'x.test', 'gone', ${TOKEN32}, ${a.user.id})`))).toMatch(/sso_domain_status|invalid input value/);
  });

  it('sso_identity round-trips, is unique per (org, protocol, issuer, subject) and cascades with its user', async () => {
    const key = { orgId: a.org.id, protocol: 'saml' as const, issuer: 'https://idp.test', subject: 'u-1' };
    const id = await insertSsoIdentity(db, { ...key, userId: a.user.id });
    expect(id.lastLoginAt).toBeNull();
    expect((await findSsoIdentity(db, key))?.id).toBe(id.id);
    expect(await findSsoIdentity(db, { ...key, protocol: 'oidc' })).toBeNull();
    expect(await findSsoIdentity(db, { ...key, orgId: b.org.id })).toBeNull();
    expect(await rejectionText(insertSsoIdentity(db, { ...key, userId: a.user.id }))).toContain('sso_identity_org_protocol_issuer_subject_unique');
  });

  it('integrations upsert per (org, type) with the section 2.1 credential write rule, webhook included', async () => {
    jira = await upsertIntegration(db, { orgId: a.org.id, type: 'jira', enabled: true, config: { projectKey: 'OPS' }, updatedBy: a.user.id, credentials: { enc: 'k1.n.c', fingerprint: '01234567' } });
    expect(jira.credentialsFp).toBe('01234567');
    expect(jira.credentialsSetAt).toBeInstanceOf(Date);
    const kept = await upsertIntegration(db, { orgId: a.org.id, type: 'jira', enabled: false, config: { projectKey: 'OPS' }, updatedBy: a.user.id });
    expect(kept.id).toBe(jira.id);
    expect(kept.enabled).toBe(false);
    expect(kept.credentialsEnc).toBe('k1.n.c');
    const cleared = await upsertIntegration(db, { orgId: a.org.id, type: 'jira', enabled: true, config: { projectKey: 'OPS' }, updatedBy: null, credentials: null });
    expect([cleared.credentialsEnc, cleared.credentialsSetAt, cleared.credentialsFp]).toEqual([null, null, null]);
    jira = await upsertIntegration(db, { orgId: a.org.id, type: 'jira', enabled: true, config: { projectKey: 'OPS' }, updatedBy: a.user.id, credentials: { enc: 'k1.n.c', fingerprint: '01234567' } });
    const hook = await upsertIntegration(db, { orgId: a.org.id, type: 'webhook', enabled: true, config: { origin: 'https://h.test', pathSet: true }, updatedBy: a.user.id });
    expect(hook.type).toBe('webhook');
    expect((await getIntegration(db, a.org.id, 'webhook'))?.id).toBe(hook.id);
    expect(await getIntegration(db, b.org.id, 'jira')).toBeNull();
    expect((await listIntegrations(db, a.org.id)).map((i) => i.type)).toEqual(['jira', 'webhook']);
  });

  it('session_summary versions are unique per session; getSessionSummary returns the latest ready one', async () => {
    const base = { orgId: a.org.id, sessionId: sess.id, provider: 'local' as const, model: 'local' };
    const v1 = await insertSessionSummary(db, { ...base, version: 1, state: 'ready', trigger: 'session_end', output: { summary: 'x' }, outputSha256: H, completedAt: new Date() });
    expect(v1.redactionCounts).toEqual({});
    expect(v1.fallbackUsed).toBe(false);
    const due = new Date(Date.now() - 1000);
    const v2 = await insertSessionSummary(db, { ...base, version: 2, state: 'pending', trigger: 'on_demand', createdBy: a.user.id, nextAttemptAt: due });
    expect(await rejectionText(insertSessionSummary(db, { ...base, version: 2, state: 'pending', trigger: 'on_demand' }))).toContain('session_summary_session_version_unique');
    expect((await getSessionSummary(db, sess.id))?.id).toBe(v1.id);
    expect((await getSessionSummary(db, sess.id, 1))?.id).toBe(v1.id);
    await expect(getSessionSummary(db, sess.id, 2)).rejects.toBeInstanceOf(SummaryNotReadyError);
    await expect(getSessionSummary(db, sess.id, 2)).rejects.toMatchObject({ code: 'summary_not_ready' });
    expect(await getSessionSummary(db, sess.id, 9)).toBeNull();
    expect(await getSessionSummary(db, randomUUID())).toBeNull();
    expect((await listSessionSummaries(db, sess.id)).map((s) => s.version)).toEqual([1, 2]);
    expect((await listDueSummaries(db, new Date(), 10)).map((s) => s.id)).toEqual([v2.id]);
    expect(await listDueSummaries(db, new Date(due.getTime() - 60_000), 10)).toEqual([]);
    expect(await rejectionText(db.execute(sql`insert into session_summary (org_id, session_id, version, state, trigger, provider, model) values (${a.org.id}, ${sess.id}, 3, 'ready', 'session_end', 'openai', 'm')`))).toMatch(/ai_provider|invalid input value/);
  });

  it('ticket_push round-trips; (org_id, client_push_id) is unique; the due list and the source check', async () => {
    const summary = (await getSessionSummary(db, sess.id))!;
    const base = {
      orgId: a.org.id,
      sessionId: sess.id,
      integrationId: jira.id,
      type: 'jira' as const,
      mode: 'create' as const,
      source: 'summary' as const,
      summaryId: summary.id,
      summaryVersion: 1,
      content: { title: 't' },
      contentSha256: H,
      createdBy: a.user.id,
    };
    const cid = randomUUID();
    const p1 = await insertTicketPush(db, { ...base, state: 'retrying', attempts: 1, nextAttemptAt: new Date(Date.now() - 1000), clientPushId: cid });
    expect(p1.manualRetries).toBe(0);
    expect(await rejectionText(insertTicketPush(db, { ...base, state: 'pending', clientPushId: cid }))).toContain('ticket_push_org_client_push_unique');
    const p2 = await insertTicketPush(db, { ...base, state: 'delivered', clientPushId: randomUUID(), externalId: 'OPS-1', deliveredAt: new Date() });
    // The same client push id in another org is a different push.
    const bTok = await seedToken(db, b.org, b.user, { tier: 'p3_portable' });
    const bSess = await createSession(db, { orgId: b.org.id, tokenId: bTok.id, assistUserId: b.user.id, deskRef: randomUUID(), tier: 'p3_portable', region: b.org.dataRegion, nodeId: 'n1' });
    const bJira = await upsertIntegration(db, { orgId: b.org.id, type: 'jira', enabled: true, config: {}, updatedBy: b.user.id });
    await insertTicketPush(db, { ...base, orgId: b.org.id, sessionId: bSess.id, integrationId: bJira.id, summaryId: null, summaryVersion: null, source: 'manual', createdBy: b.user.id, state: 'pending', clientPushId: cid });
    expect((await getTicketPush(db, a.org.id, p1.id))?.id).toBe(p1.id);
    expect(await getTicketPush(db, b.org.id, p1.id)).toBeNull();
    expect((await listTicketPushesBySession(db, a.org.id, sess.id)).map((p) => p.id)).toEqual([p2.id, p1.id]);
    expect((await listDueTicketPushes(db, new Date(), 10)).map((p) => p.id)).toEqual([p1.id]);
    expect(await rejectionText(db.update(ticketPush).set({ source: 'robot' as never }).where(eq(ticketPush.id, p2.id)))).toContain('ticket_push_source_check');
  });

  it('auth_session.login_method takes LOGIN_METHODS or null, and counts SSO logins', async () => {
    const since = new Date(Date.now() - 60_000);
    await createAuthSession(db, { userId: a.user.id, tokenHash: 'c'.repeat(64), region: a.org.dataRegion });
    await createAuthSession(db, { userId: a.user.id, tokenHash: 'd'.repeat(64), region: a.org.dataRegion, loginMethod: 'oidc' });
    await createAuthSession(db, { userId: a.user.id, tokenHash: 'e'.repeat(64), region: a.org.dataRegion, loginMethod: 'saml' });
    await createAuthSession(db, { userId: a.user.id, tokenHash: 'f'.repeat(64), region: a.org.dataRegion, loginMethod: 'local' });
    await createAuthSession(db, { userId: b.user.id, tokenHash: '1'.repeat(64), region: b.org.dataRegion, loginMethod: 'oidc' });
    expect(await countSsoLoginsSince(db, a.org.id, since)).toBe(2);
    expect(await countSsoLoginsSince(db, b.org.id, since)).toBe(1);
    expect(await countSsoLoginsSince(db, a.org.id, new Date(Date.now() + 60_000))).toBe(0);
    expect(
      await rejectionText(createAuthSession(db, { userId: a.user.id, tokenHash: '2'.repeat(64), region: a.org.dataRegion, loginMethod: 'magic' as never })),
    ).toContain('auth_session_login_method_check');
  });

  it('counts summaries and pushes since a time', async () => {
    const since = new Date(Date.now() - 60_000);
    expect(await countSummariesSince(db, a.org.id, since)).toBe(1);
    expect(await countTicketPushesSince(db, a.org.id, since)).toBe(2);
    expect(await countTicketPushesSince(db, b.org.id, since)).toBe(1);
    expect(await countSummariesSince(db, b.org.id, since)).toBe(0);
    await db.update(sessionSummary).set({ completedAt: new Date(Date.now() - 86_400_000) }).where(eq(sessionSummary.sessionId, sess.id));
    expect(await countSummariesSince(db, a.org.id, since)).toBe(0);
  });

  it('compareAndSetSealed writes only while the row still holds the old value', async () => {
    expect(await compareAndSetSealed(db, 'org.sso_secret_enc', a.org.id, 'k1.n.c', 'k2.n.c')).toBe(true);
    expect(await compareAndSetSealed(db, 'org.sso_secret_enc', a.org.id, 'k1.n.c', 'k3.n.c')).toBe(false);
    expect((await db.select().from(orgTable).where(eq(orgTable.id, a.org.id)))[0]!.ssoSecretEnc).toBe('k2.n.c');
    expect(await compareAndSetSealed(db, 'integration.credentials_enc', jira.id, 'k1.n.c', 'k2.n.c')).toBe(true);
    expect(await compareAndSetSealed(db, 'org.sso_sp_key_enc', a.org.id, 'x', 'y')).toBe(false);
    expect(await listSealed(db, 'org.sso_secret_enc')).toEqual([{ id: a.org.id, orgId: a.org.id, value: 'k2.n.c', integrationType: null }]);
    expect((await listSealed(db, 'integration.credentials_enc')).find((r) => r.id === jira.id)).toEqual({ id: jira.id, orgId: a.org.id, value: 'k2.n.c', integrationType: 'jira' });
    expect(await listSealed(db, 'org.sso_sp_key_enc')).toEqual([]);
  });
});
