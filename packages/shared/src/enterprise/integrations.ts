/**
 * Phase E section 4: ticketing integrations. The foundation lands the per-type configuration and credential
 * schemas, the ticket content and failure shapes and the Zoho data-centre table; the tickets stream fills the
 * behaviour functions (`renderTicketBody`, `classifyHttpFailure`, `isAutoRetryable`, `nextRetryAt`,
 * `webhookSignature`, `verifyWebhookSignature`) and the verified `ZOHO_DATA_CENTERS` rows.
 */
import { z } from 'zod';
import {
  LIMITS,
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
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { base64urlDecode, bytesToHex, constantTimeEqual, utf8Encode } from '../encoding.js';
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

/**
 * Phase F section 3.3 V4: the vendor-documentation verification record per ticketing type. `verified` is true only
 * when no cell of the type is unconfirmed; `sources` are vendor documentation pages with the date read. The
 * foundation lands every row unverified; the fixes stream fills the rows.
 */
export type IntegrationVerification = {
  verified: boolean;
  sources: readonly { url: string; readOn: string }[];
  unconfirmed: readonly string[];
};
export const INTEGRATION_VERIFICATION: Readonly<Record<Exclude<IntegrationType, 'webhook'>, IntegrationVerification>> = {
  zoho_desk: { verified: false, sources: [], unconfirmed: [] },
  servicenow: { verified: false, sources: [], unconfirmed: [] },
  jira: { verified: false, sources: [], unconfirmed: [] },
  freshdesk: { verified: false, sources: [], unconfirmed: [] },
};

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

/** Section 4.4d: the wait after attempt n (n = 1..5); later attempts reuse the last step. */
export const TICKET_RETRY_SCHEDULE_SEC = [30, 120, 600, 1800, 7200] as const;

/** Section 4.1: `Retry-After` (and the schedule) is capped at this many seconds. */
export const TICKET_RETRY_AFTER_CAP_SEC = 7200;

/** The footer marker line of a ticket body (section 4.3). */
const FOOTER_RULE = '—';

function chainWord(v: boolean | null): string {
  return v === null ? 'not checked' : v ? 'yes' : 'no';
}

/** Cuts `s` to at most `max` characters, at the last whitespace when one is near, ending with an ellipsis. */
function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, Math.max(0, max));
  const head = s.slice(0, max - 1);
  const ws = head.search(/\s\S*$/);
  return `${(ws > max / 2 ? head.slice(0, ws) : head).replace(/\s+$/, '')}…`;
}

/**
 * Section 4.3: the plain-text ticket body. `summary`: the summary's `ticketNote`, a blank line, "Actions taken:" with
 * each item as `- item`, "Follow-ups:" likewise (each list only when non-empty), then the footer. `manual`: the
 * technician's note, then the footer. Footer: a line `—`, `Remote session: <url>`, `Audit chain verified: yes | no |
 * not checked`, `IndiansAssist session <first 8 chars of id>`. The whole body stays within `ticketBodyMax` (20000):
 * the note part is cut at a word boundary with an ellipsis when it would not fit beside the footer.
 */
export function renderTicketBody(input: RenderTicketBodyInput): string {
  const footer = [
    FOOTER_RULE,
    `Remote session: ${input.session.url}`,
    `Audit chain verified: ${chainWord(input.session.chainVerified)}`,
    `IndiansAssist session ${input.session.id.slice(0, 8)}`,
  ].join('\n');
  let head: string;
  if (input.source === 'summary') {
    if (!input.summary) throw new Error('renderTicketBody: a summary push needs the summary output');
    const blocks = [input.summary.ticketNote.trim()];
    if (input.summary.actionsTaken.length > 0) blocks.push(['Actions taken:', ...input.summary.actionsTaken.map((a) => `- ${a}`)].join('\n'));
    if (input.summary.followUps.length > 0) blocks.push(['Follow-ups:', ...input.summary.followUps.map((a) => `- ${a}`)].join('\n'));
    head = blocks.join('\n\n');
  } else {
    if (input.note === null || input.note.trim() === '') throw new Error('renderTicketBody: a manual push needs a note');
    head = input.note.trim();
  }
  const room = LIMITS.ticketBodyMax - footer.length - 2;
  return `${cutText(head, room)}\n\n${footer}`;
}

/**
 * Section 4.1: the failure cause of an upstream status, or of a transport failure when `status` is null: 401 `auth`,
 * 403 `forbidden`, 404 `not_found`, 400 / 409 / 422 (and any other 4xx) `validation`, 429 `rate_limited`, 5xx (and any
 * other unexpected status) `upstream_error`; no status: `unreachable` when nothing can have been sent, else `timeout`.
 */
export function classifyHttpFailure(status: number | null, sent: boolean): TicketFailureCause {
  if (status === null) return sent ? 'timeout' : 'unreachable';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'validation';
  return 'upstream_error';
}

/**
 * Section 4.4c: true for `unreachable` with nothing sent, `rate_limited` and any 503; for `webhook` also `timeout` and
 * `upstream_error` (receivers de-duplicate on `X-IA-Push-Id`). Never for an ambiguous non-webhook failure, and never
 * for `egress_refused` (configuration).
 */
export function isAutoRetryable(failure: TicketFailure, type: IntegrationType): boolean {
  if (failure.cause === 'unreachable' && !failure.sent) return true;
  if (failure.cause === 'rate_limited') return true;
  if (failure.status === 503) return true;
  if (type === 'webhook' && (failure.cause === 'timeout' || failure.cause === 'upstream_error')) return true;
  return false;
}

/**
 * Section 4.4d: attempt `attempt + 1` is due 30 s, 2 min, 10 min, 30 min or 2 h after attempt `attempt` (1..5), or
 * after `retryAfterSec` when that is larger (capped at 7200 s).
 */
export function nextRetryAt(attempt: number, retryAfterSec: number | null, now: Date): Date {
  const i = Math.min(Math.max(1, Math.floor(attempt)), TICKET_RETRY_SCHEDULE_SEC.length) - 1;
  const step = TICKET_RETRY_SCHEDULE_SEC[i]!;
  const after = retryAfterSec !== null && Number.isFinite(retryAfterSec) ? Math.min(Math.max(0, retryAfterSec), TICKET_RETRY_AFTER_CAP_SEC) : 0;
  return new Date(now.getTime() + Math.max(step, after) * 1000);
}

function webhookMac(secret: string, ts: number, rawBody: Uint8Array): Uint8Array {
  const key = base64urlDecode(secret);
  if (key.length !== 32) throw new Error('webhook secret must decode to 32 bytes');
  const prefix = utf8Encode(`${ts}.`);
  const msg = new Uint8Array(prefix.length + rawBody.length);
  msg.set(prefix, 0);
  msg.set(rawBody, prefix.length);
  return hmac(sha256, key, msg);
}

/**
 * Section 4.5: `v1=<lower-case hex HMAC-SHA256(key, utf8(ts + ".") || rawBody)>` where the key is the 32 raw bytes of
 * the base64url-decoded `secret` (not the 43-character string).
 */
export function webhookSignature(secret: string, ts: number, rawBody: Uint8Array): string {
  return `v1=${bytesToHex(webhookMac(secret, ts, rawBody))}`;
}

/**
 * Section 4.5: true when `ts` is within `WEBHOOK_SIGNATURE_TOLERANCE_SEC` of `now` and any `v1=` value of the header
 * verifies under any listed secret (constant-time comparison).
 */
export function verifyWebhookSignature(
  secrets: readonly string[],
  header: string,
  ts: number,
  rawBody: Uint8Array,
  now: Date,
): boolean {
  if (!Number.isInteger(ts) || Math.abs(now.getTime() / 1000 - ts) > WEBHOOK_SIGNATURE_TOLERANCE_SEC) return false;
  const given = header
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^v1=[0-9a-f]{64}$/.test(p))
    .map((p) => p.slice(3));
  if (given.length === 0) return false;
  let ok = false;
  for (const secret of secrets) {
    let expected: string;
    try {
      expected = bytesToHex(webhookMac(secret, ts, rawBody));
    } catch {
      continue;
    }
    for (const g of given) if (constantTimeEqual(expected, g)) ok = true;
  }
  return ok;
}
