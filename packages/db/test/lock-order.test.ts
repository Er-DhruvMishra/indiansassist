/**
 * correctness-F1: one lock order for every transaction (contracts section 4.2): the session row, then token rows, then
 * the org advisory lock. `insertAuditEntry` must row-lock the session BEFORE `pg_advisory_xact_lock`, and session
 * transitions interleaved with audit appends on the same session must all commit (no 40P01) with an intact chain.
 * PGlite serialises transactions, so the interleaving case only proves the cycle is gone when TEST_DATABASE_URL points
 * at a real Postgres; the SQL-order case runs everywhere.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  createOrgWithAdmin,
  getSession,
  insertAuditEntry,
  listAuditBySession,
  migrate,
  seedSession,
  seedToken,
  transitionSession,
  updateSession,
  verifyOrgChain,
  type Db,
  type Executor,
  type SeededOrg,
} from '../src/index.js';
import { freshDb } from './helpers.js';

const pgUrl = process.env['TEST_DATABASE_URL'] ?? '';
const dialect = new PgDialect();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const system = { type: 'system' as const, id: null, label: 'system' };

/** Wraps an executor so every `execute()` inside its transactions is recorded (rendered SQL text). */
function recording(exec: Executor, log: string[]): Executor {
  const wrap = (target: Executor): Executor =>
    new Proxy(target, {
      get(t, key) {
        if (key === 'execute')
          return (q: SQL) => {
            log.push(dialect.sqlToQuery(q).sql);
            return (t as unknown as { execute: (q: SQL) => unknown }).execute(q);
          };
        if (key === 'transaction')
          return (fn: (tx: Executor) => Promise<unknown>) =>
            (t as unknown as { transaction: (f: (tx: Executor) => Promise<unknown>) => Promise<unknown> }).transaction(
              (tx) => fn(wrap(tx)),
            );
        const v: unknown = Reflect.get(t, key);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  return wrap(exec);
}

for (const driver of ['pglite', 'pg'] as const) {
  describe.skipIf(driver === 'pg' && pgUrl === '')(`lock order (${driver})`, () => {
    let db: Db;
    let s: SeededOrg;
    beforeAll(async () => {
      if (driver === 'pg') {
        db = await createDb({ databaseUrl: pgUrl });
        await migrate(db, { appRole: null });
      } else {
        db = await freshDb();
      }
      s = await createOrgWithAdmin(db);
    });
    afterAll(async () => {
      await closeDb(db);
    });

    it('insertAuditEntry row-locks the session before taking the org advisory lock', async () => {
      const tok = await seedToken(db, s.org, s.user, { typ: 'timed' });
      const sess = await seedSession(db, tok);
      const log: string[] = [];
      await insertAuditEntry(recording(db, log), {
        orgId: s.org.id,
        region: s.org.dataRegion,
        sessionId: sess.id,
        actor: system,
        action: 'session.path_changed',
        data: { from: 'unknown', to: 'p2p' },
      });
      const rowLock = log.findIndex((q) => /for update/i.test(q) && /"session"/.test(q));
      const advisory = log.findIndex((q) => /pg_advisory_xact_lock/.test(q));
      expect(rowLock).toBeGreaterThanOrEqual(0);
      expect(advisory).toBeGreaterThan(rowLock);
    });

    it('interleaved session updates and audit appends on one session all commit and keep the chain intact', async () => {
      const tok = await seedToken(db, s.org, s.user, { typ: 'timed' });
      const sess = await seedSession(db, tok);
      const append = (exec: Executor, to: 'p2p' | 'relay') =>
        insertAuditEntry(exec, {
          orgId: s.org.id,
          region: s.org.dataRegion,
          sessionId: sess.id,
          actor: system,
          action: 'session.path_changed',
          data: { from: 'unknown', to },
        });
      const rounds = 8;
      const work: Promise<unknown>[] = [];
      for (let i = 0; i < rounds; i++) {
        // Shape of endSessionFlow / assist.accept: update the session row first, then append (row -> advisory).
        work.push(
          db.transaction(async (tx) => {
            await updateSession(tx, sess.id, { path: i % 2 ? 'p2p' : 'relay' });
            await sleep(5);
            await append(tx, 'p2p');
          }),
        );
        // Shape of desk.event / POST /sessions/:id/events / signal.forbidden: append only (it takes the row lock itself).
        work.push(append(db, 'relay'));
        // An org-level append without a session (auth.login and friends) contends only on the advisory lock.
        work.push(
          insertAuditEntry(db, {
            orgId: s.org.id,
            region: s.org.dataRegion,
            actor: system,
            action: 'auth.login_failed',
            data: { userId: s.user.id },
          }),
        );
      }
      await Promise.all(work);
      const ended = await db.transaction(async (tx) => {
        const r = await transitionSession(tx, sess.id, 'ended', { set: { endReason: 'assist_ended' } });
        await append(tx, 'relay');
        return r;
      });
      expect(ended.state).toBe('ended');
      const entries = await listAuditBySession(db, sess.id);
      expect(entries).toHaveLength(rounds * 2 + 1);
      expect((await getSession(db, sess.id))?.hashChainTail).toBe(entries[entries.length - 1]!.hash);
      expect(await verifyOrgChain(db, s.org.id)).toMatchObject({ ok: true });
    });
  });
}
