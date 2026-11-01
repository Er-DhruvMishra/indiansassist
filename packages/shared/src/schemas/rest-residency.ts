/** REST schema: the data residency report (contracts 6.3; Phase B 11.3 and Phase C 13.3 additions). */
import { z } from 'zod';
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
    piiInChain: z.literal('hashed with a per-org pepper; pepper destruction is the erasure mechanism (Phase E)'),
    recordings: z.literal('until deleted by an org_admin (Phase B endpoint)'),
  }),
  statement: z.string(),
});
