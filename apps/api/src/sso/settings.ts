/**
 * Phase E sections 3.7 and 3.9: the `SsoSettings` view (secrets as `SecretStatus` only, never opened), the SSO-required
 * readiness rule of 3.7a and the `fields` list of `sso.config_updated`.
 */
import { parseSsoConfig, ssoLastTestSchema, type SsoConfig, type SsoSettings } from '@indiansassist/shared';
import { getOrg, listVerifiedDomainsByOrg, type Executor, type OrgRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { secretStatusOf } from '../lib/org-secrets.js';
import { toSsoDomain } from './domains.js';
import { countUsersOutsideDomains, listBreakGlassUsers, listDomainsByOrg } from './repo.js';
import { oidcRedirectUri, spAcsUrl, spEntityId, spMetadataUrl } from './urls.js';

export const RECENT_TEST_MS = 24 * 3_600_000;

export async function settingsOf(ctx: AppContext, exec: Executor, org: OrgRow): Promise<SsoSettings> {
  const domains = await listDomainsByOrg(exec, org.id);
  const bg = await listBreakGlassUsers(exec, org.id);
  const lt = ssoLastTestSchema.safeParse(org.ssoLastTest);
  return {
    config: parseSsoConfig(org.ssoConfig),
    required: org.ssoRequired,
    secrets: {
      clientSecret: secretStatusOf(org.ssoSecretEnc, org.ssoSecretSetAt, org.ssoSecretFp),
      spKey: secretStatusOf(org.ssoSpKeyEnc, org.ssoSpKeySetAt, org.ssoSpKeyFp),
    },
    sp: {
      entityId: spEntityId(ctx.config, org.id),
      acsUrl: spAcsUrl(ctx.config, org.id),
      metadataUrl: spMetadataUrl(ctx.config, org.id),
      oidcRedirectUri: oidcRedirectUri(ctx.config, org.id),
      certPem: org.ssoSpCert,
    },
    domains: domains.map(toSsoDomain),
    breakGlassUserIds: bg.map((u) => u.id),
    lastTest: lt.success ? { at: lt.data.at, ok: lt.data.ok, cause: lt.data.cause, matchedSelf: lt.data.matchedSelf } : null,
  };
}

export async function freshSettings(ctx: AppContext, orgId: string): Promise<SsoSettings> {
  const org = await getOrg(ctx.db, orgId);
  if (!org) throw new Error(`org ${orgId} vanished`);
  return settingsOf(ctx, ctx.db, org);
}

export type ReadinessItem = 'sso_enabled' | 'verified_domain' | 'break_glass' | 'break_glass_password' | 'recent_test';

/** Rule 3.7a: what is missing before SSO can be required (empty = ready). */
export async function ssoReadiness(exec: Executor, org: OrgRow, actingUserId: string, now: Date = new Date()): Promise<ReadinessItem[]> {
  const missing: ReadinessItem[] = [];
  const cfg = parseSsoConfig(org.ssoConfig);
  if (!cfg || !cfg.enabled) missing.push('sso_enabled');
  if ((await listVerifiedDomainsByOrg(exec, org.id)).length === 0) missing.push('verified_domain');
  const bg = await listBreakGlassUsers(exec, org.id);
  if (bg.length === 0) missing.push('break_glass');
  else if (bg.some((u) => u.status !== 'active' || u.role !== 'org_admin' || !u.passwordHash)) missing.push('break_glass_password');
  const lt = ssoLastTestSchema.safeParse(org.ssoLastTest);
  const recent =
    lt.success &&
    lt.data.ok &&
    lt.data.matchedSelf &&
    lt.data.userId === actingUserId &&
    now.getTime() - Date.parse(lt.data.at) <= RECENT_TEST_MS;
  if (!recent) missing.push('recent_test');
  return missing;
}

/** Rule 3.7a warning: active users outside the verified domains with no linked identity. */
export async function usersOutsideVerifiedDomains(exec: Executor, orgId: string): Promise<number> {
  const verified = (await listVerifiedDomainsByOrg(exec, orgId)).map((d) => d.domain);
  return countUsersOutsideDomains(exec, orgId, verified);
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
}

/** `sso.config_updated.fields`: the changed keys, nested ones dotted (`oidc.clientId`), at most 30. */
export function configDiffFields(before: SsoConfig | null, after: SsoConfig): string[] {
  const out: string[] = [];
  const top = Object.keys(after) as (keyof SsoConfig)[];
  for (const k of top) {
    const a = before ? (before[k] as unknown) : undefined;
    const b = after[k] as unknown;
    if (stable(a) === stable(b)) continue;
    if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object' && !Array.isArray(a)) {
      for (const sub of Object.keys(b as Record<string, unknown>))
        if (stable((a as Record<string, unknown>)[sub]) !== stable((b as Record<string, unknown>)[sub])) out.push(`${k}.${sub}`);
    } else out.push(k);
  }
  return out.slice(0, 30).map((f) => f.slice(0, 40));
}
