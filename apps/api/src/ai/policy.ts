/**
 * Phase E section 5.2: the org AI policy (`org.ai_policy`), the capabilities of this node for the org's region, and
 * the policy change with its exact acknowledgement (5.2e). The acknowledgement is stored, chained by scope and text
 * version, cleared when the org moves away from `anthropic`, and required again when it comes back.
 */
import {
  AI_ACK_TEXT_VERSION,
  AI_INFERENCE_GEO,
  REGION_LABELS,
  aiAckText,
  parseAiPolicy,
  type AiAckScope,
  type AiCapabilities,
  type AiPolicy,
  type AiPolicyPatch,
  type AiPolicyReply,
  type Region,
} from '@indiansassist/shared';
import { getUser, org as orgTable, type OrgRow } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';

/** 5.2d: `in_geo` where the region maps to an inference geography, else `outside_region`. */
export function requiredAckScope(region: Region): AiAckScope {
  return AI_INFERENCE_GEO[region] ? 'in_geo' : 'outside_region';
}

/** 5.2b: what this node can serve for a region. */
export function capabilitiesFor(ctx: Pick<AppContext, 'summaryProviders'>, region: Region): AiCapabilities {
  const p = ctx.summaryProviders(region);
  const available = p.anthropic !== null;
  return {
    region,
    local: p.local !== null,
    anthropic: { available, inferenceGeo: available ? AI_INFERENCE_GEO[region] : null, ackScope: available ? requiredAckScope(region) : null },
  };
}

export function orgPolicy(org: Pick<OrgRow, 'aiPolicy'>): AiPolicy {
  return parseAiPolicy(org.aiPolicy);
}

/** The GET/PATCH reply: the stored policy with the acknowledging user as `{ id, name }`. */
export async function policyReply(ctx: Pick<AppContext, 'db'>, policy: AiPolicy): Promise<AiPolicyReply> {
  let anthropicAck: AiPolicyReply['anthropicAck'] = null;
  if (policy.anthropicAck) {
    const u = await getUser(ctx.db, policy.anthropicAck.userId);
    anthropicAck = {
      scope: policy.anthropicAck.scope,
      textVersion: policy.anthropicAck.textVersion,
      by: { id: policy.anthropicAck.userId, name: (u?.name ?? 'a former user').slice(0, 100) },
      at: policy.anthropicAck.at,
    };
  }
  return { provider: policy.provider, autoSummarize: policy.autoSummarize, includeTranscript: policy.includeTranscript, anthropicAck };
}

/**
 * `PATCH /orgs/current/ai-policy` (5.2c, 5.2e, 5.2f). Throws `409 ai_provider_unavailable` for a provider this node
 * cannot serve for the region, `400 ai_ack_required` for `anthropic` without the exact acknowledgement for the
 * region's scope. Chains `ai.policy_updated` in the same transaction as the write.
 */
export async function updatePolicy(
  ctx: AppContext,
  org: OrgRow,
  user: { id: string; name: string },
  patch: AiPolicyPatch,
  now: Date = new Date(),
): Promise<AiPolicy> {
  const current = orgPolicy(org);
  const region = org.dataRegion;
  const provider = patch.provider ?? current.provider;
  if (patch.provider !== undefined && patch.provider !== current.provider && patch.provider !== 'none') {
    const caps = capabilitiesFor(ctx, region);
    const ok = patch.provider === 'local' ? caps.local : caps.anthropic.available;
    if (!ok) fail('ai_provider_unavailable', `the ${patch.provider} provider is not available in ${REGION_LABELS[region]} on this server`);
  }
  let anthropicAck = provider === 'anthropic' ? current.anthropicAck : null;
  if (provider === 'anthropic' && (anthropicAck === null || patch.acknowledge !== undefined)) {
    const scope = requiredAckScope(region);
    const expected = aiAckText(scope, org.name, REGION_LABELS[region]);
    if (!patch.acknowledge || patch.acknowledge.scope !== scope || patch.acknowledge.text !== expected)
      fail('ai_ack_required', 'choosing Anthropic needs the exact acknowledgement for this region', { scope, textVersion: AI_ACK_TEXT_VERSION });
    anthropicAck = { scope, textVersion: AI_ACK_TEXT_VERSION, userId: user.id, at: now.toISOString() };
  }
  const next: AiPolicy = {
    provider,
    autoSummarize: patch.autoSummarize ?? current.autoSummarize,
    includeTranscript: patch.includeTranscript ?? current.includeTranscript,
    anthropicAck,
  };
  await ctx.db.transaction(async (tx) => {
    await tx.update(orgTable).set({ aiPolicy: next }).where(eq(orgTable.id, org.id));
    await writeAudit(ctx, tx, org, {
      sessionId: null,
      actor: userActor(user),
      action: 'ai.policy_updated',
      data: {
        provider: next.provider,
        autoSummarize: next.autoSummarize,
        includeTranscript: next.includeTranscript,
        ackScope: next.anthropicAck?.scope ?? null,
        ackTextVersion: next.anthropicAck?.textVersion ?? null,
      },
    });
  });
  return next;
}
