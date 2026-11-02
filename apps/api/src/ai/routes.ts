/**
 * Phase E stream ai (docs/specs/phase-e-contracts.md section 5.9): the AI policy, capabilities and summary routes.
 * Listed by the foundation in `ENTERPRISE_ROUTE_PLUGINS` (app.ts). Loading this module registers the rule 5.8a
 * enqueue in `onSessionEnded` (services/session-end.ts); registering the plugin also replaces the foundation's
 * "no providers" default with the providers built from operator configuration (section 5.2a), unless the app was
 * given its own (tests).
 */
import {
  LIMITS,
  aiPolicyPatchSchema,
  summaryEditRequestSchema,
  summaryTranscriptUploadSchema,
  type AiCapabilities,
} from '@indiansassist/shared';
import { getSessionSummary, listSessionSummaries, type SessionRow } from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { TECH_ROLES } from '../lib/rbac.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate, type Principal } from '../plugins/auth.js';
import { scopedSession } from '../services/scope.js';
import { onSessionEnded } from '../services/session-end.js';
import { sessionRunIds } from './input.js';
import { capabilitiesFor, orgPolicy, policyReply, updatePolicy } from './policy.js';
import { buildSummaryProviders, noSummaryProviders } from './provider.js';
import { editSummary, enqueueAutoSummary, requestSummary, toAiSessionSummary, toSummaryWire } from './summaries.js';
import { holdTranscript, prepareTranscript } from './transcript.js';

// Rule 5.8a, registered once at module load (the hook receives the context of the app that ended the session).
if (!onSessionEnded.includes(enqueueAutoSummary)) onSessionEnded.push(enqueueAutoSummary);

/** An upload is accepted while the session is active or ended within this window (5.9 `409 bad_state`). */
const UPLOAD_AFTER_END_MS = 15 * 60_000;

async function limit(ctx: AppContext, key: string, max: number, windowMs: number, what: string): Promise<void> {
  const r = await ctx.limiter.hit(key, max, windowMs);
  if (!r.allowed) fail('rate_limited', `too many ${what}`, { retryAfterSec: r.retryAfterSec });
}

function uploadWindowOpen(s: SessionRow, now: number): boolean {
  if (s.state === 'active') return true;
  return s.state === 'ended' && s.endedAt !== null && now - s.endedAt.getTime() <= UPLOAD_AFTER_END_MS;
}

export async function aiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  if (ctx.summaryProviders === noSummaryProviders) ctx.summaryProviders = buildSummaryProviders(ctx.config.ai, { log: ctx.log });

  app.get('/api/v1/ai/capabilities', async (req): Promise<AiCapabilities> => {
    const p = await authenticate(ctx, req);
    return capabilitiesFor(ctx, p.org.dataRegion);
  });

  app.get('/api/v1/orgs/current/ai-policy', async (req) => {
    const p = await authenticate(ctx, req);
    return policyReply(ctx, orgPolicy(p.org));
  });

  app.patch('/api/v1/orgs/current/ai-policy', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const patch = parseOr400(aiPolicyPatchSchema, req.body);
    const next = await updatePolicy(ctx, p.org, p.user, patch);
    return policyReply(ctx, next);
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/sessions/:id/summary-input',
    { bodyLimit: LIMITS.summaryTranscriptUploadMaxBytes },
    async (req, reply) => {
      const p = await authenticate(ctx, req, TECH_ROLES);
      const { session } = await scopedSession(ctx, p, req.params.id, { write: true });
      await limit(ctx, `summary-input:${p.user.id}`, 10, 60_000, 'transcript uploads');
      const policy = orgPolicy(p.org);
      if (policy.provider === 'none') fail('ai_disabled', 'AI summaries are turned off for this organisation');
      if (!policy.includeTranscript) fail('ai_transcript_disabled', 'the organisation does not include the chat transcript in summaries');
      const body = parseOr400(summaryTranscriptUploadSchema, req.body);
      if (body.noticeProvider !== policy.provider)
        fail('transcript_notice_missing', `the notice named ${body.noticeProvider}, but the provider is now ${policy.provider}; a fresh notice is needed`);
      const noticeAt = Date.parse(body.noticeSentAt);
      const early = body.messages.findIndex((m) => Date.parse(m.at) < noticeAt);
      if (early >= 0) fail('validation_failed', `messages.${early}.at: before noticeSentAt (only messages after the notice may be uploaded)`);
      if (!uploadWindowOpen(session, Date.now())) fail('bad_state', 'the session is neither active nor recently ended');
      const held = prepareTranscript(body, await sessionRunIds(ctx.db, session.id));
      await holdTranscript(ctx, session.id, held);
      await writeAudit(ctx, ctx.db, p.org, {
        sessionId: session.id,
        actor: userActor(p.user),
        action: 'summary.transcript_received',
        data: { sha256: held.sha256, messages: held.messages.length, playbookOutputs: held.playbookOutputs.length, redactions: held.redactions },
      });
      return reply.status(202).send({ sha256: held.sha256, redactions: held.redactions });
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/summary', async (req, reply) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const { session } = await scopedSession(ctx, p, req.params.id, { write: true });
    await limit(ctx, `summary-gen:user:${p.user.id}`, 10, 60_000, 'summary requests');
    await limit(ctx, `summary-gen:org:${p.org.id}`, 60, 3_600_000, 'summary requests for this organisation');
    const row = await requestSummary(ctx, p.org, session, p.user);
    return reply.status(202).send({ summary: await toAiSessionSummary(ctx.db, row) });
  });

  app.get<{ Params: { id: string } }>('/api/v1/sessions/:id/summary', async (req) => {
    const p = await authenticate(ctx, req);
    const { session } = await scopedSession(ctx, p, req.params.id);
    const rows = await listSessionSummaries(ctx.db, session.id);
    const wire = await toSummaryWire(ctx.db, rows);
    const last = rows.at(-1);
    return { latest: last ? wire.full.get(last.version)! : null, versions: wire.metas };
  });

  app.get<{ Params: { id: string; version: string } }>('/api/v1/sessions/:id/summary/versions/:version', async (req) => {
    const p = await authenticate(ctx, req);
    const { session } = await scopedSession(ctx, p, req.params.id);
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1 || version > 1_000_000) fail('not_found', 'summary version not found');
    // A named version that is not ready -> SummaryNotReadyError -> 409 summary_not_ready (section 13.2a).
    const row = await getSessionSummary(ctx.db, session.id, version);
    if (!row) fail('not_found', 'summary version not found');
    return toAiSessionSummary(ctx.db, row);
  });

  app.put<{ Params: { id: string } }>('/api/v1/sessions/:id/summary', async (req) => {
    const p: Principal = await authenticate(ctx, req, TECH_ROLES);
    const { session } = await scopedSession(ctx, p, req.params.id, { write: true });
    const body = parseOr400(summaryEditRequestSchema, req.body);
    const row = await editSummary(ctx, p.org, session, p.user, body.baseVersion, body.output);
    return toAiSessionSummary(ctx.db, row);
  });
}
