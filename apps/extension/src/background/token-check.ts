/**
 * Token resolution for every entry path (sections 2.2, 2.3): the api origin must be one of the compiled
 * `REGION_ORIGINS` exactly; a compact token is verified locally against the region's published keys (cached 24 h)
 * before any lookup; then `POST /api/v1/tokens/public-lookup`, following one `421 region_mismatch` to another
 * compiled origin. The page can only select among compiled origins, never name a server.
 */
import {
  checkToken,
  normaliseTokenInput,
  publicTokenSchema,
  wellKnownSchema,
  type JoinError,
  type PublicKeyLike,
  type PublicToken,
} from '@indiansassist/shared';
import { apiError, getJson, postJson, type FetchLike } from '../shared/api';
import { isRegionOrigin, restBaseFor } from '../shared/constants';
import { LOCAL_KEYS, readLocal, writeLocal } from '../shared/storage';

export const PUBKEY_CACHE_MS = 24 * 3600 * 1000;

export type ResolveOk = { ok: true; code: string; apiOrigin: string; token: PublicToken };
export type ResolveFail = { ok: false; error: JoinError; message: string };
export type ResolveResult = ResolveOk | ResolveFail;

export type ResolveDeps = { fetch?: FetchLike; now?: () => number };

type PubkeyCache = Record<string, { fetchedAt: number; keys: { kid: string; pub: string }[] }>;

const fail = (error: JoinError, message: string): ResolveFail => ({ ok: false, error, message });

/** The published signing keys of a region (`/.well-known/indiansassist.json`), cached per origin for 24 h. */
export async function regionKeys(apiOrigin: string, deps: ResolveDeps = {}): Promise<PublicKeyLike[] | null> {
  const now = (deps.now ?? Date.now)();
  const cache = (await readLocal<PubkeyCache>(LOCAL_KEYS.pubkeys)) ?? {};
  const hit = cache[apiOrigin];
  if (hit && now - hit.fetchedAt < PUBKEY_CACHE_MS && hit.keys.length > 0) return hit.keys;
  let res;
  try {
    res = await getJson(`${restBaseFor(apiOrigin)}/.well-known/indiansassist.json`, deps.fetch);
  } catch {
    return hit?.keys ?? null;
  }
  const parsed = wellKnownSchema.safeParse(res.body);
  if (!res.ok || !parsed.success) return hit?.keys ?? null;
  const keys = parsed.data.keys.map((k) => ({ kid: k.kid, pub: k.pub }));
  await writeLocal(LOCAL_KEYS.pubkeys, { ...cache, [apiOrigin]: { fetchedAt: now, keys } });
  return keys;
}

async function lookup(apiOrigin: string, code: string, deps: ResolveDeps, followed: boolean): Promise<ResolveResult> {
  let res;
  try {
    res = await postJson(`${restBaseFor(apiOrigin)}/api/v1/tokens/public-lookup`, { code }, deps.fetch);
  } catch {
    return fail('bad_code', 'Could not reach IndiansAssist. Check your connection and try again.');
  }
  if (res.status === 421) {
    const { details } = apiError(res.body);
    const other = typeof details?.origin === 'string' ? details.origin.replace(/\/+$/, '') : null;
    if (!followed && other && isRegionOrigin(other) && other !== apiOrigin) return lookup(other, code, deps, true);
    return fail('origin', 'This code belongs to a region this extension does not serve.');
  }
  if (!res.ok) return fail('bad_code', 'This code is not valid or has expired.');
  const parsed = publicTokenSchema.safeParse(res.body);
  if (!parsed.success) return fail('bad_code', 'Unexpected answer from the server.');
  if (parsed.data.tier !== 'p2_extension') return fail('unsupported_tier', 'This code is for a different IndiansAssist package.');
  return { ok: true, code, apiOrigin, token: parsed.data };
}

/** Normalises, verifies locally (compact tokens) and looks up a code on `apiOrigin`. */
export async function resolveJoinCode(raw: string, apiOrigin: string, deps: ResolveDeps = {}): Promise<ResolveResult> {
  if (!isRegionOrigin(apiOrigin)) return fail('origin', 'This IndiansAssist site is not one this extension serves.');
  const n = normaliseTokenInput(raw);
  if (!n) return fail('bad_code', 'That is not an IndiansAssist code.');
  if (n.kind === 'compact') {
    const keys = await regionKeys(apiOrigin, deps);
    if (!keys) return fail('bad_code', 'Could not verify the code. Check your connection and try again.');
    const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
    const check = await checkToken(n.value, keys, nowSec);
    if (!check.ok) return fail('bad_code', check.error === 'token_gone' ? 'This code has expired.' : 'This code is not valid.');
  }
  return lookup(apiOrigin, n.value, deps, false);
}
