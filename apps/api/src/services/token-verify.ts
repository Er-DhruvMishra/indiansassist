/**
 * Server-side token verification, contracts section 3.5, shared by `POST /tokens/public-lookup` and WS `desk.hello`.
 * Compact tokens run steps 1-8 in order (the served-region check before any database access); short codes skip
 * steps 1-5, resolve among `active` rows and report every failure as `token_not_found` (section 3.3 S2), behind the
 * per-node miss budget (S3). The resume exception of step 7 accepts a `used` token when `resumeKey` matches the
 * `resume_key_hash` of a non-ended session on it.
 */
import {
  isRegionServed,
  isTokenTimeValid,
  luhnValid,
  normaliseTokenInput,
  parseToken,
  sha256Hex,
  verifyTokenSignature,
  type Region,
} from '@indiansassist/shared';
import {
  expireTokenIfDue,
  findTokenByShortCode,
  findTokenByTid,
  getOrg,
  listOpenSessionsByToken,
  token as tokenTable,
  type OrgRow,
  type SessionRow,
  type TokenRow,
} from '@indiansassist/db';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { safeEqual } from '../lib/crypto.js';
import { unixSeconds } from '../lib/time.js';

export type TokenVerifyErrorCode =
  | 'token_malformed'
  | 'token_bad_signature'
  | 'region_mismatch'
  | 'token_gone'
  | 'token_not_found'
  | 'rate_limited';

export type TokenVerifyOk = {
  ok: true;
  token: TokenRow;
  org: OrgRow;
  via: 'compact' | 'short_code';
  /** The non-ended session whose resume key matched, when `resumeKey` was given and matched. */
  resumeSession: SessionRow | null;
};
export type TokenVerifyFail = {
  ok: false;
  code: TokenVerifyErrorCode;
  message: string;
  details?: Record<string, unknown>;
  /** A short-code miss (counts towards the S3 budget). */
  shortCodeMiss?: boolean;
};
export type TokenVerifyResult = TokenVerifyOk | TokenVerifyFail;

const NOT_FOUND: TokenVerifyFail = { ok: false, code: 'token_not_found', message: 'token not found' };

function regionMismatch(ctx: AppContext, region: Region): TokenVerifyFail {
  return {
    ok: false,
    code: 'region_mismatch',
    message: 'this token belongs to another region',
    details: { region, origin: ctx.config.regionOrigins[region] ?? null },
  };
}

async function matchResume(ctx: AppContext, tok: TokenRow, resumeKey: string | undefined): Promise<SessionRow | null> {
  if (!resumeKey) return null;
  const hash = sha256Hex(resumeKey);
  for (const s of await listOpenSessionsByToken(ctx.db, tok.id))
    if (s.resumeKeyHash && safeEqual(s.resumeKeyHash, hash)) return s;
  return null;
}

function gone(status: string): TokenVerifyFail {
  return { ok: false, code: 'token_gone', message: `token is ${status}`, details: { status } };
}

async function verifyCompact(ctx: AppContext, compact: string, resumeKey?: string): Promise<TokenVerifyResult> {
  const parsed = parseToken(compact); // steps 1-2
  if (!parsed.ok) return { ok: false, code: 'token_malformed', message: 'token is malformed' };
  if (!(await verifyTokenSignature(parsed, ctx.keys.all)))
    return { ok: false, code: 'token_bad_signature', message: 'token signature is invalid' }; // step 3
  const p = parsed.payload;
  if (!isRegionServed(p.reg, ctx.config.servedRegions)) return regionMismatch(ctx, p.reg); // step 4, no DB access
  const nowSec = unixSeconds();
  const row = await findTokenByTid(ctx.db, p.tid);
  const rowMatches =
    row !== null &&
    row.orgId === p.org &&
    row.createdBy === p.by &&
    row.tier === p.tier &&
    row.typ === p.typ &&
    row.region === p.reg &&
    safeEqual(row.nonce, p.nonce) &&
    row.kid === parsed.kid &&
    unixSeconds(row.expiresAt) === p.exp &&
    unixSeconds(row.issuedAt) === p.iat;
  if (!isTokenTimeValid(p, nowSec)) {
    // step 5; an `active` row is expired lazily
    if (rowMatches && row.status === 'active') await expireTokenIfDue(ctx.db, row.id);
    return gone('expired');
  }
  if (!rowMatches) return NOT_FOUND; // step 6
  const resumeSession = await matchResume(ctx, row, resumeKey);
  const statusOk = row.status === 'active' || (row.status === 'used' && resumeSession !== null);
  if (!statusOk) return gone(row.status); // step 7
  const org = await getOrg(ctx.db, row.orgId);
  if (!org) return NOT_FOUND;
  if (org.dataRegion !== p.reg) return regionMismatch(ctx, p.reg); // step 8
  return { ok: true, token: row, org, via: 'compact', resumeSession };
}

async function verifyShortCode(ctx: AppContext, code: string, resumeKey?: string): Promise<TokenVerifyResult> {
  const blocked = ctx.shortCodes.blockedFor();
  if (blocked > 0)
    return { ok: false, code: 'rate_limited', message: 'too many attempts', details: { retryAfterSec: blocked } };
  const miss: TokenVerifyFail = { ...NOT_FOUND, shortCodeMiss: true };
  // Every issued code carries a Luhn check digit (section 15 X12): an invalid one can never match, so it is
  // answered without touching the database, and it still counts as a miss towards the S3 budget.
  if (!luhnValid(code)) return miss;
  let row = await findTokenByShortCode(ctx.db, code);
  let resumeSession: SessionRow | null = null;
  if (!row && resumeKey) {
    // Resume exception (section 3.5): a `used` one_time token reached by code may be resumed.
    const used = await ctx.db
      .select()
      .from(tokenTable)
      .where(and(eq(tokenTable.shortCode, code), eq(tokenTable.status, 'used')));
    for (const t of used) {
      const s = await matchResume(ctx, t, resumeKey);
      if (s) {
        row = t;
        resumeSession = s;
        break;
      }
    }
  }
  if (!row) return miss;
  const nowSec = unixSeconds();
  if (!isTokenTimeValid({ iat: unixSeconds(row.issuedAt), exp: unixSeconds(row.expiresAt) }, nowSec)) {
    if (row.status === 'active') await expireTokenIfDue(ctx.db, row.id);
    return miss;
  }
  resumeSession ??= await matchResume(ctx, row, resumeKey);
  if (!(row.status === 'active' || (row.status === 'used' && resumeSession))) return miss;
  if (!isRegionServed(row.region, ctx.config.servedRegions)) return miss;
  const org = await getOrg(ctx.db, row.orgId);
  if (!org || org.dataRegion !== row.region) return miss;
  return { ok: true, token: row, org, via: 'short_code', resumeSession };
}

/** Runs section 3.5 on a compact token or a 12-digit short code (raw user input is normalised first). */
export async function verifyTokenInput(
  ctx: AppContext,
  input: string,
  opts: { resumeKey?: string } = {},
): Promise<TokenVerifyResult> {
  const norm = normaliseTokenInput(input);
  if (!norm) return { ok: false, code: 'token_malformed', message: 'not a token or 12-digit code' };
  const res =
    norm.kind === 'compact'
      ? await verifyCompact(ctx, norm.value, opts.resumeKey)
      : await verifyShortCode(ctx, norm.value, opts.resumeKey);
  if (!res.ok && res.shortCodeMiss) {
    ctx.metrics.shortCodeMisses.inc();
    ctx.shortCodes.recordMiss();
  }
  return res;
}
