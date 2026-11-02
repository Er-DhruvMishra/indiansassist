/**
 * Phase E sections 5.3-5.9 / 15.4: summaries with FakeSummaryProvider. The chain digest (extensions only, roles not
 * names), redaction before the provider (nothing raw planted in a reason column or a transcript reaches the fake),
 * consistent placeholder numbering, auto generation after the grace, on demand with its grace, `summary_running`,
 * the transcript upload rules (held in presence, never in the database, still held after the retry schedule),
 * retries per cause, `provider_disabled`, edits and versions, `summary_not_ready`, RBAC and every chain entry.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { LIMITS, aiSessionSummarySchema, sessionSummaryListSchema, type SummaryPromptInput } from '@indiansassist/shared';
import { session as sessionTable, sessionSummary } from '@indiansassist/db';
import { formatChainEvent, fileExtension } from '../src/ai/input.js';
import { transcriptKey } from '../src/ai/transcript.js';
import { drainSummaryJobs, sweepSummaries } from '../src/ai/worker.js';
import { addMember, call, listen, makeApp, signup, type Account, type TestApp } from './helpers.js';
import { Kit } from './signal-kit.js';
import { FakeSummaryProvider, GOOD_OUTPUT, chainOf, setPolicy, useProviders } from './ai-kit.js';

let t: TestApp;
let kit: Kit;
let admin: Account;
let tech: Account;
let otherTech: Account;
let senior: Account;
let auditor: Account;
let observer: Account;
let stranger: Account;

beforeAll(async () => {
  t = await makeApp();
  kit = new Kit(t, await listen(t.app));
  admin = await signup(t.app, { orgName: 'Acme IT' });
  tech = await addMember(t.app, admin, 'technician', 'Ravi Tech');
  otherTech = await addMember(t.app, admin, 'technician');
  senior = await addMember(t.app, admin, 'senior_technician');
  auditor = await addMember(t.app, admin, 'auditor');
  observer = await addMember(t.app, admin, 'observer');
  stranger = await signup(t.app);
});
afterEach(async () => {
  await drainSummaryJobs(t.ctx);
  // Each test owns its versions: a leftover pending one must not be picked up by the next test's sweeps.
  await t.db.update(sessionSummary).set({ state: 'failed', cause: 'bad_request' }).where(eq(sessionSummary.state, 'pending'));
  kit.closeAll();
});
afterAll(async () => t.close());

// Planted personal data and secrets: none of these may reach a provider.
const PLANTED = {
  email: 'priya.sharma@example.com',
  phone: '+919876543210',
  card: '4111 1111 1111 1111',
  mac: '00:1A:2B:3C:4D:5E',
  profile: 'priyas',
  wifi: 'SunnyDay#2026',
  apiKey: 'sk-live-abcdefghijklmnopqrstuvwx',
};
const NOTE = `User ${PLANTED.email} on ${PLANTED.phone}, card ${PLANTED.card}, NIC ${PLANTED.mac}, profile C:\\Users\\${PLANTED.profile}\\Desktop, key ${PLANTED.apiKey}`;
const MARKER = 'The printer on floor three says PC LOAD LETTER';

async function ended(opts: { note?: string; upload?: (sessionId: string) => Promise<void> } = {}): Promise<string> {
  const { sessionId } = await kit.activeSession(tech);
  if (opts.upload) await opts.upload(sessionId);
  const res = await call(t.app, `/api/v1/sessions/${sessionId}/end`, { cookie: tech.cookie, body: opts.note ? { note: opts.note } : {} });
  expect(res.statusCode, res.body).toBe(200);
  return sessionId;
}

function uploadBody(noticeSentAt: string, provider = 'local', over: Record<string, unknown> = {}) {
  const at = new Date(Date.parse(noticeSentAt) + 1000).toISOString();
  return {
    noticeSentAt,
    noticeProvider: provider,
    messages: [
      { from: 'technician', at: noticeSentAt, text: 'This chat may be summarised for the support record.' },
      { from: 'user', at, text: `${MARKER}. Mail me at ${PLANTED.email} or [email-1] works too.` },
      { from: 'user', at, text: `Wi-Fi:\n    Key Content            : ${PLANTED.wifi}\nand again ${PLANTED.email}` },
    ],
    playbookOutputs: [{ runId: 'f'.repeat(32), stdoutTail: 'unknown run', stderrTail: '' }],
    consoleRedaction: 'redact-v1',
    ...over,
  };
}

const upload = (sessionId: string, body: unknown, acc: Account = tech) => call(t.app, `/api/v1/sessions/${sessionId}/summary-input`, { cookie: acc.cookie, body });
const later = (ms: number) => new Date(Date.now() + ms);
async function sweep(at: Date): Promise<void> {
  await sweepSummaries(t.ctx, at);
  await drainSummaryJobs(t.ctx);
}
async function versions(sessionId: string) {
  return t.db.select().from(sessionSummary).where(eq(sessionSummary.sessionId, sessionId)).orderBy(sessionSummary.version);
}
function assertNoPlanted(input: SummaryPromptInput): void {
  const text = JSON.stringify(input);
  for (const [kind, value] of Object.entries(PLANTED)) expect(text, kind).not.toContain(value);
  expect(text).not.toContain('Ravi Tech');
}
async function everyTableText(): Promise<string> {
  const res = (await t.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)) as unknown as {
    rows: { table_name: string }[];
  };
  let all = '';
  for (const { table_name } of res.rows) {
    const rows = (await t.db.execute(sql.raw(`select * from "${table_name}"`))) as unknown as { rows: unknown[] };
    all += JSON.stringify(rows.rows);
  }
  return all;
}

describe('chain digest formatting (5.3)', () => {
  const look = { files: new Map([['assist_to_desk:3', 'payroll-priya-2026.LOG']]), playbooks: new Map([['pb-1', 'Clear print queue']]) };
  it('files by extension and size only, never the name', () => {
    const text = formatChainEvent({ action: 'file.sent', actorType: 'user', reason: null, data: { fileId: 3, direction: 'assist_to_desk', bytes: 2_100_000 } }, look)!;
    expect(text).toBe('Sent a .log file (2.1 MB)');
    expect(fileExtension('archive')).toBeNull();
    expect(fileExtension('C:\\x\\a.tar.gz')).toBe('gz');
  });
  it('playbook runs by catalogue name with exit, time and elevation', () => {
    const text = formatChainEvent({ action: 'playbook.run', actorType: 'desk', reason: null, data: { playbookId: 'pb-1', exit: 0, durationMs: 12_000, ranAs: 'admin', truncated: false } }, look);
    expect(text).toBe('Ran playbook "Clear print queue" (exit 0, 12 s, as admin)');
  });
  it('elevation requests carry the reason column', () => {
    expect(formatChainEvent({ action: 'elevation.requested', actorType: 'user', reason: 'install the driver', data: { opId: 'x' } }, look)).toBe('Requested elevation: install the driver');
  });
  it('ignores actions outside SUMMARY_EVENT_ACTIONS', () => {
    expect(formatChainEvent({ action: 'auth.login', actorType: 'user', reason: null, data: {} }, look)).toBeNull();
  });
});

describe('automatic summary at session end (5.8a, 5.8c)', () => {
  it('waits the grace, redacts everything, stores the version and chains it; the transcript is held, then dropped', async () => {
    const fake = new FakeSummaryProvider('local');
    useProviders(t, { local: fake });
    await setPolicy(t, admin.org.id, { provider: 'local', autoSummarize: true, includeTranscript: true });
    const noticeSentAt = new Date(Date.now() - 5000).toISOString();
    let uploadReply: Record<string, unknown> = {};
    const sessionId = await ended({
      note: NOTE,
      upload: async (id) => {
        const res = await upload(id, uploadBody(noticeSentAt));
        expect(res.statusCode, res.body).toBe(202);
        uploadReply = res.json();
      },
    });
    // Held in presence, never in the database.
    expect(await t.ctx.presence.getKey(transcriptKey(sessionId))).not.toBeNull();
    expect(await everyTableText()).not.toContain(MARKER);
    expect(uploadReply.redactions).toMatchObject({ email: 2, secret: 1 });

    const [v1] = await versions(sessionId);
    expect(v1).toMatchObject({ version: 1, state: 'pending', trigger: 'session_end', provider: 'local', createdBy: null });
    const endedAt = (await t.db.select().from(sessionTable).where(eq(sessionTable.id, sessionId)))[0]!.endedAt!;
    expect(v1!.nextAttemptAt!.getTime()).toBe(endedAt.getTime() + LIMITS.summaryTranscriptGraceSec * 1000);

    await sweep(new Date());
    expect(fake.inputs).toHaveLength(0);
    await sweep(later(LIMITS.summaryTranscriptGraceSec * 1000 + 1000));
    expect(fake.inputs).toHaveLength(1);
    const input = fake.inputs[0]!;
    assertNoPlanted(input);
    expect(input.transcript).not.toBeNull();
    // The browser placeholder [email-1] kept its number; the api numbered the raw email above it, consistently.
    const msgs = input.transcript!.messages.map((m) => m.text);
    expect(msgs[1]).toBe(`${MARKER}. Mail me at [email-2] or [email-1] works too.`);
    expect(msgs[2]).toContain('[email-2]');
    expect(msgs[2]).toContain('Key Content            : [secret-');
    // The note's raw email is numbered above every placeholder the held transcript already carries (no collision);
    // the transcript holds only placeholders, so the same address is not recognisable across the upload boundary.
    const endEvent = input.events.find((e) => e.text.startsWith('The session ended'))!;
    expect(endEvent.text).toContain('[email-3]');
    expect(endEvent.text).toContain('[card-1]');
    expect(endEvent.text).toContain('[mac-1]');
    expect(endEvent.text).toContain('C:\\Users\\[user_path-1]\\Desktop');
    expect(endEvent.actor).toBe('technician');
    // Unknown runIds were dropped at upload.
    expect(input.transcript!.playbookOutputs).toEqual([]);

    const [ready] = await versions(sessionId);
    expect(ready).toMatchObject({ state: 'ready', attempts: 1, servedModel: 'fake-served-model', transcriptIncluded: true, fallbackUsed: false, normalised: false });
    expect(ready!.output).toEqual(GOOD_OUTPUT);
    expect(await t.ctx.presence.getKey(transcriptKey(sessionId))).toBeNull();

    const chain = (await chainOf(t, admin.org.id)).filter((r) => r.sessionId === sessionId);
    const received = chain.find((r) => r.action === 'summary.transcript_received')!;
    expect(received.actorType).toBe('user');
    expect(received.data).toMatchObject({ sha256: uploadReply.sha256, messages: 3, playbookOutputs: 0 });
    const auto = chain.find((r) => r.action === 'summary.auto_requested')!;
    expect(auto).toMatchObject({ actorType: 'system', data: { summaryId: v1!.id, version: 1 } });
    const gen = chain.find((r) => r.action === 'summary.generated')!;
    expect(gen.actorType).toBe('system');
    expect(gen.data).toMatchObject({ summaryId: v1!.id, version: 1, provider: 'local', servedModel: 'fake-served-model', transcriptIncluded: true, sha256: ready!.outputSha256, inputSha256: ready!.inputSha256 });
    // No summary text, chat line or note in any chain data object.
    expect(JSON.stringify(chain.map((r) => r.data))).not.toContain('print');
  });

  it('nothing is enqueued without autoSummarize or with provider none', async () => {
    useProviders(t, { local: new FakeSummaryProvider('local') });
    await setPolicy(t, admin.org.id, { provider: 'local', autoSummarize: false });
    expect(await versions(await ended())).toHaveLength(0);
    await setPolicy(t, admin.org.id, { provider: 'none', autoSummarize: true });
    expect(await versions(await ended())).toHaveLength(0);
  });
});

describe('on demand (5.8b)', () => {
  it('is due at once without the transcript, with the grace when the transcript is on and nothing is held', async () => {
    const fake = new FakeSummaryProvider('local');
    useProviders(t, { local: fake });
    await setPolicy(t, admin.org.id, { provider: 'local', includeTranscript: false });
    const s1 = await ended();
    const before = Date.now();
    const res = await call(t.app, `/api/v1/sessions/${s1}/summary`, { cookie: tech.cookie, body: {} });
    expect(res.statusCode, res.body).toBe(202);
    const summary = aiSessionSummarySchema.parse(res.json().summary);
    expect(summary).toMatchObject({ version: 1, state: 'pending', trigger: 'on_demand', createdBy: { id: tech.user.id } });
    expect((await versions(s1))[0]!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // A second request while one is pending.
    const again = await call(t.app, `/api/v1/sessions/${s1}/summary`, { cookie: tech.cookie, body: {} });
    expect(again.json().error.code).toBe('summary_running');
    const req = (await chainOf(t, admin.org.id)).find((r) => r.sessionId === s1 && r.action === 'summary.requested')!;
    expect(req).toMatchObject({ actorType: 'user', data: { summaryId: summary.id, version: 1 } });
    await sweep(new Date());
    expect(fake.inputs.at(-1)!.transcript).toBeNull();
    expect((await versions(s1))[0]).toMatchObject({ state: 'ready', transcriptIncluded: false });

    await setPolicy(t, admin.org.id, { provider: 'local', includeTranscript: true });
    const s2 = await ended();
    await call(t.app, `/api/v1/sessions/${s2}/summary`, { cookie: tech.cookie, body: {} });
    const due = (await versions(s2))[0]!.nextAttemptAt!.getTime();
    expect(due).toBeGreaterThanOrEqual(before + LIMITS.summaryTranscriptGraceSec * 1000);
  });

  it('refuses while the provider is none, and for a session that has not ended', async () => {
    await setPolicy(t, admin.org.id, { provider: 'none' });
    const s = await ended();
    expect((await call(t.app, `/api/v1/sessions/${s}/summary`, { cookie: tech.cookie, body: {} })).json().error.code).toBe('ai_disabled');
    await setPolicy(t, admin.org.id, { provider: 'local' });
    const { sessionId } = await kit.activeSession(tech);
    expect((await call(t.app, `/api/v1/sessions/${sessionId}/summary`, { cookie: tech.cookie, body: {} })).json().error.code).toBe('session_not_ended');
  });

  it('passes the acknowledgement scope to the anthropic provider', async () => {
    const fake = new FakeSummaryProvider('anthropic');
    useProviders(t, { anthropic: fake });
    await setPolicy(t, admin.org.id, {
      provider: 'anthropic',
      anthropicAck: { scope: 'outside_region', textVersion: 'ai-ack-v2', userId: admin.user.id, at: new Date().toISOString() },
    });
    const s = await ended();
    await call(t.app, `/api/v1/sessions/${s}/summary`, { cookie: tech.cookie, body: {} });
    await sweep(new Date());
    expect(fake.calls.at(-1)).toEqual({ region: 'in-mum', ackScope: 'outside_region' });
  });
});

describe('the transcript upload (5.3a-c)', () => {
  it('needs a provider, the transcript policy and a notice for the current provider', async () => {
    useProviders(t, { local: new FakeSummaryProvider('local') });
    const notice = new Date(Date.now() - 1000).toISOString();
    const { sessionId } = await kit.activeSession(tech);
    await setPolicy(t, admin.org.id, { provider: 'none', includeTranscript: true });
    expect((await upload(sessionId, uploadBody(notice))).json().error.code).toBe('ai_disabled');
    await setPolicy(t, admin.org.id, { provider: 'local', includeTranscript: false });
    expect((await upload(sessionId, uploadBody(notice))).json().error.code).toBe('ai_transcript_disabled');
    await setPolicy(t, admin.org.id, { provider: 'local', includeTranscript: true });
    expect((await upload(sessionId, uploadBody(notice, 'anthropic'))).json().error.code).toBe('transcript_notice_missing');
    const early = uploadBody(notice);
    early.messages[1]!.at = new Date(Date.parse(notice) - 1).toISOString();
    const r = await upload(sessionId, early);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_failed');
    expect((await upload(sessionId, { ...uploadBody(notice), noticeSentAt: undefined })).json().error.code).toBe('validation_failed');
    expect((await upload(sessionId, uploadBody(notice))).statusCode).toBe(202);
    // Only the session's own technician (or org-wide roles) may upload.
    expect((await upload(sessionId, uploadBody(notice), otherTech)).statusCode).toBe(403);
    expect((await upload(sessionId, uploadBody(notice), auditor)).statusCode).toBe(403);
    expect((await upload(sessionId, uploadBody(notice), stranger)).statusCode).toBe(404);
  });

  it('refuses a session ended more than 15 minutes ago (bad_state) and an oversized body', async () => {
    await setPolicy(t, admin.org.id, { provider: 'local', includeTranscript: true });
    const s = await ended();
    await t.db.update(sessionTable).set({ endedAt: new Date(Date.now() - 16 * 60_000) }).where(eq(sessionTable.id, s));
    expect((await upload(s, uploadBody(new Date(Date.now() - 20 * 60_000).toISOString()))).json().error.code).toBe('bad_state');
    const huge = uploadBody(new Date().toISOString(), 'local', {
      messages: Array.from({ length: 140 }, () => ({ from: 'user', at: new Date(Date.now() + 1000).toISOString(), text: 'x'.repeat(3999) })),
    });
    expect((await upload(s, huge)).statusCode).toBe(413);
  });
});

describe('retries and final failures (5.8d)', () => {
  async function pendingWith(steps: ConstructorParameters<typeof FakeSummaryProvider>[1], includeTranscript = true) {
    const fake = new FakeSummaryProvider('local', steps);
    useProviders(t, { local: fake });
    await setPolicy(t, admin.org.id, { provider: 'local', includeTranscript });
    const notice = new Date(Date.now() - 1000).toISOString();
    const s = await ended({ upload: async (id) => void (await upload(id, uploadBody(notice))) });
    await call(t.app, `/api/v1/sessions/${s}/summary`, { cookie: tech.cookie, body: {} });
    return { fake, s };
  }

  it('retries rate_limited, provider_unavailable and timeout after 1, 5 and 15 minutes; the transcript outlives the schedule', async () => {
    const { fake, s } = await pendingWith([
      FakeSummaryProvider.fail('rate_limited'),
      FakeSummaryProvider.fail('provider_unavailable'),
      FakeSummaryProvider.fail('timeout'),
      FakeSummaryProvider.ok(),
    ]);
    let now = later(1000);
    const expected = [60, 300, 900];
    for (let i = 0; i < 3; i++) {
      await sweep(now);
      const [v] = await versions(s);
      expect(v).toMatchObject({ state: 'pending', attempts: i + 1 });
      expect(v!.nextAttemptAt!.getTime()).toBe(now.getTime() + expected[i]! * 1000);
      expect(await t.ctx.presence.getKey(transcriptKey(s))).not.toBeNull();
      // Not due before the wait.
      await sweep(new Date(v!.nextAttemptAt!.getTime() - 1000));
      expect(fake.inputs).toHaveLength(i + 1);
      now = v!.nextAttemptAt!;
    }
    await sweep(now);
    const [v] = await versions(s);
    expect(v).toMatchObject({ state: 'ready', attempts: 4, transcriptIncluded: true });
    expect(fake.inputs.every((i) => i.transcript !== null)).toBe(true);
    const failed = (await chainOf(t, admin.org.id)).filter((r) => r.sessionId === s && r.action === 'summary.failed');
    expect(failed.map((r) => [r.data.cause, r.data.attempt, r.data.willRetry])).toEqual([
      ['rate_limited', 1, true],
      ['provider_unavailable', 2, true],
      ['timeout', 3, true],
    ]);
    expect(failed.every((r) => r.actorType === 'system')).toBe(true);
  });

  it('honours a larger retryAfterSec and gives up after the fourth attempt', async () => {
    const { s } = await pendingWith([FakeSummaryProvider.fail('rate_limited', 600)], false);
    let now = later(1000);
    await sweep(now);
    let [v] = await versions(s);
    expect(v!.nextAttemptAt!.getTime()).toBe(now.getTime() + 600_000);
    for (let i = 0; i < 3; i++) {
      now = v!.nextAttemptAt!;
      await sweep(now);
      [v] = await versions(s);
    }
    expect(v).toMatchObject({ state: 'failed', attempts: 4, cause: 'rate_limited' });
    const last = (await chainOf(t, admin.org.id)).filter((r) => r.sessionId === s && r.action === 'summary.failed').at(-1)!;
    expect(last.data).toMatchObject({ attempt: 4, willRetry: false });
  });

  for (const cause of ['auth', 'bad_request', 'refused', 'truncated', 'invalid_output'] as const) {
    it(`${cause} is final at once and drops the held transcript`, async () => {
      const { s } = await pendingWith([FakeSummaryProvider.fail(cause)]);
      await sweep(later(1000));
      const [v] = await versions(s);
      expect(v).toMatchObject({ state: 'failed', attempts: 1, cause });
      expect(await t.ctx.presence.getKey(transcriptKey(s))).toBeNull();
      const f = (await chainOf(t, admin.org.id)).find((r) => r.sessionId === s && r.action === 'summary.failed')!;
      expect(f.data).toMatchObject({ provider: 'local', cause, attempt: 1, willRetry: false });
    });
  }

  it('an answer that is not the summary object is invalid_output; an over-long one is normalised', async () => {
    const { s } = await pendingWith([FakeSummaryProvider.ok({ hello: 'world' })], false);
    await sweep(later(1000));
    expect((await versions(s))[0]).toMatchObject({ state: 'failed', cause: 'invalid_output' });
    const { s: s2 } = await pendingWith([FakeSummaryProvider.ok({ ...GOOD_OUTPUT, summary: 'word '.repeat(400) })], false);
    await sweep(later(1000));
    const [v] = await versions(s2);
    expect(v).toMatchObject({ state: 'ready', normalised: true });
    expect((v!.output as { summary: string }).summary.length).toBeLessThanOrEqual(1500);
  });

  it('a policy turned to none while pending fails the version as provider_disabled', async () => {
    const { fake, s } = await pendingWith([FakeSummaryProvider.ok()], false);
    await setPolicy(t, admin.org.id, { provider: 'none' });
    await sweep(later(1000));
    expect((await versions(s))[0]).toMatchObject({ state: 'failed', cause: 'provider_disabled' });
    expect(fake.inputs).toHaveLength(0);
  });
});

describe('versions, edits and reads (5.8e-f, 5.9)', () => {
  it('edits create a new ready version from the latest; stale or unready bases are refused', async () => {
    useProviders(t, { local: new FakeSummaryProvider('local', [FakeSummaryProvider.ok(), FakeSummaryProvider.fail('bad_request')]) });
    await setPolicy(t, admin.org.id, { provider: 'local', includeTranscript: false });
    const s = await ended();
    await call(t.app, `/api/v1/sessions/${s}/summary`, { cookie: tech.cookie, body: {} });
    // Not ready yet: a named read and an edit are refused.
    expect((await call(t.app, `/api/v1/sessions/${s}/summary/versions/1`, { cookie: tech.cookie })).json().error.code).toBe('summary_not_ready');
    const early = await call(t.app, `/api/v1/sessions/${s}/summary`, { method: 'PUT', cookie: tech.cookie, body: { baseVersion: 1, output: GOOD_OUTPUT } });
    expect(early.json().error.code).toBe('summary_not_ready');
    await sweep(new Date());

    const edited = { ...GOOD_OUTPUT, summary: 'Edited by the technician.', followUps: ['Check again on Monday'] };
    const put = await call(t.app, `/api/v1/sessions/${s}/summary`, { method: 'PUT', cookie: tech.cookie, body: { baseVersion: 1, output: edited } });
    expect(put.statusCode, put.body).toBe(200);
    const v2 = aiSessionSummarySchema.parse(put.json());
    expect(v2).toMatchObject({ version: 2, state: 'ready', trigger: 'edit', provider: 'local', model: 'fake-local-model', editedBy: { id: tech.user.id }, output: edited });
    const stale = await call(t.app, `/api/v1/sessions/${s}/summary`, { method: 'PUT', cookie: tech.cookie, body: { baseVersion: 1, output: edited } });
    expect(stale.json().error.code).toBe('summary_conflict');
    const bad = await call(t.app, `/api/v1/sessions/${s}/summary`, { method: 'PUT', cookie: tech.cookie, body: { baseVersion: 2, output: { ...edited, outcome: 'great' } } });
    expect(bad.json().error.code).toBe('validation_failed');

    const v1Row = (await versions(s))[0]!;
    const e = (await chainOf(t, admin.org.id)).find((r) => r.sessionId === s && r.action === 'summary.edited')!;
    expect(e).toMatchObject({ actorType: 'user', data: { summaryId: v2.id, version: 2, baseVersion: 1, sha256: v2.sha256, previousSha256: v1Row.outputSha256 } });

    // A regenerate that fails: the latest version is failed; the list shows every version, oldest first.
    expect((await call(t.app, `/api/v1/sessions/${s}/summary`, { cookie: tech.cookie, body: {} })).statusCode).toBe(202);
    await sweep(new Date());
    const list = sessionSummaryListSchema.parse((await call(t.app, `/api/v1/sessions/${s}/summary`, { cookie: tech.cookie })).json());
    expect(list.versions.map((v) => [v.version, v.state, v.trigger])).toEqual([
      [1, 'ready', 'on_demand'],
      [2, 'ready', 'edit'],
      [3, 'failed', 'on_demand'],
    ]);
    expect(list.latest).toMatchObject({ version: 3, state: 'failed', cause: 'bad_request', output: null });
    expect((await call(t.app, `/api/v1/sessions/${s}/summary/versions/3`, { cookie: tech.cookie })).json().error.code).toBe('summary_not_ready');
    expect((await call(t.app, `/api/v1/sessions/${s}/summary/versions/2`, { cookie: tech.cookie })).json().output).toEqual(edited);
    expect((await call(t.app, `/api/v1/sessions/${s}/summary/versions/9`, { cookie: tech.cookie })).statusCode).toBe(404);
    expect((await call(t.app, `/api/v1/sessions/${s}/summary/versions/x`, { cookie: tech.cookie })).statusCode).toBe(404);
    // An edit on top of a failed latest version is not ready.
    const onFailed = await call(t.app, `/api/v1/sessions/${s}/summary`, { method: 'PUT', cookie: tech.cookie, body: { baseVersion: 3, output: edited } });
    expect(onFailed.json().error.code).toBe('summary_not_ready');
  });

  it('RBAC: own session for technicians, org for seniors and admins, read for auditors, nothing for observers', async () => {
    useProviders(t, { local: new FakeSummaryProvider('local') });
    await setPolicy(t, admin.org.id, { provider: 'local', includeTranscript: false });
    const s = await ended();
    const get = (acc: Account) => call(t.app, `/api/v1/sessions/${s}/summary`, { cookie: acc.cookie });
    const post = (acc: Account) => call(t.app, `/api/v1/sessions/${s}/summary`, { cookie: acc.cookie, body: {} });
    expect((await get(otherTech)).statusCode).toBe(403);
    expect((await post(otherTech)).statusCode).toBe(403);
    expect((await get(observer)).statusCode).toBe(403);
    expect((await post(auditor)).statusCode).toBe(403);
    expect((await get(auditor)).statusCode).toBe(200);
    expect((await get(stranger)).statusCode).toBe(404);
    expect((await post(senior)).statusCode).toBe(202);
    expect((await post(admin)).json().error.code).toBe('summary_running');
    expect((await get(tech)).statusCode).toBe(200);
  });
});
