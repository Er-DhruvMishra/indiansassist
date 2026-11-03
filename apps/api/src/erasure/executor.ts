/**
 * Phase F stream erasure, section 5.3 (docs/specs/phase-f-contracts.md): the execution of a due erasure, step by step
 * in the bound order (freeze, stop, chain, objects, rows, seal, verify, certify, notify). Each step records its
 * completion in `org_erasure.progress` (step name -> ISO time) and is safe to repeat, so a crash anywhere resumes on
 * the next sweep. Step 5 runs one transaction per table and records each table in `progress` with it (`rows:<table>`),
 * so a table whose rows were deleted is never counted twice. Counts accumulate in `org_erasure.counts` as flat keys
 * (`deleted:<table>`, `scrubbed:<table>`, `objectBytes`), which become the `org.erased` counts and the certificate.
 *
 * What step 1 computes from rows later steps scrub (the unpeppered `login_attempt` hashes of every user and the
 * addresses of the active org_admins and auditors) is carried sealed in `progress.carry` (`erasure-carry` purpose,
 * record id = the erasure id) and deleted at the end of step 9, so a crash after step 5 loses neither.
 *
 * Deviations recorded for the report: tokens are revoked silently (TOKEN_REVOKE_REASONS has no `org_erased` and the
 * chain already says `org.erasure_started`); queued device actions, open wakes and open SOL sessions are settled
 * silently in step 2, so the fleet sweep never tries to chain an entry for the org after step 6; the sessions'
 * pending hand-overs are cleared for the same reason.
 */
import {
  DEFAULT_AI_POLICY,
  DEFAULT_UNATTENDED_POLICY,
  DEVICE_ACTION_FINAL_STATES,
  type ErasureStep,
  hashAuditEntry,
  LIMITS,
  sha256Hex,
  signErasureCertificate,
  WS_CLOSE,
  type ChainEntry,
  type DataFlowKind,
  type UnsignedErasureCertificate,
} from '@indiansassist/shared';
import {
  amtSol,
  authSession,
  device,
  deviceAction,
  deviceGroup,
  getAuditEntryBySeq,
  getErasure,
  getOrg,
  getOrgChainTail,
  integration,
  loginAttempt,
  NON_ENDED_STATES,
  org as orgTable,
  orgErasure,
  passwordReset,
  playbook,
  playbookRun,
  recording,
  revokeToken,
  session,
  sessionFile,
  sessionHost,
  sessionParticipant,
  sessionSummary,
  ssoDomain,
  ssoIdentity,
  technicianSeat,
  ticketPush,
  toChainEntry,
  token,
  transitionErasure,
  user,
  verifyOrgChain,
  wakeAttempt,
  type Executor,
  type OrgErasureRow,
  type OrgRow,
  type Tx,
} from '@indiansassist/db';
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { transcriptKey } from '../ai/transcript.js';
import { failInFlightPushes } from '../integrations/push.js';
import { systemActor, writeAudit } from '../lib/audit.js';
import { openOrgSecret, sealOrgSecret } from '../lib/org-secrets.js';
import { buildResidencyReport } from '../services/residency.js';
import { endSessionQuietly } from '../services/session-end.js';
import { certificateMail, mailEach, presenceWaitMs } from './model.js';

/** Thrown by the test hook `crashAfter` right after the named marker committed (a simulated crash). */
export class ErasureCrash extends Error {
  constructor(readonly marker: string) {
    super(`simulated crash after ${marker}`);
    this.name = 'ErasureCrash';
  }
}

export type RunErasureOptions = {
  /** Test hook: throw `ErasureCrash` right after this step or `rows:<table>` marker committed. */
  crashAfter?: string;
};

export type RunErasureResult = 'completed' | 'waiting' | 'skipped' | 'busy';

/** What step 1 carries sealed for later steps. */
type Carry = { emailHashes: string[]; notify: string[] };

type Progress = Record<string, unknown>;

/** Lease TTL of `erasure:<id>`; refreshed before every step. */
const LEASE_TTL_SEC = 300;

// Presence keys derived from the org's ids (section 5.3 step 2). Kept beside their owners' definitions:
// lib/desk-codes.ts (`ia:dc:`, `ia:dct:`), fleet/common.ts (`ia:dev:`), fleet/receipts.ts (`ia:rcpt:`),
// signal/handover.ts (`ia:ho:`) and the camera stream's `ia:cam:` / `ia:camsess:` (section 6.2).
const deskCodeKey = (hash: string) => `ia:dc:${hash}`;
const deskCodeIndexKey = (tokenId: string) => `ia:dct:${tokenId}`;
const devicePresenceKey = (deviceId: string) => `ia:dev:${deviceId}`;
const receiptKey = (deviceId: string) => `ia:rcpt:${deviceId}`;
const handoverKey = (hash: string) => `ia:ho:${hash}`;
const cameraSessionKey = (sessionId: string) => `ia:camsess:${sessionId}`;
const cameraCodeKey = (codeHash: string) => `ia:cam:${codeHash}`;

function carryRef(row: Pick<OrgErasureRow, 'id' | 'orgId'>) {
  return { orgId: row.orgId, purpose: 'erasure-carry' as const, recordId: row.id };
}

/** Merges `patch` into `progress` (jsonb `||`), in the caller's transaction. */
async function patchProgress(exec: Executor, id: string, patch: Progress): Promise<void> {
  await exec
    .update(orgErasure)
    .set({ progress: sql`${orgErasure.progress} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(orgErasure.id, id));
}

/** Adds `deltas` to the flat counts (read, add, write under a row lock, in the caller's transaction). */
async function addCounts(exec: Executor, id: string, deltas: Record<string, number>): Promise<void> {
  const [cur] = await exec.select({ counts: orgErasure.counts }).from(orgErasure).where(eq(orgErasure.id, id)).for('update');
  const next: Record<string, number> = { ...((cur?.counts as Record<string, number> | null) ?? {}) };
  for (const [k, v] of Object.entries(deltas)) next[k] = (next[k] ?? 0) + v;
  await exec.update(orgErasure).set({ counts: next }).where(eq(orgErasure.id, id));
}

function iso(d: Date = new Date()): string {
  return d.toISOString();
}

/**
 * Runs (or resumes) one erasure as far as it can go now: `waiting` when step 8 must wait for presence keys to
 * expire, `completed` when the certificate is stored (and step 9 ran), `skipped` when it is not due or was cancelled,
 * `busy` when another node holds its lease.
 */
export async function runErasure(ctx: AppContext, id: string, opts: RunErasureOptions = {}): Promise<RunErasureResult> {
  const lease = `erasure:${id}`;
  const hold = () => ctx.presence.tryLease(lease, ctx.config.nodeId, LEASE_TTL_SEC);
  if (!(await hold())) return 'busy';
  const crash = (marker: string) => {
    if (opts.crashAfter === marker) throw new ErasureCrash(marker);
  };
  let row = await getErasure(ctx.db, id);
  if (!row) return 'skipped';
  if (row.state === 'completed') {
    if ('carry' in (row.progress as Progress)) await stepNotify(ctx, row);
    return 'completed';
  }
  if (row.state === 'cooling_off' && (!row.coolingOffUntil || row.coolingOffUntil.getTime() > Date.now())) return 'skipped';
  if (row.state !== 'cooling_off' && row.state !== 'executing') return 'skipped';

  const done = (step: ErasureStep | string) => step in ((row!.progress ?? {}) as Progress);
  const reload = async () => {
    row = (await getErasure(ctx.db, id))!;
    if (!(await hold())) throw new Error(`lost the lease ${lease}`);
  };

  if (!done('freeze')) {
    if (!(await stepFreeze(ctx, row))) return 'skipped';
    crash('freeze');
    await reload();
  }
  const org = await getOrg(ctx.db, row.orgId);
  if (!org) throw new Error(`org ${row.orgId} of erasure ${id} not found`);
  if (!done('stop')) {
    await stepStop(ctx, row, org);
    crash('stop');
    await reload();
  }
  if (!done('chain')) {
    await ctx.db.transaction(async (tx) => {
      await writeAudit(ctx, tx, org, { actor: systemActor, action: 'org.erasure_started', data: { erasureId: id } });
      await patchProgress(tx, id, { chain: iso() });
    });
    crash('chain');
    await reload();
  }
  if (!done('objects')) {
    await stepObjects(ctx, row, org);
    crash('objects');
    await reload();
  }
  if (!done('rows')) {
    await stepRows(ctx, row, org, crash);
    crash('rows');
    await reload();
  }
  if (!done('seal')) {
    await stepSeal(ctx, row);
    crash('seal');
    await reload();
  }
  if (!done('verify')) {
    const v = await verifyOrgChain(ctx.db, row.orgId, { pubKeys: ctx.keys.all });
    await patchProgress(ctx.db, id, { verify: iso(), verifyResult: { ok: v.ok, checked: v.checked, tail: v.tail, failure: v.failure ?? null } });
    crash('verify');
    await reload();
  }
  if (!done('certify')) {
    const stopAt = Date.parse(String((row.progress as Progress)['stop']));
    if (Date.now() < stopAt + presenceWaitMs(ctx)) return 'waiting';
    await stepCertify(ctx, row, org);
    crash('certify');
    await reload();
  }
  if (!done('notify')) await stepNotify(ctx, row);
  return 'completed';
}

// ---------- step 1: freeze ----------

/** The flow kinds enabled at execution (E section 6.2), for the certificate. Read before step 5 removes them. */
async function enabledFlowKinds(ctx: AppContext, org: OrgRow): Promise<DataFlowKind[]> {
  try {
    const report = await buildResidencyReport(ctx, org);
    return [...new Set((report.dataFlows ?? []).filter((f) => f.enabled).map((f) => f.kind))].sort();
  } catch (err) {
    ctx.log.warn({ err: { name: (err as Error)?.name } }, 'erasure: the flow kinds could not be read; the certificate lists none');
    return [];
  }
}

async function stepFreeze(ctx: AppContext, row: OrgErasureRow): Promise<boolean> {
  const org = await getOrg(ctx.db, row.orgId);
  if (!org) throw new Error(`org ${row.orgId} not found`);
  const flows = await enabledFlowKinds(ctx, org);
  const now = new Date();
  return ctx.db.transaction(async (tx) => {
    // Compare-and-set: a Cancel that won the race leaves the erasure cancelled and nothing frozen.
    const r = await transitionErasure(tx, row.id, ['cooling_off', 'executing'], 'executing', { executedAt: row.executedAt ?? now });
    if (!r) return false;
    if ('freeze' in (r.progress as Progress)) return true;
    await tx.update(orgTable).set({ erasingAt: now }).where(and(eq(orgTable.id, org.id), isNull(orgTable.erasingAt)));
    const people = await tx.select({ email: user.email, role: user.role, status: user.status }).from(user).where(eq(user.orgId, org.id));
    const carry: Carry = {
      // A section 4.2: `login_attempt.email_hash` is `sha256Hex(lower(email))`, unpeppered.
      emailHashes: [...new Set(people.map((p) => sha256Hex(p.email.toLowerCase())))],
      notify: [...new Set(people.filter((p) => p.status === 'active' && (p.role === 'org_admin' || p.role === 'auditor')).map((p) => p.email))],
    };
    const sealed = sealOrgSecret(ctx, carryRef(row), JSON.stringify(carry));
    await patchProgress(tx, row.id, { carry: sealed, flows, freeze: iso(now) });
    return true;
  });
}

function openCarry(ctx: AppContext, row: OrgErasureRow): Carry {
  const sealed = (row.progress as Progress)['carry'];
  if (typeof sealed !== 'string') return { emailHashes: [], notify: [] };
  const v = JSON.parse(openOrgSecret(ctx, carryRef(row), sealed)) as Partial<Carry>;
  return { emailHashes: Array.isArray(v.emailHashes) ? v.emailHashes : [], notify: Array.isArray(v.notify) ? v.notify : [] };
}

// ---------- step 2: stop ----------

async function stepStop(ctx: AppContext, row: OrgErasureRow, org: OrgRow): Promise<void> {
  const orgId = org.id;
  // Live sessions end with `org_erased` (endSessionFlow: chained, the hub told, the participants closed).
  const open = await ctx.db.select({ id: session.id }).from(session).where(and(eq(session.orgId, orgId), inArray(session.state, [...NON_ENDED_STATES])));
  for (const s of open) {
    try {
      await endSessionQuietly(ctx, s.id, { reason: 'org_erased', actor: systemActor });
    } catch (err) {
      ctx.log.error({ err, sessionId: s.id }, 'erasure: a session did not end; the step is retried');
    }
  }
  const left = await ctx.db.select({ id: session.id }).from(session).where(and(eq(session.orgId, orgId), inArray(session.state, [...NON_ENDED_STATES])));
  if (left.length > 0) throw new Error(`erasure ${row.id}: ${left.length} session(s) still open`);

  // Every token revoked; its waiting Desk sockets dropped.
  const toks = await ctx.db.select({ id: token.id, status: token.status }).from(token).where(eq(token.orgId, orgId));
  for (const t of toks) {
    if (t.status === 'active') await revokeToken(ctx.db, t.id, null);
    ctx.hub.tokenRevoked(t.id);
  }

  // Every cookie session deleted; the users' sockets closed 4401.
  const users = await ctx.db.select({ id: user.id }).from(user).where(eq(user.orgId, orgId));
  const userIds = users.map((u) => u.id);
  if (!('stop:auth_session' in (row.progress as Progress))) {
    await ctx.db.transaction(async (tx) => {
      const gone = userIds.length ? await tx.delete(authSession).where(inArray(authSession.userId, userIds)).returning({ id: authSession.id }) : [];
      await addCounts(tx, row.id, { 'deleted:auth_session': gone.length });
      await patchProgress(tx, row.id, { 'stop:auth_session': iso() });
    });
  }
  for (const u of userIds) ctx.hub.closeUserSockets(u, WS_CLOSE.unauthenticated);

  // Every enrolled device disabled and sent off its socket (the D refusal `device_disabled`, close 4412).
  const devs = await ctx.db.select({ id: device.id }).from(device).where(eq(device.orgId, orgId));
  await ctx.db.update(device).set({ status: 'disabled' }).where(and(eq(device.orgId, orgId), eq(device.status, 'enrolled')));
  for (const d of devs) await ctx.hub.devices.kick(d.id, 'device_disabled', 'this organisation is being erased');

  // Fleet work settled so no later sweep chains an entry for the org.
  const now = new Date();
  await ctx.db
    .update(deviceAction)
    .set({ state: 'cancelled', completedAt: now })
    .where(and(eq(deviceAction.orgId, orgId), notInArray(deviceAction.state, [...DEVICE_ACTION_FINAL_STATES])));
  await ctx.db.update(wakeAttempt).set({ state: 'failed' }).where(and(eq(wakeAttempt.orgId, orgId), inArray(wakeAttempt.state, ['pending', 'dispatched'])));
  await ctx.db.update(amtSol).set({ closedAt: now }).where(and(eq(amtSol.orgId, orgId), isNull(amtSol.closedAt)));
  // Pending elevation hand-overs cleared (the sweeper would otherwise chain `elevation.failed` after step 6).
  const handovers = await ctx.db
    .select({ hash: session.handoverHash })
    .from(session)
    .where(and(eq(session.orgId, orgId), isNotNull(session.handoverHash)));
  await ctx.db
    .update(session)
    .set({ handoverHash: null, handoverOpid: null, handoverExpiresAt: null })
    .where(and(eq(session.orgId, orgId), isNotNull(session.handoverHash)));

  // Ticket pushes in flight fail `misconfigured`, summaries `provider_disabled` (their existing failure entries).
  for (const integ of await ctx.db.select().from(integration).where(eq(integration.orgId, orgId)))
    await failInFlightPushes(ctx, integ, 'the organisation is being erased');
  await failOpenSummaries(ctx, org);

  // Presence keys derivable from the org's ids. `Presence` has no scan; anything missed expires before step 8.
  const sessions = await ctx.db.select({ id: session.id }).from(session).where(eq(session.orgId, orgId));
  for (const t of toks) {
    await ctx.presence.setTokenSession(t.id, null);
    const st = await ctx.presence.getTokenState(t.id);
    if (st.waiting) await ctx.presence.clearTokenWaiting(t.id, st.waiting.connectionId);
    const idx = await ctx.presence.getKey(deskCodeIndexKey(t.id));
    for (const h of parseHashList(idx)) await ctx.presence.delKey(deskCodeKey(h));
    await ctx.presence.delKey(deskCodeIndexKey(t.id));
  }
  for (const s of sessions) {
    await ctx.presence.delKey(transcriptKey(s.id));
    const cam = await ctx.presence.getKey(cameraSessionKey(s.id));
    const codeHash = parseCodeHash(cam);
    if (codeHash) await ctx.presence.delKey(cameraCodeKey(codeHash));
    await ctx.presence.delKey(cameraSessionKey(s.id));
  }
  for (const h of handovers) if (h.hash) await ctx.presence.delKey(handoverKey(h.hash));
  for (const d of devs) {
    await ctx.presence.delKey(devicePresenceKey(d.id));
    await ctx.presence.delKey(receiptKey(d.id));
  }
  for (const a of await ctx.presence.listAssistsOnline(orgId)) await ctx.presence.clearAssistOnline(orgId, a.connectionId);
  await patchProgress(ctx.db, row.id, { stop: iso() });
}

function parseHashList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)) : [];
  } catch {
    return [];
  }
}

function parseCodeHash(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { codeHash?: unknown };
    return typeof v.codeHash === 'string' && /^[0-9a-f]{64}$/.test(v.codeHash) ? v.codeHash : null;
  } catch {
    return null;
  }
}

/** Every `pending` or `running` summary of the org fails `provider_disabled` (`summary.failed`, final). */
async function failOpenSummaries(ctx: AppContext, org: OrgRow): Promise<void> {
  const rows = await ctx.db.select().from(sessionSummary).where(and(eq(sessionSummary.orgId, org.id), inArray(sessionSummary.state, ['pending', 'running'])));
  for (const s of rows) {
    const attempt = Math.max(1, s.attempts);
    await ctx.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(sessionSummary)
        .set({ state: 'failed', cause: 'provider_disabled', detail: 'the organisation is being erased', attempts: attempt, nextAttemptAt: null, completedAt: new Date() })
        .where(and(eq(sessionSummary.id, s.id), inArray(sessionSummary.state, ['pending', 'running'])))
        .returning({ id: sessionSummary.id });
      if (!updated) return;
      await writeAudit(ctx, tx, org, {
        sessionId: s.sessionId,
        actor: systemActor,
        action: 'summary.failed',
        data: { summaryId: s.id, version: s.version, provider: s.provider, cause: 'provider_disabled', attempt, willRetry: false },
      });
    });
    await ctx.presence.delKey(transcriptKey(s.sessionId));
  }
}

// ---------- step 4: objects ----------

async function stepObjects(ctx: AppContext, row: OrgErasureRow, org: OrgRow): Promise<void> {
  const prefix = `${org.dataRegion}/${org.id}/`;
  for (;;) {
    const batch: { key: string; bytes: number }[] = [];
    for await (const o of ctx.storage.list(prefix)) {
      batch.push(o);
      if (batch.length >= LIMITS.erasureBatchRows) break;
    }
    if (batch.length === 0) break;
    for (const o of batch) await ctx.storage.delete(o.key);
    await ctx.db.transaction((tx) => addCounts(tx, row.id, { 'deleted:recordingObjects': batch.length, objectBytes: batch.reduce((n, o) => n + o.bytes, 0) }));
  }
  await ctx.db.transaction(async (tx) => {
    const marked = await tx
      .update(recording)
      .set({ deletedAt: new Date(), status: sql`case when ${recording.status} = 'uploading' then 'failed'::recording_status else ${recording.status} end` })
      .where(and(eq(recording.orgId, org.id), isNull(recording.deletedAt)))
      .returning({ id: recording.id });
    await addCounts(tx, row.id, { 'scrubbed:recording': marked.length });
    await patchProgress(tx, row.id, { objects: iso() });
  });
}

// ---------- step 5: rows (section 5.4), one transaction per table, in the A section 4.2 lock order ----------

type TableOp = { table: string; kind: 'deleted' | 'scrubbed'; run: (tx: Tx) => Promise<number> };

async function stepRows(ctx: AppContext, row: OrgErasureRow, org: OrgRow, crash: (marker: string) => void): Promise<void> {
  const orgId = org.id;
  const orgSessions = sql`(select ${session.id} from ${session} where ${session.orgId} = ${orgId})`;
  const orgUsers = sql`(select ${user.id} from ${user} where ${user.orgId} = ${orgId})`;
  const n = (rows: unknown[]) => rows.length;
  const carry = openCarry(ctx, row);
  const unreferenced = sql`not exists (select 1 from ${ticketPush} where ${ticketPush.integrationId} = ${integration.id})`;

  const ops: TableOp[] = [
    // Session rows and their children first, then token rows (the lock order), then everything else.
    {
      table: 'session',
      kind: 'scrubbed',
      run: async (tx) => n(await tx.update(session).set({ deskLabel: null, deskUserAgent: null, deskClient: null, lastStats: null }).where(eq(session.orgId, orgId)).returning({ id: session.id })),
    },
    {
      table: 'session_participant',
      kind: 'scrubbed',
      run: async (tx) => n(await tx.update(sessionParticipant).set({ label: 'erased' }).where(sql`${sessionParticipant.sessionId} in ${orgSessions}`).returning({ id: sessionParticipant.id })),
    },
    { table: 'session_host', kind: 'deleted', run: async (tx) => n(await tx.delete(sessionHost).where(eq(sessionHost.orgId, orgId)).returning({ id: sessionHost.id })) },
    {
      table: 'session_file',
      kind: 'scrubbed',
      run: async (tx) => n(await tx.update(sessionFile).set({ name: 'erased' }).where(sql`${sessionFile.sessionId} in ${orgSessions}`).returning({ id: sessionFile.id })),
    },
    { table: 'playbook_run', kind: 'scrubbed', run: async (tx) => n(await tx.update(playbookRun).set({ error: null }).where(eq(playbookRun.orgId, orgId)).returning({ id: playbookRun.runId })) },
    { table: 'token', kind: 'scrubbed', run: async (tx) => n(await tx.update(token).set({ label: null }).where(eq(token.orgId, orgId)).returning({ id: token.id })) },
    { table: 'technician_seat', kind: 'deleted', run: async (tx) => n(await tx.delete(technicianSeat).where(eq(technicianSeat.orgId, orgId)).returning({ id: technicianSeat.id })) },
    { table: 'auth_session', kind: 'deleted', run: async (tx) => n(await tx.delete(authSession).where(sql`${authSession.userId} in ${orgUsers}`).returning({ id: authSession.id })) },
    { table: 'sso_identity', kind: 'deleted', run: async (tx) => n(await tx.delete(ssoIdentity).where(eq(ssoIdentity.orgId, orgId)).returning({ id: ssoIdentity.id })) },
    { table: 'sso_domain', kind: 'deleted', run: async (tx) => n(await tx.delete(ssoDomain).where(eq(ssoDomain.orgId, orgId)).returning({ id: ssoDomain.id })) },
    { table: 'password_reset', kind: 'deleted', run: async (tx) => n(await tx.delete(passwordReset).where(sql`${passwordReset.userId} in ${orgUsers}`).returning({ id: passwordReset.id })) },
    {
      table: 'user',
      kind: 'scrubbed',
      run: async (tx) =>
        n(
          await tx
            .update(user)
            .set({
              email: sql`'erased+' || ${user.id}::text || '@erased.invalid'`,
              name: 'Erased user',
              passwordHash: null,
              authRef: null,
              inviteTokenHash: null,
              inviteExpiresAt: null,
              inviteMailedAt: null,
              deviceGroupIds: null,
              status: 'disabled',
              ssoBreakGlass: false,
            })
            .where(eq(user.orgId, orgId))
            .returning({ id: user.id }),
        ),
    },
    {
      // The hashes come from step 1's carry: hashing the scrubbed addresses now would miss every row.
      table: 'login_attempt',
      kind: 'deleted',
      run: async (tx) => {
        let total = 0;
        for (let i = 0; i < carry.emailHashes.length; i += LIMITS.erasureBatchRows) {
          const chunk = carry.emailHashes.slice(i, i + LIMITS.erasureBatchRows);
          total += n(await tx.delete(loginAttempt).where(inArray(loginAttempt.emailHash, chunk)).returning({ id: loginAttempt.id }));
        }
        return total;
      },
    },
    {
      table: 'device',
      kind: 'scrubbed',
      run: async (tx) =>
        n(
          await tx
            .update(device)
            .set({
              name: 'Erased device',
              groupName: null,
              tags: [],
              lastIp: null,
              macEnc: null,
              macHash: null,
              notifyEmail: null,
              hwFingerprint: null,
              interactive: null,
              lanSegment: null,
              amt: null,
              publicKey: null,
              kexPublicKey: null,
              status: sql`case when ${device.status} = 'enrolled' then 'disabled'::device_status else ${device.status} end`,
            })
            .where(eq(device.orgId, orgId))
            .returning({ id: device.id }),
        ),
    },
    {
      table: 'device_group',
      kind: 'scrubbed',
      run: async (tx) =>
        n(
          await tx
            .update(deviceGroup)
            .set({ name: sql`'Erased group ' || left(${deviceGroup.id}::text, 8)`, description: null, notifyEmail: null, defaultTags: [] })
            .where(eq(deviceGroup.orgId, orgId))
            .returning({ id: deviceGroup.id }),
        ),
    },
    {
      table: 'device_action',
      kind: 'scrubbed',
      run: async (tx) => n(await tx.update(deviceAction).set({ payload: {}, result: null, reason: null }).where(eq(deviceAction.orgId, orgId)).returning({ id: deviceAction.id })),
    },
    { table: 'wake_attempt', kind: 'scrubbed', run: async (tx) => n(await tx.update(wakeAttempt).set({ reason: null }).where(eq(wakeAttempt.orgId, orgId)).returning({ id: wakeAttempt.id })) },
    { table: 'amt_sol', kind: 'scrubbed', run: async (tx) => n(await tx.update(amtSol).set({ reason: 'erased', transcriptRef: null }).where(eq(amtSol.orgId, orgId)).returning({ id: amtSol.id })) },
    { table: 'playbook', kind: 'deleted', run: async (tx) => n(await tx.delete(playbook).where(eq(playbook.orgId, orgId)).returning({ id: playbook.id })) },
    {
      // The E section 4.7 rule: deleted when no push references it, else reset to the unconfigured state.
      table: 'integration',
      kind: 'deleted',
      run: async (tx) => {
        const gone = n(await tx.delete(integration).where(and(eq(integration.orgId, orgId), unreferenced)).returning({ id: integration.id }));
        const reset = n(
          await tx
            .update(integration)
            .set({ enabled: false, config: {}, credentialsEnc: null, credentialsSetAt: null, credentialsFp: null, lastTest: null })
            .where(eq(integration.orgId, orgId))
            .returning({ id: integration.id }),
        );
        await addCounts(tx, row.id, { 'scrubbed:integration': reset });
        return gone;
      },
    },
    {
      table: 'ticket_push',
      kind: 'scrubbed',
      run: async (tx) =>
        n(
          await tx
            .update(ticketPush)
            .set({ content: {}, externalUrl: null, externalId: null, externalIdIn: null, lastFailure: null })
            .where(eq(ticketPush.orgId, orgId))
            .returning({ id: ticketPush.id }),
        ),
    },
    {
      table: 'session_summary',
      kind: 'scrubbed',
      run: async (tx) => n(await tx.update(sessionSummary).set({ output: null, detail: null, usage: null }).where(eq(sessionSummary.orgId, orgId)).returning({ id: sessionSummary.id })),
    },
    { table: 'org_erasure', kind: 'scrubbed', run: async (tx) => n(await tx.update(orgErasure).set({ reason: null }).where(eq(orgErasure.orgId, orgId)).returning({ id: orgErasure.id })) },
    {
      table: 'org',
      kind: 'scrubbed',
      run: async (tx) =>
        n(
          await tx
            .update(orgTable)
            .set({
              name: 'Erased organisation',
              slug: `erased-${orgId.replace(/-/g, '').slice(0, 8)}`,
              branding: {},
              ssoConfig: null,
              ssoRequired: false,
              ssoSecretEnc: null,
              ssoSecretSetAt: null,
              ssoSecretFp: null,
              ssoSpKeyEnc: null,
              ssoSpKeySetAt: null,
              ssoSpKeyFp: null,
              ssoSpCert: null,
              ssoLastTest: null,
              aiPolicy: { ...DEFAULT_AI_POLICY },
              unattendedPolicy: { ...DEFAULT_UNATTENDED_POLICY },
            })
            .where(eq(orgTable.id, orgId))
            .returning({ id: orgTable.id }),
        ),
    },
  ];

  for (const op of ops) {
    const marker = `rows:${op.table}`;
    if (marker in (row.progress as Progress)) continue;
    await ctx.db.transaction(async (tx) => {
      const count = await op.run(tx);
      await addCounts(tx, row.id, { [`${op.kind}:${op.table}`]: count });
      await patchProgress(tx, row.id, { [marker]: iso() });
    });
    crash(marker);
  }
  await patchProgress(ctx.db, row.id, { rows: iso() });
}

// ---------- step 6: seal ----------

/** The flat counts as the `org.erased` data and the certificate read them. */
function countsOf(row: OrgErasureRow): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries((row.counts as Record<string, unknown> | null) ?? {})) if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  return out;
}

async function stepSeal(ctx: AppContext, row: OrgErasureRow): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [o] = await tx.select().from(orgTable).where(eq(orgTable.id, row.orgId)).for('update');
    if (!o) throw new Error(`org ${row.orgId} not found`);
    if (o.erasedAt === null) {
      const tail = await getOrgChainTail(tx, o.id);
      // The last entry the org's chain will ever have; after this commit insertAuditEntry refuses the org.
      await writeAudit(ctx, tx, o, {
        actor: systemActor,
        action: 'org.erased',
        data: { erasureId: row.id, entriesBefore: tail?.seq ?? 0, counts: countsOf(row) },
      });
      await tx.update(orgTable).set({ auditPepper: null, erasedAt: new Date() }).where(eq(orgTable.id, o.id));
    }
    await patchProgress(tx, row.id, { seal: iso() });
  });
}

// ---------- step 8: certify ----------

function backupsText(ctx: AppContext): string {
  const days = ctx.config.backupRetentionDays;
  return days === null ? 'backup retention not stated' : `database backups are kept for ${days} days (operator setting)`;
}

async function stepCertify(ctx: AppContext, row: OrgErasureRow, org: OrgRow): Promise<void> {
  const progress = row.progress as Progress;
  const v = (progress['verifyResult'] ?? {}) as { ok?: boolean; failure?: { kind: string; seq: number } | null };
  const tail = await getOrgChainTail(ctx.db, org.id);
  if (!tail) throw new Error(`org ${org.id} has no chain`);
  const last = await getAuditEntryBySeq(ctx.db, org.id, tail.seq);
  if (!last || last.action !== 'org.erased') throw new Error(`the last entry of org ${org.id} is not org.erased`);
  const { id: _dbId, ...finalEntry } = toChainEntry(last);
  if (hashAuditEntry(finalEntry) !== tail.hash) throw new Error('the org.erased entry does not recompute to the tail');
  const counts = countsOf(row);
  const pick = (prefix: string) => Object.fromEntries(Object.entries(counts).filter(([k]) => k.startsWith(prefix)).map(([k, n]) => [k.slice(prefix.length), n]));
  const flows = Array.isArray(progress['flows']) ? (progress['flows'] as DataFlowKind[]) : [];
  const completedAt = new Date();
  const unsigned: UnsignedErasureCertificate = {
    v: 1,
    erasureId: row.id,
    orgId: org.id,
    region: org.dataRegion,
    requestedAt: row.requestedAt.toISOString(),
    approvedAt: (row.approvedAt ?? row.requestedAt).toISOString(),
    executedAt: (row.executedAt ?? completedAt).toISOString(),
    completedAt: completedAt.toISOString(),
    chain: {
      entries: tail.seq,
      tail: tail.hash,
      verified: v.ok === true,
      failure: (v.failure ?? null) as UnsignedErasureCertificate['chain']['failure'],
      finalEntry: finalEntry as ChainEntry & UnsignedErasureCertificate['chain']['finalEntry'],
    },
    deleted: pick('deleted:'),
    scrubbed: pick('scrubbed:'),
    objectBytes: counts['objectBytes'] ?? 0,
    externalFlows: flows,
    backups: backupsText(ctx),
  };
  const cert = await signErasureCertificate(unsigned, ctx.keys.seedHex, ctx.keys.kid);
  await ctx.db.transaction(async (tx) => {
    const r = await transitionErasure(tx, row.id, 'executing', 'completed', { certificate: cert as unknown as Record<string, unknown>, completedAt });
    if (!r) throw new Error(`erasure ${row.id} is not executing`);
    await patchProgress(tx, row.id, { certify: iso(completedAt) });
  });
}

// ---------- step 9: notify ----------

async function stepNotify(ctx: AppContext, row: OrgErasureRow): Promise<void> {
  let carry: Carry = { emailHashes: [], notify: [] };
  try {
    carry = openCarry(ctx, row);
  } catch (err) {
    ctx.log.error({ err: { name: (err as Error)?.name }, erasureId: row.id }, 'erasure: the carried addresses could not be opened; no certificate mail');
  }
  if (row.certificate) {
    const m = certificateMail(ctx, row);
    await mailEach(ctx, carry.notify, m.subject, m.text, [{ name: `erasure-certificate-${row.id}.json`, json: row.certificate }]);
  }
  await ctx.db
    .update(orgErasure)
    .set({ progress: sql`(${orgErasure.progress} - 'carry') || ${JSON.stringify({ notify: iso() })}::jsonb` })
    .where(eq(orgErasure.id, row.id));
}
