/**
 * Phase D credential vault client (docs/specs/phase-d-contracts.md rule 9.8, 8.4c, W37): the api is the only vault
 * client (OpenBao / Vault AppRole over plain `fetch`, no new package), reading `secret/data/ia/<orgId>/<path>` (KV v2)
 * with a read-only policy. Secrets are read at dispatch only, sealed to one device and never logged or stored.
 */
import type { AppContext } from '../context.js';

export class VaultUnavailableError extends Error {
  readonly code = 'vault_unavailable';
  constructor(message = 'the credential vault is not configured or unreachable') {
    super(message);
  }
}

let cached: { addr: string; token: string; expiresAt: number } | null = null;

async function login(ctx: AppContext): Promise<string> {
  const v = ctx.config.vault;
  if (!v.addr) throw new VaultUnavailableError('the credential vault is not configured');
  if (cached && cached.addr === v.addr && cached.expiresAt > Date.now() + 10_000) return cached.token;
  let res: Response;
  try {
    res = await fetch(`${v.addr}/v1/auth/approle/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_id: v.roleId, secret_id: v.secretId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new VaultUnavailableError();
  }
  if (!res.ok) throw new VaultUnavailableError(`vault login failed (${res.status})`);
  const body = (await res.json()) as { auth?: { client_token?: string; lease_duration?: number } };
  const token = body.auth?.client_token;
  if (!token) throw new VaultUnavailableError('vault login returned no token');
  cached = { addr: v.addr, token, expiresAt: Date.now() + Math.max(30, body.auth?.lease_duration ?? 300) * 1000 };
  return token;
}

/** Reads one secret value of an org (`value` key, else the whole KV map as JSON); null when absent. */
export async function readVaultSecret(ctx: AppContext, orgId: string, path: string): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(path) || path.split('/').includes('..')) throw new VaultUnavailableError('bad vault path');
  const token = await login(ctx);
  let res: Response;
  try {
    res = await fetch(`${ctx.config.vault.addr}/v1/secret/data/ia/${orgId}/${path}`, { headers: { 'X-Vault-Token': token }, signal: AbortSignal.timeout(5000) });
  } catch {
    throw new VaultUnavailableError();
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new VaultUnavailableError(`vault read failed (${res.status})`);
  const body = (await res.json()) as { data?: { data?: Record<string, unknown> } };
  const data = body.data?.data;
  if (!data) return null;
  return typeof data['value'] === 'string' ? (data['value'] as string) : JSON.stringify(data);
}

export function vaultConfigured(ctx: AppContext): boolean {
  return ctx.config.vault.addr !== '';
}
