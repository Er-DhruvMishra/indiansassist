/**
 * Phase E section 2.1 (docs/specs/phase-e-contracts.md section 15.1): sealOrgSecret / openOrgSecret round trip; a
 * value moved to another org, purpose or row refused; an unknown key and tampering refused; lazy rotation through a
 * previous key with the compare-and-set write-back (and a lost race that is not an error); the eager re-seal; and
 * fingerprint stability across key rotations under the fixed fingerprint key. Plus the section 10 boot rules.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { closeDb, createOrgWithAdmin, getIntegration, org as orgTable, upsertIntegration, type Db, type SeededOrg } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import {
  needsReseal,
  openOrgSecret,
  openOrgSecretWithReseal,
  OrgSecretError,
  orgSecretAad,
  orgSecretFingerprint,
  orgSecretKeysFromConfig,
  purposeForColumn,
  resealAllOrgSecrets,
  sealOrgSecret,
  sealedKeyId,
  secretStatusOf,
  type OrgSecretCtx,
  type OrgSecretRef,
} from '../src/lib/org-secrets.js';
import { makeDb } from './helpers.js';

const hex = () => randomBytes(32).toString('hex');
const K1 = `k1:${hex()}`;
const K2 = `k2:${hex()}`;
const FP = hex();

function ctxOf(env: Record<string, string>): OrgSecretCtx {
  const config = loadConfig({ NODE_ENV: 'test', ...env }, { persistSecrets: false });
  return { orgSecrets: orgSecretKeysFromConfig(config.orgSecrets) };
}

const ORG = randomUUID();
const REF: OrgSecretRef = { orgId: ORG, purpose: 'sso-oidc-client-secret', recordId: ORG };

describe('sealOrgSecret / openOrgSecret', () => {
  const ctx = ctxOf({ ORG_SECRETS_KEY: K1, ORG_SECRETS_FP_KEY: FP });

  it('round-trips a UTF-8 secret under the current key id', () => {
    const sealed = sealOrgSecret(ctx, REF, 'client-secret-é-✓');
    expect(sealedKeyId(sealed)).toBe('k1');
    expect(sealed).not.toContain('client-secret');
    expect(openOrgSecret(ctx, REF, sealed)).toBe('client-secret-é-✓');
    expect(sealOrgSecret(ctx, REF, 'x')).not.toBe(sealOrgSecret(ctx, REF, 'x'));
    expect(needsReseal(ctx, sealed)).toBe(false);
  });

  it('binds the value to its org, purpose and row (AAD)', () => {
    expect(orgSecretAad(REF)).toBe(`ia-org-secret-v1/${ORG}/sso-oidc-client-secret/${ORG}`);
    const sealed = sealOrgSecret(ctx, REF, 'hunter2-hunter2');
    const moved: OrgSecretRef[] = [
      { ...REF, orgId: randomUUID() },
      { ...REF, purpose: 'sso-saml-sp-key' },
      { ...REF, recordId: randomUUID() },
    ];
    for (const ref of moved) {
      expect(() => openOrgSecret(ctx, ref, sealed)).toThrow(OrgSecretError);
      try {
        openOrgSecret(ctx, ref, sealed);
      } catch (err) {
        expect((err as OrgSecretError).reason).toBe('tampered');
        expect((err as Error).message).not.toContain('hunter2');
      }
    }
    expect(() => orgSecretAad({ ...REF, purpose: 'other' as never })).toThrow();
  });

  it('refuses an unknown key, a tampered value and a malformed value', () => {
    const sealed = sealOrgSecret(ctx, REF, 'v');
    const other = ctxOf({ ORG_SECRETS_KEY: K2, ORG_SECRETS_FP_KEY: FP });
    expect(() => openOrgSecret(other, REF, sealed)).toThrow(expect.objectContaining({ reason: 'unknown_key' }));
    const [kid, nonce, ct] = sealed.split('.');
    const flipped = `${kid}.${nonce}.${ct!.slice(0, -2)}${ct!.endsWith('AA') ? 'BA' : 'AA'}`;
    expect(() => openOrgSecret(ctx, REF, flipped)).toThrow(expect.objectContaining({ reason: 'tampered' }));
    expect(() => openOrgSecret(ctx, REF, 'not-sealed')).toThrow(expect.objectContaining({ reason: 'malformed' }));
  });
});

describe('fingerprints (section 2.1 Wire)', () => {
  it('are the first 8 hex of the keyed HMAC, stable across ORG_SECRETS_KEY rotations', () => {
    const a = ctxOf({ ORG_SECRETS_KEY: K1, ORG_SECRETS_FP_KEY: FP });
    const b = ctxOf({ ORG_SECRETS_KEY: K2, ORG_SECRETS_KEYS_PREVIOUS: K1, ORG_SECRETS_FP_KEY: FP });
    const other = ctxOf({ ORG_SECRETS_KEY: K1, ORG_SECRETS_FP_KEY: hex() });
    const fp = orgSecretFingerprint(a, 'password1');
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(orgSecretFingerprint(b, 'password1')).toBe(fp);
    expect(orgSecretFingerprint(a, 'password2')).not.toBe(fp);
    expect(orgSecretFingerprint(other, 'password1')).not.toBe(fp);
  });

  it('SecretStatus is read from the stored columns, never from the value', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    expect(secretStatusOf(null, null, null)).toEqual({ set: false, setAt: null, fingerprint: null });
    expect(secretStatusOf('k1.a.b', at, '0a1b2c3d')).toEqual({ set: true, setAt: '2026-11-01T10:00:00.000Z', fingerprint: '0a1b2c3d' });
  });
});

describe('rotation (section 2.1): lazy re-seal with compare-and-set, and the eager re-seal', () => {
  let db: Db;
  let a: SeededOrg;
  const before = ctxOf({ ORG_SECRETS_KEY: K1, ORG_SECRETS_FP_KEY: FP });
  const after = ctxOf({ ORG_SECRETS_KEY: K2, ORG_SECRETS_KEYS_PREVIOUS: K1, ORG_SECRETS_FP_KEY: FP });
  beforeAll(async () => {
    db = await makeDb();
    a = await createOrgWithAdmin(db, {});
  });
  afterAll(async () => {
    await closeDb(db);
  });
  const readSecret = async () => (await db.select().from(orgTable).where(eq(orgTable.id, a.org.id)))[0]!.ssoSecretEnc;

  it('an open through a previous key re-seals under the current key and writes it back once', async () => {
    const ref: OrgSecretRef = { orgId: a.org.id, purpose: 'sso-oidc-client-secret', recordId: a.org.id };
    const old = sealOrgSecret(before, ref, 'oidc-secret');
    await db.update(orgTable).set({ ssoSecretEnc: old }).where(eq(orgTable.id, a.org.id));
    expect(needsReseal(after, old)).toBe(true);
    expect(await openOrgSecretWithReseal(after, db, ref, old, { column: 'org.sso_secret_enc', rowId: a.org.id })).toBe('oidc-secret');
    const now = (await readSecret())!;
    expect(sealedKeyId(now)).toBe('k2');
    expect(openOrgSecret(after, ref, now)).toBe('oidc-secret');
    // The new value is under the current key: no further write.
    expect(await openOrgSecretWithReseal(after, db, ref, now, { column: 'org.sso_secret_enc', rowId: a.org.id })).toBe('oidc-secret');
    expect(await readSecret()).toBe(now);
  });

  it('losing the compare-and-set race is not an error and leaves the winner in place', async () => {
    const ref: OrgSecretRef = { orgId: a.org.id, purpose: 'sso-oidc-client-secret', recordId: a.org.id };
    const stale = sealOrgSecret(before, ref, 'stale');
    const winner = sealOrgSecret(after, ref, 'replaced-by-admin');
    await db.update(orgTable).set({ ssoSecretEnc: winner }).where(eq(orgTable.id, a.org.id));
    // A request still holding the stale value opens it and tries to re-seal: the row moved on.
    expect(await openOrgSecretWithReseal(after, db, ref, stale, { column: 'org.sso_secret_enc', rowId: a.org.id })).toBe('stale');
    expect(await readSecret()).toBe(winner);
  });

  it('pnpm secrets:reseal re-seals every stored value not under the current key, by purpose', async () => {
    const jira = await upsertIntegration(db, { orgId: a.org.id, type: 'jira', enabled: true, config: {}, updatedBy: a.user.id });
    const hook = await upsertIntegration(db, { orgId: a.org.id, type: 'webhook', enabled: true, config: {}, updatedBy: a.user.id });
    const jiraRef: OrgSecretRef = { orgId: a.org.id, purpose: purposeForColumn('integration.credentials_enc', 'jira'), recordId: jira.id };
    const hookRef: OrgSecretRef = { orgId: a.org.id, purpose: purposeForColumn('integration.credentials_enc', 'webhook'), recordId: hook.id };
    expect(hookRef.purpose).toBe('webhook-secret');
    expect(jiraRef.purpose).toBe('integration-credentials');
    await upsertIntegration(db, { orgId: a.org.id, type: 'jira', enabled: true, config: {}, updatedBy: a.user.id, credentials: { enc: sealOrgSecret(before, jiraRef, '{"apiToken":"t"}'), fingerprint: '00000000' } });
    await upsertIntegration(db, { orgId: a.org.id, type: 'webhook', enabled: true, config: {}, updatedBy: a.user.id, credentials: { enc: sealOrgSecret(before, hookRef, '{"secret":"s"}'), fingerprint: '00000000' } });
    const spRef: OrgSecretRef = { orgId: a.org.id, purpose: 'sso-saml-sp-key', recordId: a.org.id };
    await db.update(orgTable).set({ ssoSpKeyEnc: sealOrgSecret(before, spRef, 'pkcs8') }).where(eq(orgTable.id, a.org.id));
    const report = await resealAllOrgSecrets(after, db);
    const by = Object.fromEntries(report.map((r) => [r.column, r]));
    expect(by['integration.credentials_enc']).toMatchObject({ scanned: 2, resealed: 2, failed: 0 });
    expect(by['org.sso_sp_key_enc']).toMatchObject({ scanned: 1, resealed: 1 });
    expect(by['org.sso_secret_enc']).toMatchObject({ scanned: 1, resealed: 0 });
    const j = (await getIntegration(db, a.org.id, 'jira'))!;
    expect(sealedKeyId(j.credentialsEnc!)).toBe('k2');
    expect(openOrgSecret(after, jiraRef, j.credentialsEnc!)).toBe('{"apiToken":"t"}');
    expect((await resealAllOrgSecrets(after, db)).every((r) => r.resealed === 0)).toBe(true);
  });
});

describe('boot rules (section 10, rule 12.2, W86)', () => {
  const boot = (env: Record<string, string>) => () => loadConfig(env, { persistSecrets: false });
  it('production needs ORG_SECRETS_KEY and ORG_SECRETS_FP_KEY', () => {
    expect(boot({ NODE_ENV: 'production' })).toThrow(/ORG_SECRETS_KEY is required in production/);
    expect(boot({ NODE_ENV: 'production' })).toThrow(/ORG_SECRETS_FP_KEY is required in production/);
  });
  it('keys must be well formed and the previous list must not repeat the current key id', () => {
    expect(boot({ NODE_ENV: 'test', ORG_SECRETS_KEY: hex() })).toThrow(ConfigError);
    expect(boot({ NODE_ENV: 'test', ORG_SECRETS_KEY: K1, ORG_SECRETS_FP_KEY: 'abc' })).toThrow(/ORG_SECRETS_FP_KEY must be 64 hex/);
    expect(boot({ NODE_ENV: 'test', ORG_SECRETS_KEY: K1, ORG_SECRETS_KEYS_PREVIOUS: K1 })).toThrow(/repeats the current key id/);
    expect(boot({ NODE_ENV: 'test', ORG_SECRETS_KEY: K1, ORG_SECRETS_KEYS_PREVIOUS: 'nope' })).toThrow(/ORG_SECRETS_KEYS_PREVIOUS/);
    const c = loadConfig({ NODE_ENV: 'test', ORG_SECRETS_KEY: K2, ORG_SECRETS_KEYS_PREVIOUS: K1 }, { persistSecrets: false });
    expect(c.orgSecrets.keyId).toBe('k2');
    expect(c.orgSecrets.previous.map((p) => p.keyId)).toEqual(['k1']);
  });
  it('development generates the keys when unset', () => {
    const c = loadConfig({ NODE_ENV: 'development' }, { persistSecrets: false });
    expect(c.orgSecrets.key).toHaveLength(32);
    expect(c.orgSecrets.fpKey).toHaveLength(32);
  });
  it('AUTH_PROVIDER accepts only local', () => {
    expect(boot({ NODE_ENV: 'test', AUTH_PROVIDER: 'oidc' })).toThrow(/section 3\.10/);
    expect(loadConfig({ NODE_ENV: 'test', AUTH_PROVIDER: 'local' }, { persistSecrets: false }).authProvider).toBe('local');
  });
  it('the AI operator settings are validated', () => {
    expect(boot({ NODE_ENV: 'test', AI_LOCAL_ENDPOINTS: 'mars-1=http://llm:8000' })).toThrow(/AI_LOCAL_ENDPOINTS/);
    expect(boot({ NODE_ENV: 'test', AI_ANTHROPIC_MAX_RETRIES: '3' })).toThrow(/AI_ANTHROPIC_MAX_RETRIES/);
    expect(boot({ NODE_ENV: 'test', AI_LOCAL_TIMEOUT_MS: '10' })).toThrow(/AI_LOCAL_TIMEOUT_MS/);
    const c = loadConfig({ NODE_ENV: 'test', AI_LOCAL_ENDPOINTS: 'in-mum=http://llm.in-mum.internal:8000/', AI_ANTHROPIC_REGIONS: 'us-east' }, { persistSecrets: false });
    expect(c.ai.local.endpoints).toEqual({ 'in-mum': 'http://llm.in-mum.internal:8000' });
    expect(c.ai.anthropic).toMatchObject({ regions: ['us-east'], model: 'claude-opus-5-5', timeoutMs: 90000, maxRetries: 0, apiKey: '' });
  });
});
