/** Small `/signal` scenario helpers shared by the hardening tests. */
import { token as tokenTable } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { createToken, SignalClient, type Account, type TestApp } from './helpers.js';

export class Kit {
  readonly clients: SignalClient[] = [];
  constructor(
    readonly t: TestApp,
    readonly url: string,
  ) {}

  async open(cookie?: string): Promise<SignalClient> {
    const c = await SignalClient.open(this.url, cookie ? { cookie } : {});
    this.clients.push(c);
    return c;
  }

  async assistOnline(acc: Account): Promise<SignalClient> {
    const a = await this.open(acc.cookie);
    await a.request({ t: 'assist.hello' }, 'assist.hello.ok');
    return a;
  }

  async deskOnline(token: string, deskLabel = 'Front desk'): Promise<SignalClient> {
    const d = await this.open();
    await d.request({ t: 'desk.hello', token, deskLabel }, 'desk.hello.ok');
    return d;
  }

  /** Knock, accept and consent: an `active` session between `acc` (Assist) and a fresh Desk. */
  async activeSession(acc: Account, typ: 'one_time' | 'timed' = 'timed') {
    const { compact, token } = await createToken(this.t.app, acc, { tier: 'p1_browser', typ });
    const assist = await this.assistOnline(acc);
    const desk = await this.deskOnline(compact);
    const knock = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    const sessionId = knock.sessionId as string;
    await assist.next('assist.knock', (m) => m.sessionId === sessionId);
    await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    await desk.next('session.created');
    const ok = await desk.request({ t: 'desk.consent', state: 'granted', surface: 'monitor' }, 'consent.ok');
    expect(ok.state).toBe('active');
    return { assist, desk, sessionId, resumeKey: knock.resumeKey as string, compact, tokenId: token.id };
  }

  /** Moves a token's validity window into the past (issued 2 min ago, expired 1 min ago). */
  async expireToken(tokenId: string): Promise<void> {
    const now = Date.now();
    await this.t.db
      .update(tokenTable)
      .set({ issuedAt: new Date(now - 120_000), expiresAt: new Date(now - 60_000) })
      .where(eq(tokenTable.id, tokenId));
  }

  closeAll(): void {
    for (const c of this.clients) c.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replaces `db.transaction` for its next call only (delay, or throw instead of running). */
export function patchNextTransaction(t: TestApp, mode: { delayMs?: number; throwError?: Error }): void {
  const db = t.ctx.db as unknown as { transaction: (...args: unknown[]) => Promise<unknown> };
  const orig = db.transaction.bind(db);
  db.transaction = async (...args: unknown[]) => {
    db.transaction = orig;
    if (mode.delayMs) await sleep(mode.delayMs);
    if (mode.throwError) throw mode.throwError;
    return orig(...args);
  };
}
