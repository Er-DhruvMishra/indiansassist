/** REST schemas of the ticketing integration routes (docs/specs/phase-e-contracts.md section 4.7). */
import { z } from 'zod';
import {
  INTEGRATION_TYPES,
  TICKET_FAILURE_CAUSES,
  TICKET_PRIORITIES,
  TICKET_PUSH_MODES,
  TICKET_PUSH_STATES,
  TICKET_SOURCES,
} from '../enums.js';
import { ticketFailureSchema } from '../enterprise/integrations.js';
import { secretStatusSchema } from '../enterprise/secrets.js';
import { hex64Schema, isoTimestampSchema, uuidSchema } from './common.js';

const userRef = z.strictObject({ id: uuidSchema, name: z.string() });
const webhookSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'expected 32 bytes base64url');

/** One configured integration (credentials as SecretStatus only; for `webhook` the config is `{ origin, pathSet }`). */
export const integrationSchema = z.strictObject({
  type: z.enum(INTEGRATION_TYPES),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  credentials: secretStatusSchema,
  lastTest: z
    .strictObject({ at: isoTimestampSchema, ok: z.boolean(), cause: z.enum(TICKET_FAILURE_CAUSES).nullable() })
    .nullable(),
  updatedAt: isoTimestampSchema,
  updatedBy: userRef.nullable(),
});
export type Integration = z.infer<typeof integrationSchema>;

/**
 * `PUT /integrations/:type`. `config` is validated by `INTEGRATION_CONFIG_SCHEMAS[type]` and `credentials` by
 * `INTEGRATION_CREDENTIAL_SCHEMAS[type]` in the route (`credentials` is ignored for `webhook`); absent = unchanged,
 * null = cleared.
 */
export const integrationPutRequestSchema = z.strictObject({
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  credentials: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type IntegrationPutRequest = z.infer<typeof integrationPutRequestSchema>;

/** `PUT /integrations/webhook` creating the webhook: the secret is shown exactly once. */
export const webhookCreatedReplySchema = z.strictObject({ integration: integrationSchema, secret: webhookSecret });

export const integrationTestReplySchema = z.strictObject({
  ok: z.boolean(),
  cause: z.enum(TICKET_FAILURE_CAUSES).nullable(),
  detail: z.string().max(200).nullable(),
  account: z.string().max(200).nullable(),
});

export const integrationsAvailableSchema = z.strictObject({
  items: z.array(z.strictObject({ type: z.enum(INTEGRATION_TYPES), enabled: z.literal(true) })),
});

/** `POST /integrations/:type/ticket` (PRD 11): `externalId` iff append, `note` iff manual. */
export const ticketPushRequestSchema = z
  .strictObject({
    sessionId: uuidSchema,
    clientPushId: uuidSchema,
    mode: z.enum(TICKET_PUSH_MODES),
    externalId: z.string().min(1).max(100).optional(),
    source: z.enum(TICKET_SOURCES),
    /** Default: the latest `ready` version. */
    summaryVersion: z.number().int().min(1).optional(),
    note: z.string().min(1).max(20000).optional(),
    title: z.string().min(1).max(200).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    requesterEmail: z.string().email().max(254).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.mode === 'append' && r.externalId === undefined)
      ctx.addIssue({ code: 'custom', path: ['externalId'], message: 'externalId is required to append' });
    if (r.mode === 'create' && r.externalId !== undefined)
      ctx.addIssue({ code: 'custom', path: ['externalId'], message: 'externalId is only sent to append' });
    if (r.source === 'manual' && r.note === undefined)
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'a manual push needs a note' });
    if (r.source === 'summary' && r.note !== undefined)
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'a summary push carries no note' });
  });
export type TicketPushRequest = z.infer<typeof ticketPushRequestSchema>;

/** A push record (never the body). */
export const ticketPushSchema = z.strictObject({
  id: uuidSchema,
  sessionId: uuidSchema,
  type: z.enum(INTEGRATION_TYPES),
  mode: z.enum(TICKET_PUSH_MODES),
  source: z.enum(TICKET_SOURCES),
  summary: z.strictObject({ version: z.number().int().min(1), sha256: hex64Schema }).nullable(),
  state: z.enum(TICKET_PUSH_STATES),
  attempts: z.number().int().nonnegative(),
  manualRetries: z.number().int().nonnegative(),
  nextAttemptAt: isoTimestampSchema.nullable(),
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  lastFailure: ticketFailureSchema.nullable(),
  contentSha256: hex64Schema,
  createdBy: userRef,
  createdAt: isoTimestampSchema,
  deliveredAt: isoTimestampSchema.nullable(),
});
export type TicketPush = z.infer<typeof ticketPushSchema>;

export const ticketPushReplySchema = z.strictObject({ push: ticketPushSchema });

/** `GET /sessions/:id/tickets` (newest first). */
export const sessionTicketsSchema = z.strictObject({ items: z.array(ticketPushSchema) });

/** `POST /integrations/webhook/rotate-secret`: shown once. */
export const webhookSecretReplySchema = z.strictObject({ secret: webhookSecret });
