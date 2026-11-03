/**
 * Phase F stream erasure (sections 5.1, 5.3): expiry of unapproved and unconfirmed requests and the execution of due
 * erasures, run by the sweeper lease holder after the A-E passes. Execution runs in the background, one erasure at a
 * time per node (each under the presence lease `erasure:<id>`), so a long erasure never holds the 10 s sweep; step 8
 * waits for presence keys to expire by returning `waiting` and is resumed by a later pass.
 */
import { LIMITS } from '@indiansassist/shared';
import { getOrg, listDueErasures, orgErasure, transitionErasure, type OrgErasureRow } from '@indiansassist/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { systemActor, writeAudit } from '../lib/audit.js';
import { runErasure } from './executor.js';

const DAY_MS = 86_400_000;
const jobs = new WeakMap<AppContext, Promise<void>>();

/** Waits for the erasure job this app started, if any (tests and shutdown). */
export async function drainErasureJobs(ctx: AppContext): Promise<void> {
  for (;;) {
    const job = jobs.get(ctx);
    if (!job) return;
    await job;
  }
}

/** Rule 5.1: `pending_approval` past 7 days and `pending_confirmation` past its 24 h link expire (chained, system). */
export async function expireErasures(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const stale = await ctx.db
    .select()
    .from(orgErasure)
    .where(
      sql`(${orgErasure.state} = 'pending_approval' and ${orgErasure.requestedAt} < ${new Date(now.getTime() - LIMITS.erasureApprovalTtlDays * DAY_MS)})
        or (${orgErasure.state} = 'pending_confirmation' and ${orgErasure.confirmExpiresAt} < ${now})`,
    );
  let n = 0;
  for (const e of stale) {
    const org = await getOrg(ctx.db, e.orgId);
    if (!org) continue;
    const done = await ctx.db.transaction(async (tx) => {
      const r = await transitionErasure(tx, e.id, e.state, 'expired', { confirmTokenHash: null, confirmExpiresAt: null });
      if (!r) return false;
      await writeAudit(ctx, tx, org, { actor: systemActor, action: 'org.erasure_expired', data: { erasureId: e.id } });
      return true;
    });
    if (done) n++;
  }
  return n;
}

/** Completed erasures whose step 9 did not finish (a crash between 8 and 9): their carried addresses still exist. */
async function listUnnotified(ctx: AppContext): Promise<OrgErasureRow[]> {
  return ctx.db
    .select()
    .from(orgErasure)
    .where(and(eq(orgErasure.state, 'completed'), sql`${orgErasure.progress} ? 'carry'`, lt(orgErasure.completedAt, new Date())));
}

export async function sweepErasures(ctx: AppContext, now: Date = new Date()): Promise<void> {
  await expireErasures(ctx, now);
  if (jobs.has(ctx)) return;
  const due = [...(await listDueErasures(ctx.db, now)), ...(await listUnnotified(ctx))];
  if (due.length === 0) return;
  const job = (async () => {
    for (const e of due) {
      try {
        const r = await runErasure(ctx, e.id);
        ctx.log.info({ erasureId: e.id, result: r }, 'erasure pass');
      } catch (err) {
        ctx.log.error({ err, erasureId: e.id }, 'erasure step failed; resumed on the next pass');
      }
    }
  })().finally(() => jobs.delete(ctx));
  jobs.set(ctx, job);
}
