/**
 * Phase E section 4: ticketing integrations. The foundation lands the per-type configuration and credential
 * schemas, the ticket content and failure shapes and the Zoho data-centre table; the tickets stream fills the
 * behaviour functions (`renderTicketBody`, `classifyHttpFailure`, `isAutoRetryable`, `nextRetryAt`,
 * `webhookSignature`, `verifyWebhookSignature`) and the verified `ZOHO_DATA_CENTERS` rows.
 */
import { z } from 'zod';
import {
  PACKAGE_TIERS,
  TICKET_FAILURE_CAUSES,
  TICKET_PRIORITIES,
  TICKET_SOURCES,
  type IntegrationType,
  type TicketFailureCause,
  type TicketSource,
} from '../enums.js';
import type { Region } from '../regions.js';
import { emailSchema, hex64Schema, isoTimestampSchema, uuidSchema } from '../schemas/common.js';
import { notBuilt } from './not-built.js';
import type { SessionSummaryOutput } from './summary.js';

/** Receivers refuse a webhook timestamp further than this from their clock (section 4.5). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;

/** One row of the Zoho host table (section 4.2): the only hosts the Zoho adapter calls. */
export type ZohoDataCenter = { id: string; deskHost: string; accountsHost: string; region: Region | null };

/**
 * Section 4.2: none of the candidate hosts is verified by the contract, so the foundation ships the table empty;
 * the tickets stream adds each row only after checking it against Zoho Desk's API documentation. With no row, no
 * `zoho_desk` configuration validates (honestly unavailable rather than guessed).
 */
export const ZOHO_DATA_CENTERS: readonly ZohoDataCenter[] = [];

/** An http(s) origin with no path, query or userinfo (`https:` enforced by the egress guard, section 2.2 G1). */
const originUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s.replace(/\/+$/, '') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'expected an http(s) origin without a path');

/** An http(s) URL that may carry a path and query but no userinfo (the webhook URL). */
const webhookUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && u.hash === '';
    } catch {
      return false;
    }
  }, 'expected an http(s) URL without userinfo or fragment');

const sysId = z.string().regex(/^[0-9a-f]{32}$/, 'expected a 32-hex sys_id');
const digits20 = z.string().regex(/^\d{1,20}$/, 'expected 1..20 digits');
const cred = (max: number) => z.string().min(1).max(max);

export const zohoDeskConfigSchema = z.strictObject({
  /** The `id` of a ZOHO_DATA_CENTERS row, never a free host. */
  dataCenter: z
    .string()
    .max(16)
    .refine((id) => ZOHO_DATA_CENTERS.some((d) => d.id === id), 'not a verified Zoho data centre'),
  orgId: digits20,
  departmentId: digits20,
  defaultContactEmail: emailSchema,
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).nullable(),
});

export const servicenowConfigSchema = z.strictObject({
  instanceUrl: originUrl,
  callerId: sysId.nullable(),
  assignmentGroup: sysId.nullable(),
  urgency: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
});

export const jiraConfigSchema = z.strictObject({
  siteUrl: originUrl,
  deployment: z.enum(['cloud', 'data_center']),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,9}$/, 'expected a Jira project key'),
  /** Default 'Task'. */
  issueType: z.string().min(1).max(60),
  labels: z.array(z.string().regex(/^[^\s]{1,50}$/, 'a label has no whitespace')).max(10),
});

export const freshdeskConfigSchema = z.strictObject({
  /** The `<domain>.freshdesk.com` subdomain. */
  domain: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'expected a freshdesk.com subdomain'),
  defaultRequesterEmail: emailSchema,
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  groupId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
});

/** The webhook config as written: the full URL, which is sealed with the credentials (section 4.2). */
export const webhookConfigSchema = z.strictObject({ url: webhookUrl });

/** The webhook config as stored in `integration.config` and returned: origin only (the path may hold a secret). */
export const webhookStoredConfigSchema = z.strictObject({
  origin: z.string().max(2048),
  pathSet: z.boolean(),
});
export type WebhookStoredConfig = z.infer<typeof webhookStoredConfigSchema>;

/** Section 4.2: the written `config` of each type. */
export const INTEGRATION_CONFIG_SCHEMAS = {
  zoho_desk: zohoDeskConfigSchema,
  servicenow: servicenowConfigSchema,
  jira: jiraConfigSchema,
  freshdesk: freshdeskConfigSchema,
  webhook: webhookConfigSchema,
} as const satisfies Record<IntegrationType, z.ZodType>;
export type IntegrationConfigOf<T extends IntegrationType> = z.infer<(typeof INTEGRATION_CONFIG_SCHEMAS)[T]>;

export const jiraCloudCredentialsSchema = z.strictObject({ email: emailSchema, apiToken: cred(512) });
export const jiraDataCenterCredentialsSchema = z.strictObject({ personalAccessToken: cred(512) });

/** The webhook's sealed credential object: the full URL, the server-minted secret and the rotation overlap. */
export const webhookCredentialsSchema = z.strictObject({
  url: webhookUrl,
  /** 32 CSPRNG bytes, base64url (43 chars). */
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'expected 32 bytes base64url'),
  previousSecret: z
    .strictObject({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), until: isoTimestampSchema })
    .nullable(),
});

/**
 * Section 4.2: the credential object of each type (sealed as `canonicalJson`; purpose `integration-credentials`, or
 * `webhook-secret` for webhook). Jira's shape follows `config.deployment`.
 */
export const INTEGRATION_CREDENTIAL_SCHEMAS = {
  zoho_desk: z.strictObject({ clientId: cred(512), clientSecret: cred(512), refreshToken: cred(512) }),
  servicenow: z.strictObject({ username: cred(255), password: cred(1024) }),
  jira: z.union([jiraCloudCredentialsSchema, jiraDataCenterCredentialsSchema]),
  freshdesk: z.strictObject({ apiKey: cred(512) }),
  webhook: webhookCredentialsSchema,
} as const satisfies Record<IntegrationType, z.ZodType>;
export type IntegrationCredentialsOf<T extends IntegrationType> = z.infer<(typeof INTEGRATION_CREDENTIAL_SCHEMAS)[T]>;

/** Section 4.3: what is pushed (stored exactly as sent in `ticket_push.content`). */
export const ticketContentSchema = z.strictObject({
  title: z.string().min(1).max(200),
  /** Plain text; adapters convert. */
  body: z.string().min(1).max(20000),
  source: z.enum(TICKET_SOURCES),
  session: z.strictObject({
    id: uuidSchema,
    /** `${WEB_ORIGIN}/app/sessions/<id>`. */
    url: z.string().url(),
    tier: z.enum(PACKAGE_TIERS),
    startedAt: isoTimestampSchema.nullable(),
    endedAt: isoTimestampSchema,
    technician: z.string().max(80),
    chainVerified: z.boolean().nullable(),
  }),
  summary: z.strictObject({ id: uuidSchema, version: z.number().int().min(1), sha256: hex64Schema }).nullable(),
  priority: z.enum(TICKET_PRIORITIES).nullable(),
  requesterEmail: z.string().email().max(254).nullable(),
});
export type TicketContent = z.infer<typeof ticketContentSchema>;

/** Section 4.1: the honest outcome of a failed attempt. */
export const ticketFailureSchema = z.strictObject({
  cause: z.enum(TICKET_FAILURE_CAUSES),
  /** The upstream HTTP status, when one arrived. */
  status: z.number().int().min(100).max(599).nullable(),
  /** From Retry-After (seconds or HTTP date), capped at 7200. */
  retryAfterSec: z.number().int().min(0).max(7200).nullable(),
  /** False only when no request byte can have reached the far end. */
  sent: z.boolean(),
  /** <= 200, sanitised; never a credential, header or body beyond an upstream error code. */
  detail: z.string().max(200),
});
export type TicketFailure = z.infer<typeof ticketFailureSchema>;

/** The input of `renderTicketBody` (section 4.3). */
export type RenderTicketBodyInput = {
  source: TicketSource;
  /** The technician's note (`source: 'manual'`). */
  note: string | null;
  /** The summary version's output (`source: 'summary'`). */
  summary: Pick<SessionSummaryOutput, 'ticketNote' | 'actionsTaken' | 'followUps'> | null;
  session: TicketContent['session'];
};

/** Section 4.3: the plain-text ticket body with its footer (tickets stream). */
export function renderTicketBody(_input: RenderTicketBodyInput): string {
  return notBuilt('tickets', 'renderTicketBody');
}

/** Section 4.1: the failure cause of an upstream status, or of a transport failure when `status` is null (tickets stream). */
export function classifyHttpFailure(_status: number | null, _sent: boolean): TicketFailureCause {
  return notBuilt('tickets', 'classifyHttpFailure');
}

/** Section 4.4c: whether a failed attempt is retried automatically (tickets stream). */
export function isAutoRetryable(_failure: TicketFailure, _type: IntegrationType): boolean {
  return notBuilt('tickets', 'isAutoRetryable');
}

/** Section 4.4d: when attempt `attempt + 1` is due (tickets stream). */
export function nextRetryAt(_attempt: number, _retryAfterSec: number | null, _now: Date): Date {
  return notBuilt('tickets', 'nextRetryAt');
}

/** Section 4.5: `v1=<hex HMAC-SHA256(base64url-decoded secret, utf8(ts + "." + rawBody))>` (tickets stream). */
export function webhookSignature(_secret: string, _ts: number, _rawBody: Uint8Array): string {
  return notBuilt('tickets', 'webhookSignature');
}

/** Section 4.5: constant-time check of any listed `v1=` value within the 300 s window (tickets stream). */
export function verifyWebhookSignature(
  _secrets: readonly string[],
  _header: string,
  _ts: number,
  _rawBody: Uint8Array,
  _now: Date,
): boolean {
  return notBuilt('tickets', 'verifyWebhookSignature');
}
