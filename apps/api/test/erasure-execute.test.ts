/**
 * Phase F section 5.3 and 5.4 (docs/specs/phase-f-contracts.md 15.4): execution on a seeded throwaway org (users, SSO,
 * sessions with files and hosts, recordings in the fs storage, tokens, devices with MACs, a group, fleet actions,
 * playbooks, integrations with pushes, summaries, login attempts, a reset token, presence keys). Afterwards every
 * table is read back and grepped for every seeded email, name, label, host and file name; the objects are gone; the
 * audit entries are byte-identical and `org.erased` is the last; later writes and `piiHash` are refused; the chain
 * verifies; the signed certificate and the chain digest are served. Each step is crashed once and resumed, including
 * a crash inside step 5 (the `login_attempt` rows and the step-9 mail come from `progress.carry`). During execution
 * logins, REST reads and hellos answer `org_erasing`, and the push and summary sweeps skip the org. Another org is
 * untouched. Every address is synthetic (`@example.test`).
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  amtSol,
  auditEntry,
  createSession,
  device,
  deviceAction,
  deviceGroup,
  getErasure,
  getOrg,
  getUser,
  insertAuditEntry,
  integration,
  loginAttempt,
  org as orgTable,
  orgErasure,
  OrgErasedError,
  passwordReset,
  playbook,
  playbookRun,
  recording,
  seedToken,
  session,
  sessionFile,
  sessionHost,
  sessionParticipant,
  sessionSummary,
  ssoDomain,
  ssoIdentity,
  technicianSeat,
  ticketPush,
  token,
  user,
  verifyOrgChain,
  wakeAttempt,
  authSession,
} from '@indiansassist/db';
import { erasureCertificateSchema, hashAuditEntry, sha256Hex, verifyErasureCertificate, type ChainEntry } from '@indiansassist/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transcriptKey } from '../src/ai/transcript.js';
import { sweepSummaries } from '../src/ai/worker.js';
import { ErasureCrash, runErasure } from '../src/erasure/executor.js';
import { refuseIfOrgErasing } from '../src/erasure/guard.js';
import { sweepTicketPushes } from '../src/integrations/sweep.js';
import { piiHash, systemActor, writeAudit } from '../src/lib/audit.js';
import type { MailMessage, Mailer } from '../src/mail/mailer.js';
import { call, createToken, listen, PASSWORD, signup, SignalClient, uniq, type Account, type TestApp, makeApp } from './helpers.js';

let t: TestApp;
let signalUrl: string;
let mails: MailMessage[] = [];

beforeAll(async () => {
  // Development shortening (5.2c): cooling-off, the approver age and the step 8 wait all become one second.
  t = await makeApp({ ERASURE_DEV_COOLING_OFF_SEC: '1', API_ORIGIN: 'http://localhost:4145' });
  signalUrl = await listen(t.app);
  const smtp: Mailer = {
    driver: 'smtp',
    async send(m) {
      mails.push(m);
      return true;
    },
  };
  (t.ctx as { mailer: Mailer }).mailer = smtp;
});
afterAll(async () => {
  await t?.close();
});

type Seed = {
  tag: string;
  a: Account;
  b: Account;
  auditor: Account;
  tech: Account;
  emails: string[];
  secrets: string[];
  liveSessionId: string;
  endedSessionId: string;
  tokenId: string;
  compact: string;
  deviceId: string;
  pushId: string;
  summaryId: string;
  erasureId: string;
  prefix: string;
  presenceKeys: string[];
};

/** A throwaway org with one of everything, and its erasure in `cooling_off` and due. */
async function seedOrg(): Promise<Seed> {
  const tag = uniq('seed').toLowerCase();
  const emails = [`${tag}-a@example.test`, `${tag}-b@example.test`, `${tag}-auditor@example.test`, `${tag}-tech@example.test`];
  const names = [`Admin ${tag}`, `Second ${tag}`, `Auditor ${tag}`, `Tech ${tag}`];
  const a = await signup(t.app, { orgName: `Org ${tag}`, name: names[0], email: emails[0] });
  const invite = async (role: string, i: number): Promise<Account> => {
    const inv = await call(t.app, '/api/v1/users/invite', { cookie: a.cookie, body: { email: emails[i], name: names[i], role } });
    const secret = (inv.json() as { inviteUrl: string }).inviteUrl.split('#i=')[1]!;
    const acc = await call(t.app, '/api/v1/auth/accept-invite', { body: { invite: secret, name: names[i], password: PASSWORD } });
    const cookie = String(acc.headers['set-cookie']).split(';')[0]!;
    return { cookie, user: acc.json().user, org: acc.json().org };
  };
  const b = await invite('org_admin', 1);
  const auditor = await invite('auditor', 2);
  const tech = await invite('technician', 3);
  const orgRow = (await getOrg(t.db, a.org.id))!;
  const admin = (await getUser(t.db, a.user.id))!;
  // A failed sign-in leaves login_attempt rows keyed by the unpeppered email hash.
  await call(t.app, '/api/v1/auth/login', { body: { email: emails[3], password: 'not the password!' } });

  const secrets = [
    ...emails,
    ...names,
    `Org ${tag}`,
    orgRow.slug,
    `desk-label-${tag}`,
    `SeedAgent/${tag}`,
    `participant-${tag}`,
    `host-${tag}.example.test`,
    `file-${tag}.txt`,
    `token-label-${tag}`,
    `laptop-${tag}`,
    `group-${tag}`,
    `group-desc-${tag}`,
    `notify-${tag}@example.test`,
    `group-notify-${tag}@example.test`,
    `203.0.113.${(tag.length % 200) + 1}-${tag}`,
    `playbook-${tag}`,
    `echo body-${tag}`,
    `run-error-${tag}`,
    `https://hooks-${tag}.example.test/in`,
    `ticket-note-${tag}`,
    `TICKET-${tag}`,
    `summary-text-${tag}`,
    `erasure-reason-${tag}`,
    `action-reason-${tag}`,
    `wake-reason-${tag}`,
    `sol-reason-${tag}`,
    `idp-subject-${tag}`,
    `${tag}.example.test`,
    `stats-${tag}`,
  ];

  await t.db.update(orgTable).set({ branding: { displayName: `Brand ${tag}` }, ssoConfig: { protocol: 'oidc', issuer: `https://idp-${tag}.example.test` }, ssoSecretEnc: 'sealed', ssoSecretFp: 'abcdef12' }).where(eq(orgTable.id, a.org.id));
  secrets.push(`Brand ${tag}`, `https://idp-${tag}.example.test`);
  await t.db.insert(ssoDomain).values({ orgId: a.org.id, domain: `${tag}.example.test`, verifyToken: 'v'.repeat(32), createdBy: a.user.id });
  await t.db.insert(ssoIdentity).values({ orgId: a.org.id, userId: b.user.id, protocol: 'oidc', issuer: `https://idp-${tag}.example.test`, subject: `idp-subject-${tag}` });
  await t.db.insert(passwordReset).values({ userId: tech.user.id, tokenHash: sha256Hex(`reset-${tag}`), expiresAt: new Date(Date.now() + 600_000) });

  // Tokens and sessions: one live, one ended, with participants, files, hosts and a playbook run.
  const tok = await createToken(t.app, a);
  await t.db.update(token).set({ label: `token-label-${tag}` }).where(eq(token.id, tok.token.id));
  const tok2 = await seedToken(t.db, orgRow, admin);
  const mk = async (tokenId: string, live: boolean) => {
    const s = await createSession(t.db, { orgId: a.org.id, tokenId, assistUserId: a.user.id, deskRef: randomUUID(), tier: 'p1_browser', region: orgRow.dataRegion, nodeId: 'test-node' });
    const started = new Date(Date.now() - 600_000);
    await t.db
      .update(session)
      .set({
        deskLabel: `desk-label-${tag}`,
        deskUserAgent: `SeedAgent/${tag}`,
        deskClient: { kind: 'web', note: `stats-${tag}` },
        lastStats: { note: `stats-${tag}` },
        state: live ? 'active' : 'ended',
        acceptedAt: started,
        startedAt: started,
        consentState: 'granted',
        ...(live ? {} : { endedAt: new Date(), endReason: 'assist_ended' as const }),
      })
      .where(eq(session.id, s.id));
    await t.db.insert(sessionParticipant).values({ sessionId: s.id, role: 'desk', label: `participant-${tag}`, connectionId: randomUUID() });
    await t.db.insert(sessionHost).values({ sessionId: s.id, orgId: a.org.id, hostHash: sha256Hex(`h-${s.id}`), host: `host-${tag}.example.test` });
    await t.db.insert(sessionFile).values({ sessionId: s.id, direction: 'desk_to_assist', fileId: 1, name: `file-${tag}.txt`, bytes: 12 });
    return s.id;
  };
  const liveSessionId = await mk(tok2.id, true);
  const endedSessionId = await mk(tok.token.id, false);
  // A chained entry with hashed PII, as the file and host entries are written.
  await writeAudit(t.ctx, t.db, orgRow, { sessionId: endedSessionId, actor: systemActor, action: 'chat.relayed', data: { count: 3 } });
  await t.db.insert(playbook).values({ orgId: a.org.id, name: `playbook-${tag}`, interpreter: 'sh', body: `echo body-${tag}`, bodySha256: sha256Hex(`echo body-${tag}`), createdBy: a.user.id });
  await t.db.insert(playbookRun).values({ runId: randomUUID().replace(/-/g, ''), sessionId: endedSessionId, orgId: a.org.id, playbookId: randomUUID(), bodySha256: 'a'.repeat(64), opId: '0123456789abcdef', error: `run-error-${tag}` });

  // Recordings: a stored object, and the part object of an unfinished upload.
  const prefix = `${orgRow.dataRegion}/${a.org.id}/`;
  const recId = randomUUID();
  const key = `${prefix}${endedSessionId}/${recId}.webm`;
  const put = await t.ctx.storage.put(key, Buffer.from(`recording-${tag}`), { contentType: 'video/webm' });
  await t.ctx.storage.put(`${prefix}${endedSessionId}/${randomUUID()}.webm.part1`, Buffer.from('part'), { contentType: 'application/octet-stream' });
  await t.db.insert(recording).values({ id: recId, orgId: a.org.id, sessionId: endedSessionId, uploadedBy: a.user.id, storageKey: key, status: 'stored', bytes: put.bytes, region: orgRow.dataRegion });

  // Fleet: a group, a device with a MAC, an action, a wake and an open SOL.
  const [grp] = await t.db.insert(deviceGroup).values({ orgId: a.org.id, name: `group-${tag}`, description: `group-desc-${tag}`, notifyEmail: `group-notify-${tag}@example.test`, defaultTags: ['seedtag'], createdBy: a.user.id }).returning();
  const [dev] = await t.db
    .insert(device)
    .values({
      orgId: a.org.id,
      name: `laptop-${tag}`,
      region: orgRow.dataRegion,
      groupId: grp!.id,
      tags: ['seedtag'],
      lastIp: `203.0.113.${(tag.length % 200) + 1}-${tag}`,
      macEnc: 'sealed-mac',
      macHash: 'c'.repeat(64),
      notifyEmail: `notify-${tag}@example.test`,
      hwFingerprint: 'd'.repeat(64),
      publicKey: 'pk',
      kexPublicKey: 'kex',
      interactive: { user: `stats-${tag}` },
    })
    .returning();
  await t.db.insert(deviceAction).values({ orgId: a.org.id, deviceId: dev!.id, createdBy: a.user.id, kind: 'message', payload: { text: `action-reason-${tag}` }, reason: `action-reason-${tag}`, expiresAt: new Date(Date.now() + 3_600_000) });
  await t.db.insert(wakeAttempt).values({ orgId: a.org.id, deviceId: dev!.id, createdBy: a.user.id, method: 'wol', reason: `wake-reason-${tag}` });
  await t.db.insert(amtSol).values({ orgId: a.org.id, deviceId: dev!.id, openedBy: a.user.id, viaDeviceId: dev!.id, reason: `sol-reason-${tag}`, transcriptRef: `sol/${tag}` });

  // Integrations: a webhook with a pending push (kept, reset) and an unreferenced jira (deleted).
  const [hook] = await t.db.insert(integration).values({ orgId: a.org.id, type: 'webhook', enabled: true, config: { url: `https://hooks-${tag}.example.test/in` }, credentialsEnc: 'sealed', credentialsFp: 'abcdef12' }).returning();
  await t.db.insert(integration).values({ orgId: a.org.id, type: 'jira', enabled: true, config: { siteUrl: `https://hooks-${tag}.example.test/in` } });
  const [push] = await t.db
    .insert(ticketPush)
    .values({
      orgId: a.org.id,
      sessionId: endedSessionId,
      integrationId: hook!.id,
      type: 'webhook',
      mode: 'create',
      source: 'manual',
      content: { note: `ticket-note-${tag}` },
      contentSha256: 'e'.repeat(64),
      state: 'pending',
      clientPushId: randomUUID(),
      createdBy: a.user.id,
      externalId: `TICKET-${tag}`,
      nextAttemptAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  const [sum] = await t.db
    .insert(sessionSummary)
    .values({ orgId: a.org.id, sessionId: endedSessionId, version: 1, state: 'pending', trigger: 'on_demand', provider: 'local', model: 'local', detail: `summary-text-${tag}`, nextAttemptAt: new Date(Date.now() + 3_600_000) })
    .returning();
  await t.db.insert(sessionSummary).values({ orgId: a.org.id, sessionId: liveSessionId, version: 1, state: 'ready', trigger: 'on_demand', provider: 'local', model: 'local', output: { summary: `summary-text-${tag}` }, completedAt: new Date() });

  // Presence keys derivable from the org's ids.
  const presenceKeys = [transcriptKey(endedSessionId), `ia:camsess:${liveSessionId}`, `ia:cam:${'f'.repeat(64)}`, `ia:dev:${dev!.id}`, `ia:rcpt:${dev!.id}`, `ia:dct:${tok.token.id}`, `ia:dc:${'9'.repeat(64)}`];
  await t.ctx.presence.setKey(transcriptKey(endedSessionId), JSON.stringify({ text: `summary-text-${tag}` }), 1800);
  await t.ctx.presence.setKey(`ia:camsess:${liveSessionId}`, JSON.stringify({ cameraId: randomUUID(), codeHash: 'f'.repeat(64), state: 'linked' }), 600);
  await t.ctx.presence.setKey(`ia:cam:${'f'.repeat(64)}`, '{}', 600);
  await t.ctx.presence.setKey(`ia:dev:${dev!.id}`, JSON.stringify({ connectionId: 'c', nodeId: 'other-node', region: orgRow.dataRegion }), 90);
  await t.ctx.presence.setKey(`ia:rcpt:${dev!.id}`, '[]', 600);
  await t.ctx.presence.setKey(`ia:dct:${tok.token.id}`, JSON.stringify(['9'.repeat(64)]), 600);
  await t.ctx.presence.setKey(`ia:dc:${'9'.repeat(64)}`, '{}', 600);
  await t.ctx.presence.setAssistOnline({ connectionId: `conn-${tag}`, userId: a.user.id, orgId: a.org.id, role: 'org_admin', nodeId: 'other-node' }, 600);

  // The erasure, approved by B and due.
  const [er] = await t.db
    .insert(orgErasure)
    .values({ orgId: a.org.id, state: 'cooling_off', reason: `erasure-reason-${tag}`, requestedBy: a.user.id, requestedAt: new Date(Date.now() - 86_400_000), approvedBy: b.user.id, approvedAt: new Date(Date.now() - 3_600_000), coolingOffUntil: new Date(Date.now() - 1000) })
    .returning();
  return { tag, a, b, auditor, tech, emails, secrets, liveSessionId, endedSessionId, tokenId: tok.token.id, compact: tok.compact, deviceId: dev!.id, pushId: push!.id, summaryId: sum!.id, erasureId: er!.id, prefix, presenceKeys };
}

const TABLES = [
  orgTable, user, technicianSeat, authSession, token, device, deviceGroup, deviceAction, wakeAttempt, amtSol, session, sessionParticipant, sessionHost, sessionFile, recording,
  integration, playbook, playbookRun, ssoDomain, ssoIdentity, sessionSummary, ticketPush, passwordReset, orgErasure,
] as const;

/** Every mutable table as one JSON text (the append-only audit tables are checked separately). */
async function dumpMutable(): Promise<string> {
  const parts: string[] = [];
  for (const tb of TABLES) parts.push(JSON.stringify(await t.db.select().from(tb as never)));
  return parts.join('\n');
}

async function auditRows(orgId: string) {
  return t.db.select().from(auditEntry).where(eq(auditEntry.orgId, orgId)).orderBy(asc(auditEntry.seq));
}

/** Runs the erasure to completion (it waits once for the presence-key period, one second here). */
async function runToCompletion(id: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const r = await runErasure(t.ctx, id);
    if (r === 'completed') return;
    expect(['waiting']).toContain(r);
    await sleep(1100);
  }
  throw new Error('the erasure did not complete');
}

/** The section 5.4 invariants after completion. */
async function expectErased(s: Seed, before: Awaited<ReturnType<typeof auditRows>>): Promise<void> {
  const row = (await getErasure(t.db, s.erasureId))!;
  expect(row.state).toBe('completed');
  expect('carry' in (row.progress as Record<string, unknown>)).toBe(false);
  // No seeded value survives in any mutable table.
  const dump = await dumpMutable();
  for (const secret of s.secrets) expect(dump.includes(secret), `"${secret}" survived`).toBe(false);
  // login_attempt rows of every user are gone (the carried unpeppered hashes).
  for (const e of s.emails) expect(await t.db.select().from(loginAttempt).where(eq(loginAttempt.emailHash, sha256Hex(e.toLowerCase())))).toHaveLength(0);
  // Objects gone.
  const left: string[] = [];
  for await (const o of t.ctx.storage.list(s.prefix)) left.push(o.key);
  expect(left).toEqual([]);
  // The org is a tombstone with its pepper destroyed.
  const o = (await getOrg(t.db, s.a.org.id))!;
  expect(o).toMatchObject({ name: 'Erased organisation', slug: `erased-${s.a.org.id.replace(/-/g, '').slice(0, 8)}`, auditPepper: null, branding: {}, ssoConfig: null, ssoSecretEnc: null });
  expect(o.erasedAt).not.toBeNull();
  expect(o.erasingAt).not.toBeNull();
  // Users scrubbed and disabled; seats, cookie sessions, SSO rows, reset tokens deleted; playbooks deleted.
  const users = await t.db.select().from(user).where(eq(user.orgId, s.a.org.id));
  for (const u of users) expect(u).toMatchObject({ email: `erased+${u.id}@erased.invalid`, name: 'Erased user', status: 'disabled', passwordHash: null, inviteTokenHash: null });
  for (const tb of [technicianSeat, ssoDomain, ssoIdentity, playbook] as const) expect(await t.db.select().from(tb as never).where(eq((tb as typeof playbook).orgId, s.a.org.id))).toHaveLength(0);
  expect(await t.db.select().from(authSession).where(sql`${authSession.userId} in (select id from "user" where org_id = ${s.a.org.id})`)).toHaveLength(0);
  expect(await t.db.select().from(sessionHost).where(eq(sessionHost.orgId, s.a.org.id))).toHaveLength(0);
  // Kept rows, scrubbed.
  const sessions = await t.db.select().from(session).where(eq(session.orgId, s.a.org.id));
  expect(sessions.every((x) => x.state === 'ended' && x.deskLabel === null && x.deskUserAgent === null)).toBe(true);
  expect(sessions.find((x) => x.id === s.liveSessionId)!.endReason).toBe('org_erased');
  const devs = await t.db.select().from(device).where(eq(device.orgId, s.a.org.id));
  expect(devs[0]).toMatchObject({ name: 'Erased device', status: 'disabled', macEnc: null, macHash: null, tags: [], publicKey: null });
  const grp = (await t.db.select().from(deviceGroup).where(eq(deviceGroup.orgId, s.a.org.id)))[0]!;
  expect(grp.name).toBe(`Erased group ${grp.id.slice(0, 8)}`);
  const ints = await t.db.select().from(integration).where(eq(integration.orgId, s.a.org.id));
  expect(ints.map((i) => [i.type, i.enabled, i.config, i.credentialsEnc])).toEqual([['webhook', false, {}, null]]);
  const recs = await t.db.select().from(recording).where(eq(recording.orgId, s.a.org.id));
  expect(recs.every((r) => r.deletedAt !== null)).toBe(true);
  const toks = await t.db.select().from(token).where(eq(token.orgId, s.a.org.id));
  expect(toks.every((x) => x.status !== 'active' && x.label === null)).toBe(true);
  // Pushes and summaries cancelled (their existing failure entries), never picked up again.
  expect((await t.db.select().from(ticketPush).where(eq(ticketPush.id, s.pushId)))[0]).toMatchObject({ state: 'failed', content: {}, externalId: null });
  expect((await t.db.select().from(sessionSummary).where(eq(sessionSummary.id, s.summaryId)))[0]).toMatchObject({ state: 'failed', cause: 'provider_disabled', detail: null });
  // Presence keys derived from the org's ids are gone.
  for (const k of s.presenceKeys) expect(await t.ctx.presence.getKey(k), k).toBeNull();
  expect(await t.ctx.presence.listAssistsOnline(s.a.org.id)).toEqual([]);

  // The chain: every earlier entry byte-identical, org.erased the last, verifying without the pepper.
  const after = await auditRows(s.a.org.id);
  expect(after.slice(0, before.length)).toEqual(before);
  const last = after[after.length - 1]!;
  expect(last.action).toBe('org.erased');
  expect(after.map((e) => e.action)).toContain('org.erasure_started');
  const erasedData = last.data as { erasureId: string; entriesBefore: number; counts: Record<string, number> };
  expect(erasedData.erasureId).toBe(s.erasureId);
  expect(erasedData.entriesBefore).toBe(after.length - 1);
  expect(erasedData.counts['deleted:recordingObjects']).toBe(2);
  const v = await verifyOrgChain(t.db, s.a.org.id, { pubKeys: t.ctx.keys.all });
  expect(v.ok).toBe(true);
  expect(v.checked).toBe(after.length);
  // No entry can follow, and no unpeppered hash can be made.
  await expect(writeAudit(t.ctx, t.db, o, { actor: systemActor, action: 'chat.relayed', data: { count: 1 } })).rejects.toBeInstanceOf(OrgErasedError);
  await expect(insertAuditEntry(t.db, { orgId: o.id, region: o.dataRegion, actor: systemActor, action: 'chat.relayed', data: { count: 1 } })).rejects.toBeInstanceOf(OrgErasedError);
  expect(() => piiHash(o, 'x@example.test')).toThrow(OrgErasedError);

  // The signed certificate and the chain digest, public by id.
  const res = await call(t.app, `/api/v1/erasures/${s.erasureId}/certificate`);
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  const raw = JSON.parse(res.body) as Record<string, unknown>;
  expect(verifyErasureCertificate(raw, t.ctx.keys.all)).toEqual({ ok: true });
  const cert = erasureCertificateSchema.parse(raw);
  expect(cert).toMatchObject({ erasureId: s.erasureId, orgId: s.a.org.id, chain: { entries: after.length, tail: last.hash, verified: true, failure: null } });
  expect(hashAuditEntry(cert.chain.finalEntry as ChainEntry)).toBe(cert.chain.tail);
  expect(cert.deleted).toMatchObject({ recordingObjects: 2, technician_seat: 3, sso_identity: 1, sso_domain: 1, password_reset: 1, playbook: 1, integration: 1, session_host: 2 });
  expect(cert.deleted['login_attempt']).toBeGreaterThanOrEqual(1);
  expect(cert.scrubbed).toMatchObject({ user: 4, session: 2, device: 1, device_group: 1, integration: 1, org: 1 });
  expect(cert.objectBytes).toBeGreaterThan(0);
  expect(cert.externalFlows).toContain('webhook');
  expect(cert.backups).toBe('backup retention not stated');
  for (const secret of s.secrets) expect(res.body.includes(secret)).toBe(false);
  const d1 = (await call(t.app, `/api/v1/erasures/${s.erasureId}/chain-digest?limit=2`)).json() as { items: { seq: number; hash: string; prevHash: string }[]; nextAfter: number | null };
  expect(d1.items.map((i) => i.seq)).toEqual([1, 2]);
  expect(d1.nextAfter).toBe(2);
  const d2 = (await call(t.app, `/api/v1/erasures/${s.erasureId}/chain-digest?after=2&limit=10000`)).json() as typeof d1;
  expect(d2.nextAfter).toBeNull();
  const digest = [...d1.items, ...d2.items];
  expect(digest.map((i) => i.hash)).toEqual(after.map((e) => e.hash));
  expect(Object.keys(digest[0]!).sort()).toEqual(['hash', 'prevHash', 'seq']);
}

describe('execution (5.3, 5.4)', () => {
  it('erases the seeded org completely while another org is untouched', async () => {
    const s = await seedOrg();
    const other = await seedOrg();
    await t.db.update(orgErasure).set({ state: 'cancelled' }).where(eq(orgErasure.id, other.erasureId));
    const otherBefore = await dumpOrg(other.a.org.id);
    const before = await auditRows(s.a.org.id);
    mails = [];
    await runToCompletion(s.erasureId);
    await expectErased(s, before);
    // Step 9: the certificate went to the active admins and auditors as they were at step 1.
    const to = mails.filter((m) => m.attachments.some((x) => x.name.startsWith('erasure-certificate-'))).map((m) => m.to).sort();
    expect(to).toEqual([s.emails[0], s.emails[1], s.emails[2]].sort());
    expect(await dumpOrg(other.a.org.id)).toEqual(otherBefore);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: other.a.cookie })).statusCode).toBe(200);
  });

  it('during execution: logins, REST reads, Assist and Desk hellos answer org_erasing; the push and summary sweeps skip the org', async () => {
    const s = await seedOrg();
    await expect(runErasure(t.ctx, s.erasureId, { crashAfter: 'freeze' })).rejects.toBeInstanceOf(ErasureCrash);
    expect((await getErasure(t.db, s.erasureId))!.state).toBe('executing');
    const me = await call(t.app, '/api/v1/auth/me', { cookie: s.b.cookie });
    expect([me.statusCode, me.json().error.code]).toEqual([409, 'org_erasing']);
    const login = await call(t.app, '/api/v1/auth/login', { body: { email: s.emails[1], password: PASSWORD } });
    expect([login.statusCode, login.json().error.code]).toEqual([409, 'org_erasing']);
    await expect(SignalClient.open(signalUrl, { cookie: s.a.cookie })).rejects.toThrow(/409/);
    // The Desk hello (this stream's guard): the token is still active before step 2.
    const desk = await SignalClient.open(signalUrl);
    desk.send({ t: 'desk.hello', token: s.compact, id: 'h1' });
    const err = await desk.next('error');
    expect(err).toMatchObject({ code: 'org_erasing', re: 'h1' });
    expect(await desk.closed()).toBe(4403);
    // The sweeps skip the org: a due push and a due summary stay untouched.
    await t.db.update(ticketPush).set({ state: 'retrying', nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(ticketPush.id, s.pushId));
    await t.db.update(sessionSummary).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(sessionSummary.id, s.summaryId));
    await sweepTicketPushes(t.ctx);
    await sweepSummaries(t.ctx);
    expect((await t.db.select().from(ticketPush).where(eq(ticketPush.id, s.pushId)))[0]).toMatchObject({ state: 'retrying', attempts: 0 });
    expect((await t.db.select().from(sessionSummary).where(eq(sessionSummary.id, s.summaryId)))[0]).toMatchObject({ state: 'pending', attempts: 0 });
    const before = await auditRows(s.a.org.id);
    await runToCompletion(s.erasureId);
    await expectErased(s, before);
  });

  it.each(['freeze', 'stop', 'chain', 'objects', 'rows:session', 'rows:user', 'rows', 'seal', 'verify', 'certify'])('resumes after a crash after %s', async (marker) => {
    const s = await seedOrg();
    const before = await auditRows(s.a.org.id);
    mails = [];
    let crashed = false;
    for (let i = 0; i < 4 && !crashed; i++) {
      try {
        const r = await runErasure(t.ctx, s.erasureId, { crashAfter: marker });
        if (r === 'waiting') await sleep(1100);
      } catch (e) {
        expect(e).toBeInstanceOf(ErasureCrash);
        crashed = true;
      }
    }
    expect(crashed).toBe(true);
    if (marker === 'rows:user') {
      // Crashed inside step 5: the addresses are scrubbed, the login_attempt rows are not yet deleted.
      const users = await t.db.select({ email: user.email }).from(user).where(eq(user.orgId, s.a.org.id));
      expect(users.every((u) => u.email.endsWith('@erased.invalid'))).toBe(true);
      expect(await t.db.select().from(loginAttempt).where(eq(loginAttempt.emailHash, sha256Hex(s.emails[3]!)))).not.toHaveLength(0);
    }
    await runToCompletion(s.erasureId);
    // The before list may have gained the org.erasure_started entry only after a crash after `chain` or later.
    await expectErased(s, before);
    const to = mails.filter((m) => m.attachments.length > 0).map((m) => m.to).sort();
    expect(to).toEqual([s.emails[0], s.emails[1], s.emails[2]].sort());
  });

  it('a cancel that wins the race leaves nothing frozen; a sweep never starts a cancelled erasure', async () => {
    const s = await seedOrg();
    await t.db.update(orgErasure).set({ state: 'cancelled' }).where(eq(orgErasure.id, s.erasureId));
    expect(await runErasure(t.ctx, s.erasureId)).toBe('skipped');
    expect((await getOrg(t.db, s.a.org.id))!.erasingAt).toBeNull();
    // Not yet due.
    const s2 = await seedOrg();
    await t.db.update(orgErasure).set({ coolingOffUntil: new Date(Date.now() + 60_000) }).where(eq(orgErasure.id, s2.erasureId));
    expect(await runErasure(t.ctx, s2.erasureId)).toBe('skipped');
  });

  it('refuseIfOrgErasing answers error org_erasing and closes 4403 only for an erasing org', () => {
    const calls: unknown[] = [];
    const conn = { error: (...a: unknown[]) => calls.push(['error', ...a]), close: (...a: unknown[]) => calls.push(['close', ...a]) };
    expect(refuseIfOrgErasing(conn, { erasingAt: null }, 'x')).toBe(false);
    expect(calls).toEqual([]);
    expect(refuseIfOrgErasing(conn, { erasingAt: new Date() }, 'x')).toBe(true);
    expect(calls).toEqual([
      ['error', 'org_erasing', 'this organisation is being erased', 'x'],
      ['close', 4403, 'org_erasing'],
    ]);
  });
});

/** The rows of one org that erasure would touch, for the "another org untouched" check. */
async function dumpOrg(orgId: string): Promise<string> {
  const parts: unknown[] = [];
  parts.push(await t.db.select().from(orgTable).where(eq(orgTable.id, orgId)));
  parts.push(await t.db.select().from(user).where(eq(user.orgId, orgId)).orderBy(asc(user.id)));
  parts.push(await t.db.select().from(session).where(eq(session.orgId, orgId)).orderBy(asc(session.id)));
  parts.push(await t.db.select().from(device).where(eq(device.orgId, orgId)));
  parts.push(await t.db.select().from(token).where(eq(token.orgId, orgId)).orderBy(asc(token.id)));
  parts.push(await t.db.select().from(integration).where(eq(integration.orgId, orgId)).orderBy(asc(integration.id)));
  parts.push(await t.db.select().from(ticketPush).where(eq(ticketPush.orgId, orgId)));
  parts.push(await auditRows(orgId));
  return JSON.stringify(parts, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
}
