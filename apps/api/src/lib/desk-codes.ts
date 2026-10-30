/**
 * Desk codes (docs/specs/phase-c-contracts.md sections 2.2, 2.3): the 12 digits in the served filename, minted per
 * download, stored `ia:dc:<sha256Hex(deskCode)>` = `{ tokenId, orgId, region }` in the presence store (TTL = the
 * token's remaining life, cap 8 h). They are accepted only by a native `desk.hello` and an Origin-less
 * `public-lookup`. When the first session on the token reaches `active` every desk code of the token stops opening
 * new joins: the entry is rewritten `resumeOnly` so the agent that joined with it can still resume or hand over
 * with its resume key / hand-over value (a deviation note in the report: the contract says "deleted").
 */
import { makeDeskCode, sha256Hex, type Region } from '@indiansassist/shared';
import type { TokenRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';

export type DeskCodeEntry = { tokenId: string; orgId: string; region: Region; resumeOnly?: true };

const MAX_TTL_SEC = 8 * 60 * 60;
const key = (hash: string) => `ia:dc:${hash}`;
const indexKey = (tokenId: string) => `ia:dct:${tokenId}`;

function ttlOf(tok: Pick<TokenRow, 'expiresAt'>): number {
  return Math.max(1, Math.min(MAX_TTL_SEC, Math.ceil((tok.expiresAt.getTime() - Date.now()) / 1000)));
}

/** Mints a desk code for `tok` (never its short code) and indexes it under the token. */
export async function mintDeskCode(ctx: Pick<AppContext, 'presence'>, tok: TokenRow): Promise<string> {
  const code = makeDeskCode(tok.shortCode);
  const hash = sha256Hex(code);
  const ttl = ttlOf(tok);
  const entry: DeskCodeEntry = { tokenId: tok.id, orgId: tok.orgId, region: tok.region };
  await ctx.presence.setKey(key(hash), JSON.stringify(entry), ttl);
  const list = parseList(await ctx.presence.getKey(indexKey(tok.id)));
  list.push(hash);
  await ctx.presence.setKey(indexKey(tok.id), JSON.stringify(list.slice(-50)), ttl);
  return code;
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)) : [];
  } catch {
    return [];
  }
}

/** The entry behind a 12-digit desk code, or null. */
export async function resolveDeskCode(ctx: Pick<AppContext, 'presence'>, code: string): Promise<DeskCodeEntry | null> {
  if (!/^\d{12}$/.test(code)) return null;
  const raw = await ctx.presence.getKey(key(sha256Hex(code)));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DeskCodeEntry>;
    if (typeof v.tokenId !== 'string' || typeof v.orgId !== 'string' || typeof v.region !== 'string') return null;
    return { tokenId: v.tokenId, orgId: v.orgId, region: v.region as Region, ...(v.resumeOnly ? { resumeOnly: true as const } : {}) };
  } catch {
    return null;
  }
}

/** First `active` on the token: its desk codes no longer open new joins (resume / hand-over only). */
export async function retireDeskCodes(ctx: Pick<AppContext, 'presence'>, tok: Pick<TokenRow, 'id' | 'expiresAt'>): Promise<void> {
  const hashes = parseList(await ctx.presence.getKey(indexKey(tok.id)));
  const ttl = ttlOf(tok);
  for (const h of hashes) {
    const raw = await ctx.presence.getKey(key(h));
    if (!raw) continue;
    try {
      const v = JSON.parse(raw) as DeskCodeEntry;
      if (v.resumeOnly) continue;
      await ctx.presence.setKey(key(h), JSON.stringify({ ...v, resumeOnly: true }), ttl);
    } catch {
      await ctx.presence.delKey(key(h));
    }
  }
}
