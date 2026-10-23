/** Phase B test helpers: a P2-licensed admin, an extension Desk socket and an active P2 session. */
import { expect } from 'vitest';
import { call, createToken, SignalClient, type Account, type Msg, type TestApp } from './helpers.js';

export const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
export const EXT_CLIENT = { kind: 'extension', version: '0.2.0', browser: { name: 'chrome', version: '131' }, os: 'windows' };
export const OP = '0123456789abcdef';

/** Raises the account's own seat to p2_extension (signup orgs have plan tier p2_extension). */
export async function licenceP2(t: TestApp, acc: Account): Promise<void> {
  const res = await call(t.app, `/api/v1/users/${acc.user.id}/role`, {
    method: 'PATCH',
    cookie: acc.cookie,
    body: { role: acc.user.role, tier: 'p2_extension' },
  });
  if (res.statusCode !== 200) throw new Error(`seat raise failed ${res.statusCode} ${res.body}`);
}

export async function p2Token(t: TestApp, acc: Account, typ: 'one_time' | 'timed' = 'timed') {
  return createToken(t.app, acc, { tier: 'p2_extension', typ });
}

export async function patchPolicy(t: TestApp, acc: Account, body: Record<string, unknown>) {
  return call(t.app, '/api/v1/orgs/current/policy/extension', { method: 'PATCH', cookie: acc.cookie, body });
}

export class P2Kit {
  readonly clients: SignalClient[] = [];
  constructor(
    readonly t: TestApp,
    readonly url: string,
  ) {}

  async assist(acc: Account): Promise<SignalClient> {
    const a = await SignalClient.open(this.url, { cookie: acc.cookie });
    this.clients.push(a);
    await a.request({ t: 'assist.hello' }, 'assist.hello.ok');
    return a;
  }

  async extDesk(token: string, extra: Record<string, unknown> = {}): Promise<SignalClient> {
    const d = await SignalClient.open(this.url, { origin: EXT_ORIGIN });
    this.clients.push(d);
    await d.request({ t: 'desk.hello', token, client: EXT_CLIENT, ...extra }, 'desk.hello.ok');
    return d;
  }

  /** Knock and accept on a P2 token; the session waits in consent_pending. */
  async pending(acc: Account, typ: 'one_time' | 'timed' = 'timed') {
    const { compact, token } = await p2Token(this.t, acc, typ);
    const assist = await this.assist(acc);
    const desk = await this.extDesk(compact);
    const knock = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    const sessionId = knock.sessionId as string;
    await assist.next('assist.knock', (m) => m.sessionId === sessionId);
    const created = await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    const deskCreated = await desk.next('session.created');
    return { assist, desk, sessionId, compact, tokenId: token.id, resumeKey: knock.resumeKey as string, created, deskCreated };
  }

  /** An active P2 session with the given consent decision. */
  async active(acc: Account, ext = { level: 'tab_control', scope: 'current_tab', backstage: false }) {
    const p = await this.pending(acc);
    const ok = await p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'browser', extension: ext }, 'consent.ok');
    expect(ok.state).toBe('active');
    const changed: Msg = await p.assist.next('consent.changed');
    return { ...p, changed };
  }

  closeAll(): void {
    for (const c of this.clients) c.close();
  }
}

/** The audit entries of a session, as the API serves them. */
export async function sessionAudit(t: TestApp, acc: Account, sessionId: string) {
  const res = await call(t.app, `/api/v1/sessions/${sessionId}/audit`, { cookie: acc.cookie });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    items: { action: string; actor: { type: string }; reason: string | null; data: Record<string, unknown> }[];
    integrity: { ok: boolean };
    hosts: Record<string, string>;
  };
}
