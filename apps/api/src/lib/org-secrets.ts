/**
 * Org secrets at rest (docs/specs/phase-e-contracts.md section 2.1). Every credential an org_admin gives us (OIDC
 * client secret, SAML SP private key, ticketing credentials, webhook secret) is sealed with the unchanged D
 * `sealAtRest` primitive under the dedicated `ORG_SECRETS_KEY`, bound by its AAD to one org, purpose and row, and is
 * write-only: no response, log line, audit entry, metric label or report ever carries it. Reads show `SecretStatus`
 * from stored columns (`*_set_at`, `*_fp`), never by opening.
 */
import { createHmac } from 'node:crypto';
import {
  openAtRest,
  ORG_SECRET_PURPOSES,
  sealAtRest,
  type OrgSecretPurpose,
  type SecretStatus,
} from '@indiansassist/shared';
import { compareAndSetSealed, listSealed, SEALED_COLUMNS, type Executor, type SealedColumn } from '@indiansassist/db';
import type { OrgSecretsConfig } from '../config.js';

/** The key material of `ctx.orgSecrets`, built once from config. */
export type OrgSecretKeys = {
  /** The key every new value is sealed under. */
  currentKeyId: string;
  current: Uint8Array;
  /** Every key a value may be opened with: the current one and `ORG_SECRETS_KEYS_PREVIOUS`. */
  open: ReadonlyMap<string, Uint8Array>;
  /** `ORG_SECRETS_FP_KEY`: fingerprints stay comparable across key rotations. */
  fpKey: Uint8Array;
};

export function orgSecretKeysFromConfig(cfg: OrgSecretsConfig): OrgSecretKeys {
  const open = new Map<string, Uint8Array>();
  for (const p of cfg.previous) open.set(p.keyId, new Uint8Array(p.key));
  open.set(cfg.keyId, new Uint8Array(cfg.key));
  return { currentKeyId: cfg.keyId, current: new Uint8Array(cfg.key), open, fpKey: new Uint8Array(cfg.fpKey) };
}

/** What a sealed value is bound to: `recordId` = the org id for the two SSO purposes, the `integration.id` otherwise. */
export type OrgSecretRef = { orgId: string; purpose: OrgSecretPurpose; recordId: string };

export type OrgSecretCtx = { orgSecrets: OrgSecretKeys };

export class OrgSecretError extends Error {
  readonly reason: 'unknown_key' | 'tampered' | 'malformed';
  constructor(reason: 'unknown_key' | 'tampered' | 'malformed') {
    super(`org secret could not be opened: ${reason}`);
    this.name = 'OrgSecretError';
    this.reason = reason;
  }
}

/** `ia-org-secret-v1/<orgId>/<purpose>/<recordId>` (UTF-8 inside the primitive). */
export function orgSecretAad(ref: OrgSecretRef): string {
  if (!(ORG_SECRET_PURPOSES as readonly string[]).includes(ref.purpose)) throw new Error(`unknown org secret purpose ${ref.purpose}`);
  if (!ref.orgId || !ref.recordId) throw new Error('org secret ref needs orgId and recordId');
  return `ia-org-secret-v1/${ref.orgId}/${ref.purpose}/${ref.recordId}`;
}

/** Seals `plaintext` (a UTF-8 string; structured credentials are `canonicalJson`) under the current key. */
export function sealOrgSecret(ctx: OrgSecretCtx, ref: OrgSecretRef, plaintext: string): string {
  return sealAtRest(ctx.orgSecrets.current, ctx.orgSecrets.currentKeyId, plaintext, orgSecretAad(ref));
}

/** The key id a sealed value names (`<keyId>.<nonce>.<ct>`), or null when it is not of that form. */
export function sealedKeyId(sealed: string): string | null {
  const parts = sealed.split('.');
  return parts.length === 3 && parts[0] ? parts[0] : null;
}

/** Opens a sealed value; throws OrgSecretError on an unknown key, tampering, or a value copied from another ref. */
export function openOrgSecret(ctx: OrgSecretCtx, ref: OrgSecretRef, sealed: string): string {
  const keyId = sealedKeyId(sealed);
  if (keyId === null) throw new OrgSecretError('malformed');
  if (!ctx.orgSecrets.open.has(keyId)) throw new OrgSecretError('unknown_key');
  try {
    return openAtRest(ctx.orgSecrets.open, sealed, orgSecretAad(ref));
  } catch {
    throw new OrgSecretError('tampered');
  }
}

/** True when a value was sealed under a key other than the current one (it opens, but should be re-sealed). */
export function needsReseal(ctx: OrgSecretCtx, sealed: string): boolean {
  return sealedKeyId(sealed) !== ctx.orgSecrets.currentKeyId;
}

/** First 8 hex of `HMAC-SHA256(ORG_SECRETS_FP_KEY, plaintext)`, computed at write time and stored beside the value. */
export function orgSecretFingerprint(ctx: OrgSecretCtx, plaintext: string): string {
  return createHmac('sha256', ctx.orgSecrets.fpKey).update(plaintext, 'utf8').digest('hex').slice(0, 8);
}

/** The section 2.1 wire status from the stored columns (never by opening). */
export function secretStatusOf(enc: string | null, setAt: Date | null, fingerprint: string | null): SecretStatus {
  if (!enc) return { set: false, setAt: null, fingerprint: null };
  return { set: true, setAt: setAt ? setAt.toISOString() : null, fingerprint: fingerprint ?? null };
}

/**
 * Opens a stored value and, when it opened under a previous key, re-seals it under the current key and writes it back
 * with a compare-and-set on its column (section 2.1 rotation). Losing the race is not an error: another request
 * already re-sealed or replaced the value. The plaintext is returned either way.
 */
export async function openOrgSecretWithReseal(
  ctx: OrgSecretCtx,
  exec: Executor,
  ref: OrgSecretRef,
  sealed: string,
  stored: { column: SealedColumn; rowId: string },
): Promise<string> {
  const plaintext = openOrgSecret(ctx, ref, sealed);
  if (needsReseal(ctx, sealed)) await compareAndSetSealed(exec, stored.column, stored.rowId, sealed, sealOrgSecret(ctx, ref, plaintext));
  return plaintext;
}

export type ResealReport = { column: SealedColumn; scanned: number; resealed: number; lostRace: number; failed: number }[];

/**
 * `pnpm secrets:reseal` (section 2.1): re-seals every stored value that is not under the current key, with the same
 * compare-and-set as the lazy path. A value that does not open is counted as failed and left untouched.
 */
export async function resealAllOrgSecrets(ctx: OrgSecretCtx, exec: Executor): Promise<ResealReport> {
  const out: ResealReport = [];
  for (const column of SEALED_COLUMNS) {
    const r = { column, scanned: 0, resealed: 0, lostRace: 0, failed: 0 };
    for (const row of await listSealed(exec, column)) {
      r.scanned++;
      if (!needsReseal(ctx, row.value)) continue;
      const purpose = purposeForColumn(column, row.integrationType);
      const ref: OrgSecretRef = { orgId: row.orgId, purpose, recordId: column.startsWith('org.') ? row.orgId : row.id };
      let plaintext: string;
      try {
        plaintext = openOrgSecret(ctx, ref, row.value);
      } catch {
        r.failed++;
        continue;
      }
      if (await compareAndSetSealed(exec, column, row.id, row.value, sealOrgSecret(ctx, ref, plaintext))) r.resealed++;
      else r.lostRace++;
    }
    out.push(r);
  }
  return out;
}

/** The purpose of each sealed column of a row (org columns are fixed; an integration row by its type). */
export function purposeForColumn(column: SealedColumn, integrationType: string | null): OrgSecretPurpose {
  if (column === 'org.sso_secret_enc') return 'sso-oidc-client-secret';
  if (column === 'org.sso_sp_key_enc') return 'sso-saml-sp-key';
  return integrationType === 'webhook' ? 'webhook-secret' : 'integration-credentials';
}
