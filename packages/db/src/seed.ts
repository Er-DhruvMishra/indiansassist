/**
 * Test seed helpers (also used by apps/api integration tests). They write through the repositories, so seeded
 * rows obey every repository rule. Not used by production code paths.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEFAULT_REGION,
  pepperedHash,
  type PackageTier,
  type Region,
  type TokenType,
  type UserRole,
} from '@indiansassist/shared';
import type { Executor } from './client.js';
import { insertAuditEntry } from './repo/audit.js';
import { createOrg } from './repo/orgs.js';
import { createSession } from './repo/sessions.js';
import { insertTokenWithShortCode } from './repo/tokens.js';
import { createSeat, createUser } from './repo/users.js';
import type { OrgRow, SessionRow, TechnicianSeatRow, TokenRow, UserRow } from './schema/index.js';

const suffix = (): string => randomBytes(4).toString('hex');

export type SeedOrgOptions = {
  orgName?: string;
  slug?: string;
  region?: Region;
  adminName?: string;
  adminEmail?: string;
  passwordHash?: string | null;
  seatTier?: PackageTier;
  planTier?: PackageTier;
  /** Also append the `auth.signup` audit entry (seq 1), as POST /auth/signup does. */
  withSignupAudit?: boolean;
};

export type SeededOrg = { org: OrgRow; user: UserRow; seat: TechnicianSeatRow };

/** Creates an org with one active `org_admin` user and a seat, in one transaction. */
export async function createOrgWithAdmin(exec: Executor, opts: SeedOrgOptions = {}): Promise<SeededOrg> {
  const s = suffix();
  return exec.transaction(async (tx) => {
    const org = await createOrg(tx, {
      name: opts.orgName ?? `Acme IT ${s}`,
      slug: opts.slug ?? `acme-${s}`,
      dataRegion: opts.region ?? DEFAULT_REGION,
      ...(opts.planTier ? { planTier: opts.planTier } : {}),
    });
    const email = opts.adminEmail ?? `admin-${s}@example.test`;
    const user = await createUser(tx, {
      orgId: org.id,
      email,
      name: opts.adminName ?? 'Priya S',
      role: 'org_admin',
      status: 'active',
      passwordHash: opts.passwordHash ?? null,
    });
    const seat = await createSeat(tx, { orgId: org.id, userId: user.id, tier: opts.seatTier ?? 'p1_browser' });
    if (opts.withSignupAudit) {
      await insertAuditEntry(tx, {
        orgId: org.id,
        actor: { type: 'user', id: user.id, label: user.name },
        action: 'auth.signup',
        region: org.dataRegion,
        data: { emailHash: pepperedHash(org.auditPepper!, email.toLowerCase()) },
      });
    }
    return { org, user, seat };
  });
}

/** Adds a user (with a seat when the role has one) to an existing org. */
export async function createOrgUser(
  exec: Executor,
  org: OrgRow,
  opts: { role?: UserRole; name?: string; email?: string; seatTier?: PackageTier } = {},
): Promise<{ user: UserRow; seat: TechnicianSeatRow | null }> {
  const role = opts.role ?? 'technician';
  const user = await createUser(exec, {
    orgId: org.id,
    email: opts.email ?? `${role}-${suffix()}@example.test`,
    name: opts.name ?? `User ${suffix()}`,
    role,
  });
  const hasSeat = role === 'technician' || role === 'senior_technician' || role === 'org_admin';
  const seat = hasSeat
    ? await createSeat(exec, { orgId: org.id, userId: user.id, tier: opts.seatTier ?? 'p1_browser' })
    : null;
  return { user, seat };
}

/** Inserts an `active` token row with placeholder signature material (tests that do not verify signatures). */
export async function seedToken(
  exec: Executor,
  org: OrgRow,
  creator: UserRow,
  opts: { tier?: PackageTier; typ?: TokenType; ttlMs?: number; label?: string | null; issuedAt?: Date } = {},
): Promise<TokenRow> {
  const issuedAt = new Date(Math.floor((opts.issuedAt ?? new Date()).getTime() / 1000) * 1000);
  return insertTokenWithShortCode(exec, {
    id: randomUUID(),
    orgId: org.id,
    createdBy: creator.id,
    tier: opts.tier ?? 'p1_browser',
    typ: opts.typ ?? 'one_time',
    label: opts.label ?? null,
    region: org.dataRegion,
    kid: '0000000000000000',
    signature: 'test-signature',
    nonce: randomBytes(16).toString('base64url'),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + (opts.ttlMs ?? 15 * 60 * 1000)),
  });
}

/** Creates a `knocked` session on a token. */
export async function seedSession(
  exec: Executor,
  tok: TokenRow,
  opts: { assistUserId?: string; nodeId?: string; deskLabel?: string } = {},
): Promise<SessionRow> {
  return createSession(exec, {
    orgId: tok.orgId,
    tokenId: tok.id,
    assistUserId: opts.assistUserId ?? tok.createdBy,
    deskRef: randomUUID(),
    deskLabel: opts.deskLabel ?? 'Desk',
    tier: tok.tier,
    region: tok.region,
    nodeId: opts.nodeId ?? 'test-node',
  });
}
