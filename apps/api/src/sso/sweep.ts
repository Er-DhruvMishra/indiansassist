/**
 * Phase E stream sso, rule 3.2d: the weekly re-check of verified domains, run by the sweeper lease holder after the
 * A-D passes. Each pass handles a bounded batch of domains whose last check is older than
 * `LIMITS.ssoDomainRecheckHours`; three consecutive misses set `lapsed` and chain `sso.domain_lapsed`.
 */
import type { AppContext } from '../context.js';
import { recheckDomains } from './domains.js';

export async function sweepSsoDomains(ctx: AppContext, now: Date = new Date()): Promise<void> {
  const r = await recheckDomains(ctx, now);
  if (r.lapsed > 0) ctx.log.info({ checked: r.checked, lapsed: r.lapsed }, 'sso domains lapsed');
}
