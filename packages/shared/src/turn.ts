/**
 * TURN REST credentials (coturn `use-auth-secret`, contracts section 6.11) via HMAC-SHA1 from @noble/hashes,
 * and the pure ICE server builder used for GET /ice, `session.created`, `consent.ok` and `ice.refresh`.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha1 } from '@noble/hashes/legacy';
import { base64Encode, utf8Encode } from './encoding.js';

export type IceServer = { urls: string[]; username?: string; credential?: string };
export type IceConfig = { iceServers: IceServer[]; iceTtl: number; iceExpiresAt: string };

/** `user:<userId>` for the Assist, `desk:<sessionId>` for the Desk. */
/** `recorder:<recorderId>` is the Phase A.2 service principal (docs/specs/phase-a2-recorder.md section 10). */
export type TurnPrincipal = `user:${string}` | `desk:${string}` | `recorder:${string}`;

/** `base64(HMAC-SHA1(key = secret, message = username))`. */
export function turnCredential(secret: string, username: string): string {
  return base64Encode(hmac(sha1, utf8Encode(secret), utf8Encode(username)));
}

/** `username = "<expiry>:<principal>"` with expiry = unix seconds now + ttl. */
export function turnRestCredentials(opts: {
  secret: string;
  principal: TurnPrincipal;
  ttlSeconds: number;
  nowMs?: number;
}): { username: string; credential: string; expiresAtSec: number } {
  if (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds <= 0)
    throw new Error('ttlSeconds must be a positive integer');
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const expiresAtSec = nowSec + opts.ttlSeconds;
  const username = `${expiresAtSec}:${opts.principal}`;
  return { username, credential: turnCredential(opts.secret, username), expiresAtSec };
}

/** Splits an env comma list, dropping blanks. */
export function splitUrlList(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Builds the ICE configuration: a STUN entry from `stunUrls`, a TURN entry with REST credentials from
 * `turnUrls`; each entry is omitted when its list is empty (both empty => `iceServers: []`).
 */
export function buildIceConfig(opts: {
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  secret: string;
  principal: TurnPrincipal;
  ttlSeconds: number;
  nowMs?: number;
}): IceConfig {
  const nowMs = opts.nowMs ?? Date.now();
  const iceServers: IceServer[] = [];
  if (opts.stunUrls.length > 0) iceServers.push({ urls: [...opts.stunUrls] });
  const creds = turnRestCredentials({
    secret: opts.secret,
    principal: opts.principal,
    ttlSeconds: opts.ttlSeconds,
    nowMs,
  });
  if (opts.turnUrls.length > 0)
    iceServers.push({ urls: [...opts.turnUrls], username: creds.username, credential: creds.credential });
  return {
    iceServers,
    iceTtl: opts.ttlSeconds,
    iceExpiresAt: new Date(creds.expiresAtSec * 1000).toISOString(),
  };
}

/** Delay before the server should send `ice.refresh` (80 % of iceTtl), in milliseconds. */
export function iceRefreshDelayMs(iceTtlSeconds: number): number {
  return Math.floor(iceTtlSeconds * 0.8 * 1000);
}
