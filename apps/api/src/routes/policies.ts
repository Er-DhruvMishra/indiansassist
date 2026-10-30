/**
 * Org policies (docs/specs/phase-b-contracts.md section 11.3): the extension policy (GET any role, PATCH org_admin)
 * merged over DEFAULT_EXTENSION_POLICY with the read-only built-in deny list, and the recording retention policy
 * (Y26). Both PATCH routes write `org.policy_updated { fields }` and are limited to 10 / minute per user. Live
 * sessions are not re-policed: a session uses the policy sent at its `session.created`. Phase A.2 adds the recording
 * policy (docs/specs/phase-a2-recorder.md section 3 M3), snapshotted into each session at accept.
 */
import {
  agentPolicySchema,
  applyPolicyPatch,
  BUILTIN_DENY_LIST,
  extensionPolicyPatchSchema,
  mergePolicy,
  recordingPolicySchema,
  retentionPolicySchema,
  type ExtensionPolicyResponse,
} from '@indiansassist/shared';
import { updateOrg, type OrgRow } from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { iso } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate, type Principal } from '../plugins/auth.js';

function policyBody(org: Pick<OrgRow, 'extensionPolicy'>): ExtensionPolicyResponse {
  return { ...mergePolicy(org.extensionPolicy), builtinDenyList: [...BUILTIN_DENY_LIST] };
}

async function patchLimit(ctx: AppContext, p: Principal): Promise<void> {
  const lim = await ctx.limiter.hit(`policy-patch:${p.user.id}`, 10, 60_000);
  if (!lim.allowed) {
    ctx.metrics.rateLimited.inc();
    fail('rate_limited', 'too many policy changes', { retryAfterSec: lim.retryAfterSec });
  }
}

export async function policyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/orgs/current/policy/extension', async (req) => policyBody((await authenticate(ctx, req)).org));

  app.patch('/api/v1/orgs/current/policy/extension', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    await patchLimit(ctx, p);
    const patch = parseOr400(extensionPolicyPatchSchema, req.body);
    const { next, fields, error } = applyPolicyPatch(mergePolicy(p.org.extensionPolicy), patch);
    if (error) fail('validation_failed', error);
    const stored = { ...next, updatedAt: iso(new Date()) };
    const org = await ctx.db.transaction(async (tx) => {
      const o = await updateOrg(tx, p.org.id, { extensionPolicy: stored });
      await writeAudit(ctx, tx, o, { actor: userActor(p.user), action: 'org.policy_updated', data: { fields } });
      return o;
    });
    return policyBody(org);
  });

  app.get('/api/v1/orgs/current/policy/retention', async (req) => {
    const p = await authenticate(ctx, req);
    return { recordingRetentionDays: p.org.recordingRetentionDays ?? null };
  });

  app.patch('/api/v1/orgs/current/policy/retention', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    await patchLimit(ctx, p);
    const body = parseOr400(retentionPolicySchema, req.body);
    const org = await ctx.db.transaction(async (tx) => {
      const o = await updateOrg(tx, p.org.id, { recordingRetentionDays: body.recordingRetentionDays });
      await writeAudit(ctx, tx, o, {
        actor: userActor(p.user),
        action: 'org.policy_updated',
        data: { fields: ['recordingRetentionDays'] },
      });
      return o;
    });
    return { recordingRetentionDays: org.recordingRetentionDays ?? null };
  });

  // Phase C sections 1.3 step 7, 13.1: the console's security-code gate (default on).
  app.get('/api/v1/orgs/current/policy/agent', async (req) => {
    const p = await authenticate(ctx, req);
    return { requireSasConfirm: p.org.requireSasConfirm };
  });

  app.patch('/api/v1/orgs/current/policy/agent', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    await patchLimit(ctx, p);
    const body = parseOr400(agentPolicySchema, req.body);
    if (body.requireSasConfirm === p.org.requireSasConfirm) return { requireSasConfirm: p.org.requireSasConfirm };
    const org = await ctx.db.transaction(async (tx) => {
      const o = await updateOrg(tx, p.org.id, { requireSasConfirm: body.requireSasConfirm });
      await writeAudit(ctx, tx, o, { actor: userActor(p.user), action: 'org.policy_updated', data: { fields: ['requireSasConfirm'] } });
      return o;
    });
    return { requireSasConfirm: org.requireSasConfirm };
  });

  app.get('/api/v1/orgs/current/policy/recording', async (req) => {
    const p = await authenticate(ctx, req);
    return { recordingMode: p.org.recordingMode };
  });

  app.patch('/api/v1/orgs/current/policy/recording', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    await patchLimit(ctx, p);
    const body = parseOr400(recordingPolicySchema, req.body);
    if (body.recordingMode === p.org.recordingMode) return { recordingMode: p.org.recordingMode };
    const org = await ctx.db.transaction(async (tx) => {
      const o = await updateOrg(tx, p.org.id, { recordingMode: body.recordingMode });
      await writeAudit(ctx, tx, o, {
        actor: userActor(p.user),
        action: 'org.policy_updated',
        data: { fields: ['recordingMode'] },
      });
      return o;
    });
    return { recordingMode: org.recordingMode };
  });
}
