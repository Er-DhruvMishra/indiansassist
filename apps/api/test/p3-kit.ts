/** Phase C test helpers: a P3-licensed admin, a native (Origin-less) Desk socket and an active P3 session. */
import { expect } from 'vitest';
import { call, createToken, makeApp, signup, SignalClient, type Account, type Msg, type TestApp } from './helpers.js';

export const AGENT_UA = 'IndiansAssist-Agent/0.3.0 (Windows 10.0.26100; x64)';
export const OP = '0123456789abcdef';
export const NATIVE = {
  kind: 'native',
  version: '0.3.0',
  os: 'windows',
  platform: { osVersion: '10.0.26100', arch: 'x64' },
  tokenSource: 'manual',
  capabilities: {
    monitors: 2,
    elevation: 'user',
    features: ['screen', 'multi_monitor', 'input', 'input_text', 'clipboard', 'files', 'chat', 'voice', 'elevation', 'playbooks'],
    encoders: ['vp8', 'vp9'],
    hwEncoder: false,
    interpreters: ['powershell', 'cmd'],
  },
} as const;
export const ADMIN_CLIENT = { ...NATIVE, capabilities: { ...NATIVE.capabilities, elevation: 'admin' } };
/** A native Desk that answers the server recorder's offer (`features` has `recorder`, section 9 R2 amendment). */
export const RECORDER_NATIVE = {
  ...NATIVE,
  capabilities: { ...NATIVE.capabilities, features: [...NATIVE.capabilities.features, 'recorder'] },
};
export const RECORDER_ADMIN_CLIENT = { ...RECORDER_NATIVE, capabilities: { ...RECORDER_NATIVE.capabilities, elevation: 'admin' } };

/** An app whose signups get a P3 plan. */
export function makeP3App(env: Record<string, string> = {}, timing: Parameters<typeof makeApp>[1] = {}): Promise<TestApp> {
  return makeApp({ SIGNUP_PLAN_TIER: 'p3_portable', ...env }, timing);
}

/** Signs up an org and raises the admin's seat to p3_portable. */
export async function p3Admin(t: TestApp): Promise<Account> {
  const acc = await signup(t.app);
  await licenceP3(t, acc);
  return acc;
}

export async function licenceP3(t: TestApp, acc: Account, by: Account = acc): Promise<void> {
  const res = await call(t.app, `/api/v1/users/${acc.user.id}/role`, {
    method: 'PATCH',
    cookie: by.cookie,
    body: { role: acc.user.role, tier: 'p3_portable' },
  });
  if (res.statusCode !== 200) throw new Error(`seat raise failed ${res.statusCode} ${res.body}`);
}

export async function p3Token(t: TestApp, acc: Account, typ: 'one_time' | 'timed' = 'one_time') {
  return createToken(t.app, acc, typ === 'timed' ? { tier: 'p3_portable', typ, ttlMinutes: 30 } : { tier: 'p3_portable', typ });
}

export class P3Kit {
  readonly clients: SignalClient[] = [];
  constructor(
    readonly t: TestApp,
    readonly url: string,
    /** The `desk.hello.client` of `nativeDesk` (and so of `pending` / `active`). */
    readonly client: Record<string, unknown> = NATIVE,
  ) {}

  async assist(acc: Account): Promise<SignalClient> {
    const a = await SignalClient.open(this.url, { cookie: acc.cookie });
    this.clients.push(a);
    await a.request({ t: 'assist.hello' }, 'assist.hello.ok');
    return a;
  }

  /** An Origin-less socket with the agent's User-Agent (section 3.1). */
  async socket(): Promise<SignalClient> {
    const d = await SignalClient.open(this.url, { origin: null, headers: { 'user-agent': AGENT_UA } });
    this.clients.push(d);
    return d;
  }

  async nativeDesk(token: string, extra: Record<string, unknown> = {}): Promise<SignalClient> {
    const d = await this.socket();
    await d.request({ t: 'desk.hello', token, client: this.client, ...extra }, 'desk.hello.ok');
    return d;
  }

  /** Knock and accept on a P3 token; the session waits in consent_pending. */
  async pending(acc: Account, typ: 'one_time' | 'timed' = 'one_time') {
    const { compact, token } = await p3Token(this.t, acc, typ);
    const assist = await this.assist(acc);
    const desk = await this.nativeDesk(compact);
    const knock = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    const sessionId = knock.sessionId as string;
    await assist.next('assist.knock', (m) => m.sessionId === sessionId);
    const created = await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    const deskCreated = await desk.next('session.created');
    return { assist, desk, sessionId, compact, tokenId: token.id, resumeKey: knock.resumeKey as string, created, deskCreated };
  }

  /** An active P3 session with the given native consent. */
  async active(acc: Account, native: Record<string, unknown> = { level: 'control', monitors: [1, 2], clipboard: false }, typ: 'one_time' | 'timed' = 'one_time') {
    const p = await this.pending(acc, typ);
    const ok = await p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'monitor', native }, 'consent.ok');
    expect(ok.state).toBe('active');
    const changed: Msg = await p.assist.next('consent.changed');
    return { ...p, changed };
  }

  closeAll(): void {
    for (const c of this.clients) c.close();
  }
}

/** The audit entries of a session, as the API serves them. */
export async function audit(t: TestApp, acc: Account, sessionId: string) {
  const res = await call(t.app, `/api/v1/sessions/${sessionId}/audit`, { cookie: acc.cookie });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    items: { action: string; actor: { type: string }; reason: string | null; data: Record<string, unknown> }[];
    integrity: { ok: boolean };
  };
}
