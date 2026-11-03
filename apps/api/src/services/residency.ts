/**
 * The data residency report (docs/specs/phase-e-contracts.md section 6; Phase A 6.3, B 11.3, C 13.3, D 7.2): built
 * from the rows of the org's region database and this node's configuration, then signed with the region's token
 * signing key (6.3a). Both residency routes call `issueResidencyReport`; nothing here writes.
 *
 * The rows of other Phase E streams (the `org` SSO columns, `sso_domain`, `integration`, `org.ai_policy`, the counts
 * over `session_summary`, `ticket_push` and `auth_session`) are only read, through the section 13.2a repo functions
 * or a plain count. No secret column is ever selected: sealed credentials and fingerprints stay out of the report.
 */
import {
  DATA_CATEGORIES,
  REGION_LABELS,
  ZOHO_DATA_CENTERS,
  mergePolicy,
  parseAiPolicy,
  signResidencyReport,
  type AiPolicy,
  type DataCategory,
  type DataCategoryEntry,
  type DataFlow,
  type IntegrationType,
  type Region,
  type ResidencyReport,
  type ResidencySignature,
  type SsoConfig,
  type ZohoDataCenter,
} from '@indiansassist/shared';
import {
  auditEntry,
  countAgentSessionsSince,
  countAmtPlainHttpDevices,
  countDeviceActionsSince,
  countDevices,
  countElevationGrantsSince,
  countPlaybookRunsSince,
  countSsoLoginsSince,
  countSummariesSince,
  countTicketPushesSince,
  countUnattendedSessionsSince,
  countWakeAttemptsSince,
  getLatestCheckpoint,
  getOrgChainTail,
  getOrgSsoState,
  listEnrolledDevices,
  listIntegrations,
  listVerifiedDomainsByOrg,
  recording,
  session as sessionTable,
  sessionFile,
  sessionSummary,
  ticketPush,
  token as tokenTable,
  user as userTable,
  type IntegrationRow,
  getOpenErasure,
  type OrgRow,
} from '@indiansassist/db';
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { onlineSet } from '../fleet/common.js';
import { thirdPartyIceHosts } from '../lib/ice.js';

const DAY_MS = 86_400_000;

/** Phase F section 5.7: the erasure note (erasure stream; the Phase E text said it was not implemented). */
export const ERASURE_NOTE =
  "Erasure destroys this organisation's personal data and the audit pepper after two administrators approve it and a 7-day cooling-off period (an organisation with a single administrator: a mailed confirmation and a 14-day cooling-off period). Technician display names and typed reasons stay in the audit chain.";

/** Phase F section 5.7: `retention.piiInChain` (erasure stream). */
export const PII_IN_CHAIN_TEXT =
  'Personal data in the audit chain is stored only as hashes with a per-org pepper; erasure destroys the pepper, after which the hashes cannot be linked to anyone.';

/**
 * Phase F section 5.7: the erasure block: available, the open erasure's state (`none` when there is none) and, in
 * cooling-off, the time it is scheduled for.
 */
async function erasureBlock(ctx: AppContext, org: OrgRow): Promise<NonNullable<ResidencyReport['erasure']>> {
  const open = await getOpenErasure(ctx.db, org.id);
  return {
    available: true,
    state: open?.state ?? 'none',
    scheduledFor: open?.state === 'cooling_off' && open.coolingOffUntil ? open.coolingOffUntil.toISOString() : null,
    note: ERASURE_NOTE,
  };
}

/** Section 6.2e: `retention.recordings`, computed from `org.recording_retention_days`. */
export function recordingRetentionText(days: number | null | undefined): string {
  return days ? `deleted ${days} days after recording (org setting)` : 'until deleted by an org_admin';
}

/** The host of a URL, or null (never a path, query or credential). */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname;
    return h === '' ? null : h.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** The chain entries a flow's `since` / `enabledBy` come from (rule 6.2c). */
const ENABLING_ACTIONS = ['sso.config_updated', 'integration.updated', 'integration.deleted', 'ai.policy_updated'] as const;

export type ChainRow = { action: string; data: Record<string, unknown>; actorLabel: string; ts: Date };
type Enabling = { since: string | null; enabledBy: string | null };
const NOT_ENABLED: Enabling = { since: null, enabledBy: null };

/**
 * Rule 6.2c: the latest chain entry that turned the flow on. `state` reads one entry (oldest first): `undefined` when the
 * entry is about another flow, else whether the flow was on after it. The answer is the last off -> on transition; a
 * flow whose rows show it on but which has no such entry (rows written outside the routes) reports nulls.
 */
export function lastEnabling(rows: readonly ChainRow[], state: (row: ChainRow) => boolean | undefined): Enabling {
  let on = false;
  let found: ChainRow | null = null;
  for (const r of rows) {
    const s = state(r);
    if (s === undefined) continue;
    if (s && !on) found = r;
    on = s;
  }
  return on && found ? { since: found.ts.toISOString(), enabledBy: found.actorLabel.slice(0, 80) } : NOT_ENABLED;
}

const TICKET_DATA_SENT = 'session summary or note, with a link to the session';

/** Rule 6.2b: one `ticketing` or `webhook` flow per configured integration (enabled or not). */
export function integrationFlow(
  row: Pick<IntegrationRow, 'type' | 'enabled' | 'config'>,
  orgRegion: Region,
  enabling: Enabling,
  dataCenters: readonly ZohoDataCenter[] = ZOHO_DATA_CENTERS,
): DataFlow {
  const c = (row.config ?? {}) as Record<string, unknown>;
  const base = {
    leavesInfrastructure: true,
    enabled: row.enabled,
    since: row.enabled ? enabling.since : null,
    enabledBy: row.enabled ? enabling.enabledBy : null,
    acknowledgement: null,
  };
  const type: IntegrationType = row.type;
  switch (type) {
    case 'zoho_desk': {
      const dc = dataCenters.find((d) => d.id === c.dataCenter) ?? null;
      return {
        ...base,
        kind: 'ticketing',
        name: dc ? `Zoho Desk (${dc.id} data centre)`.slice(0, 80) : 'Zoho Desk',
        host: dc?.deskHost ?? null,
        // Rule 6.2b: 'no' only when the verified data-centre row is in the org's region. A data centre this node no
        // longer lists cannot be placed at all, so it is reported as unknown rather than guessed.
        leavesRegion: dc ? (dc.region === orgRegion ? 'no' : 'yes') : 'unknown',
        dataSent: TICKET_DATA_SENT,
      };
    }
    case 'servicenow':
      return { ...base, kind: 'ticketing', name: 'ServiceNow', host: hostOf(str(c.instanceUrl)), leavesRegion: 'unknown', dataSent: TICKET_DATA_SENT };
    case 'jira':
      return {
        ...base,
        kind: 'ticketing',
        name: c.deployment === 'data_center' ? 'Jira Data Center' : 'Jira Cloud',
        host: hostOf(str(c.siteUrl)),
        leavesRegion: 'unknown',
        dataSent: TICKET_DATA_SENT,
      };
    case 'freshdesk': {
      const d = str(c.domain);
      return {
        ...base,
        kind: 'ticketing',
        name: 'Freshdesk',
        host: d && /^[a-z0-9][a-z0-9-]{0,62}$/.test(d) ? `${d}.freshdesk.com` : null,
        leavesRegion: 'unknown',
        dataSent: TICKET_DATA_SENT,
      };
    }
    case 'webhook':
      // The stored config holds the origin only (the path may carry a secret, section 4.2).
      return {
        ...base,
        kind: 'webhook',
        name: 'Webhook',
        host: hostOf(str(c.origin)),
        leavesRegion: 'unknown',
        dataSent: 'signed JSON: session summary or note, with a link',
      };
  }
}

/** Rule 6.2b: the AI provider flow (none when the provider is `none`). */
export function aiFlow(
  policy: AiPolicy,
  localEndpoint: string | null,
  enabling: Enabling,
  ackBy: string | null,
): DataFlow | null {
  if (policy.provider === 'none') return null;
  const dataSent = policy.includeTranscript
    ? 'redacted session events; after a notice in chat, redacted chat and playbook output'
    : 'redacted session events';
  if (policy.provider === 'local')
    return {
      kind: 'ai_provider',
      name: 'Local model (operator-run, in region)',
      host: hostOf(localEndpoint),
      leavesInfrastructure: false,
      leavesRegion: 'no',
      dataSent,
      enabled: true,
      since: enabling.since,
      enabledBy: enabling.enabledBy,
      acknowledgement: null,
    };
  const ack = policy.anthropicAck;
  return {
    kind: 'ai_provider',
    name: 'Anthropic (Claude)',
    host: 'api.anthropic.com',
    leavesInfrastructure: true,
    // Rule 6.2b: `inference_geo: 'us'` is a geography, not one of our regions, so every Anthropic flow leaves it.
    leavesRegion: 'yes',
    dataSent,
    enabled: true,
    since: enabling.since,
    enabledBy: enabling.enabledBy,
    acknowledgement: ack ? { scope: ack.scope, by: (ackBy ?? 'a former user').slice(0, 80), at: ack.at } : null,
  };
}

/** Rule 6.2b: the `sso_idp` flow of a configured IdP (enabled or not). */
export function ssoFlow(config: SsoConfig, enabling: Enabling): DataFlow {
  const host = config.protocol === 'oidc' ? hostOf(config.oidc?.issuer) : hostOf(config.saml?.ssoUrl);
  return {
    kind: 'sso_idp',
    name: `${config.displayName} (${config.protocol === 'oidc' ? 'OIDC' : 'SAML'})`.slice(0, 80),
    host,
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: "sign-in requests; the IdP returns the user's email and name",
    enabled: config.enabled,
    since: config.enabled ? enabling.since : null,
    enabledBy: config.enabled ? enabling.enabledBy : null,
    acknowledgement: null,
  };
}

const OPERATOR: Pick<DataFlow, 'since' | 'enabledBy' | 'acknowledgement' | 'enabled'> = {
  enabled: true,
  since: null,
  enabledBy: 'operator',
  acknowledgement: null,
};

/** Rule 6.2b: the flows the operator configured for this node (mail, vault, third-party ICE, the recorder). */
export function operatorFlows(config: AppContext['config'], thirdPartyIce: readonly string[]): DataFlow[] {
  const out: DataFlow[] = [];
  if (config.mail.driver === 'smtp')
    out.push({
      ...OPERATOR,
      kind: 'mail',
      name: 'SMTP relay',
      // Host only: the user name and password in SMTP_URL never reach the report.
      host: hostOf(config.mail.smtpUrl),
      leavesInfrastructure: true,
      leavesRegion: 'unknown',
      // Phase F section 4.1d.
      dataSent: 'consent receipts, invitations, password-reset links and break-glass and erasure notices',
    });
  if (config.vault.addr !== '')
    out.push({
      ...OPERATOR,
      kind: 'vault',
      name: 'Credential vault (OpenBao / Vault)',
      host: hostOf(config.vault.addr),
      leavesInfrastructure: false,
      leavesRegion: 'unknown',
      dataSent: 'requests for credentials a technician injects',
    });
  for (const h of thirdPartyIce)
    out.push({
      ...OPERATOR,
      kind: 'ice',
      name: `STUN/TURN ${h}`.slice(0, 80),
      host: h,
      leavesInfrastructure: true,
      leavesRegion: 'unknown',
      dataSent: 'IP address candidates of both computers; encrypted media if relayed',
    });
  if (config.recorderToken !== '')
    out.push({
      ...OPERATOR,
      kind: 'recorder',
      name: 'Server recorder',
      host: null,
      leavesInfrastructure: false,
      leavesRegion: 'no',
      dataSent: 'media of recorded sessions, stored in the region bucket',
    });
  return out;
}

/** Rule 6.2d: what each kind of flow carries, as the subject of its statement sentence. */
const FLOW_SENTENCE: Record<DataFlow['kind'], string> = {
  ai_provider: 'Redacted session summaries are processed by',
  ticketing: 'Tickets and notes are sent to',
  webhook: 'Signed ticket notifications are sent to the webhook',
  sso_idp: 'Sign-in requests are sent to the identity provider',
  mail: 'Consent receipts and break-glass notices are sent through the',
  vault: 'Injected credentials are read from the',
  ice: 'Connection candidates (IP addresses) may be sent to the third-party server',
  recorder: 'Recorded session media is stored by the',
};

/** Rule 6.2d: one sentence per enabled flow that may leave the region, so the statement is never more reassuring than the table. */
export function flowSentence(f: DataFlow, regionLabel: string): string {
  const who = f.kind === 'ice' ? (f.host ?? f.name) : `${f.name}${f.host && f.kind !== 'ai_provider' ? ` (${f.host})` : ''}`;
  const where = f.leavesRegion === 'yes' ? `outside ${regionLabel}` : 'whose location is not known to this report';
  const ack = f.acknowledgement ? `, acknowledged by ${f.acknowledgement.by} on ${f.acknowledgement.at.slice(0, 10)}` : '';
  return `${FLOW_SENTENCE[f.kind]} ${who}, ${where}${ack}.`;
}

async function countOf(ctx: AppContext, table: typeof userTable | typeof tokenTable | typeof sessionTable | typeof auditEntry | typeof sessionSummary | typeof ticketPush, orgId: string): Promise<number> {
  const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.orgId, orgId));
  return Number(row?.n ?? 0);
}

/** Section 6.4: the unsigned report (every A, B, C, D and E field). */
export async function buildResidencyReport(ctx: AppContext, org: OrgRow): Promise<ResidencyReport> {
  const now = Date.now();
  const since30d = new Date(now - 30 * DAY_MS);
  const region = org.dataRegion;
  const label = REGION_LABELS[region];
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
    .where(and(eq(auditEntry.orgId, org.id), eq(auditEntry.action, 'mirror.relayed'), gte(auditEntry.ts, since30d)));
  const [files] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessionFile)
    .innerJoin(sessionTable, eq(sessionTable.id, sessionFile.sessionId))
    .where(eq(sessionTable.orgId, org.id));
  const policy = mergePolicy(org.extensionPolicy);
  const tail = await getOrgChainTail(ctx.db, org.id);
  const lastVerify = await getLatestCheckpoint(ctx.db, org.id, 'verify');
  const lastAnchor = await getLatestCheckpoint(ctx.db, org.id);
  const thirdParty = thirdPartyIceHosts([...ctx.config.stunUrls, ...ctx.config.turnUrls], ctx.config.iceOwnHostSuffixes);

  const counts = {
    users: await countOf(ctx, userTable, org.id),
    tokens: await countOf(ctx, tokenTable, org.id),
    sessions: await countOf(ctx, sessionTable, org.id),
    recordings: Number(rec?.n ?? 0),
    recordingBytes: Number(rec?.bytes ?? 0),
    auditEntries: await countOf(ctx, auditEntry, org.id),
  };
  const devices = await countDevices(ctx.db, org.id, { excludeRetired: true });
  const retentionDays = org.recordingRetentionDays ?? null;

  // ---------- Phase E rows of the other streams (read only) ----------
  const sso = await getOrgSsoState(ctx.db, org.id);
  const verifiedDomains = (await listVerifiedDomainsByOrg(ctx.db, org.id)).map((d) => d.domain);
  const integrations = await listIntegrations(ctx.db, org.id);
  const ai = parseAiPolicy(org.aiPolicy);
  const chainRows: ChainRow[] = (
    await ctx.db
      .select({ action: auditEntry.action, data: auditEntry.data, actorLabel: auditEntry.actorLabel, ts: auditEntry.ts })
      .from(auditEntry)
      .where(and(eq(auditEntry.orgId, org.id), inArray(auditEntry.action, [...ENABLING_ACTIONS])))
      .orderBy(asc(auditEntry.seq))
  ).map((r) => ({ ...r, data: (r.data ?? {}) as Record<string, unknown> }));
  let ackBy: string | null = null;
  if (ai.anthropicAck) {
    const [u] = await ctx.db
      .select({ name: userTable.name })
      .from(userTable)
      .where(and(eq(userTable.id, ai.anthropicAck.userId), eq(userTable.orgId, org.id)))
      .limit(1);
    ackBy = u?.name ?? null;
  }

  // ---------- flows (rule 6.2b) ----------
  const flows: DataFlow[] = [];
  const aiF = aiFlow(
    ai,
    ctx.config.ai.local.endpoints[region] ?? null,
    lastEnabling(chainRows, (r) => (r.action === 'ai.policy_updated' ? r.data.provider === ai.provider : undefined)),
    ackBy,
  );
  if (aiF) flows.push(aiF);
  if (sso?.config) {
    const cfg = sso.config;
    const on = (r: ChainRow) => (r.action === 'sso.config_updated' ? r.data.enabled === true && r.data.protocol === cfg.protocol : undefined);
    flows.push(ssoFlow(cfg, lastEnabling(chainRows, on)));
  }
  for (const row of integrations) {
    // A deleted and re-created integration starts over: `integration.deleted` turns the flow off.
    const on = (r: ChainRow) =>
      r.data.type !== row.type ? undefined : r.action === 'integration.updated' ? r.data.enabled === true : r.action === 'integration.deleted' ? false : undefined;
    flows.push(integrationFlow(row, region, lastEnabling(chainRows, on)));
  }
  flows.push(...operatorFlows(ctx.config, thirdParty));

  // ---------- categories (rule 6.2a) ----------
  const db = (detail: string) => ({ kind: 'database' as const, region, detail });
  const pgDetail = `PostgreSQL of ${region}`;
  const objectDetail = `${ctx.storage.driver === 's3' ? 'bucket' : 'storage'} ${ctx.storage.bucket}, prefix ${region}/${org.id}/`;
  const summaryCount = await countOf(ctx, sessionSummary, org.id);
  const pushCount = await countOf(ctx, ticketPush, org.id);
  const transcriptHeld = ai.provider !== 'none' && ai.includeTranscript;
  const category: Record<DataCategory, Omit<DataCategoryEntry, 'category'>> = {
    identity: {
      stores: [db(`${pgDetail}: users, seats, sign-ins${sso?.config ? ', SSO identities, domains' : ''}`)],
      retention: 'kept while the org exists; removed users are disabled',
      count: counts.users,
      bytes: null,
    },
    sessions: {
      stores: [db(`${pgDetail}: session rows and metadata`)],
      retention: 'kept while the org exists',
      count: counts.sessions,
      bytes: null,
    },
    recordings: {
      stores: [{ kind: 'object_store', region, detail: objectDetail }],
      retention: recordingRetentionText(retentionDays),
      count: counts.recordings,
      bytes: counts.recordingBytes,
    },
    audit: {
      stores: [db(`${pgDetail}: hash-chained log, personal data hashed`)],
      retention: 'append-only, never deleted',
      count: counts.auditEntries,
      bytes: null,
    },
    files: {
      // W88: transfers travel peer to peer; only their names, sizes and hashes are kept. No pushed file is stored:
      // a Phase D file push carries an address the device fetches, and the console offers no upload for it.
      stores: [db(`${pgDetail}: names, sizes, hashes only; files go peer to peer, never stored`)],
      retention: 'kept while the org exists',
      count: Number(files?.n ?? 0),
      bytes: null,
    },
    fleet: {
      stores: [
        db(`${pgDetail}: devices, policies, actions, wakes`),
        { kind: 'device', region, detail: 'session receipts on each device' },
      ],
      retention: 'kept while the org exists; retired devices are kept',
      count: devices,
      bytes: null,
    },
    summaries: {
      stores: [
        db(`${pgDetail}: every summary version`),
        ...(transcriptHeld
          ? [{ kind: 'presence' as const, region, detail: 'redacted transcripts in memory for at most 30 min, never stored' }]
          : []),
      ],
      retention: 'kept with the session record',
      count: summaryCount,
      bytes: null,
    },
    tickets: {
      stores: [db(`${pgDetail}: push records; tickets live in the far system`)],
      retention: 'kept with the session record',
      count: pushCount,
      bytes: null,
    },
  };
  const dataCategories: DataCategoryEntry[] = DATA_CATEGORIES.map((c) => ({ category: c, ...category[c] }));

  // ---------- statement (rule 6.2d) ----------
  let statement = `All session metadata, recordings and audit entries for ${org.name} are stored and served in ${label}.`;
  for (const f of flows) if (f.enabled && f.leavesRegion !== 'no') statement += ` ${flowSentence(f, label)}`;

  const subprocessors = [...new Set(flows.filter((f) => f.enabled && f.leavesInfrastructure).map((f) => f.name))];

  return {
    org: { id: org.id, name: org.name, slug: org.slug, dataRegion: region },
    generatedAt: new Date(now).toISOString(),
    servedBy: { region, apiOrigin: ctx.config.apiOrigin, nodeId: ctx.config.nodeId },
    storage: { driver: ctx.storage.driver, bucket: ctx.storage.bucket, prefix: `${region}/${org.id}/` },
    ice: { stunUrls: ctx.config.stunUrls, turnUrls: ctx.config.turnUrls, thirdPartyHosts: thirdParty },
    counts,
    extensionPolicy: { allowRelayFallback: policy.allowRelayFallback, recordRevealed: policy.recordRevealed },
    relaySessions: Number(relay?.n ?? 0),
    relayBytes: Number(relay?.bytes ?? 0),
    recordingRetentionDays: retentionDays,
    // Phase C section 13.3: P3 activity over the last 30 days.
    agentSessions: await countAgentSessionsSince(ctx.db, org.id, since30d),
    elevationGrants: await countElevationGrantsSince(ctx.db, org.id, since30d),
    playbookRuns: await countPlaybookRunsSince(ctx.db, org.id, since30d),
    // Phase D section 7.2: fleet counts.
    devices,
    onlineDevices: (await onlineSet(ctx, (await listEnrolledDevices(ctx.db, org.id)).map((d) => d.id))).size,
    unattendedSessions30d: await countUnattendedSessionsSince(ctx.db, org.id, since30d),
    wakeAttempts30d: await countWakeAttemptsSince(ctx.db, org.id, since30d),
    deviceActions30d: await countDeviceActionsSince(ctx.db, org.id, since30d),
    amtPlainHttpDevices: await countAmtPlainHttpDevices(ctx.db, org.id),
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
      piiInChain: PII_IN_CHAIN_TEXT,
      recordings: recordingRetentionText(retentionDays),
    },
    statement,
    // ---------- Phase E section 6.2 ----------
    dataCategories,
    dataFlows: flows,
    subprocessors,
    activity30d: {
      summaries: await countSummariesSince(ctx.db, org.id, since30d),
      ticketPushes: await countTicketPushesSince(ctx.db, org.id, since30d),
      ssoLogins: await countSsoLoginsSince(ctx.db, org.id, since30d),
    },
    sso: {
      protocol: sso?.config?.protocol ?? null,
      enabled: sso?.config?.enabled ?? false,
      required: sso?.required ?? false,
      verifiedDomains,
    },
    recorder: { enabled: ctx.config.recorderToken !== '' },
    erasure: await erasureBlock(ctx, org),
  };
}

export type SignedResidencyReport = ResidencyReport & { signature: ResidencySignature };

/** Section 6.3: the report signed with the region's token-signing key (a fresh signature on every call, 6.3d). */
export async function issueResidencyReport(ctx: AppContext, org: OrgRow): Promise<SignedResidencyReport> {
  return signResidencyReport(await buildResidencyReport(ctx, org), ctx.keys.seedHex, ctx.keys.kid);
}
