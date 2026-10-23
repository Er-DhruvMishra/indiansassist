/**
 * token repository (contracts sections 3, 4.2, 6.7). The compact string is never stored; the row keeps kid,
 * signature and nonce so it can be rebuilt. Short codes are unique among `active` tokens (partial unique index).
 */
import { generateShortCode, type TokenStatus } from '@indiansassist/shared';
import { and, eq, lte, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { isUniqueViolation, ShortCodeExhaustedError } from '../errors.js';
import { token, type NewTokenRow, type TokenRow } from '../schema/index.js';
import { clampLimit, timeIdAfter, timeIdCursorOf, timeIdOrder, toPage, type Page, type PageQuery } from './page.js';

export type InsertTokenInput = Omit<
  NewTokenRow,
  'status' | 'usedAt' | 'revokedAt' | 'revokedBy' | 'deniedCount' | 'createdAt'
> & {
  /** Required: the id is the signed payload `tid`, so the API generates it before signing. */
  id: string;
};

export type TokenWithEffectiveStatus = TokenRow & { effectiveStatus: TokenStatus };

/** `CASE WHEN status = 'active' AND expires_at <= now() THEN 'expired' ELSE status END` (section 6.7). */
export const effectiveTokenStatus: SQL<TokenStatus> = sql<TokenStatus>`(CASE WHEN ${token.status} = 'active' AND ${token.expiresAt} <= now() THEN 'expired' ELSE ${token.status}::text END)`;

export async function insertToken(exec: Executor, input: InsertTokenInput): Promise<TokenRow> {
  const [row] = await exec.insert(token).values(input).returning();
  return row!;
}

/**
 * Inserts a token with a freshly generated short code, retrying on a collision with another `active` token's code
 * (section 3.3). Each attempt runs in its own transaction / savepoint so a collision never aborts the caller's tx.
 */
export async function insertTokenWithShortCode(
  exec: Executor,
  input: Omit<InsertTokenInput, 'shortCode'>,
  opts: { generate?: () => string; maxAttempts?: number } = {},
): Promise<TokenRow> {
  const generate = opts.generate ?? (() => generateShortCode());
  const maxAttempts = opts.maxAttempts ?? 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const shortCode = generate();
    try {
      return await exec.transaction(async (tx) => insertToken(tx, { ...input, shortCode }));
    } catch (err) {
      if (isUniqueViolation(err, 'token_short_code_active_unique')) continue;
      throw err;
    }
  }
  throw new ShortCodeExhaustedError(maxAttempts);
}

export async function findTokenByTid(exec: Executor, tid: string): Promise<TokenRow | null> {
  const [row] = await exec.select().from(token).where(eq(token.id, tid)).limit(1);
  return row ?? null;
}

/** Resolves a 12-digit short code among `active` tokens only (section 3.5, short-code path). */
export async function findTokenByShortCode(exec: Executor, shortCode: string): Promise<TokenRow | null> {
  const [row] = await exec
    .select()
    .from(token)
    .where(and(eq(token.shortCode, shortCode), eq(token.status, 'active')))
    .limit(1);
  return row ?? null;
}

/** `active -> used` on the first `active` session transition of a one_time token. Null when not active. */
export async function markTokenUsed(exec: Executor, id: string, at: Date = new Date()): Promise<TokenRow | null> {
  const [row] = await exec
    .update(token)
    .set({ status: 'used', usedAt: at })
    .where(and(eq(token.id, id), eq(token.status, 'active')))
    .returning();
  return row ?? null;
}

/**
 * Revokes an `active` token. Idempotent: an already revoked token is returned with `changed = false` (no second
 * audit entry, section 6.7). `revokedBy` is null for `auto_denied`. Returns null when the token does not exist.
 */
export async function revokeToken(
  exec: Executor,
  id: string,
  revokedBy: string | null,
  at: Date = new Date(),
): Promise<{ token: TokenRow; changed: boolean } | null> {
  const [row] = await exec
    .update(token)
    .set({ status: 'revoked', revokedAt: at, revokedBy })
    .where(and(eq(token.id, id), eq(token.status, 'active')))
    .returning();
  if (row) return { token: row, changed: true };
  const current = await findTokenByTid(exec, id);
  return current ? { token: current, changed: false } : null;
}

/** Lazily sets `expired` on an `active` token whose expiry passed (section 3.5 step 7). */
export async function expireTokenIfDue(exec: Executor, id: string, now: Date = new Date()): Promise<TokenRow | null> {
  const [row] = await exec
    .update(token)
    .set({ status: 'expired' })
    .where(and(eq(token.id, id), eq(token.status, 'active'), lte(token.expiresAt, now)))
    .returning();
  return row ?? null;
}

/** Consecutive denials (section 7.3); returns the new count. */
export async function incrementTokenDenied(exec: Executor, id: string): Promise<number> {
  const [row] = await exec
    .update(token)
    .set({ deniedCount: sql`${token.deniedCount} + 1` })
    .where(eq(token.id, id))
    .returning({ deniedCount: token.deniedCount });
  return row?.deniedCount ?? 0;
}

export async function resetTokenDenied(exec: Executor, id: string): Promise<void> {
  await exec.update(token).set({ deniedCount: 0 }).where(eq(token.id, id));
}

export async function listActiveTokensByCreator(exec: Executor, userId: string): Promise<TokenRow[]> {
  return exec
    .select()
    .from(token)
    .where(and(eq(token.createdBy, userId), eq(token.status, 'active')));
}

export type ListTokensQuery = PageQuery & {
  /** Effective status filter (section 6.7). */
  status?: TokenStatus;
  /** `own` scope: only tokens created by this user. */
  createdBy?: string;
};

/** Tokens of an org, newest first (`created_at desc, id desc`), with the effective status. */
export async function listTokensByOrg(
  exec: Executor,
  orgId: string,
  q: ListTokensQuery = {},
): Promise<Page<TokenWithEffectiveStatus>> {
  const limit = clampLimit(q.limit);
  const conds: SQL[] = [eq(token.orgId, orgId)];
  if (q.createdBy) conds.push(eq(token.createdBy, q.createdBy));
  if (q.status) conds.push(sql`${effectiveTokenStatus} = ${q.status}`);
  const after = timeIdAfter(token.createdAt, token.id, q.cursor, 'desc');
  if (after) conds.push(after);
  const rows = await exec
    .select({ token, effectiveStatus: effectiveTokenStatus })
    .from(token)
    .where(and(...conds))
    .orderBy(...timeIdOrder(token.createdAt, token.id, 'desc'))
    .limit(limit + 1);
  const items = rows.map((r) => ({ ...r.token, effectiveStatus: r.effectiveStatus }));
  return toPage(items, limit, timeIdCursorOf);
}
