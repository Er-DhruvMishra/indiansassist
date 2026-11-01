/**
 * Playbook catalogue and run log (docs/specs/phase-c-contracts.md sections 8.1-8.5). Every load is scoped by
 * `(id, org_id)` so another org's id is simply absent (the api answers `404`). `body_sha256` is computed here from
 * the UTF-8 body: callers never set it.
 */
import { sha256Hex } from '@indiansassist/shared';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { DbError, isUniqueViolation } from '../errors.js';
import { playbook, playbookRun, type PlaybookRow, type PlaybookRunRow } from '../schema/index.js';
import { clampLimit, timeIdAfter, timeIdCursorOf, timeIdOrder, toPage, type Page, type PageQuery } from './page.js';

/** `(org_id, name)` is taken (maps to `409 playbook_name_taken`). */
export class PlaybookNameTakenError extends DbError {
  constructor() {
    super('playbook_name_taken', 'a playbook with this name exists');
  }
}

export type PlaybookInput = {
  orgId: string;
  name: string;
  description: string;
  interpreter: PlaybookRow['interpreter'];
  body: string;
  requiresElevation?: boolean;
  parameters?: unknown[];
  timeoutSec?: number;
  enabled?: boolean;
  /** Phase D rule 9.8. */
  vaultRefs?: { env: string; path: string }[] | null;
  createdBy: string | null;
};

export type PlaybookPatchInput = Partial<
  Pick<PlaybookRow, 'name' | 'description' | 'interpreter' | 'body' | 'requiresElevation' | 'parameters' | 'timeoutSec' | 'enabled' | 'vaultRefs'>
>;

async function nameSafe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err, 'playbook_org_name_unique')) throw new PlaybookNameTakenError();
    throw err;
  }
}

export async function insertPlaybook(exec: Executor, input: PlaybookInput): Promise<PlaybookRow> {
  return nameSafe(async () => {
    const [row] = await exec.transaction(async (tx) =>
      tx
        .insert(playbook)
        .values({ ...input, bodySha256: sha256Hex(input.body) })
        .returning(),
    );
    return row!;
  });
}

/** The playbook `id` of org `orgId`, or null (another org's id reads as absent). */
export async function getPlaybookScoped(exec: Executor, id: string, orgId: string): Promise<PlaybookRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await exec
    .select()
    .from(playbook)
    .where(and(eq(playbook.id, id), eq(playbook.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/** Page of an org's playbooks, newest first; a cursor never leaves the org. */
export async function listPlaybooksByOrg(
  exec: Executor,
  orgId: string,
  q: PageQuery & { enabled?: boolean } = {},
): Promise<Page<PlaybookRow>> {
  const limit = clampLimit(q.limit);
  const conds = [eq(playbook.orgId, orgId)];
  if (q.enabled !== undefined) conds.push(eq(playbook.enabled, q.enabled));
  const after = timeIdAfter(playbook.createdAt, playbook.id, q.cursor, 'desc');
  if (after) conds.push(after);
  const rows = await exec
    .select()
    .from(playbook)
    .where(and(...conds))
    .orderBy(...timeIdOrder(playbook.createdAt, playbook.id, 'desc'))
    .limit(limit + 1);
  return toPage(rows, limit, timeIdCursorOf);
}

/** Applies a patch to `(id, org_id)`; a body change recomputes `body_sha256`. Null when absent. */
export async function updatePlaybook(exec: Executor, id: string, orgId: string, patch: PlaybookPatchInput): Promise<PlaybookRow | null> {
  return nameSafe(async () => {
    const set: Record<string, unknown> = { ...patch, updatedAt: new Date() };
    if (patch.body !== undefined) set['bodySha256'] = sha256Hex(patch.body);
    const rows = await exec.transaction(async (tx) =>
      tx
        .update(playbook)
        .set(set)
        .where(and(eq(playbook.id, id), eq(playbook.orgId, orgId)))
        .returning(),
    );
    return rows[0] ?? null;
  });
}

export async function deletePlaybook(exec: Executor, id: string, orgId: string): Promise<boolean> {
  const rows = await exec
    .delete(playbook)
    .where(and(eq(playbook.id, id), eq(playbook.orgId, orgId)))
    .returning({ id: playbook.id });
  return rows.length > 0;
}

/** Enabled playbooks of an org runnable by `interpreters`, newest update first (the section 8.3 manifest source). */
export async function listManifestPlaybooks(exec: Executor, orgId: string, interpreters: readonly string[], max: number): Promise<PlaybookRow[]> {
  if (interpreters.length === 0) return [];
  return exec
    .select()
    .from(playbook)
    .where(
      and(
        eq(playbook.orgId, orgId),
        eq(playbook.enabled, true),
        inArray(playbook.interpreter, interpreters as PlaybookRow['interpreter'][]),
      ),
    )
    .orderBy(desc(playbook.updatedAt), desc(playbook.id))
    .limit(max);
}

export async function countPlaybooks(exec: Executor, orgId: string): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(playbook)
    .where(eq(playbook.orgId, orgId));
  return Number(r?.n ?? 0);
}

// ---------- runs ----------

export async function insertPlaybookRun(
  exec: Executor,
  input: Pick<PlaybookRunRow, 'runId' | 'sessionId' | 'orgId' | 'playbookId' | 'bodySha256' | 'opId' | 'requestedBy'>,
): Promise<PlaybookRunRow> {
  const [row] = await exec.insert(playbookRun).values(input).returning();
  return row!;
}

export async function getPlaybookRun(exec: Executor, sessionId: string, runId: string): Promise<PlaybookRunRow | null> {
  const [row] = await exec
    .select()
    .from(playbookRun)
    .where(and(eq(playbookRun.sessionId, sessionId), eq(playbookRun.runId, runId)))
    .limit(1);
  return row ?? null;
}

/** Records the agent's outcome once (the first `playbook.run` attestation wins). */
export async function completePlaybookRun(
  exec: Executor,
  sessionId: string,
  runId: string,
  out: { exitCode: number | null; durationMs: number; ranAs: string; error: string | null },
): Promise<boolean> {
  const rows = await exec
    .update(playbookRun)
    .set({ ...out, endedAt: new Date() })
    .where(and(eq(playbookRun.sessionId, sessionId), eq(playbookRun.runId, runId), sql`${playbookRun.endedAt} is null`))
    .returning({ runId: playbookRun.runId });
  return rows.length > 0;
}

export async function countPlaybookRunsSince(exec: Executor, orgId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(playbookRun)
    .where(and(eq(playbookRun.orgId, orgId), gte(playbookRun.requestedAt, since)));
  return Number(r?.n ?? 0);
}
