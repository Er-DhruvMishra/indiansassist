// Offline audit-chain checks used by scripts/smoke.mjs (contracts sections 5.1, 5.2, 6.3, 6.9).
// Dependency free on purpose (node:crypto only) so the smoke test is an independent re-implementation of the
// hash rules rather than a call into @indiansassist/shared; scripts/test/audit.test.mjs cross-checks the two.

import { createHash } from 'node:crypto';

/** RFC 8785 subset of section 5.1: sorted keys, no whitespace, integers only, undefined dropped. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error(`canonicalJson: non-integer number ${value}`);
      return String(value === 0 ? 0 : value);
    case 'object':
      break;
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // UTF-16 code unit order
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256Hex(s) {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

/** Wire `AuditEntry` (camelCase, section 6.3) -> the ten-key hashed material of section 5.2. */
export function materialFromWire(entry, orgId) {
  return {
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
  };
}

export function hashWireEntry(entry, orgId) {
  return sha256Hex(canonicalJson(materialFromWire(entry, orgId)));
}

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Checks the entries of one session as returned by `GET /api/v1/sessions/:id/audit`.
 * A session's entries are a non-contiguous subset of the org chain (section 6.9), so prev_hash linkage is
 * checked only between entries whose seq values are adjacent.
 * Returns { ok, checked, problems: string[] }.
 */
export function verifySessionEntries(items, { orgId, sessionId, region, requiredActions = [] }) {
  const problems = [];
  let prev = null;
  for (const e of items) {
    const where = `seq ${e.seq} (${e.action})`;
    if (!HEX64.test(e.hash ?? '') || !HEX64.test(e.prevHash ?? '')) problems.push(`${where}: hash fields are not 64 hex`);
    if (!ISO_MS.test(e.ts ?? '')) problems.push(`${where}: ts is not ISO 8601 with milliseconds`);
    if (sessionId && e.sessionId !== sessionId) problems.push(`${where}: sessionId ${e.sessionId} != ${sessionId}`);
    if (region && e.region !== region) problems.push(`${where}: region ${e.region} != ${region}`);
    try {
      const h = hashWireEntry(e, orgId);
      if (h !== e.hash) problems.push(`${where}: hash mismatch (recomputed ${h.slice(0, 12)}...)`);
    } catch (err) {
      problems.push(`${where}: cannot hash: ${err.message}`);
    }
    if (prev) {
      if (e.seq <= prev.seq) problems.push(`${where}: seq not ascending`);
      else if (e.seq === prev.seq + 1 && e.prevHash !== prev.hash) problems.push(`${where}: prevHash does not link to seq ${prev.seq}`);
    }
    prev = e;
  }
  const actions = new Set(items.map((e) => e.action));
  for (const a of requiredActions) if (!actions.has(a)) problems.push(`missing action ${a}`);
  return { ok: problems.length === 0, checked: items.length, problems };
}
