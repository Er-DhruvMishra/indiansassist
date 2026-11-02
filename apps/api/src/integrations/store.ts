/**
 * Integration rows (docs/specs/phase-e-contracts.md sections 2.1, 4.2, 4.7, 12.4): what counts as configured, the
 * wire `Integration` (credentials only as `SecretStatus`, never opened; the webhook config only as `{ origin, pathSet }`),
 * the sealing purpose of each type, and opening the sealed credentials for one call.
 */
import {
  canonicalJson,
  INTEGRATION_CONFIG_SCHEMAS,
  INTEGRATION_CREDENTIAL_SCHEMAS,
  INTEGRATION_TYPES,
  TICKET_FAILURE_CAUSES,
  webhookStoredConfigSchema,
  type Integration,
  type IntegrationConfigOf,
  type IntegrationCredentialsOf,
  type IntegrationType,
  type OrgSecretPurpose,
  type TicketFailureCause,
} from '@indiansassist/shared';
import type { Executor, IntegrationRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import type { UserRef } from '../lib/mappers.js';
import { openOrgSecretWithReseal, secretStatusOf, sealOrgSecret, orgSecretFingerprint } from '../lib/org-secrets.js';
import { iso } from '../lib/time.js';

export function isIntegrationType(s: string): s is IntegrationType {
  return (INTEGRATION_TYPES as readonly string[]).includes(s);
}

/** The sealing purpose of a type's credentials (section 4.2). */
export function purposeOf(type: IntegrationType): OrgSecretPurpose {
  return type === 'webhook' ? 'webhook-secret' : 'integration-credentials';
}

/**
 * A row is configured once a valid `PUT` stored its config (section 12.4: rows Phase A created keep an empty config
 * and are treated as unconfigured; a deleted integration still referenced by pushes is reset to that state).
 */
export function isConfigured(row: IntegrationRow | null): row is IntegrationRow {
  return row !== null && Object.keys(row.config ?? {}).length > 0;
}

export type LastTest = { at: string; ok: boolean; cause: TicketFailureCause | null };

function lastTestOf(v: unknown): LastTest | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o['at'] !== 'string' || typeof o['ok'] !== 'boolean') return null;
  const cause = typeof o['cause'] === 'string' && (TICKET_FAILURE_CAUSES as readonly string[]).includes(o['cause']) ? (o['cause'] as TicketFailureCause) : null;
  return { at: o['at'], ok: o['ok'], cause };
}

/** The wire `Integration` (section 4.7). */
export function toIntegration(row: IntegrationRow, updatedBy: UserRef | null): Integration {
  const config: Record<string, unknown> =
    row.type === 'webhook' ? (webhookStoredConfigSchema.safeParse(row.config).data ?? { origin: '', pathSet: false }) : { ...row.config };
  return {
    type: row.type,
    enabled: row.enabled,
    config,
    credentials: secretStatusOf(row.credentialsEnc, row.credentialsSetAt, row.credentialsFp),
    lastTest: lastTestOf(row.lastTest),
    updatedAt: iso(row.updatedAt),
    updatedBy,
  };
}

/** The stored webhook config: origin only, plus whether a path or query is sealed with the credentials. */
export function webhookStoredConfig(url: string): { origin: string; pathSet: boolean } {
  const u = new URL(url);
  return { origin: u.origin, pathSet: (u.pathname !== '/' && u.pathname !== '') || u.search !== '' };
}

/** Seals a credential object as `canonicalJson` under the row's AAD, with its keyed fingerprint (section 2.1). */
export function sealCredentials(ctx: AppContext, row: Pick<IntegrationRow, 'id' | 'orgId' | 'type'>, creds: object): { enc: string; fingerprint: string } {
  const plain = canonicalJson(creds);
  return {
    enc: sealOrgSecret(ctx, { orgId: row.orgId, purpose: purposeOf(row.type), recordId: row.id }, plain),
    fingerprint: orgSecretFingerprint(ctx, plain),
  };
}

/** Opens a row's sealed credentials (lazily re-sealing under the current key) and parses them; null when unusable. */
export async function openCredentials<T extends IntegrationType>(
  ctx: AppContext,
  exec: Executor,
  row: IntegrationRow & { type: T },
): Promise<IntegrationCredentialsOf<T> | null> {
  if (!row.credentialsEnc) return null;
  let plain: string;
  try {
    plain = await openOrgSecretWithReseal(
      ctx,
      exec,
      { orgId: row.orgId, purpose: purposeOf(row.type), recordId: row.id },
      row.credentialsEnc,
      { column: 'integration.credentials_enc', rowId: row.id },
    );
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  const r = INTEGRATION_CREDENTIAL_SCHEMAS[row.type].safeParse(parsed);
  return r.success ? (r.data as IntegrationCredentialsOf<T>) : null;
}

/**
 * The adapter config of a row: the stored config parsed by `INTEGRATION_CONFIG_SCHEMAS[type]`, and for `webhook` the
 * written form `{ url }` rebuilt from the sealed credentials. Null when it no longer validates (for Zoho, a data
 * centre that is no longer in the verified table).
 */
export function adapterConfigOf<T extends IntegrationType>(
  row: IntegrationRow & { type: T },
  creds: IntegrationCredentialsOf<T>,
): IntegrationConfigOf<T> | null {
  if (row.type === 'webhook') return { url: (creds as IntegrationCredentialsOf<'webhook'>).url } as IntegrationConfigOf<T>;
  const r = INTEGRATION_CONFIG_SCHEMAS[row.type].safeParse(row.config);
  return r.success ? (r.data as IntegrationConfigOf<T>) : null;
}
