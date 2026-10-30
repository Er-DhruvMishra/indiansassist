/**
 * Playbook catalogue and run (docs/specs/phase-c-contracts.md sections 8.1, 8.2, 13.3). CRUD is org_admin (list: any
 * role, bodies only for org_admin / senior_technician / auditor); every load is `(id, org_id)` so another org's id
 * is `404`. The run endpoint is the body's release point: assist of the session, then the playbook of the session's
 * org, `enabled`, the pinned manifest hash (`playbook_changed`) and the elevation rule, in that order; it mints
 * `runId` / `opId`, chains `playbook.run_requested` and answers `202` with the body and canonical args.
 */
import { randomBytes } from 'node:crypto';
import {
  lintPlaybookBody,
  opIdFor,
  playbookCreateSchema,
  playbookListQuerySchema,
  playbookPatchSchema,
  playbookRunRequestSchema,
  validatePlaybookArgs,
  type Playbook,
  type PlaybookParam,
  type PlaybookRunReply,
} from '@indiansassist/shared';
import {
  deletePlaybook,
  getPlaybookScoped,
  insertPlaybook,
  insertPlaybookRun,
  listPlaybooksByOrg,
  PlaybookNameTakenError,
  updatePlaybook,
  type PlaybookRow,
} from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { refOf, userRefs } from '../lib/lookup.js';
import type { UserRef } from '../lib/mappers.js';
import { TECH_ROLES } from '../lib/rbac.js';
import { iso } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate } from '../plugins/auth.js';
import { requireSessionAssist, scopedSession } from '../services/scope.js';

const BODY_ROLES = new Set(['org_admin', 'senior_technician', 'auditor']);

export function toPlaybook(r: PlaybookRow, createdBy: UserRef | null, withBody: boolean): Playbook {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    interpreter: r.interpreter,
    requiresElevation: r.requiresElevation,
    parameters: (Array.isArray(r.parameters) ? r.parameters : []) as PlaybookParam[],
    timeoutSec: r.timeoutSec,
    enabled: r.enabled,
    bodyHash: r.bodySha256,
    ...(withBody ? { body: r.body } : {}),
    createdBy,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function lintOr400(interpreter: PlaybookRow['interpreter'], body: string): void {
  const lint = lintPlaybookBody(interpreter, body);
  if (lint.errors.length > 0) fail('validation_failed', lint.errors[0]!, { lint });
}

async function nameGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PlaybookNameTakenError) fail('playbook_name_taken', 'a playbook with this name exists');
    throw err;
  }
}

export async function playbookRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/orgs/current/playbooks', async (req) => {
    const p = await authenticate(ctx, req);
    const q = parseOr400(playbookListQuerySchema, req.query);
    const page = await listPlaybooksByOrg(ctx.db, p.org.id, {
      limit: q.limit,
      cursor: q.cursor ?? null,
      ...(q.enabled !== undefined ? { enabled: q.enabled } : {}),
    });
    const names = await userRefs(ctx.db, page.items.flatMap((r) => (r.createdBy ? [r.createdBy] : [])));
    const withBody = BODY_ROLES.has(p.user.role);
    return {
      items: page.items.map((r) => toPlaybook(r, r.createdBy ? refOf(names, r.createdBy) : null, withBody)),
      nextCursor: page.nextCursor,
    };
  });

  app.post('/api/v1/orgs/current/playbooks', async (req, reply) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(playbookCreateSchema, req.body);
    lintOr400(body.interpreter, body.body);
    const row = await nameGuard(() =>
      ctx.db.transaction(async (tx) => {
        const r = await insertPlaybook(tx, {
          orgId: p.org.id,
          name: body.name,
          description: body.description,
          interpreter: body.interpreter,
          body: body.body,
          requiresElevation: body.requiresElevation ?? false,
          parameters: body.parameters ?? [],
          timeoutSec: body.timeoutSec ?? 120,
          enabled: body.enabled ?? true,
          createdBy: p.user.id,
        });
        await writeAudit(ctx, tx, p.org, {
          actor: userActor(p.user),
          action: 'playbook.created',
          data: { playbookId: r.id, bodyHash: r.bodySha256, interpreter: r.interpreter, requiresElevation: r.requiresElevation },
        });
        return r;
      }),
    );
    return reply.status(201).send(toPlaybook(row, { id: p.user.id, name: p.user.name }, true));
  });

  app.patch<{ Params: { id: string } }>('/api/v1/orgs/current/playbooks/:id', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const patch = parseOr400(playbookPatchSchema, req.body);
    const cur = await getPlaybookScoped(ctx.db, req.params.id, p.org.id);
    if (!cur) fail('not_found', 'playbook not found');
    lintOr400(patch.interpreter ?? cur.interpreter, patch.body ?? cur.body);
    const fields = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    const row = await nameGuard(() =>
      ctx.db.transaction(async (tx) => {
        const r = await updatePlaybook(tx, cur.id, p.org.id, patch);
        if (!r) fail('not_found', 'playbook not found');
        await writeAudit(ctx, tx, p.org, {
          actor: userActor(p.user),
          action: 'playbook.updated',
          data: { playbookId: r.id, fields, bodyHash: r.bodySha256 },
        });
        return r;
      }),
    );
    const names = row.createdBy ? await userRefs(ctx.db, [row.createdBy]) : new Map<string, UserRef>();
    return toPlaybook(row, row.createdBy ? refOf(names, row.createdBy) : null, true);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/orgs/current/playbooks/:id', async (req, reply) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const cur = await getPlaybookScoped(ctx.db, req.params.id, p.org.id);
    if (!cur) fail('not_found', 'playbook not found');
    await ctx.db.transaction(async (tx) => {
      if (!(await deletePlaybook(tx, cur.id, p.org.id))) fail('not_found', 'playbook not found');
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'playbook.deleted', data: { playbookId: cur.id } });
    });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string; playbookId: string } }>('/api/v1/sessions/:id/playbooks/:playbookId/run', async (req, reply) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const { session } = await scopedSession(ctx, p, req.params.id, { write: true });
    requireSessionAssist(p, session);
    const body = parseOr400(playbookRunRequestSchema, req.body);
    if (session.tier !== 'p3_portable' || session.state !== 'active') fail('bad_state', 'playbooks run in an active P3 session');
    const pb = await getPlaybookScoped(ctx.db, req.params.playbookId, session.orgId);
    if (!pb) fail('not_found', 'playbook not found');
    if (!pb.enabled) fail('playbook_disabled', 'this playbook is disabled');
    const pinned = ctx.hub.live.get(session.id)?.manifest?.hashes.get(pb.id);
    if (pinned !== pb.bodySha256)
      fail('playbook_changed', 'this playbook was edited during the session; it cannot run until the session is restarted');
    if (pb.requiresElevation && session.consentLevel !== 'elevated') fail('elevation_required', 'request elevation first');
    const lim = await ctx.limiter.hit(`playbook-run:${session.id}`, 10, 60_000);
    if (!lim.allowed) fail('rate_limited', 'too many playbook runs', { retryAfterSec: lim.retryAfterSec });
    const params = (Array.isArray(pb.parameters) ? pb.parameters : []) as PlaybookParam[];
    const args = validatePlaybookArgs(params, body.args, pb.interpreter);
    if (!args.ok) fail('validation_failed', `${args.param ?? 'args'}: ${args.error}`, { param: args.param ?? null });
    const runId = randomBytes(16).toString('hex');
    const opId = opIdFor(session.id, runId);
    await ctx.db.transaction(async (tx) => {
      await insertPlaybookRun(tx, { runId, sessionId: session.id, orgId: session.orgId, playbookId: pb.id, bodySha256: pb.bodySha256, opId, requestedBy: p.user.id });
      await writeAudit(ctx, tx, p.org, {
        sessionId: session.id,
        actor: userActor(p.user),
        action: 'playbook.run_requested',
        reason: body.reason ?? null,
        data: { playbookId: pb.id, bodyHash: pb.bodySha256, runId, opId },
      });
    });
    const out: PlaybookRunReply = {
      runId,
      opId,
      playbookId: pb.id,
      body: pb.body,
      bodyHash: pb.bodySha256,
      interpreter: pb.interpreter,
      requiresElevation: pb.requiresElevation,
      timeoutSec: pb.timeoutSec,
      args: args.args,
    };
    return reply.status(202).send(out);
  });
}
