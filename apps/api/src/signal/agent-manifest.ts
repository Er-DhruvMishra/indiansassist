/**
 * The playbook manifest of a P3 session (docs/specs/phase-c-contracts.md section 8.3): the org's enabled playbooks
 * the Desk's interpreters can run, newest update first, capped at 100 entries and 32 KiB of JSON (`truncated: true`
 * when trimmed). Loaded once per live session and kept as `live.manifest`: both `session.created` copies carry it,
 * and the run endpoint refuses a body whose hash differs from the pinned one (`409 playbook_changed`).
 */
import { LIMITS, utf8Encode, type PlaybookManifest } from '@indiansassist/shared';
import { listManifestPlaybooks, type SessionRow } from '@indiansassist/db';
import type { Live, LiveManifest } from './conn.js';
import type { SignalHub } from './hub.js';

function interpretersOf(s: Pick<SessionRow, 'deskClient'>): string[] {
  const caps = (s.deskClient as { capabilities?: { interpreters?: unknown } } | null)?.capabilities;
  return Array.isArray(caps?.interpreters) ? caps.interpreters.filter((x): x is string => typeof x === 'string') : [];
}

/** Builds the capped manifest from catalogue rows. */
export function buildManifest(rows: Parameters<typeof toEntry>[0][]): LiveManifest {
  const playbooks: PlaybookManifest[] = [];
  const hashes = new Map<string, string>();
  let bytes = utf8Encode('{"playbooks":[],"truncated":true}').length;
  let truncated = rows.length > LIMITS.playbookCatalogueMax;
  for (const r of rows.slice(0, LIMITS.playbookCatalogueMax)) {
    const e = toEntry(r);
    const size = utf8Encode(JSON.stringify(e)).length + 1;
    if (bytes + size > LIMITS.playbookManifestMaxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    playbooks.push(e);
    hashes.set(e.id, e.bodyHash);
  }
  return { msg: { playbooks: playbooks as unknown as Record<string, unknown>[], ...(truncated ? { truncated: true as const } : {}) }, hashes };
}

function toEntry(r: {
  id: string;
  name: string;
  description: string;
  interpreter: PlaybookManifest['interpreter'];
  requiresElevation: boolean;
  parameters: unknown;
  timeoutSec: number;
  bodySha256: string;
}): PlaybookManifest {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    interpreter: r.interpreter,
    requiresElevation: r.requiresElevation,
    parameters: (Array.isArray(r.parameters) ? r.parameters : []) as PlaybookManifest['parameters'],
    timeoutSec: r.timeoutSec,
    bodyHash: r.bodySha256,
  };
}

/** Loads `live.manifest` once for a P3 session (no-op for other tiers or when already pinned). */
export async function ensureAgentManifest(hub: SignalHub, live: Live, s: SessionRow): Promise<void> {
  if (s.tier !== 'p3_portable' || live.manifest) return;
  const rows = await listManifestPlaybooks(hub.ctx.db, s.orgId, interpretersOf(s), LIMITS.playbookCatalogueMax + 1);
  live.manifest ??= buildManifest(rows);
}
