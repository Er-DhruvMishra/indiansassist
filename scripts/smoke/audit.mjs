// Client-side audit-chain checks for the smoke test, built on @indiansassist/shared (sections 5.2, 5.4, 5.5, 6.9).
// `shared` is the module returned by loadShared() (packages/shared/dist).

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Wire `AuditEntry` (camelCase, section 6.3) -> shared `ChainEntry` (snake_case hashed shape plus hash). */
export function wireToChainEntry(entry, orgId) {
  return {
    id: entry.id,
    action: entry.action,
    actor: { id: entry.actor?.id ?? null, label: entry.actor?.label, type: entry.actor?.type },
    data: entry.data ?? {},
    org_id: orgId,
    prev_hash: entry.prevHash,
    reason: entry.reason ?? null,
    region: entry.region,
    seq: entry.seq,
    session_id: entry.sessionId ?? null,
    ts: entry.ts,
    hash: entry.hash,
  };
}

/**
 * Verifies the entries of ONE session as returned by `GET /api/v1/sessions/:id/audit`.
 * A session's entries are a non-contiguous subset of the org chain (section 6.9), so the shared
 * `hashAuditEntry` is applied to every entry, prev_hash linkage is checked wherever two listed entries have
 * adjacent seq numbers, and every maximal run of consecutive seq numbers is additionally run through the
 * shared `verifyChain` as a segment (`start = { seq, prevHash }` of its first entry).
 * Returns { ok, checked, segments, problems: string[] }.
 */
export function verifySessionAudit(shared, items, opts) {
  const { orgId, sessionId, region, requiredActions = [], expectedTail = null } = opts;
  const problems = [];
  const entries = items.map((e) => wireToChainEntry(e, orgId));
  let prev = null;
  for (const e of entries) {
    const where = `seq ${e.seq} (${e.action})`;
    if (!HEX64.test(e.hash ?? '') || !HEX64.test(e.prev_hash ?? ''))
      problems.push(`${where}: hash fields are not 64 hex`);
    if (!ISO_MS.test(e.ts ?? '')) problems.push(`${where}: ts is not ISO 8601 with milliseconds`);
    if (sessionId && e.session_id !== sessionId) problems.push(`${where}: sessionId ${e.session_id} != ${sessionId}`);
    if (region && e.region !== region) problems.push(`${where}: region ${e.region} != ${region}`);
    try {
      const h = shared.hashAuditEntry(e);
      if (h !== e.hash)
        problems.push(
          `${where}: hash mismatch (recomputed ${h.slice(0, 12)}..., server ${String(e.hash).slice(0, 12)}...)`,
        );
    } catch (err) {
      problems.push(`${where}: cannot hash: ${err.message}`);
    }
    if (prev) {
      if (e.seq <= prev.seq) problems.push(`${where}: seq not ascending`);
      else if (e.seq === prev.seq + 1 && e.prev_hash !== prev.hash)
        problems.push(`${where}: prevHash does not link to seq ${prev.seq}`);
    }
    prev = e;
  }

  // Consecutive runs through the shared verifyChain.
  const runs = [];
  for (const e of entries) {
    const run = runs.at(-1);
    if (run && run.at(-1).seq + 1 === e.seq) run.push(e);
    else runs.push([e]);
  }
  for (const run of runs) {
    const r = shared.verifyChain(run, { orgId, region, start: { seq: run[0].seq, prevHash: run[0].prev_hash } });
    if (!r.ok) problems.push(`verifyChain segment from seq ${run[0].seq}: ${r.failure?.kind} at seq ${r.failure?.seq}`);
  }

  const actions = entries.map((e) => e.action);
  for (const a of requiredActions) if (!actions.includes(a)) problems.push(`missing action ${a}`);
  let last = -1;
  for (const a of requiredActions) {
    const i = actions.indexOf(a);
    if (i >= 0 && i < last) problems.push(`action ${a} is out of order`);
    if (i >= 0) last = i;
  }
  if (expectedTail) {
    const ended = entries.filter((e) => e.action === 'session.ended').at(-1);
    if (!ended) problems.push('no session.ended entry to compare with hashChainTail');
    else if (ended.hash !== expectedTail)
      problems.push(
        `session.ended hash ${ended.hash.slice(0, 12)}... != hashChainTail ${expectedTail.slice(0, 12)}...`,
      );
  }
  return { ok: problems.length === 0, checked: entries.length, segments: runs.length, problems };
}

/**
 * Verifies a JSONL export (section 5.5) with the shared `verifyAuditJsonl` (header, full org chain from
 * genesis, audit.anchored signatures against the header keys) and checks that every hash in `mustContain`
 * appears in it. Returns { ok, checked, problems }.
 */
export function verifyExport(shared, text, { orgId, region, mustContain = [] }) {
  const problems = [];
  const r = shared.verifyAuditJsonl(text);
  if (r.malformed) return { ok: false, checked: 0, problems: [`malformed export: ${r.malformed}`] };
  if (!r.ok) problems.push(`verifyChain failed: ${r.failure?.kind} at seq ${r.failure?.seq}`);
  if (r.countMatches === false) problems.push(`header count ${r.header?.count} != number of entries`);
  if (r.header?.orgId !== orgId) problems.push(`header orgId ${r.header?.orgId} != ${orgId}`);
  if (region && r.header?.region !== region) problems.push(`header region ${r.header?.region} != ${region}`);
  if ((r.header?.keys ?? []).length === 0) problems.push('header lists no public keys');
  const parsed = shared.parseAuditJsonl(text);
  const hashes = new Set(parsed.ok ? parsed.entries.map((e) => e.hash) : []);
  for (const h of mustContain) if (!hashes.has(h)) problems.push(`export lacks session entry ${h.slice(0, 12)}...`);
  return { ok: problems.length === 0, checked: r.checked, problems };
}
