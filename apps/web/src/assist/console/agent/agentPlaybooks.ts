/**
 * Playbook runs in the P3 console (docs/specs/phase-c-contracts.md sections 8.2-8.5): the REST `202` is the body
 * release point, the encrypted `playbook.run` op is built verbatim from it with `ctl.req.id = runId`, and the live
 * output arrives as `pb.output` / `pb.end` on `ia.playbook`. Pure reducers plus the error texts.
 */
import type { PbEnd, PbOutput, Playbook, PlaybookManifest } from '@indiansassist/shared';
import { isApiError } from '../../../lib/api';
import type { PlaybookRun } from './agentState';

/** Output kept per stream in the UI (the agent caps a run at 1 MiB). */
export const RUN_OUTPUT_MAX_CHARS = 262_144;

export const PLAYBOOK_CHANGED_TEXT = 'This playbook was edited during the session; it cannot run until the session is restarted.';

export function runErrorText(e: unknown): string {
  if (isApiError(e, 'playbook_changed')) return PLAYBOOK_CHANGED_TEXT;
  if (isApiError(e, 'playbook_disabled')) return 'This playbook is disabled.';
  if (isApiError(e, 'elevation_required')) return 'Request elevation first: this playbook needs administrator rights.';
  if (isApiError(e, 'bad_state')) return 'The session is not active.';
  if (isApiError(e, 'validation_failed')) return `Check the parameters: ${(e as Error).message}`;
  if (isApiError(e, 'not_found')) return 'This playbook no longer exists.';
  return e instanceof Error ? e.message : String(e);
}

export function addRun(runs: readonly PlaybookRun[], run: PlaybookRun): PlaybookRun[] {
  return [run, ...runs.filter((r) => r.runId !== run.runId)].slice(0, 20);
}

export function applyOutput(runs: readonly PlaybookRun[], m: PbOutput): PlaybookRun[] {
  return runs.map((r) => {
    if (r.runId !== m.runId || r.end) return r;
    const key = m.stream === 'stdout' ? 'stdout' : 'stderr';
    const next = (r[key] + m.chunk).slice(-RUN_OUTPUT_MAX_CHARS);
    return { ...r, [key]: next };
  });
}

export function applyEnd(runs: readonly PlaybookRun[], m: PbEnd): PlaybookRun[] {
  return runs.map((r) => (r.runId === m.runId ? { ...r, end: m } : r));
}

export function applyOpError(runs: readonly PlaybookRun[], runId: string, code: string): PlaybookRun[] {
  return runs.map((r) => (r.runId === runId ? { ...r, opError: code } : r));
}

/** A REST `Playbook` as a manifest entry (the list used when `session.created.agent.truncated`). */
export function toManifest(p: Playbook): PlaybookManifest {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    interpreter: p.interpreter,
    requiresElevation: p.requiresElevation,
    parameters: p.parameters,
    timeoutSec: p.timeoutSec,
    bodyHash: p.bodyHash,
  };
}

/** Merges the delivered manifest with REST entries (the delivered pinned hash wins on duplicates). */
export function mergeManifest(delivered: readonly PlaybookManifest[], rest: readonly Playbook[]): PlaybookManifest[] {
  const seen = new Set(delivered.map((p) => p.id));
  return [...delivered, ...rest.filter((p) => p.enabled && !seen.has(p.id)).map(toManifest)];
}
