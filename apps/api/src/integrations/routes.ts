/**
 * Phase E stream tickets (docs/specs/phase-e-contracts.md section 4.7): the integration admin routes and the ticket
 * push routes (PRD 11 `POST /integrations/:type/ticket`).
 *
 *   GET    /api/v1/integrations                       org_admin, auditor
 *   GET    /api/v1/integrations/available             technician, senior_technician, org_admin, auditor
 *   GET    /api/v1/integrations/:type                 org_admin, auditor
 *   PUT    /api/v1/integrations/:type                 org_admin (a new webhook answers 201 with its secret, once)
 *   POST   /api/v1/integrations/:type/test            org_admin
 *   DELETE /api/v1/integrations/:type                 org_admin (rule 4.4g)
 *   POST   /api/v1/integrations/webhook/rotate-secret org_admin
 *   POST   /api/v1/integrations/:type/ticket          technician (own session), senior_technician, org_admin
 *   GET    /api/v1/sessions/:id/tickets               session read scope (no observer)
 *   POST   /api/v1/integrations/pushes/:pushId/retry  the push's creator, senior_technician, org_admin
 *
 * Credentials are write-only (section 2.1): sealed at save, opened in memory for one outbound call, answered only as
 * `SecretStatus`. Every org-supplied URL is checked by the egress guard at save (`400 egress_refused`) and at each call.
 */
import {
  base64urlEncode,
  canonicalJsonBytes,
  INTEGRATION_CONFIG_SCHEMAS,
  INTEGRATION_CREDENTIAL_SCHEMAS,
  integrationPutRequestSchema,
  jiraCloudCredentialsSchema,
  jiraDataCenterCredentialsSchema,
  LIMITS,
  randomBytes,
  sha256Hex,
  ticketPushRequestSchema,
  type IntegrationCredentialsOf,
  type IntegrationType,
  type TicketFailureCause,
  type TicketPushRequest,
} from '@indiansassist/shared';
import {
  getIntegration,
  getTicketPush,
  insertTicketPush,
  integration as integrationTable,
  isUniqueViolation,
  listIntegrations,
  listTicketPushesBySession,
  ticketPush,
  upsertIntegration,
  type IntegrationRow,
  type TicketPushRow,
} from '@indiansassist/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { checkEgressUrl } from '../lib/egress.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { TECH_ROLES } from '../lib/rbac.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate, type Principal } from '../plugins/auth.js';
import { scopedSession, UUID_RE } from '../services/scope.js';
import { attemptTiming, INTEGRATION_ADAPTERS, type AdapterCtx, type TicketingAdapter } from './adapter.js';
import { buildTicketContent } from './content.js';
import { claimAttempt, failInFlightPushes, newPushId, runClaimedAttempt, toTicketPush } from './push.js';
import { adapterConfigOf, isConfigured, isIntegrationType, openCredentials, sealCredentials, toIntegration, webhookStoredConfig } from './store.js';

const READ_ROLES = ['org_admin', 'auditor'] as const;
const ADMIN_ROLES = ['org_admin'] as const;
const AVAILABLE_ROLES = ['technician', 'senior_technician', 'org_admin', 'auditor'] as const;

/** A fresh webhook secret: 32 CSPRNG bytes, base64url (section 4.2). */
function mintWebhookSecret(): string {
  return base64urlEncode(randomBytes(32));
}

function typeOr404(raw: string): IntegrationType {
  if (!isIntegrationType(raw)) fail('not_found', 'unknown integration type');
  return raw;
}

async function rateLimit(ctx: AppContext, key: string, limit: number, windowMs: number, what: string): Promise<void> {
  const lim = await ctx.limiter.hit(key, limit, windowMs);
  if (!lim.allowed) fail('rate_limited', `too many ${what}`, { retryAfterSec: lim.retryAfterSec });
}

/** The org-supplied URL a config makes the adapter call (checked at save, section 4.2). */
function urlOfConfig(type: IntegrationType, config: Record<string, unknown>): string | null {
  if (type === 'servicenow') return String(config['instanceUrl']);
  if (type === 'jira') return String(config['siteUrl']);
  if (type === 'webhook') return String(config['url']);
  return null;
}

/** The names of the config fields whose value changed (chained in `integration.updated`, never the values). */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).sort();
}

export async function integrationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const refsFor = async (rows: { updatedBy?: string | null; createdBy?: string | null }[]) =>
    userRefs(ctx.db, rows.flatMap((r) => [r.updatedBy, r.createdBy].filter((x): x is string => typeof x === 'string')));

  const integrationReply = async (row: IntegrationRow) => {
    const names = await refsFor([row]);
    return toIntegration(row, row.updatedBy ? refOf(names, row.updatedBy) : null);
  };

  const pushReply = async (row: TicketPushRow) => {
    const names = await userRefs(ctx.db, [row.createdBy]);
    return toTicketPush(row, refOf(names, row.createdBy));
  };

  // ---------- admin ----------

  app.get('/api/v1/integrations', async (req) => {
    const p = await authenticate(ctx, req, READ_ROLES);
    const rows = (await listIntegrations(ctx.db, p.org.id)).filter(isConfigured);
    const names = await refsFor(rows);
    return { items: rows.map((r) => toIntegration(r, r.updatedBy ? refOf(names, r.updatedBy) : null)) };
  });

  app.get('/api/v1/integrations/available', async (req) => {
    const p = await authenticate(ctx, req, AVAILABLE_ROLES);
    const rows = (await listIntegrations(ctx.db, p.org.id)).filter((r) => isConfigured(r) && r.enabled);
    return { items: rows.map((r) => ({ type: r.type, enabled: true as const })) };
  });

  app.get<{ Params: { type: string } }>('/api/v1/integrations/:type', async (req) => {
    const p = await authenticate(ctx, req, READ_ROLES);
    const type = typeOr404(req.params.type);
    const row = await getIntegration(ctx.db, p.org.id, type);
    if (!isConfigured(row)) fail('not_found', 'this integration is not configured');
    return integrationReply(row);
  });

  app.put<{ Params: { type: string } }>('/api/v1/integrations/:type', async (req, reply) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    const type = typeOr404(req.params.type);
    const body = parseOr400(integrationPutRequestSchema, req.body);
    const rawConfig: Record<string, unknown> = { ...body.config };
    if (type === 'jira') {
      rawConfig['issueType'] ??= 'Task';
      rawConfig['labels'] ??= [];
    }
    const config = parseOr400(INTEGRATION_CONFIG_SCHEMAS[type], rawConfig) as Record<string, unknown>;
    const url = urlOfConfig(type, config);
    if (url) {
      const verdict = await checkEgressUrl(url, { config: ctx.config.egress, lookup: (h) => ctx.dnsResolver.lookup(h) });
      if (!verdict.ok) fail('egress_refused', 'this address may not be reached from the server', { cause: verdict.cause });
    }
    // Credentials (absent = unchanged, null = cleared); the webhook's are server-minted, so `credentials` is ignored.
    let newCreds: object | null | undefined;
    if (type !== 'webhook' && body.credentials !== undefined) {
      if (body.credentials === null) newCreds = null;
      else {
        newCreds = parseOr400(INTEGRATION_CREDENTIAL_SCHEMAS[type], body.credentials) as object;
        if (type === 'jira') {
          const wanted = config['deployment'] === 'cloud' ? jiraCloudCredentialsSchema : jiraDataCenterCredentialsSchema;
          if (!wanted.safeParse(newCreds).success)
            fail('validation_failed', `credentials: ${config['deployment'] === 'cloud' ? 'cloud needs email and apiToken' : 'data_center needs personalAccessToken'}`);
        }
      }
    }
    const found = await getIntegration(ctx.db, p.org.id, type);
    const existing = isConfigured(found) ? found : null;
    let shownSecret: string | null = null;
    const result = await ctx.db.transaction(async (tx) => {
      const storedConfig = type === 'webhook' ? webhookStoredConfig(String(config['url'])) : config;
      let row = await upsertIntegration(tx, { orgId: p.org.id, type, enabled: body.enabled, config: storedConfig, updatedBy: p.user.id });
      let credentialsChanged = false;
      let fields = changedFields(existing ? existing.config : {}, storedConfig);
      if (type === 'webhook') {
        const prior = existing ? await openCredentials(ctx, tx, { ...existing, type: 'webhook' as const }) : null;
        const creds: IntegrationCredentialsOf<'webhook'> = prior
          ? { ...prior, url: String(config['url']) }
          : { url: String(config['url']), secret: mintWebhookSecret(), previousSecret: null };
        if (!prior) shownSecret = creds.secret;
        if (prior && prior.url !== creds.url) fields = [...new Set([...fields, 'url'])].sort();
        credentialsChanged = !prior || prior.url !== creds.url;
        if (credentialsChanged) {
          const sealed = sealCredentials(ctx, row, creds);
          row = await upsertIntegration(tx, { orgId: p.org.id, type, enabled: body.enabled, config: storedConfig, updatedBy: p.user.id, credentials: sealed });
        }
      } else if (newCreds !== undefined) {
        credentialsChanged = true;
        row = await upsertIntegration(tx, {
          orgId: p.org.id,
          type,
          enabled: body.enabled,
          config: storedConfig,
          updatedBy: p.user.id,
          credentials: newCreds === null ? null : sealCredentials(ctx, row, newCreds),
        });
      }
      if (!existing || existing.enabled !== body.enabled) fields = [...new Set([...fields, 'enabled'])].sort();
      await writeAudit(ctx, tx, p.org, {
        actor: userActor(p.user),
        action: 'integration.updated',
        data: { type, enabled: body.enabled, fields, credentialsChanged },
      });
      return row;
    });
    if (existing?.enabled && !body.enabled) await failInFlightPushes(ctx, result, 'the integration was disabled');
    const out = await integrationReply(result);
    if (type === 'webhook' && shownSecret) return reply.status(201).send({ integration: out, secret: shownSecret });
    return out;
  });

  app.post<{ Params: { type: string } }>('/api/v1/integrations/:type/test', async (req) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    const type = typeOr404(req.params.type);
    await rateLimit(ctx, `integration-test:${p.org.id}`, 10, 60_000, 'integration tests');
    const row = await getIntegration(ctx.db, p.org.id, type);
    if (!isConfigured(row)) fail('integration_not_configured', 'configure this integration first');
    const outcome = await testIntegration(ctx, row);
    const at = new Date();
    await ctx.db.transaction(async (tx) => {
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'integration.tested', data: { type, ok: outcome.ok, cause: outcome.cause } });
      await tx
        .update(integrationTable)
        .set({ lastTest: { at: at.toISOString(), ok: outcome.ok, cause: outcome.cause } })
        .where(eq(integrationTable.id, row.id));
    });
    return outcome;
  });

  app.delete<{ Params: { type: string } }>('/api/v1/integrations/:type', async (req, reply) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    const type = typeOr404(req.params.type);
    const row = await getIntegration(ctx.db, p.org.id, type);
    if (!isConfigured(row)) fail('not_found', 'this integration is not configured');
    // Rule 4.4g: in-flight pushes fail first, so none can deliver through credentials that are being removed.
    await failInFlightPushes(ctx, row, 'the integration was deleted');
    await ctx.db.transaction(async (tx) => {
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'integration.deleted', data: { type } });
      const [ref] = await tx.select({ id: ticketPush.id }).from(ticketPush).where(eq(ticketPush.integrationId, row.id)).limit(1);
      if (ref) {
        // Pushes keep pointing at the row (their history stays readable), so it is reset to the unconfigured state.
        await tx
          .update(integrationTable)
          .set({ enabled: false, config: {}, credentialsEnc: null, credentialsSetAt: null, credentialsFp: null, lastTest: null, updatedBy: p.user.id, updatedAt: new Date() })
          .where(eq(integrationTable.id, row.id));
      } else {
        await tx.delete(integrationTable).where(and(eq(integrationTable.id, row.id), eq(integrationTable.orgId, p.org.id)));
      }
    });
    return reply.status(204).send();
  });

  app.post('/api/v1/integrations/webhook/rotate-secret', async (req) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    const row = await getIntegration(ctx.db, p.org.id, 'webhook');
    if (!isConfigured(row)) fail('integration_not_configured', 'configure the webhook first');
    const secret = mintWebhookSecret();
    await ctx.db.transaction(async (tx) => {
      const prior = await openCredentials(ctx, tx, { ...row, type: 'webhook' as const });
      if (!prior) fail('integration_not_configured', 'the webhook credentials cannot be opened; save the webhook again');
      const until = new Date(Date.now() + LIMITS.webhookRotationOverlapHours * 3_600_000).toISOString();
      const creds: IntegrationCredentialsOf<'webhook'> = { url: prior.url, secret, previousSecret: { secret: prior.secret, until } };
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'integration.secret_rotated', data: { type: 'webhook' } });
      await upsertIntegration(tx, {
        orgId: p.org.id,
        type: 'webhook',
        enabled: row.enabled,
        config: row.config,
        updatedBy: p.user.id,
        credentials: sealCredentials(ctx, row, creds),
      });
    });
    return { secret };
  });

  // ---------- pushes ----------

  app.post<{ Params: { type: string } }>('/api/v1/integrations/:type/ticket', async (req, reply) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const type = typeOr404(req.params.type);
    const body = parseOr400(ticketPushRequestSchema, req.body);
    await rateLimit(ctx, `ticket-push:user:${p.user.id}`, 20, 60_000, 'ticket pushes');
    await rateLimit(ctx, `ticket-push:org:${p.org.id}`, 60, 60_000, 'ticket pushes');
    const { session } = await scopedSession(ctx, p, body.sessionId, { write: true });
    const repeat = await findByClientPushId(ctx, p.org.id, body.clientPushId);
    if (repeat) return idempotentReply(repeat, body, type, reply, pushReply);
    if (session.state !== 'ended') fail('session_not_ended', 'tickets are pushed for ended sessions only');
    const integration = await getIntegration(ctx.db, p.org.id, type);
    if (!isConfigured(integration)) fail('integration_not_configured', 'this integration is not configured');
    if (!integration.enabled) fail('integration_disabled', 'this integration is disabled');
    const { content, summary } = await buildTicketContent(ctx, session, body);
    const contentSha256 = sha256Hex(canonicalJsonBytes(content));
    const pushId = newPushId();
    let created: TicketPushRow;
    try {
      created = await ctx.db.transaction(async (tx) => {
        await writeAudit(ctx, tx, p.org, {
          sessionId: session.id,
          actor: userActor(p.user),
          action: 'ticket.push_requested',
          data: { pushId, type, mode: body.mode, source: body.source, summaryVersion: summary?.version ?? null, contentSha256 },
        });
        return insertTicketPush(tx, {
          id: pushId,
          orgId: p.org.id,
          sessionId: session.id,
          integrationId: integration.id,
          type,
          mode: body.mode,
          externalIdIn: body.externalId ?? null,
          source: body.source,
          summaryId: summary?.id ?? null,
          summaryVersion: summary?.version ?? null,
          content: content as unknown as Record<string, unknown>,
          contentSha256,
          state: 'pending',
          clientPushId: body.clientPushId,
          createdBy: p.user.id,
        });
      });
    } catch (err) {
      // A concurrent request with the same clientPushId won the insert (rule 4.4f).
      if (isUniqueViolation(err, 'ticket_push_org_client_push_unique')) {
        const winner = await findByClientPushId(ctx, p.org.id, body.clientPushId);
        if (winner) return idempotentReply(winner, body, type, reply, pushReply);
      }
      throw err;
    }
    const claimed = await claimAttempt(ctx, created, 'pending', { state: 'pending' }, new Date());
    const final = claimed ? await runClaimedAttempt(ctx, claimed) : created;
    return reply.status(201).send({ push: await pushReply(final) });
  });

  app.get<{ Params: { id: string } }>('/api/v1/sessions/:id/tickets', async (req) => {
    const p = await authenticate(ctx, req);
    const { session } = await scopedSession(ctx, p, req.params.id);
    const rows = await listTicketPushesBySession(ctx.db, p.org.id, session.id);
    const names = await userRefs(ctx.db, rows.map((r) => r.createdBy));
    return { items: rows.map((r) => toTicketPush(r, refOf(names, r.createdBy))) };
  });

  app.post<{ Params: { pushId: string } }>('/api/v1/integrations/pushes/:pushId/retry', async (req) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const push = UUID_RE.test(req.params.pushId) ? await getTicketPush(ctx.db, p.org.id, req.params.pushId) : null;
    if (!push) fail('not_found', 'push not found');
    if (p.user.role === 'technician' && push.createdBy !== p.user.id) fail('forbidden', 'only the push creator may retry it');
    if (push.state !== 'failed') fail('bad_state', 'only a failed push can be retried');
    if (push.manualRetries >= LIMITS.ticketPushManualRetries) fail('retry_limit', 'this push has been retried the maximum number of times');
    const integration = await getIntegration(ctx.db, p.org.id, push.type);
    if (!isConfigured(integration) || integration.id !== push.integrationId) fail('integration_not_configured', 'this integration is not configured');
    if (!integration.enabled) fail('integration_disabled', 'this integration is disabled');
    const claimed = await claimRetry(ctx, p, push);
    if (!claimed) fail('bad_state', 'this push changed while retrying; reload it');
    return { push: await pushReply(await runClaimedAttempt(ctx, claimed)) };
  });
}

/** Rule 4.4e: `ticket.push_retried` (user) is chained before the attempt, in the claim's transaction. */
async function claimRetry(ctx: AppContext, p: Principal, push: TicketPushRow): Promise<TicketPushRow | null> {
  const now = new Date();
  return ctx.db
    .transaction(async (tx) => {
      await writeAudit(ctx, tx, p.org, {
        sessionId: push.sessionId,
        actor: userActor(p.user),
        action: 'ticket.push_retried',
        data: { pushId: push.id, type: push.type },
      });
      const [row] = await tx
        .update(ticketPush)
        .set({ state: 'pending', attempts: push.attempts + 1, manualRetries: push.manualRetries + 1, nextAttemptAt: null, updatedAt: now })
        .where(and(eq(ticketPush.id, push.id), eq(ticketPush.state, 'failed'), eq(ticketPush.manualRetries, push.manualRetries)))
        .returning();
      if (!row) throw new LostRace();
      return row;
    })
    .catch((err: unknown) => {
      if (err instanceof LostRace) return null;
      throw err;
    });
}

class LostRace extends Error {}

async function findByClientPushId(ctx: AppContext, orgId: string, clientPushId: string): Promise<TicketPushRow | null> {
  const [row] = await ctx.db
    .select()
    .from(ticketPush)
    .where(and(eq(ticketPush.orgId, orgId), eq(ticketPush.clientPushId, clientPushId)))
    .limit(1);
  return row ?? null;
}

/** Rule 4.4f: the same id with the same session, type and mode is the same push (200, unchanged); else a conflict. */
async function idempotentReply(
  existing: TicketPushRow,
  body: TicketPushRequest,
  type: IntegrationType,
  reply: FastifyReply,
  pushReply: (row: TicketPushRow) => Promise<unknown>,
) {
  if (existing.sessionId !== body.sessionId || existing.type !== type || existing.mode !== body.mode)
    fail('push_id_conflict', 'this clientPushId was used for another push');
  return reply.status(200).send({ push: await pushReply(existing) });
}

/** `POST /integrations/:type/test`: one cheap authenticated read through the adapter (section 4.6). */
async function testIntegration(
  ctx: AppContext,
  row: IntegrationRow,
): Promise<{ ok: boolean; cause: AdapterTestCause; detail: string | null; account: string | null }> {
  const creds = await openCredentials(ctx, ctx.db, row);
  if (!creds) return { ok: false, cause: 'misconfigured', detail: 'the credentials are missing or cannot be opened', account: null };
  const config = adapterConfigOf(row, creds);
  if (!config) return { ok: false, cause: 'misconfigured', detail: 'the configuration no longer validates', account: null };
  const adapter = INTEGRATION_ADAPTERS[row.type] as TicketingAdapter;
  const c: AdapterCtx<typeof row.type> = {
    orgId: row.orgId,
    config,
    credentials: creds,
    fetch: ctx.egressFetch,
    delivery: { pushId: '', attempt: 0 },
    now: () => new Date(),
    deadline: Date.now() + attemptTiming.timeoutMs,
  };
  try {
    const r = await adapter.test(c);
    if (r.ok) return { ok: true, cause: null, detail: null, account: r.value.account ? r.value.account.slice(0, 200) : null };
    return { ok: false, cause: r.failure.cause, detail: r.failure.detail, account: null };
  } catch (err) {
    ctx.log.error({ err, type: row.type }, 'ticketing adapter test threw');
    return { ok: false, cause: 'upstream_error', detail: 'adapter error', account: null };
  }
}

type AdapterTestCause = TicketFailureCause | null;
