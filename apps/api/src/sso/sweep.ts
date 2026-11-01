/**
 * Phase E stream sso, rule 3.2d: the weekly re-check of verified domains. Landed by the foundation as a no-op pass
 * the sweeper already calls; the sso stream fills it.
 */
import type { AppContext } from '../context.js';

export async function sweepSsoDomains(_ctx: AppContext, _now: Date = new Date()): Promise<void> {
  // No-op until the sso stream lands rule 3.2d.
}
