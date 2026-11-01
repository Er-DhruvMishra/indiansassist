/**
 * A tiny in-process stand-in for the credential vault of rule 9.8 (OpenBao / Vault): AppRole login plus KV v2 reads
 * on `secret/data/ia/<orgId>/<path>`, so `src/fleet/vault.ts` can be driven without a real server (the machine has
 * no Docker). It records every login and read so a test can prove secrets are fetched at dispatch only, once.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeVault = {
  readonly addr: string;
  /** `<orgId>/<path>` -> the KV v2 `data.data` map; an absent key answers 404. */
  readonly secrets: Map<string, Record<string, unknown>>;
  /** Every `<orgId>/<path>` the api asked for, in order. */
  readonly reads: string[];
  /** AppRole logins served (the client caches its token, so this stays at 1 for a run of reads). */
  readonly logins: number;
  /** The last credentials the api presented. */
  readonly login: { roleId?: unknown; secretId?: unknown } | null;
  /** When set, every request answers this status with an empty body (an unhealthy vault). */
  fail: number | null;
  close(): Promise<void>;
};

/** Starts the fake vault on an ephemeral loopback port. `secrets` keys are `<orgId>/<path>`. */
export async function startFakeVault(secrets: Record<string, Record<string, unknown>> = {}): Promise<FakeVault> {
  const state = {
    secrets: new Map(Object.entries(secrets)),
    reads: [] as string[],
    logins: 0,
    login: null as FakeVault['login'],
    fail: null as number | null,
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    if (state.fail !== null) return send(res, state.fail, { errors: ['fake vault is unhealthy'] });
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/v1/auth/approle/login') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { role_id?: unknown; secret_id?: unknown };
          state.login = { roleId: body.role_id, secretId: body.secret_id };
        } catch {
          state.login = null;
        }
        state.logins += 1;
        send(res, 200, { auth: { client_token: `fake.${state.logins}`, lease_duration: 3600 } });
      });
      return;
    }
    const m = /^\/v1\/secret\/data\/ia\/(.+)$/.exec(url);
    if (req.method === 'GET' && m) {
      if (req.headers['x-vault-token'] === undefined) return send(res, 403, { errors: ['missing client token'] });
      const key = decodeURIComponent(m[1]!);
      state.reads.push(key);
      const data = state.secrets.get(key);
      if (!data) return send(res, 404, { errors: [] });
      return send(res, 200, { data: { data, metadata: { version: 1 } } });
    }
    send(res, 404, { errors: ['no such path'] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    addr: `http://127.0.0.1:${port}`,
    secrets: state.secrets,
    reads: state.reads,
    get logins() {
      return state.logins;
    },
    get login() {
      return state.login;
    },
    get fail() {
      return state.fail;
    },
    set fail(v: number | null) {
      state.fail = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The env a `makeApp` needs to use `vault` as its credential vault. */
export function vaultEnv(vault: Pick<FakeVault, 'addr'>): Record<string, string> {
  return { VAULT_ADDR: vault.addr, VAULT_ROLE_ID: 'test-role-id', VAULT_SECRET_ID: 'test-secret-id' };
}
