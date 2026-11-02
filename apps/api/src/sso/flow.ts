/**
 * Phase E sections 3.4 O3 and 3.5 S2: the single-use flow record in presence and the per-flow browser binding
 * cookie. The record is keyed by `sha256Hex(state | relayState)` and consumed exactly once (`Presence.consume`); the
 * cookie value `b` is random, the record holds only `sha256Hex(b)`, and the callback compares in constant time.
 */
import { randomBytes } from 'node:crypto';
import { LIMITS, sha256Hex, ssoFlowRecordSchema, type SsoFlowRecord } from '@indiansassist/shared';
import type { FastifyReply } from 'fastify';
import type { Presence } from '../adapters/presence.js';
import type { Config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { SSO_PREFIX } from './urls.js';

export const FLOW_KEY_PREFIX = 'ia:sso:flow:';
export const TEST_TICKET_PREFIX = 'ia:sso:test:';

export function flowKey(handle: string): string {
  return `${FLOW_KEY_PREFIX}${sha256Hex(handle)}`;
}

/** `ia_sso_<first 16 hex of sha256Hex(handle)>`: one cookie per flow, so concurrent tabs never overwrite each other. */
export function bindingCookieName(handle: string): string {
  return `ia_sso_${sha256Hex(handle).slice(0, 16)}`;
}

/** 32 CSPRNG bytes, base64url without padding. */
export function randomHandle(): string {
  return randomBytes(32).toString('base64url');
}

export async function saveFlow(presence: Presence, handle: string, flow: SsoFlowRecord): Promise<void> {
  await presence.setKey(flowKey(handle), JSON.stringify(ssoFlowRecordSchema.parse(flow)), LIMITS.ssoFlowTtlSec);
}

/** Consumes the flow record exactly once; null when missing, expired, already consumed or malformed. */
export async function consumeFlow(presence: Presence, handle: string): Promise<SsoFlowRecord | null> {
  if (!handle || handle.length > 512) return null;
  const raw = await presence.consume(flowKey(handle));
  if (!raw) return null;
  try {
    const parsed = ssoFlowRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** True when the cookie value hashes to the record's `bindingHash` (constant-time compare). */
export function bindingMatches(flow: Pick<SsoFlowRecord, 'bindingHash'>, cookieValue: string | undefined): boolean {
  if (typeof cookieValue !== 'string' || cookieValue.length === 0 || cookieValue.length > 128) return false;
  return safeEqual(sha256Hex(cookieValue), flow.bindingHash);
}

export type BindingCookie = { name: string; value: string; sameSite: 'lax' | 'none' };

/**
 * Sets the per-flow binding cookie: HttpOnly, `Path=/api/v1/auth/sso`, `Max-Age=600`. OIDC is `SameSite=Lax`
 * (`Secure` in production); SAML is `SameSite=None; Secure` because the ACS is a cross-site POST (browsers treat
 * http://localhost as secure for this in development).
 */
export function setBindingCookie(cfg: Pick<Config, 'production'>, reply: FastifyReply, c: BindingCookie): void {
  void reply.setCookie(c.name, c.value, {
    httpOnly: true,
    path: SSO_PREFIX,
    maxAge: LIMITS.ssoFlowTtlSec,
    sameSite: c.sameSite,
    secure: c.sameSite === 'none' ? true : cfg.production,
  });
}

export function clearBindingCookie(cfg: Pick<Config, 'production'>, reply: FastifyReply, name: string, sameSite: 'lax' | 'none'): void {
  void reply.clearCookie(name, { httpOnly: true, path: SSO_PREFIX, sameSite, secure: sameSite === 'none' ? true : cfg.production });
}
