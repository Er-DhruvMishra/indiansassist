/**
 * Phase E enumerations (docs/specs/phase-e-contracts.md section 13.1), re-exported by enums.ts (the enums-p3.ts /
 * enums-p4.ts pattern). Values are exact wire strings; each list has one owning definition here.
 */
import type { Region } from './regions.js';

// ---------- SSO (section 3) ----------

export const SSO_PROTOCOLS = ['oidc', 'saml'] as const;
export type SsoProtocol = (typeof SSO_PROTOCOLS)[number];

/** Section 3.1: `email`, `persistent`, `unspecified`, mapped to their SAML URNs by `SAML_NAMEID_FORMAT_URNS`. */
export const SAML_NAMEID_FORMATS = ['email', 'persistent', 'unspecified'] as const;
export type SamlNameIdFormat = (typeof SAML_NAMEID_FORMATS)[number];
export const SAML_NAMEID_FORMAT_URNS: Record<SamlNameIdFormat, string> = {
  email: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
};

/** Section 3.2a. */
export const SSO_DOMAIN_STATUSES = ['pending', 'verified', 'lapsed'] as const;
export type SsoDomainStatus = (typeof SSO_DOMAIN_STATUSES)[number];

/** Section 3.9: the `?sso_error=` codes and the `auth.sso_failed.cause` values. */
export const SSO_ERROR_CODES = [
  'sso_disabled',
  'flow_expired',
  'binding_mismatch',
  'idp_error',
  'invalid_response',
  'email_missing',
  'email_unverified',
  'claim_mismatch',
  'domain_not_verified',
  'user_disabled',
  'jit_disabled',
  'email_conflict',
  'seat_unavailable',
  'replay',
  'unsolicited',
] as const;
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];

/** Section 3.1: the roles JIT may assign (never `org_admin`). */
export const JIT_ROLES = ['technician', 'senior_technician', 'auditor', 'observer'] as const;
export type JitRole = (typeof JIT_ROLES)[number];

/** Section 3.2a: public mail domains no org may claim (`400 domain_not_allowed`). */
export const PUBLIC_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.in',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'zohomail.in',
  'rediffmail.com',
  'gmx.com',
  'gmx.de',
  'web.de',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com',
  '126.com',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
] as const;

// ---------- org secrets and egress (sections 2.1, 2.2) ----------

export const ORG_SECRET_PURPOSES = [
  'sso-oidc-client-secret',
  'sso-saml-sp-key',
  'integration-credentials',
  'webhook-secret',
] as const;
export type OrgSecretPurpose = (typeof ORG_SECRET_PURPOSES)[number];

export const EGRESS_PURPOSES = ['sso_discovery', 'sso_jwks', 'sso_token', 'sso_userinfo', 'ticketing', 'webhook'] as const;
export type EgressPurpose = (typeof EGRESS_PURPOSES)[number];

/**
 * Section 2.2: why `egressFetch` refused a call (`EgressRefusedError.cause`, `400 egress_refused { cause }`): G1
 * `scheme`, G2 `private_address`, G4 `redirect`, G5 `too_large`.
 */
export const EGRESS_REFUSE_CAUSES = ['scheme', 'private_address', 'redirect', 'too_large'] as const;
export type EgressRefuseCause = (typeof EGRESS_REFUSE_CAUSES)[number];

// ---------- ticketing (section 4) ----------

export const TICKET_SOURCES = ['summary', 'manual'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const TICKET_PUSH_MODES = ['create', 'append'] as const;
export type TicketPushMode = (typeof TICKET_PUSH_MODES)[number];

export const TICKET_PUSH_STATES = ['pending', 'delivered', 'retrying', 'failed'] as const;
export type TicketPushState = (typeof TICKET_PUSH_STATES)[number];

export const TICKET_FAILURE_CAUSES = [
  'auth',
  'forbidden',
  'not_found',
  'validation',
  'rate_limited',
  'unreachable',
  'timeout',
  'upstream_error',
  'misconfigured',
  'egress_refused',
] as const;
export type TicketFailureCause = (typeof TICKET_FAILURE_CAUSES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

// ---------- AI summaries (section 5) ----------

export const AI_PROVIDERS = ['none', 'local', 'anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_ACK_SCOPES = ['in_geo', 'outside_region'] as const;
export type AiAckScope = (typeof AI_ACK_SCOPES)[number];

/** Section 5.2d: the Messages API `inference_geo` a region maps to; null = no geography for that region. */
export const AI_INFERENCE_GEO: Record<Region, 'us' | null> = { 'us-east': 'us', 'in-mum': null, 'eu-fra': null };

export const SUMMARY_STATES = ['pending', 'running', 'ready', 'failed'] as const;
export type SummaryState = (typeof SUMMARY_STATES)[number];

export const SUMMARY_TRIGGERS = ['session_end', 'on_demand', 'edit'] as const;
export type SummaryTrigger = (typeof SUMMARY_TRIGGERS)[number];

export const SUMMARY_FAIL_CAUSES = [
  'provider_disabled',
  'provider_unavailable',
  'rate_limited',
  'auth',
  'bad_request',
  'refused',
  'truncated',
  'invalid_output',
  'timeout',
] as const;
export type SummaryFailCause = (typeof SUMMARY_FAIL_CAUSES)[number];

export const SUMMARY_OUTCOMES = ['resolved', 'partially_resolved', 'unresolved', 'unknown'] as const;
export type SummaryOutcome = (typeof SUMMARY_OUTCOMES)[number];

/** Section 5.4, in rule order. */
export const REDACTION_KINDS = [
  'private_key',
  'jwt',
  'url_credential',
  'secret',
  'email',
  'card',
  'aadhaar',
  'pan',
  'phone',
  'mac',
  'ip',
  'user_path',
  'long_token',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/**
 * Section 5.3: the audit actions the chain digest of a summary reads (session lifecycle and consent changes, path
 * changes, files, recordings, elevation, playbooks, the input and clipboard aggregates, the P2 tab actions, the
 * unattended and secure-desktop events, device actions, the security-code check). Every entry is an AUDIT_ACTIONS name.
 */
export const SUMMARY_EVENT_ACTIONS = [
  'session.knock',
  'session.accepted',
  'session.denied',
  'session.consent_granted',
  'session.consent_revoked',
  'session.started',
  'session.resumed',
  'session.ended',
  'consent.level_changed',
  'consent.clipboard_changed',
  'consent.monitors_changed',
  'session.path_changed',
  'file.sent',
  'file.received',
  'recording.started',
  'recording.stored',
  'recording.failed',
  'recording.deleted',
  'recording.server_started',
  'recording.server_stopped',
  'elevation.requested',
  'elevation.granted',
  'elevation.denied',
  'playbook.run_requested',
  'playbook.run',
  'control.input',
  'clipboard.sync',
  'tab.action',
  'session.unattended_started',
  'capture.secure_desktop',
  'input.lock_changed',
  'device.action_queued',
  'device.action_dispatched',
  'device.action_cancelled',
  'device.action_started',
  'device.action_completed',
  'sec.verified',
] as const;
export type SummaryEventAction = (typeof SUMMARY_EVENT_ACTIONS)[number];

// ---------- residency (section 6) ----------

export const DATA_CATEGORIES = ['identity', 'sessions', 'recordings', 'audit', 'files', 'fleet', 'summaries', 'tickets'] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];

export const DATA_FLOW_KINDS = ['ai_provider', 'ticketing', 'webhook', 'sso_idp', 'mail', 'vault', 'ice', 'recorder'] as const;
export type DataFlowKind = (typeof DATA_FLOW_KINDS)[number];

export const LEAVES_REGION = ['yes', 'no', 'unknown'] as const;
export type LeavesRegion = (typeof LEAVES_REGION)[number];

export const DATA_STORE_KINDS = ['database', 'object_store', 'presence', 'device', 'none'] as const;
export type DataStoreKind = (typeof DATA_STORE_KINDS)[number];
