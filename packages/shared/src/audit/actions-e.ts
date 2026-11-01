/**
 * Phase E audit actions (docs/specs/phase-e-contracts.md section 13.3): the chain shapes of every new action
 * (strict, strings sanitised before hashing) and the one actor each is written by. Emails appear only as
 * `emailHash = piiHash(org, lower(email))`; domains are an org's own and appear in clear. No secret, token,
 * assertion, ticket body, chat line, playbook output or summary text is ever a chain value: pushes and summaries are
 * chained by sha256 of their canonical JSON. `auth.login` (A) gains `oidc` / `saml` through LOGIN_METHODS.
 */
import { z } from 'zod';
import {
  AI_ACK_SCOPES,
  AI_PROVIDERS,
  INTEGRATION_TYPES,
  JIT_ROLES,
  PACKAGE_TIERS,
  SSO_ERROR_CODES,
  SSO_PROTOCOLS,
  SUMMARY_FAIL_CAUSES,
  TICKET_FAILURE_CAUSES,
  TICKET_PUSH_MODES,
  TICKET_SOURCES,
} from '../enums.js';
import { redactionCountsSchema } from '../enterprise/redact.js';
import { sanitiseText } from './sanitise.js';

const id = z.string().transform((s) => sanitiseText(s, 100));
const text = (n: number) => z.string().transform((s) => sanitiseText(s, n));
const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
const kid = z.string().regex(/^[0-9a-f]{16}$/, 'expected a 16-hex-char key id');
const fields = z.array(text(40)).max(30);
const protocol = z.enum(SSO_PROTOCOLS);
const integrationType = z.enum(INTEGRATION_TYPES);
const domain = z.strictObject({ domainId: id, domain: text(253) });
const summaryRef = z.strictObject({ summaryId: id, version: int });

/** Chain `data` of the Phase E actions (merged into AUDIT_ACTIONS / auditDataSchema by actions.ts). */
export const E_CHAIN_SCHEMAS = {
  // ---------- SSO (section 3) ----------
  'auth.sso_failed': z.strictObject({ protocol, cause: z.enum(SSO_ERROR_CODES), emailHash: hash.nullable() }),
  'auth.sso_linked': z.strictObject({ userId: id, protocol }),
  'auth.break_glass_used': z.strictObject({ userId: id }),
  'user.provisioned': z.strictObject({
    userId: id,
    emailHash: hash,
    role: z.enum(JIT_ROLES),
    tier: z.enum(PACKAGE_TIERS).nullable(),
    protocol,
  }),
  'sso.config_updated': z.strictObject({ protocol, enabled: z.boolean(), fields, secretChanged: z.boolean() }),
  'sso.sp_key_rotated': z.strictObject({ certSha256: hash }),
  'sso.tested': z.strictObject({ protocol, ok: z.boolean(), cause: z.enum(SSO_ERROR_CODES).nullable() }),
  'sso.required_changed': z.strictObject({ required: z.boolean(), revokedSessions: int }),
  'sso.break_glass_changed': z.strictObject({ userIds: z.array(id).max(10) }),
  'sso.domain_added': domain,
  'sso.domain_verified': domain,
  'sso.domain_removed': domain,
  'sso.domain_lapsed': domain,
  // ---------- ticketing (section 4) ----------
  'integration.updated': z.strictObject({ type: integrationType, enabled: z.boolean(), fields, credentialsChanged: z.boolean() }),
  'integration.deleted': z.strictObject({ type: integrationType }),
  'integration.tested': z.strictObject({ type: integrationType, ok: z.boolean(), cause: z.enum(TICKET_FAILURE_CAUSES).nullable() }),
  'integration.secret_rotated': z.strictObject({ type: z.literal('webhook') }),
  'ticket.push_requested': z.strictObject({
    pushId: id,
    type: integrationType,
    mode: z.enum(TICKET_PUSH_MODES),
    source: z.enum(TICKET_SOURCES),
    summaryVersion: int.nullable(),
    contentSha256: hash,
  }),
  'ticket.push_delivered': z.strictObject({ pushId: id, type: integrationType, externalId: text(100), attempts: int }),
  'ticket.push_failed': z.strictObject({
    pushId: id,
    type: integrationType,
    cause: z.enum(TICKET_FAILURE_CAUSES),
    status: int.nullable(),
    attempt: int,
    willRetry: z.boolean(),
  }),
  'ticket.push_retried': z.strictObject({ pushId: id, type: integrationType }),
  // ---------- AI summaries (section 5) ----------
  'ai.policy_updated': z.strictObject({
    provider: z.enum(AI_PROVIDERS),
    autoSummarize: z.boolean(),
    includeTranscript: z.boolean(),
    ackScope: z.enum(AI_ACK_SCOPES).nullable(),
    ackTextVersion: text(40).nullable(),
  }),
  'summary.requested': summaryRef,
  'summary.auto_requested': summaryRef,
  'summary.transcript_received': z.strictObject({
    sha256: hash,
    messages: int,
    playbookOutputs: int,
    redactions: redactionCountsSchema,
  }),
  'summary.generated': z.strictObject({
    summaryId: id,
    version: int,
    provider: z.enum(AI_PROVIDERS),
    model: text(100),
    servedModel: text(100).nullable(),
    inferenceGeo: text(40).nullable(),
    fallbackUsed: z.boolean(),
    transcriptIncluded: z.boolean(),
    inputSha256: hash,
    sha256: hash,
    redactions: redactionCountsSchema,
  }),
  'summary.failed': z.strictObject({
    summaryId: id,
    version: int,
    provider: z.enum(AI_PROVIDERS),
    cause: z.enum(SUMMARY_FAIL_CAUSES),
    attempt: int,
    willRetry: z.boolean(),
  }),
  'summary.edited': z.strictObject({ summaryId: id, version: int, baseVersion: int, sha256: hash, previousSha256: hash }),
  // ---------- residency (section 6) ----------
  'residency.report_issued': z.strictObject({ sha256: hash, kid }),
} as const;

export const E_AUDIT_ACTIONS = Object.keys(E_CHAIN_SCHEMAS) as (keyof typeof E_CHAIN_SCHEMAS)[];
export type EAuditAction = keyof typeof E_CHAIN_SCHEMAS;

/** Section 13.3: exactly one actor per action (as D `P4_ACTION_ACTORS`). */
export const E_ACTION_ACTORS: Record<EAuditAction, 'user' | 'system'> = {
  'auth.sso_failed': 'system',
  'auth.sso_linked': 'user',
  'auth.break_glass_used': 'user',
  'user.provisioned': 'system',
  'sso.config_updated': 'user',
  'sso.sp_key_rotated': 'user',
  'sso.tested': 'user',
  'sso.required_changed': 'user',
  'sso.break_glass_changed': 'user',
  'sso.domain_added': 'user',
  'sso.domain_verified': 'user',
  'sso.domain_removed': 'user',
  'sso.domain_lapsed': 'system',
  'integration.updated': 'user',
  'integration.deleted': 'user',
  'integration.tested': 'user',
  'integration.secret_rotated': 'user',
  'ticket.push_requested': 'user',
  'ticket.push_delivered': 'system',
  'ticket.push_failed': 'system',
  'ticket.push_retried': 'user',
  'ai.policy_updated': 'user',
  'summary.requested': 'user',
  'summary.auto_requested': 'system',
  'summary.transcript_received': 'user',
  'summary.generated': 'system',
  'summary.failed': 'system',
  'summary.edited': 'user',
  'residency.report_issued': 'user',
};

/** Section 13.3: the entries whose `session_id` is set (every `ticket.*` and `summary.*`); the others have none. */
export function eActionHasSession(action: EAuditAction): boolean {
  return action.startsWith('ticket.') || action.startsWith('summary.');
}
