/**
 * Org routes (contracts sections 6.3, 6.6): current org and branding patch. The data residency report moved to
 * routes/residency.ts with services/residency.ts (docs/specs/phase-e-contracts.md section 6.4; same path).
 */
import { brandingPatchRequestSchema } from '@indiansassist/shared';
import { updateOrgBranding, type OrgBranding } from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { toOrg } from '../lib/mappers.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate } from '../plugins/auth.js';

const BRANDING_KEYS = ['displayName', 'logoData', 'accentColor', 'supportEmail'] as const;

export async function orgRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/orgs/current', async (req) => toOrg((await authenticate(ctx, req)).org));

  app.patch('/api/v1/orgs/current/branding', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const patch = parseOr400(brandingPatchRequestSchema, req.body);
    const next: OrgBranding = { ...(p.org.branding ?? {}) };
    const fields: string[] = [];
    for (const k of BRANDING_KEYS) {
      if (!(k in patch)) continue;
      const v = patch[k];
      if (v === undefined) continue;
      fields.push(k);
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const org = await ctx.db.transaction(async (tx) => {
      const o = await updateOrgBranding(tx, p.org.id, next);
      await writeAudit(ctx, tx, o, { actor: userActor(p.user), action: 'org.branding_updated', data: { fields } });
      return o;
    });
    return toOrg(org);
  });
}
