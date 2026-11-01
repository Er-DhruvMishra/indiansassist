/**
 * Phase E stream ai, rule 5.8c: the summary worker, run only by the sweeper lease holder (at most
 * `LIMITS.summaryConcurrency` per region). Landed by the foundation as a no-op pass the sweeper already calls; the ai
 * stream fills it.
 */
import type { AppContext } from '../context.js';

export async function sweepSummaries(_ctx: AppContext, _now: Date = new Date()): Promise<void> {
  // No-op until the ai stream lands rule 5.8c.
}
