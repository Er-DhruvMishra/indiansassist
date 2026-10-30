/** Org routes (contracts sections 6.3, 6.6): current org, branding patch and the data residency report. */
import { brandingPatchRequestSchema, mergePolicy, REGION_LABELS, type ResidencyReport } from '@indiansassist/shared';
import {
  auditEntry,
  countAgentSessionsSince,
  countElevationGrantsSince,
  countPlaybookRunsSince,
  getLatestCheckpoint,
  getOrgChainTail,
  recording,
  session as sessionTable,
  token as tokenTable,
  updateOrgBranding,
  user as userTable,
  type OrgBranding,
} from '@indiansassist/db';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { thirdPartyIceHosts } from '../lib/ice.js';
import { toOrg } from '../lib/mappers.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate } from '../plugins/auth.js';

const BRANDING_KEYS = ['displayName', 'logoData', 'accentColor', 'supportEmail'] as const;

async function countWhere(ctx: AppContext, table: 'user' | 'token' | 'session' | 'audit', orgId: string): Promise<number> {
  const t = { user: userTable, token: tokenTable, session: sessionTable, audit: auditEntry }[table];
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(eq(t.orgId, orgId));
  return Number(row?.n ?? 0);
}

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

  app.get('/api/v1/orgs/current/residency', async (req): Promise<ResidencyReport> => {
    const p = await authenticate(ctx, req, ['org_admin', 'auditor']);
    const org = p.org;
    const [rec] = await ctx.db
      .select({ n: sql<number>`count(*)::int`, bytes: sql<string>`coalesce(sum(${recording.bytes}), 0)::text` })
      .from(recording)
      .where(and(eq(recording.orgId, org.id), eq(recording.status, 'stored'), isNull(recording.deletedAt)));
    // Phase B 11.3: WS relay use over the last 30 days, from the `mirror.relayed` entries.
    const [relay] = await ctx.db
      .select({
        n: sql<number>`count(distinct ${auditEntry.sessionId})::int`,
        bytes: sql<string>`coalesce(sum((${auditEntry.data}->>'mirrorBytes')::bigint), 0)::text`,
      })
      .from(auditEntry)
      .where(
        and(
          eq(auditEntry.orgId, org.id),
          eq(auditEntry.action, 'mirror.relayed'),
          gte(auditEntry.ts, new Date(Date.now() - 30 * 86_400_000)),
        ),
      );
    const policy = mergePolicy(org.extensionPolicy);
    const tail = await getOrgChainTail(ctx.db, org.id);
    const lastVerify = await getLatestCheckpoint(ctx.db, org.id, 'verify');
    const lastAnchor = await getLatestCheckpoint(ctx.db, org.id);
    const thirdParty = thirdPartyIceHosts([...ctx.config.stunUrls, ...ctx.config.turnUrls], ctx.config.iceOwnHostSuffixes);
    const label = REGION_LABELS[org.dataRegion];
    let statement = `All session metadata, recordings and audit entries for ${org.name} are stored and served in ${label}.`;
    if (thirdParty.length > 0) statement += ` Media candidates may be sent to third-party STUN hosts: ${thirdParty.join(', ')}.`;
    return {
      org: { id: org.id, name: org.name, slug: org.slug, dataRegion: org.dataRegion },
      generatedAt: new Date().toISOString(),
      servedBy: { region: org.dataRegion, apiOrigin: ctx.config.apiOrigin, nodeId: ctx.config.nodeId },
      storage: { driver: ctx.storage.driver, bucket: ctx.storage.bucket, prefix: `${org.dataRegion}/${org.id}/` },
      ice: { stunUrls: ctx.config.stunUrls, turnUrls: ctx.config.turnUrls, thirdPartyHosts: thirdParty },
      counts: {
        users: await countWhere(ctx, 'user', org.id),
        tokens: await countWhere(ctx, 'token', org.id),
        sessions: await countWhere(ctx, 'session', org.id),
        recordings: Number(rec?.n ?? 0),
        recordingBytes: Number(rec?.bytes ?? 0),
        auditEntries: await countWhere(ctx, 'audit', org.id),
      },
      extensionPolicy: { allowRelayFallback: policy.allowRelayFallback, recordRevealed: policy.recordRevealed },
      relaySessions: Number(relay?.n ?? 0),
      relayBytes: Number(relay?.bytes ?? 0),
      recordingRetentionDays: org.recordingRetentionDays ?? null,
      // Phase C section 13.3: P3 activity over the last 30 days.
      agentSessions: await countAgentSessionsSince(ctx.db, org.id, new Date(Date.now() - 30 * 86_400_000)),
      elevationGrants: await countElevationGrantsSince(ctx.db, org.id, new Date(Date.now() - 30 * 86_400_000)),
      playbookRuns: await countPlaybookRunsSince(ctx.db, org.id, new Date(Date.now() - 30 * 86_400_000)),
      chain: {
        length: tail?.seq ?? 0,
        tail: tail?.hash ?? null,
        lastVerifiedAt: lastVerify ? new Date(lastVerify.ts).toISOString() : null,
        lastVerifiedOk: lastVerify ? (lastVerify.verifyOk ?? false) : null,
        lastAnchor: lastAnchor
          ? { seq: lastAnchor.seq, tail: lastAnchor.tail, ts: new Date(lastAnchor.ts).toISOString(), kid: lastAnchor.kid }
          : null,
      },
      retention: {
        auditEntries: 'append-only, never deleted',
        piiInChain: 'hashed with a per-org pepper; pepper destruction is the erasure mechanism (Phase E)',
        recordings: 'until deleted by an org_admin (Phase B endpoint)',
      },
      statement,
    };
  });
}
