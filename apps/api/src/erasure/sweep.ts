/**
 * Phase F stream erasure (sections 5.1, 5.3): expiry of unapproved and unconfirmed requests and the execution of due
 * erasures (one at a time per node, under the presence lease `erasure:<id>`). Run by the sweeper lease holder after
 * the A-E passes; a no-op until the erasure stream fills it.
 */
import type { AppContext } from '../context.js';

export async function sweepErasures(ctx: AppContext, now: Date = new Date()): Promise<void> {
  void ctx;
  void now;
}
