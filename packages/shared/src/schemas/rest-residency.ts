/** REST schema: the data residency report (contracts 6.3; Phase B 11.3, Phase C 13.3, Phase D 7.2, Phase E 6.2 additions). */
import { z } from 'zod';
import { SSO_PROTOCOLS } from '../enums.js';
import { dataCategorySchema, dataFlowSchema, residencySignatureSchema } from '../enterprise/residency.js';
import { hex64Schema, isoTimestampSchema, kidSchema, regionSchema, uuidSchema } from './common.js';

export const residencyReportSchema = z.object({
  org: z.object({ id: uuidSchema, name: z.string(), slug: z.string(), dataRegion: regionSchema }),
  generatedAt: isoTimestampSchema,
  servedBy: z.object({ region: regionSchema, apiOrigin: z.string(), nodeId: z.string() }),
  storage: z.object({ driver: z.string(), bucket: z.string(), prefix: z.string() }),
  ice: z.object({
    stunUrls: z.array(z.string()),
    turnUrls: z.array(z.string()),
    thirdPartyHosts: z.array(z.string()),
  }),
  counts: z.object({
    users: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    recordings: z.number().int().nonnegative(),
    recordingBytes: z.number().int().nonnegative(),
    auditEntries: z.number().int().nonnegative(),
  }),
  chain: z.object({
    length: z.number().int().nonnegative(),
    tail: hex64Schema.nullable(),
    lastVerifiedAt: isoTimestampSchema.nullable(),
    lastVerifiedOk: z.boolean().nullable(),
    lastAnchor: z
      .object({ seq: z.number().int().nonnegative(), tail: hex64Schema, ts: isoTimestampSchema, kid: kidSchema })
      .nullable(),
  }),
  /** Phase B 11.3 additions (always sent by the api; optional so Phase A fixtures still parse). */
  extensionPolicy: z.object({ allowRelayFallback: z.boolean(), recordRevealed: z.boolean() }).optional(),
  relaySessions: z.number().int().nonnegative().optional(),
  relayBytes: z.number().int().nonnegative().optional(),
  recordingRetentionDays: z.number().int().positive().nullable().optional(),
  /** Phase C section 13.3: P3 activity of the last 30 days (always sent by the api). */
  agentSessions: z.number().int().nonnegative().optional(),
  elevationGrants: z.number().int().nonnegative().optional(),
  playbookRuns: z.number().int().nonnegative().optional(),
  /** Phase D section 7.2: fleet counts (always sent by the api; optional so earlier fixtures parse). */
  devices: z.number().int().nonnegative().optional(),
  onlineDevices: z.number().int().nonnegative().optional(),
  unattendedSessions30d: z.number().int().nonnegative().optional(),
  wakeAttempts30d: z.number().int().nonnegative().optional(),
  deviceActions30d: z.number().int().nonnegative().optional(),
  amtPlainHttpDevices: z.number().int().nonnegative().optional(),
  retention: z.object({
    auditEntries: z.literal('append-only, never deleted'),
    /** Phase E 6.2e: widened from a literal (the A literal promised an erasure mechanism that does not exist). */
    piiInChain: z.string().max(300),
    /** Phase E 6.2e: widened from a literal; computed from `recordingRetentionDays`. */
    recordings: z.string().max(300),
  }),
  statement: z.string(),
  /**
   * Phase E section 6.2 additions (all optional on the wire, always sent by a Phase E api). `dataCategories` holds
   * exactly one entry per DATA_CATEGORIES value, in that order; `dataFlows` every configured flow, enabled or not.
   */
  dataCategories: z.array(dataCategorySchema).max(8).optional(),
  dataFlows: z.array(dataFlowSchema).max(64).optional(),
  /** Distinct names of flows with leavesInfrastructure && enabled. */
  subprocessors: z.array(z.string().max(80)).max(64).optional(),
  activity30d: z
    .object({
      summaries: z.number().int().nonnegative(),
      ticketPushes: z.number().int().nonnegative(),
      ssoLogins: z.number().int().nonnegative(),
    })
    .optional(),
  sso: z
    .object({
      protocol: z.enum(SSO_PROTOCOLS).nullable(),
      enabled: z.boolean(),
      required: z.boolean(),
      verifiedDomains: z.array(z.string().max(253)),
    })
    .optional(),
  /** RECORDER_TOKEN set on this node; the recorder stores into the same region bucket. */
  recorder: z.object({ enabled: z.boolean() }).optional(),
  /** W75: erasure by pepper destruction is not built. */
  erasure: z.object({ available: z.literal(false), note: z.string().max(300) }).optional(),
  signature: residencySignatureSchema.optional(),
});
