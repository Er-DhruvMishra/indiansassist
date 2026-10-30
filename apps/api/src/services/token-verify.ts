/**
 * Server-side token verification, contracts section 3.5, shared by `POST /tokens/public-lookup` and WS `desk.hello`.
 * Compact tokens run steps 1-8 in order (the served-region check before any database access); short codes skip
 * steps 1-5, resolve among `active` rows and report every failure as `token_not_found` (section 3.3 S2), behind the
 * per-node miss budget (S3). The resume exception of step 7 accepts a `used` token when `resumeKey` matches the
 * `resume_key_hash` of a non-ended session on it; Phase C adds the hand-over relaxation (`handover` hashing to the
 * session's `handover_hash`, section 7.2) and desk codes (section 2.3: 12 digits resolved through the presence store,
 * only when the caller allows them, i.e. a native `desk.hello` or an Origin-less `public-lookup`).
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
import { resolveDeskCode } from '../lib/desk-codes.js';
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
  via: 'compact' | 'short_code' | 'desk_code';
  /** The non-ended session whose resume key matched, when `resumeKey` was given and matched. */
  resumeSession: SessionRow | null;
  /** Phase C section 7.2: the non-ended session whose `handover_hash` equals sha256(handover), when given and matched. */
  handoverSession?: SessionRow | null;
};

/** Optional inputs of a verification. */
export type VerifyOpts = { resumeKey?: string; ip?: string; handover?: string; deskCode?: boolean };
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

async function matchHandover(ctx: AppContext, tok: TokenRow, handover: string | undefined): Promise<SessionRow | null> {
  if (!handover) return null;
  const hash = sha256Hex(handover);
  for (const s of await listOpenSessionsByToken(ctx.db, tok.id))
    if (s.handoverHash && safeEqual(s.handoverHash, hash)) return s;
  return null;
}

function gone(status: string): TokenVerifyFail {
  return { ok: false, code: 'token_gone', message: `token is ${status}`, details: { status } };
}

async function verifyCompact(ctx: AppContext, compact: string, opts: VerifyOpts): Promise<TokenVerifyResult> {
  const resumeKey = opts.resumeKey;
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
  const handoverSession = await matchHandover(ctx, row, opts.handover);
  const statusOk = row.status === 'active' || (row.status === 'used' && (resumeSession !== null || handoverSession !== null));
  if (!statusOk) return gone(row.status); // step 7 (with the Phase C hand-over relaxation)
  const org = await getOrg(ctx.db, row.orgId);
  if (!org) return NOT_FOUND;
  if (org.dataRegion !== p.reg) return regionMismatch(ctx, p.reg); // step 8
  return { ok: true, token: row, org, via: 'compact', resumeSession, handoverSession };
}

async function verifyShortCode(ctx: AppContext, code: string, opts: VerifyOpts): Promise<TokenVerifyResult> {
  const resumeKey = opts.resumeKey;
  const blocked = ctx.shortCodes.blockedFor();
  if (blocked > 0)
    return { ok: false, code: 'rate_limited', message: 'too many attempts', details: { retryAfterSec: blocked } };
  const miss: TokenVerifyFail = { ...NOT_FOUND, shortCodeMiss: true };
  // Every issued code carries a Luhn check digit (section 3.3, 15 X12): an invalid one can never match, so it is
  // answered without touching the database, and it still counts as a miss towards the S3 budgets.
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
  let via: 'short_code' | 'desk_code' = 'short_code';
  let resumeOnly = false;
  if (!row && opts.deskCode) {
    // Section 2.3: a desk code (native Desk / Origin-less lookup only); same miss rules as a short code.
    const dc = await resolveDeskCode(ctx, code);
    const t = dc ? await findTokenByTid(ctx.db, dc.tokenId) : null;
    if (dc && t && t.orgId === dc.orgId && t.region === dc.region) {
      row = t;
      via = 'desk_code';
      resumeOnly = dc.resumeOnly === true;
    }
  }
  if (!row) return miss;
  const nowSec = unixSeconds();
  if (!isTokenTimeValid({ iat: unixSeconds(row.issuedAt), exp: unixSeconds(row.expiresAt) }, nowSec)) {
    if (row.status === 'active') await expireTokenIfDue(ctx.db, row.id);
    return miss;
  }
  resumeSession ??= await matchResume(ctx, row, resumeKey);
  const handoverSession = await matchHandover(ctx, row, opts.handover);
  if (!(row.status === 'active' || (row.status === 'used' && (resumeSession || handoverSession)))) return miss;
  // A retired desk code (the first session reached active) only resumes or hands over (section 2.2).
  if (resumeOnly && !resumeSession && !handoverSession) return miss;
  if (!isRegionServed(row.region, ctx.config.servedRegions)) return miss;
  const org = await getOrg(ctx.db, row.orgId);
  if (!org || org.dataRegion !== row.region) return miss;
  return { ok: true, token: row, org, via, resumeSession, handoverSession };
}

/**
 * Per-IP short-code miss budget (section 3.3 S3, SEC-11): the Luhn digit leaves 9 x 10^10 issued codes, so the
 * guessing budgets are a tenth of what a full 12-digit space would allow. With 3 misses per IP and minute it also
 * takes at least 11 addresses to trip the node budget of 30.
 */
export const SHORT_CODE_IP_MISSES = { limit: 3, windowMs: 60_000 };

/** Runs section 3.5 on a compact token or a 12-digit short code (raw user input is normalised first). */
export async function verifyTokenInput(ctx: AppContext, input: string, opts: VerifyOpts = {}): Promise<TokenVerifyResult> {
  const norm = normaliseTokenInput(input);
  if (!norm) return { ok: false, code: 'token_malformed', message: 'not a token or 12-digit code' };
  const ipKey = opts.ip !== undefined ? `short-code-miss:${opts.ip}` : null;
  if (norm.kind === 'short_code' && ipKey && (await ctx.limiter.count(ipKey, SHORT_CODE_IP_MISSES.windowMs)) >= SHORT_CODE_IP_MISSES.limit)
    return { ok: false, code: 'rate_limited', message: 'too many attempts', details: { retryAfterSec: 60 } };
  const res =
    norm.kind === 'compact' ? await verifyCompact(ctx, norm.value, opts) : await verifyShortCode(ctx, norm.value, opts);
  if (!res.ok && res.shortCodeMiss) {
    ctx.metrics.shortCodeMisses.inc();
    ctx.shortCodes.recordMiss();
    if (ipKey) await ctx.limiter.hit(ipKey, Number.MAX_SAFE_INTEGER, SHORT_CODE_IP_MISSES.windowMs);
  }
  return res;
}
