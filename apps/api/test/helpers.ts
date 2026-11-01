/** Test harness: buildApp on in-memory PGlite, cookie-aware inject helpers and a small `/signal` client. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, createDb, migrate, type Db } from '@indiansassist/db';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { inject } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext, Timing } from '../src/context.js';
import { createMetrics } from '../src/lib/metrics.js';

export const WEB_ORIGIN = 'http://localhost:5173';
export const TURN_SECRET = 'test-turn-secret-0123456789abcdef0123456789';

export type TestApp = {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  storageDir: string;
  close: () => Promise<void>;
};

let template: Blob | null | undefined;

/**
 * A fresh in-memory PGlite with every migration applied, started from the run's migrated template
 * (test/global-setup.ts) when there is one. `migrate` still runs: on the template it only confirms the journal.
 */
export async function makeDb(): Promise<Db> {
  if (template === undefined) {
    const file = inject('pgliteTemplate');
    template = file ? new Blob([readFileSync(file)]) : null;
  }
  const db = await createDb({ databaseUrl: 'memory://', ...(template ? { pgliteLoadDataDir: template } : {}) });
  await migrate(db);
  return db;
}

export async function makeApp(env: Record<string, string> = {}, timing: Partial<Timing> = {}): Promise<TestApp> {
  const storageDir = mkdtempSync(join(tmpdir(), 'ia-api-test-'));
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_DISABLED: 'true',
      NODE_ID: 'test-node',
      WEB_ORIGIN,
      API_ORIGIN: 'http://localhost:4000',
      STORAGE_FS_DIR: storageDir,
      TURN_SECRET,
      STUN_URLS: 'stun:turn.example.test:3478',
      TURN_URLS: 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349',
      ICE_OWN_HOST_SUFFIXES: 'example.test',
      AGENT_DEV_STUB: '',
      AGENT_DIST_DIR: join(storageDir, 'agent-dist'),
      AGENT_MSI_DIST_DIR: join(storageDir, 'agent-msi'),
      ...env,
    },
    { persistSecrets: false },
  );
  const db = await makeDb();
  const { app, ctx } = await buildApp({ config, db, logLevel: 'silent', metrics: createMetrics({ defaults: false }), timing });
  trackServerErrors(app);
  await app.ready();
  return {
    app,
    ctx,
    db,
    storageDir,
    close: async () => {
      await app.close();
      await closeDb(db);
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

const serverErrors = new WeakMap<FastifyInstance, string[]>();

function describeError(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { code?: unknown; cause?: unknown };
  const own = `${e.name}${e.code !== undefined ? ` [${String(e.code)}]` : ''}: ${e.message}`;
  return e.cause !== undefined && depth < 3 ? `${own} <- ${describeError(e.cause, depth + 1)}` : own;
}

/**
 * Records the server-side cause of every 5xx (the app logger is silent in tests) so a helper that sees an
 * unexpected status can say why; IA_TEST_DEBUG=1 also prints each one with its stack. Call before `ready()`.
 */
export function trackServerErrors(app: FastifyInstance): void {
  const list: string[] = [];
  serverErrors.set(app, list);
  app.addHook('onError', async (req, _reply, err) => {
    const line = `${req.method} ${req.url.split('?')[0]}: ${describeError(err)}`;
    list.push(line);
    if (list.length > 20) list.shift();
    if (process.env['IA_TEST_DEBUG']) console.error(`[IA_TEST_DEBUG] ${line}\n${err.stack ?? ''}`);
  });
}

/** The most recent server-side error recorded by trackServerErrors, for failure messages. */
export function lastServerError(app: FastifyInstance): string {
  const list = serverErrors.get(app);
  return list && list.length > 0 ? ` (server: ${list[list.length - 1]})` : '';
}

export type Call = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  cookie?: string | undefined;
  body?: unknown;
  headers?: Record<string, string>;
  csrf?: boolean;
};

export async function call(app: FastifyInstance, url: string, c: Call = {}): Promise<LightMyRequestResponse> {
  const method = c.method ?? (c.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  if (c.csrf !== false && method !== 'GET') headers['x-requested-with'] = 'IndiansAssist';
  if (c.cookie) headers['cookie'] = c.cookie;
  const opts: InjectOptions = { method, url, headers };
  if (c.body !== undefined) {
    if (Buffer.isBuffer(c.body)) opts.payload = c.body;
    else {
      headers['content-type'] ??= 'application/json';
      opts.payload = JSON.stringify(c.body);
    }
  }
  return app.inject(opts);
}

/** `ia_session=<signed value>` exactly as the server set it. */
export function cookieOf(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find((x) => x.startsWith('ia_session='));
  if (!c) throw new Error(`no session cookie (status ${res.statusCode}: ${res.body})`);
  return c.split(';')[0]!;
}

let counter = 0;
export function uniq(prefix = 'u'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export const PASSWORD = 'correct horse battery';

export type Account = { cookie: string; user: { id: string; name: string; role: string }; org: { id: string; slug: string } };

export async function signup(app: FastifyInstance, over: Record<string, unknown> = {}): Promise<Account> {
  const id = uniq('org');
  const res = await call(app, '/api/v1/auth/signup', {
    body: { orgName: `Org ${id}`, name: 'Priya S', email: `${id}@example.test`, password: PASSWORD, ...over },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed ${res.statusCode} ${res.body}${lastServerError(app)}`);
  const body = res.json() as { user: Account['user']; org: Account['org'] };
  return { cookie: cookieOf(res), user: body.user, org: body.org };
}

/** Invites a user with `role` into the admin's org and accepts the invite; returns their session. */
export async function addMember(app: FastifyInstance, admin: Account, role: string, name = `User ${uniq()}`): Promise<Account> {
  const email = `${uniq(role)}@example.test`;
  const inv = await call(app, '/api/v1/users/invite', { cookie: admin.cookie, body: { email, name, role } });
  if (inv.statusCode !== 201) throw new Error(`invite failed ${inv.statusCode} ${inv.body}${lastServerError(app)}`);
  const secret = (inv.json() as { inviteUrl: string }).inviteUrl.split('#i=')[1]!;
  const acc = await call(app, '/api/v1/auth/accept-invite', { body: { invite: secret, name, password: PASSWORD } });
  if (acc.statusCode !== 200) throw new Error(`accept failed ${acc.statusCode} ${acc.body}${lastServerError(app)}`);
  const body = acc.json() as { user: Account['user']; org: Account['org'] };
  return { cookie: cookieOf(acc), user: body.user, org: body.org };
}

export async function createToken(
  app: FastifyInstance,
  acc: Account,
  body: Record<string, unknown> = { tier: 'p1_browser', typ: 'one_time' },
): Promise<{ token: { id: string; shortCode: string; status: string }; compact: string; joinUrl: string }> {
  const res = await call(app, '/api/v1/tokens', { cookie: acc.cookie, body });
  if (res.statusCode !== 201) throw new Error(`token create failed ${res.statusCode} ${res.body}${lastServerError(app)}`);
  return res.json();
}

// ---------- WebSocket client ----------

export type Msg = Record<string, unknown> & { t: string };

export class SignalClient {
  readonly messages: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  closeCode: number | null = null;
  private closedWaiters: ((code: number) => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Msg;
      if (m.t === 'ping') {
        this.send({ t: 'pong' });
        return;
      }
      const idx = this.waiters.findIndex((w) => w.pred(m));
      if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(m);
      else this.messages.push(m);
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      for (const w of this.closedWaiters) w(code);
    });
  }

  /** `origin: null` opens an Origin-less socket (a native agent, Phase C section 3.1). */
  static async open(
    url: string,
    opts: { cookie?: string; origin?: string | null; headers?: Record<string, string> } = {},
  ): Promise<SignalClient> {
    const headers: Record<string, string> = { ...(opts.origin === null ? {} : { origin: opts.origin ?? WEB_ORIGIN }), ...(opts.headers ?? {}) };
    if (opts.cookie) headers['cookie'] = opts.cookie;
    const ws = new WebSocket(url, { headers });
    const client = new SignalClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused ${res.statusCode}`)));
    });
    return client;
  }

  send(m: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Next message of type `t` (optionally matching `pred`), from the backlog or the wire. */
  next(t: string, pred: (m: Msg) => boolean = () => true, timeoutMs = 5000): Promise<Msg> {
    const match = (m: Msg) => m.t === t && pred(m);
    const idx = this.messages.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.messages.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`timeout waiting for ${t}; backlog: ${JSON.stringify(this.messages.map((x) => x.t))}`));
      }, timeoutMs);
      const done = (m: Msg) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push({ pred: match, resolve: done });
    });
  }

  /** Sends and waits for the reply carrying `re`. */
  async request(m: Record<string, unknown>, replyType: string): Promise<Msg> {
    const id = uniq('c');
    const p = this.next(replyType, (x) => x.re === id);
    this.send({ ...m, id });
    return p;
  }

  /** True when no message of type `t` arrives within `ms`. */
  async quiet(t: string, ms = 300): Promise<boolean> {
    await new Promise((r) => setTimeout(r, ms));
    return !this.messages.some((m) => m.t === t);
  }

  closed(timeoutMs = 5000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.closedWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `ws://127.0.0.1:${addr.port}/signal`;
}
