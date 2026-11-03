/**
 * Phase E stream ai, rule 5.8c-d: the summary worker, run by the sweeper lease holder only (one per region cluster).
 * Each sweep claims due pending versions (at most `LIMITS.summaryConcurrency` running per region) and starts them
 * without blocking the sweeper; a job builds and redacts the input (5.3, 5.4), calls the policy's provider within
 * the provider timeout, validates and normalises the answer (5.5), stores the version and chains the outcome.
 * `rate_limited`, `provider_unavailable` and `timeout` retry after 1, 5 and 15 minutes (`retryAfterSec` honoured
 * when larger) up to `LIMITS.summaryMaxAttempts`; every other cause is final at once.
 */
import { LIMITS, REDACTION_KINDS, normaliseSummaryOutput, summaryOutputSha256, type SummaryFailCause } from '@indiansassist/shared';
import { getOrg, getSession, listDueSummaries, sessionSummary, type OrgRow, type SessionSummaryRow } from '@indiansassist/db';
import { and, eq, lt } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { systemActor, writeAudit } from '../lib/audit.js';
import { buildSummaryInput } from './input.js';
import { orgPolicy } from './policy.js';
import { providerTimeoutMs, type SummaryProviderResult } from './provider.js';
import { dropHeldTranscript, getHeldTranscript } from './transcript.js';

/** 5.8d: the waits before attempts 2, 3 and 4. */
export const SUMMARY_RETRY_DELAYS_SEC = [60, 300, 900] as const;
const RETRYABLE: ReadonlySet<SummaryFailCause> = new Set(['rate_limited', 'provider_unavailable', 'timeout']);
/** Slack beyond the provider timeout before a `running` row left by a lost node is taken back. */
const STALE_RUNNING_SLACK_MS = 60_000;

type Job = { region: string; promise: Promise<void> };
const jobs = new WeakMap<AppContext, Map<string, Job>>();

function jobsOf(ctx: AppContext): Map<string, Job> {
  let m = jobs.get(ctx);
  if (!m) {
    m = new Map();
    jobs.set(ctx, m);
  }
  return m;
}

/** Waits for every job this app started (tests and shutdown). */
export async function drainSummaryJobs(ctx: AppContext): Promise<void> {
  for (;;) {
    const pending = [...jobsOf(ctx).values()].map((j) => j.promise);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

export async function sweepSummaries(ctx: AppContext, now: Date = new Date()): Promise<void> {
  await reclaimStale(ctx, now);
  const running = jobsOf(ctx);
  const perRegion = new Map<string, number>();
  for (const j of running.values()) perRegion.set(j.region, (perRegion.get(j.region) ?? 0) + 1);
  const orgs = new Map<string, OrgRow | null>();
  for (const row of await listDueSummaries(ctx.db, now, 50)) {
    if (running.has(row.id)) continue;
    let org = orgs.get(row.orgId);
    if (org === undefined) {
      org = await getOrg(ctx.db, row.orgId);
      orgs.set(row.orgId, org);
    }
    // Phase F section 5.3 step 2: an org whose erasure is executing (or done) is skipped.
    if (!org || org.erasingAt !== null) continue;
    const region = org.dataRegion;
    if ((perRegion.get(region) ?? 0) >= LIMITS.summaryConcurrency) continue;
    const claimed = await claim(ctx, row, now);
    if (!claimed) continue;
    perRegion.set(region, (perRegion.get(region) ?? 0) + 1);
    const promise = runJob(ctx, claimed, org, now)
      .catch((err: unknown) => ctx.log.error({ err, summaryId: row.id }, 'summary job failed'))
      .finally(() => running.delete(row.id));
    running.set(row.id, { region, promise });
  }
}

/** pending -> running (compare-and-set), counting the attempt; the deadline covers a node lost mid-attempt. */
async function claim(ctx: AppContext, row: SessionSummaryRow, now: Date): Promise<SessionSummaryRow | null> {
  const kind = row.provider === 'anthropic' ? 'anthropic' : 'local';
  const deadline = new Date(now.getTime() + providerTimeoutMs(ctx.config.ai, kind) + STALE_RUNNING_SLACK_MS);
  const [claimed] = await ctx.db
    .update(sessionSummary)
    .set({ state: 'running', attempts: row.attempts + 1, nextAttemptAt: deadline })
    .where(and(eq(sessionSummary.id, row.id), eq(sessionSummary.state, 'pending')))
    .returning();
  return claimed ?? null;
}

/** A `running` version past its deadline that no job of this app holds counts as a timed-out attempt. */
async function reclaimStale(ctx: AppContext, now: Date): Promise<void> {
  const stale = await ctx.db
    .select()
    .from(sessionSummary)
    .where(and(eq(sessionSummary.state, 'running'), lt(sessionSummary.nextAttemptAt, now)))
    .limit(50);
  for (const row of stale) {
    if (jobsOf(ctx).has(row.id)) continue;
    const org = await getOrg(ctx.db, row.orgId);
    if (org) await recordFailure(ctx, org, row, { ok: false, cause: 'timeout', detail: 'the attempt was lost', retryAfterSec: null }, now);
  }
}

async function runJob(ctx: AppContext, row: SessionSummaryRow, org: OrgRow, now: Date): Promise<void> {
  const started = performance.now();
  const policy = orgPolicy((await getOrg(ctx.db, org.id)) ?? org);
  // 5.8d: a policy turned to `none` (or moved to another provider) while the version waited ends it as disabled.
  if (policy.provider === 'none' || policy.provider !== row.provider)
    return recordFailure(ctx, org, row, { ok: false, cause: 'provider_disabled', detail: `the org policy is now ${policy.provider}`, retryAfterSec: null }, now);
  const kind = policy.provider;
  const provider = ctx.summaryProviders(org.dataRegion)[kind];
  if (!provider) return recordFailure(ctx, org, row, { ok: false, cause: 'provider_unavailable', detail: `${kind} is not configured for ${org.dataRegion}`, retryAfterSec: null }, now);
  const session = await getSession(ctx.db, row.sessionId);
  if (!session) return recordFailure(ctx, org, row, { ok: false, cause: 'bad_request', detail: 'session not found', retryAfterSec: null }, now);
  const held = policy.includeTranscript ? await getHeldTranscript(ctx, session.id) : null;
  const built = await buildSummaryInput(ctx.db, session, held);
  for (const k of REDACTION_KINDS) if (built.newRedactions[k] > 0) ctx.metrics.redactions.inc({ kind: k }, built.newRedactions[k]);
  // The provider's own timeout bounds the attempt; this outer deadline only guards against a provider that hangs.
  const signal = AbortSignal.timeout(providerTimeoutMs(ctx.config.ai, kind) + 5_000);
  let result: SummaryProviderResult;
  try {
    result = await provider.summarize(built.input, { signal, region: org.dataRegion, ackScope: policy.anthropicAck?.scope ?? null });
  } catch (err) {
    ctx.log.warn({ err: { name: (err as Error)?.name }, summaryId: row.id }, 'summary provider threw');
    result = { ok: false, cause: signal.aborted ? 'timeout' : 'provider_unavailable', detail: 'provider error', retryAfterSec: null };
  }
  ctx.metrics.summarySeconds.observe({ provider: kind }, (performance.now() - started) / 1000);
  if (!result.ok) return recordFailure(ctx, org, row, result, now);
  const norm = normaliseSummaryOutput(result.output);
  if (!norm) return recordFailure(ctx, org, row, { ok: false, cause: 'invalid_output', detail: 'the answer is not the summary object', retryAfterSec: null }, now);
  const sha256 = summaryOutputSha256(norm.output);
  const completedAt = new Date();
  await ctx.db.transaction(async (tx) => {
    const [stored] = await tx
      .update(sessionSummary)
      .set({
        state: 'ready',
        output: norm.output as unknown as Record<string, unknown>,
        outputSha256: sha256,
        inputSha256: built.inputSha256,
        redactionCounts: built.redactions,
        servedModel: result.servedModel.slice(0, 100),
        inferenceGeo: result.inferenceGeo?.slice(0, 40) ?? null,
        fallbackUsed: result.fallbackUsed,
        transcriptIncluded: built.transcriptIncluded,
        normalised: norm.normalised,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
        cause: null,
        detail: null,
        nextAttemptAt: null,
        completedAt,
      })
      .where(and(eq(sessionSummary.id, row.id), eq(sessionSummary.state, 'running')))
      .returning();
    if (!stored) return;
    await writeAudit(ctx, tx, org, {
      sessionId: row.sessionId,
      actor: systemActor,
      action: 'summary.generated',
      data: {
        summaryId: row.id,
        version: row.version,
        provider: row.provider,
        model: row.model.slice(0, 100),
        servedModel: result.servedModel.slice(0, 100),
        inferenceGeo: result.inferenceGeo?.slice(0, 40) ?? null,
        fallbackUsed: result.fallbackUsed,
        transcriptIncluded: built.transcriptIncluded,
        inputSha256: built.inputSha256,
        sha256,
        redactions: built.redactions,
      },
    });
  });
  ctx.metrics.summaries.inc({ provider: kind, result: 'ready' });
  await dropHeldTranscript(ctx, row.sessionId);
}

/** 5.8d: one failed attempt; retried for the transient causes until `LIMITS.summaryMaxAttempts`, else final. */
async function recordFailure(ctx: AppContext, org: OrgRow, row: SessionSummaryRow, r: Extract<SummaryProviderResult, { ok: false }>, now: Date): Promise<void> {
  const attempt = Math.max(1, row.attempts);
  const willRetry = RETRYABLE.has(r.cause) && attempt < LIMITS.summaryMaxAttempts;
  const delaySec = willRetry ? Math.max(SUMMARY_RETRY_DELAYS_SEC[attempt - 1] ?? 900, r.retryAfterSec ?? 0) : 0;
  await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(sessionSummary)
      .set({
        state: willRetry ? 'pending' : 'failed',
        cause: r.cause,
        detail: r.detail.slice(0, 200),
        attempts: attempt,
        nextAttemptAt: willRetry ? new Date(now.getTime() + delaySec * 1000) : null,
        completedAt: willRetry ? null : new Date(),
      })
      .where(and(eq(sessionSummary.id, row.id), eq(sessionSummary.state, 'running')))
      .returning();
    if (!updated) return;
    await writeAudit(ctx, tx, org, {
      sessionId: row.sessionId,
      actor: systemActor,
      action: 'summary.failed',
      data: { summaryId: row.id, version: row.version, provider: row.provider, cause: r.cause, attempt, willRetry },
    });
  });
  if (row.provider !== 'none') ctx.metrics.summaries.inc({ provider: row.provider, result: r.cause });
  if (!willRetry) await dropHeldTranscript(ctx, row.sessionId);
}
