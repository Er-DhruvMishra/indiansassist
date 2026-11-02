/**
 * Phase E section 3.6: account resolution, linking and just-in-time provisioning for an `SsoAssertion` that passed
 * every protocol check (and `requiredClaims`, O7). Runs inside the caller's transaction; the first matching rule wins.
 * The test flow evaluates rules 1 and 2 read-only (`evaluateTestLogin`).
 */
import {
  emailDomainOf,
  resolveJitRole,
  roleHasSeat,
  tierWithin,
  type JitRole,
  type PackageTier,
  type SsoAssertion,
  type SsoConfig,
  type SsoErrorCode,
} from '@indiansassist/shared';
import {
  createSeat,
  createUser,
  findSsoIdentity,
  findUserByEmail,
  getUser,
  insertSsoIdentity,
  listVerifiedDomainsByOrg,
  updateUser,
  type Executor,
  type OrgRow,
  type UserRow,
} from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { piiHash, systemActor, userActor, writeAudit } from '../lib/audit.js';
import { findOrgUserByEmail, touchSsoIdentity } from './repo.js';

export type ResolveResult =
  | { ok: true; user: UserRow; via: 'identity' | 'linked' | 'provisioned' }
  | { ok: false; cause: SsoErrorCode };

async function domainVerifiedFor(exec: Executor, orgId: string, email: string): Promise<boolean> {
  const d = emailDomainOf(email);
  if (!d) return false;
  return (await listVerifiedDomainsByOrg(exec, orgId)).some((r) => r.domain === d);
}

/** `invited` becomes `active` with the invite cleared (rules 1 and 2). */
async function activateInvited(exec: Executor, u: UserRow): Promise<UserRow> {
  if (u.status !== 'invited') return u;
  return updateUser(exec, u.id, { status: 'active', inviteTokenHash: null, inviteExpiresAt: null });
}

export async function resolveAccount(
  ctx: AppContext,
  tx: Executor,
  org: OrgRow,
  cfg: SsoConfig,
  a: SsoAssertion,
): Promise<ResolveResult> {
  // Rule 1: a linked identity.
  const ident = await findSsoIdentity(tx, { orgId: org.id, protocol: a.protocol, issuer: a.issuer, subject: a.subject });
  if (ident) {
    const u = await getUser(tx, ident.userId);
    if (!u || u.orgId !== org.id) return { ok: false, cause: 'user_disabled' };
    if (u.status === 'disabled') return { ok: false, cause: 'user_disabled' };
    await touchSsoIdentity(tx, ident.id);
    return { ok: true, user: await activateInvited(tx, u), via: 'identity' };
  }
  // Rule 2: link an existing user of this org with the same email.
  const sameOrg = await findOrgUserByEmail(tx, org.id, a.email);
  if (sameOrg) {
    if (!(await domainVerifiedFor(tx, org.id, a.email))) return { ok: false, cause: 'domain_not_verified' };
    if (a.protocol === 'oidc' && a.emailVerified === false) return { ok: false, cause: 'email_unverified' };
    const row = await insertSsoIdentity(tx, { orgId: org.id, userId: sameOrg.id, protocol: a.protocol, issuer: a.issuer, subject: a.subject });
    await touchSsoIdentity(tx, row.id);
    await writeAudit(ctx, tx, org, {
      actor: userActor(sameOrg),
      action: 'auth.sso_linked',
      data: { userId: sameOrg.id, protocol: a.protocol },
    });
    if (sameOrg.status === 'disabled') return { ok: false, cause: 'user_disabled' };
    return { ok: true, user: await activateInvited(tx, sameOrg), via: 'linked' };
  }
  // Rule 3: the email belongs to another org of this region (user_email_lower_unique is region-wide).
  if (await findUserByEmail(tx, a.email)) return { ok: false, cause: 'email_conflict' };
  // Rule 4: JIT.
  if (!cfg.jit.enabled) return { ok: false, cause: 'jit_disabled' };
  if (!(await domainVerifiedFor(tx, org.id, a.email))) return { ok: false, cause: 'domain_not_verified' };
  const role: JitRole = resolveJitRole(cfg.jit, a.groups);
  const tier: PackageTier | null = roleHasSeat(role) ? cfg.jit.defaultSeatTier : null;
  if (tier && !tierWithin(tier, org.planTier)) return { ok: false, cause: 'seat_unavailable' };
  const localPart = a.email.slice(0, a.email.indexOf('@')).slice(0, 80) || a.email.slice(0, 80);
  const u = await createUser(tx, {
    orgId: org.id,
    email: a.email,
    name: a.name ?? localPart,
    role,
    status: 'active',
    passwordHash: null,
    authProvider: a.protocol,
    authRef: a.subject.slice(0, 1024),
  });
  if (tier) await createSeat(tx, { orgId: org.id, userId: u.id, tier });
  const row = await insertSsoIdentity(tx, { orgId: org.id, userId: u.id, protocol: a.protocol, issuer: a.issuer, subject: a.subject });
  await touchSsoIdentity(tx, row.id);
  await writeAudit(ctx, tx, org, {
    actor: systemActor,
    action: 'user.provisioned',
    data: { userId: u.id, emailHash: piiHash(org, a.email), role, tier, protocol: a.protocol },
  });
  return { ok: true, user: u, via: 'provisioned' };
}

export type TestEvaluation = { ok: boolean; cause: SsoErrorCode | null; matchedSelf: boolean };

/**
 * Section 3.6 "The test flow": rules 1 and 2, read-only. `matchedSelf` when rule 1 finds the acting admin, or rule 2
 * would link the acting admin (same email, domain verified). Writes nothing.
 */
export async function evaluateTestLogin(exec: Executor, org: OrgRow, a: SsoAssertion, actingUserId: string | null): Promise<TestEvaluation> {
  const ident = await findSsoIdentity(exec, { orgId: org.id, protocol: a.protocol, issuer: a.issuer, subject: a.subject });
  if (ident) {
    const u = await getUser(exec, ident.userId);
    if (!u || u.status === 'disabled') return { ok: false, cause: 'user_disabled', matchedSelf: false };
    return { ok: true, cause: null, matchedSelf: u.id === actingUserId };
  }
  const sameOrg = await findOrgUserByEmail(exec, org.id, a.email);
  if (sameOrg) {
    if (!(await domainVerifiedFor(exec, org.id, a.email))) return { ok: false, cause: 'domain_not_verified', matchedSelf: false };
    if (a.protocol === 'oidc' && a.emailVerified === false) return { ok: false, cause: 'email_unverified', matchedSelf: false };
    if (sameOrg.status === 'disabled') return { ok: false, cause: 'user_disabled', matchedSelf: false };
    return { ok: true, cause: null, matchedSelf: sameOrg.id === actingUserId };
  }
  return { ok: true, cause: null, matchedSelf: false };
}
