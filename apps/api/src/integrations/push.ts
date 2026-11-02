/**
 * The push lifecycle (docs/specs/phase-e-contracts.md section 4.4). A push is claimed (attempt counter bumped with a
 * compare-and-set, so two runners never make the same attempt), one adapter call is made with the stored content,
 * and its outcome is chained and written in one transaction:
 *   4.4b delivered: `ticket.push_delivered` (system);
 *   4.4c a failure: `ticket.push_failed { cause, status, attempt, willRetry }` (system) and `last_failure`;
 *   4.4d auto-retryable and under `LIMITS.ticketPushMaxAttempts`: `retrying` with `next_attempt_at`, else `failed`;
 *   4.4g a deleted or disabled integration fails its in-flight pushes with cause `misconfigured`.
 * The chain carries only ids, the cause and the status; never the ticket body or a credential.
 */
import { randomUUID } from 'node:crypto';
import {
  isAutoRetryable,
  LIMITS,
  nextRetryAt,
  ticketContentSchema,
  ticketFailureSchema,
  type TicketFailure,
  type TicketPush,
  type TicketPushState,
} from '@indiansassist/shared';
import { getIntegration, getOrg, ticketPush, type IntegrationRow, type TicketPushRow } from '@indiansassist/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { systemActor, writeAudit } from '../lib/audit.js';
import type { UserRef } from '../lib/mappers.js';
import { isoOrNull, iso } from '../lib/time.js';
import { attemptTiming, INTEGRATION_ADAPTERS, type AdapterCtx, type AdapterResult, type TicketingAdapter, type TicketRef } from './adapter.js';
import { failure } from './http.js';
import { adapterConfigOf, isConfigured, openCredentials } from './store.js';

/** The wire `TicketPush` (never the body). */
export function toTicketPush(r: TicketPushRow, createdBy: UserRef): TicketPush {
  const lf = ticketFailureSchema.safeParse(r.lastFailure);
  return {
    id: r.id,
    sessionId: r.sessionId,
    type: r.type,
    mode: r.mode,
    source: r.source,
    summary: r.summaryVersion !== null && r.source === 'summary' ? { version: r.summaryVersion, sha256: summarySha(r) } : null,
    state: r.state,
    attempts: r.attempts,
    manualRetries: r.manualRetries,
    nextAttemptAt: isoOrNull(r.nextAttemptAt),
    externalId: r.externalId,
    externalUrl: r.externalUrl,
    lastFailure: lf.success ? lf.data : null,
    contentSha256: r.contentSha256,
    createdBy,
    createdAt: iso(r.createdAt),
    deliveredAt: isoOrNull(r.deliveredAt),
  };
}

function summarySha(r: TicketPushRow): string {
  const c = ticketContentSchema.safeParse(r.content);
  return c.success && c.data.summary ? c.data.summary.sha256 : '0'.repeat(64);
}

/** Bumps the attempt counter of a push still in `from` with `attempts = expected` (null when another runner won). */
export async function claimAttempt(
  ctx: AppContext,
  push: TicketPushRow,
  from: TicketPushState,
  set: { state: TicketPushState; manualRetries?: number },
  now: Date,
): Promise<TicketPushRow | null> {
  const [row] = await ctx.db
    .update(ticketPush)
    .set({
      attempts: push.attempts + 1,
      state: set.state,
      nextAttemptAt: null,
      updatedAt: now,
      ...(set.manualRetries !== undefined ? { manualRetries: set.manualRetries } : {}),
    })
    .where(and(eq(ticketPush.id, push.id), eq(ticketPush.state, from), eq(ticketPush.attempts, push.attempts)))
    .returning();
  return row ?? null;
}

/** One adapter call for a claimed push, with the stored content and the integration as it is now. */
async function callAdapter(ctx: AppContext, push: TicketPushRow, integration: IntegrationRow | null, now: () => Date): Promise<AdapterResult<TicketRef>> {
  if (!isConfigured(integration)) return { ok: false, failure: failure('misconfigured', { detail: 'the integration is not configured' }) };
  if (!integration.enabled) return { ok: false, failure: failure('misconfigured', { detail: 'the integration is disabled' }) };
  const creds = await openCredentials(ctx, ctx.db, integration);
  if (!creds) return { ok: false, failure: failure('misconfigured', { detail: 'the credentials are missing or cannot be opened' }) };
  const config = adapterConfigOf(integration, creds);
  if (!config) return { ok: false, failure: failure('misconfigured', { detail: 'the configuration no longer validates' }) };
  const content = ticketContentSchema.safeParse(push.content);
  if (!content.success) return { ok: false, failure: failure('misconfigured', { detail: 'the stored ticket content is not valid' }) };
  const adapter = INTEGRATION_ADAPTERS[integration.type] as TicketingAdapter;
  const c: AdapterCtx<typeof integration.type> = {
    orgId: push.orgId,
    config,
    credentials: creds,
    fetch: ctx.egressFetch,
    delivery: { pushId: push.id, attempt: push.attempts },
    now,
    deadline: Date.now() + attemptTiming.timeoutMs,
  };
  try {
    return push.mode === 'append' && push.externalIdIn !== null ? await adapter.append(c, push.externalIdIn, content.data) : await adapter.create(c, content.data);
  } catch (err) {
    ctx.log.error({ err, pushId: push.id, type: push.type }, 'ticketing adapter threw');
    return { ok: false, failure: failure('upstream_error', { sent: true, detail: 'adapter error' }) };
  }
}

/**
 * Runs the attempt a push was just claimed for (`push.attempts` is that attempt's number) and records the outcome.
 * Returns the push as stored afterwards.
 */
export async function runClaimedAttempt(ctx: AppContext, push: TicketPushRow, opts: { now?: Date } = {}): Promise<TicketPushRow> {
  const clock = () => opts.now ?? new Date();
  const integration = await getIntegration(ctx.db, push.orgId, push.type);
  const result = await callAdapter(ctx, push, integration?.id === push.integrationId ? integration : null, clock);
  return recordOutcome(ctx, push, result, clock());
}

async function recordOutcome(ctx: AppContext, push: TicketPushRow, result: AdapterResult<TicketRef>, now: Date): Promise<TicketPushRow> {
  const org = await getOrg(ctx.db, push.orgId);
  if (!org) throw new Error(`org ${push.orgId} of push ${push.id} not found`);
  const attempt = push.attempts;
  if (result.ok) {
    const externalId = result.value.externalId ? result.value.externalId.slice(0, 200) : null;
    const row = await ctx.db.transaction(async (tx) => {
      await writeAudit(ctx, tx, org, {
        sessionId: push.sessionId,
        actor: systemActor,
        action: 'ticket.push_delivered',
        data: { pushId: push.id, type: push.type, externalId: externalId === null ? null : externalId.slice(0, 100), attempts: attempt },
      });
      const [r] = await tx
        .update(ticketPush)
        .set({
          state: 'delivered',
          externalId,
          externalUrl: result.value.externalUrl,
          deliveredAt: now,
          nextAttemptAt: null,
          lastFailure: null,
          updatedAt: now,
        })
        .where(eq(ticketPush.id, push.id))
        .returning();
      return r!;
    });
    ctx.metrics.ticketPushes.inc({ type: push.type, state: 'delivered' });
    return row;
  }
  const f: TicketFailure = result.failure;
  const willRetry = isAutoRetryable(f, push.type) && attempt < LIMITS.ticketPushMaxAttempts;
  const state: TicketPushState = willRetry ? 'retrying' : 'failed';
  const row = await ctx.db.transaction(async (tx) => {
    await writeAudit(ctx, tx, org, {
      sessionId: push.sessionId,
      actor: systemActor,
      action: 'ticket.push_failed',
      data: { pushId: push.id, type: push.type, cause: f.cause, status: f.status, attempt, willRetry },
    });
    const [r] = await tx
      .update(ticketPush)
      .set({
        state,
        lastFailure: f,
        nextAttemptAt: willRetry ? nextRetryAt(attempt, f.retryAfterSec, now) : null,
        updatedAt: now,
      })
      .where(eq(ticketPush.id, push.id))
      .returning();
    return r!;
  });
  ctx.metrics.ticketPushes.inc({ type: push.type, state });
  return row;
}

/**
 * Rule 4.4g: a deleted or disabled integration fails its `pending` and `retrying` pushes with cause `misconfigured`
 * (`willRetry: false`), each chained. Returns how many were failed.
 */
export async function failInFlightPushes(ctx: AppContext, integration: IntegrationRow, detail: string): Promise<number> {
  const org = await getOrg(ctx.db, integration.orgId);
  if (!org) return 0;
  const rows = await ctx.db
    .select()
    .from(ticketPush)
    .where(and(eq(ticketPush.integrationId, integration.id), inArray(ticketPush.state, ['pending', 'retrying'])));
  let n = 0;
  const f = failure('misconfigured', { detail });
  for (const p of rows) {
    const now = new Date();
    // Lock order (A section 4.2): the audit write locks the session first; a push that left flight meanwhile rolls
    // the entry back.
    const done = await ctx.db
      .transaction(async (tx) => {
        await writeAudit(ctx, tx, org, {
          sessionId: p.sessionId,
          actor: systemActor,
          action: 'ticket.push_failed',
          data: { pushId: p.id, type: p.type, cause: 'misconfigured', status: null, attempt: p.attempts, willRetry: false },
        });
        const [r] = await tx
          .update(ticketPush)
          .set({ state: 'failed', lastFailure: f, nextAttemptAt: null, updatedAt: now })
          .where(and(eq(ticketPush.id, p.id), inArray(ticketPush.state, ['pending', 'retrying'])))
          .returning({ id: ticketPush.id });
        if (!r) throw new LeftFlight();
        return true;
      })
      .catch((err: unknown) => {
        if (err instanceof LeftFlight) return false;
        throw err;
      });
    if (done) {
      n++;
      ctx.metrics.ticketPushes.inc({ type: p.type, state: 'failed' });
    }
  }
  return n;
}

class LeftFlight extends Error {}

/** A fresh push id (the row id, chained in `ticket.push_requested` before the row is written). */
export function newPushId(): string {
  return randomUUID();
}
