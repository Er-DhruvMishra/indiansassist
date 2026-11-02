/**
 * Phase E stream residency (docs/specs/phase-e-contracts.md section 6.4): the residency routes. The A
 * `GET /orgs/current/residency` moved here from routes/orgs.ts (same path, same roles), now with every section 6.2
 * field and the section 6.3 signature; `GET .../residency/signed.json` serves the same signed report as a download and
 * chains `residency.report_issued`. Both build through `services/residency.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { authenticate } from '../plugins/auth.js';
import { issueResidencyReport, type SignedResidencyReport } from '../services/residency.js';

const RESIDENCY_ROLES = ['org_admin', 'auditor'] as const;

/** Section 2.5: the signed download, 10 per minute per org. */
export const RESIDENCY_SIGNED_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/** `residency-<slug>-<YYYY-MM-DD>.json` (the UTC date of `generatedAt`). */
export function residencyFileName(slug: string, generatedAt: string): string {
  const safe = slug.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'org';
  return `residency-${safe}-${generatedAt.slice(0, 10)}.json`;
}

export async function residencyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/orgs/current/residency', async (req, reply): Promise<SignedResidencyReport> => {
    const p = await authenticate(ctx, req, [...RESIDENCY_ROLES]);
    void reply.header('Cache-Control', 'no-store');
    return issueResidencyReport(ctx, p.org);
  });

  app.get('/api/v1/orgs/current/residency/signed.json', async (req, reply) => {
    const p = await authenticate(ctx, req, [...RESIDENCY_ROLES]);
    const lim = await ctx.limiter.hit(`residency-signed:${p.org.id}`, RESIDENCY_SIGNED_LIMIT.limit, RESIDENCY_SIGNED_LIMIT.windowMs);
    if (!lim.allowed) fail('rate_limited', 'too many signed residency reports for this organisation', { retryAfterSec: lim.retryAfterSec });
    const report = await issueResidencyReport(ctx, p.org);
    await writeAudit(ctx, ctx.db, p.org, {
      actor: userActor(p.user),
      action: 'residency.report_issued',
      data: { sha256: report.signature.sha256, kid: report.signature.kid },
    });
    // Verification is over the parsed JSON's canonical form (6.3c), so the file may be indented for people to read.
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${residencyFileName(p.org.slug, report.generatedAt)}"`)
      .header('Cache-Control', 'no-store')
      .send(`${JSON.stringify(report, null, 2)}\n`);
  });
}
