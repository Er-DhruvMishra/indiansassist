// Audit part of the smoke flow (contracts sections 5, 6.9): session audit fetched over REST and verified
// client-side with @indiansassist/shared, then the full org chain via the JSONL export and the server verify.

import { verifyExport, verifySessionAudit } from './audit.mjs';
import { check, eq } from './runner.mjs';

export const SESSION_ACTIONS = [
  'session.knock',
  'session.accepted',
  'session.consent_granted',
  'session.started',
  'session.ended',
];

/** @param {import('./runner.mjs').Runner} run */
export async function auditSteps(run, ctx) {
  const { api, shared, state } = ctx;

  await run.step('GET /api/v1/sessions/:id/audit + client-side chain verification', async () => {
    const r = await api.expect('GET', `/api/v1/sessions/${state.sessionId}/audit`);
    check(Array.isArray(r.items) && r.items.length > 0, 'no audit items');
    check(r.integrity?.ok === true, `server integrity not ok: ${JSON.stringify(r.integrity?.failure ?? null)}`);
    const v = verifySessionAudit(shared, r.items, {
      orgId: state.org.id,
      sessionId: state.sessionId,
      region: state.region,
      requiredActions: SESSION_ACTIONS,
      expectedTail: state.hashChainTail,
    });
    if (!v.ok) throw new Error(v.problems.join('; '));
    const ended = r.items.find((e) => e.action === 'session.ended');
    eq(ended.data?.endReason, 'assist_ended', 'session.ended data.endReason');
    eq(ended.actor?.type, 'user', 'session.ended actor.type');
    const knock = r.items.find((e) => e.action === 'session.knock');
    check(
      knock.data?.deskLabelHash && !JSON.stringify(knock.data).includes('Smoke Desk'),
      'session.knock must hash the Desk label (PII rule)',
    );
    state.sessionHashes = r.items.map((e) => e.hash);
    return `${v.checked} entries in ${v.segments} segment(s), hashes recomputed with shared.hashAuditEntry`;
  });

  await run.step(
    'POST /api/v1/audit/export + offline verifyChain of the whole org',
    async () => {
      const r = await api.request('POST', '/api/v1/audit/export', {});
      eq(r.status, 200, 'status');
      check(
        /application\/x-ndjson/.test(r.headers.get('content-type') ?? ''),
        `content-type ${r.headers.get('content-type')}`,
      );
      const v = verifyExport(shared, r.text, {
        orgId: state.org.id,
        region: state.region,
        mustContain: state.sessionHashes ?? [],
      });
      if (!v.ok) throw new Error(v.problems.join('; '));
      return `${v.checked} entries verified from genesis, anchors checked against the header keys`;
    },
    { critical: false },
  );

  await run.step(
    'POST /api/v1/audit/verify (server side)',
    async () => {
      const r = await api.expect('POST', '/api/v1/audit/verify', {});
      check(r.ok === true, `server verify failed: ${JSON.stringify(r.failure ?? null)}`);
      check(r.checked > 0, 'server verify checked 0 entries');
      return `${r.checked} entries, tail ${String(r.tail).slice(0, 16)}...`;
    },
    { critical: false },
  );
}
