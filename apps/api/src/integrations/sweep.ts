/**
 * Phase E stream tickets, rule 4.4d: due `retrying` pushes, run by the sweeper lease holder (the sweeper calls this
 * pass only on the node holding the `sweeper` lease). Each due push is claimed with a compare-and-set before its
 * attempt, so an attempt is never made twice; one bad push does not stop the others. Attempts run a few at a time
 * so a batch of slow upstreams (15 s each at most) does not hold the sweeper for minutes.
 */
import { listDueTicketPushes, type TicketPushRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { claimAttempt, runClaimedAttempt } from './push.js';
import { erasingOrgIds } from '../erasure/guard.js';

/** Due pushes per pass. */
export const TICKET_SWEEP_BATCH = 20;
/** Attempts in flight at once within a pass. */
export const TICKET_SWEEP_PARALLEL = 5;

async function retryOne(ctx: AppContext, due: TicketPushRow, now: Date): Promise<void> {
  try {
    const claimed = await claimAttempt(ctx, due, 'retrying', { state: 'retrying' }, now);
    if (claimed) await runClaimedAttempt(ctx, claimed, { now });
  } catch (err) {
    ctx.log.error({ err, pushId: due.id }, 'ticket push retry failed; left for the next pass');
  }
}

export async function sweepTicketPushes(ctx: AppContext, now: Date = new Date()): Promise<void> {
  // Phase F section 5.3 step 2: an org whose erasure is executing (or done) is skipped.
  const erasing = await erasingOrgIds(ctx.db);
  const due = (await listDueTicketPushes(ctx.db, now, TICKET_SWEEP_BATCH)).filter((p) => !erasing.has(p.orgId));
  for (let i = 0; i < due.length; i += TICKET_SWEEP_PARALLEL)
    await Promise.all(due.slice(i, i + TICKET_SWEEP_PARALLEL).map((p) => retryOne(ctx, p, now)));
}
