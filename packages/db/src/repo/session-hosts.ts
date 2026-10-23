/**
 * session_host repository (docs/specs/phase-b-contracts.md sections 3.6, 11.1): the plaintext host behind a chain
 * `hostHash`, written once per (session, hostHash) by the api when it maps a wire `host`, read by the session audit
 * view and deletable for erasure.
 */
import { asc, eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { sessionHost, type SessionHostRow } from '../schema/index.js';

export type UpsertSessionHostInput = { sessionId: string; orgId: string; hostHash: string; host: string };

/** Inserts the row unless (session, hostHash) exists; idempotent. */
export async function upsertSessionHost(exec: Executor, input: UpsertSessionHostInput): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(input.hostHash)) throw new Error('hostHash must be 64 lower-case hex chars');
  if (input.host.length === 0 || input.host.length > 253) throw new Error('host must be 1..253 chars');
  await exec.insert(sessionHost).values(input).onConflictDoNothing({ target: [sessionHost.sessionId, sessionHost.hostHash] });
}

export async function listSessionHosts(exec: Executor, sessionId: string): Promise<SessionHostRow[]> {
  return exec.select().from(sessionHost).where(eq(sessionHost.sessionId, sessionId)).orderBy(asc(sessionHost.firstSeenAt));
}

/** `hostHash -> host` for the audit response side map. */
export async function sessionHostMap(exec: Executor, sessionId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await listSessionHosts(exec, sessionId)) out[r.hostHash] = r.host;
  return out;
}

/** Erasure: removes every plaintext host of a session (the chain keeps only the peppered hashes). */
export async function deleteSessionHosts(exec: Executor, sessionId: string): Promise<number> {
  const rows = await exec.delete(sessionHost).where(eq(sessionHost.sessionId, sessionId)).returning({ id: sessionHost.id });
  return rows.length;
}
