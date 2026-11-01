/**
 * Phase E stream tickets, rule 4.4d: due `retrying` pushes run by the sweeper lease holder. Landed by the foundation
 * as a no-op pass the sweeper already calls; the tickets stream fills it.
 */
import type { AppContext } from '../context.js';

export async function sweepTicketPushes(_ctx: AppContext, _now: Date = new Date()): Promise<void> {
  // No-op until the tickets stream lands rule 4.4d.
}
