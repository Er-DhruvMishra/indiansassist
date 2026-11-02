/**
 * Shared fixtures of the ticketing tests (docs/specs/phase-e-contracts.md section 15.3): an app whose egress guard
 * allows the loopback fakes, ended sessions and summary rows inserted directly (the ai stream builds summaries in
 * parallel, so these tests read only rows they write themselves), and the integration set-up calls.
 */
import { randomUUID } from 'node:crypto';
import { canonicalJsonBytes, sha256Hex, type SessionSummaryOutput } from '@indiansassist/shared';
import { createSession, getOrg, getUser, insertSessionSummary, seedToken, session as sessionTable } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { call, makeApp, type Account, type TestApp } from './helpers.js';

export const EGRESS_ENV = { EGRESS_ALLOW_HTTP: '1', EGRESS_ALLOW_LOOPBACK: '1' };

export async function makeTicketApp(env: Record<string, string> = {}, logLevel?: string): Promise<TestApp> {
  return makeApp({ ...EGRESS_ENV, ...env }, {}, logLevel ? { logLevel } : {});
}

/** An `ended` P1 session of `owner` (the assist and token creator), optionally still active. */
export async function endedSession(t: TestApp, owner: Account, opts: { state?: 'ended' | 'active' } = {}): Promise<string> {
  const org = (await getOrg(t.db, owner.org.id))!;
  const user = (await getUser(t.db, owner.user.id))!;
  const tok = await seedToken(t.db, org, user);
  const s = await createSession(t.db, {
    orgId: org.id,
    tokenId: tok.id,
    assistUserId: user.id,
    deskRef: randomUUID(),
    tier: 'p1_browser',
    region: org.dataRegion,
    nodeId: 'test-node',
  });
  const started = new Date(Date.now() - 30 * 60_000);
  await t.db
    .update(sessionTable)
    .set(
      opts.state === 'active'
        ? { state: 'active', acceptedAt: started, startedAt: started, consentState: 'granted' }
        : { state: 'ended', acceptedAt: started, startedAt: started, consentState: 'granted', endedAt: new Date(), endReason: 'assist_ended' },
    )
    .where(eq(sessionTable.id, s.id));
  return s.id;
}

export const SUMMARY_OUTPUT: SessionSummaryOutput = {
  summary: 'The printer queue was stuck and was cleared.',
  outcome: 'resolved',
  actionsTaken: ['Cleared the print queue', 'Restarted the spooler service'],
  issuesFound: ['Spooler hung'],
  followUps: ['Replace the toner next week'],
  ticketNote: 'Printer queue cleared remotely; spooler restarted.',
};

/** A summary version row as the ai stream will write it. */
export async function insertSummary(
  t: TestApp,
  orgId: string,
  sessionId: string,
  version: number,
  state: 'ready' | 'pending' | 'failed' = 'ready',
  output: SessionSummaryOutput = SUMMARY_OUTPUT,
): Promise<{ id: string; sha256: string }> {
  const sha = sha256Hex(canonicalJsonBytes(output));
  const row = await insertSessionSummary(t.db, {
    orgId,
    sessionId,
    version,
    state,
    trigger: 'on_demand',
    provider: 'local',
    model: 'local',
    output: state === 'ready' ? (output as unknown as Record<string, unknown>) : null,
    outputSha256: state === 'ready' ? sha : null,
    completedAt: state === 'ready' ? new Date() : null,
  });
  return { id: row.id, sha256: sha };
}

export function jiraConfig(siteUrl: string) {
  return { siteUrl, deployment: 'cloud', projectKey: 'OPS', issueType: 'Task', labels: ['remote'] };
}

export const JIRA_CREDS = { email: 'bot@example.test', apiToken: 'jira-token-PLAINTEXT-1' };

export async function configureJira(t: TestApp, admin: Account, siteUrl: string, enabled = true): Promise<void> {
  const r = await call(t.app, '/api/v1/integrations/jira', { method: 'PUT', cookie: admin.cookie, body: { enabled, config: jiraConfig(siteUrl), credentials: JIRA_CREDS } });
  expect(r.statusCode, r.body).toBe(200);
}

export async function configureWebhook(t: TestApp, admin: Account, url: string): Promise<string> {
  const r = await call(t.app, '/api/v1/integrations/webhook', { method: 'PUT', cookie: admin.cookie, body: { enabled: true, config: { url } } });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { secret: string }).secret;
}

export function manualPush(sessionId: string, over: Record<string, unknown> = {}) {
  return { sessionId, clientPushId: randomUUID(), mode: 'create', source: 'manual', note: 'Called the user back; all fine.', ...over };
}
