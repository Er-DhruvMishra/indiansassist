// Audit checks of the Phase B smoke flow: the session's chain verified client-side with @indiansassist/shared,
// the P2 entries (consent level, control.refused, level change, both tab.action reporters with hostHash and no
// host, mirror.relayed right before session.ended), the hosts side map and the org export.

import { verifyExport, verifySessionAudit } from './audit.mjs';
import { check, eq } from './runner.mjs';

const REQUIRED = ['session.knock', 'session.accepted', 'session.consent_granted', 'session.started', 'session.ended'];

/** @param {import('./runner.mjs').Runner} run */
export async function p2AuditSteps(run, ctx) {
  const { api, shared, state } = ctx;

  await run.step('P2 audit: session chain verifies client-side and holds the P2 entries', async () => {
    const r = await api.expect('GET', `/api/v1/sessions/${state.sessionId}/audit`);
    check(r.integrity?.ok === true, `server integrity not ok: ${JSON.stringify(r.integrity?.failure ?? null)}`);
    const v = verifySessionAudit(shared, r.items, {
      orgId: state.org.id,
      sessionId: state.sessionId,
      region: state.region,
      requiredActions: REQUIRED,
      expectedTail: state.hashChainTail,
    });
    if (!v.ok) throw new Error(v.problems.join('; '));
    const by = (a) => r.items.filter((e) => e.action === a);
    const granted = by('session.consent_granted')[0];
    eq(granted?.data?.level, 'tab_control', 'session.consent_granted data.level');
    eq(granted?.data?.scope, 'current_tab', 'session.consent_granted data.scope');
    const refused = by('control.refused')[0];
    check(refused, 'control.refused entry missing');
    eq(refused.data.op, 'input.pointer', 'control.refused op');
    eq(refused.data.required, 'in_page', 'control.refused required');
    eq(refused.data.opId, state.refusedOpId, 'control.refused opId matches the error details');
    eq(by('consent.level_changed')[0]?.data?.requestedBy, 'assist', 'consent.level_changed requestedBy');
    const tabs = by('tab.action');
    eq(tabs.length, 2, 'tab.action entries (desk + user)');
    check(tabs.some((e) => e.actor.type === 'desk') && tabs.some((e) => e.actor.type === 'user'), 'both reporters');
    for (const e of tabs) {
      check(/^[0-9a-f]{64}$/.test(e.data.hostHash ?? ''), 'tab.action carries hostHash');
      check(!('host' in e.data), 'tab.action must not carry the plaintext host');
    }
    eq(tabs[0].data.hostHash, tabs[1].data.hostHash, 'both reporters hash the same host');
    eq(r.hosts?.[tabs[0].data.hostHash], 'example.com', 'hosts side map');
    const actions = r.items.map((e) => e.action);
    const relayed = actions.lastIndexOf('mirror.relayed');
    check(relayed >= 0, 'mirror.relayed entry missing');
    eq(actions[relayed + 1], 'session.ended', 'entry after mirror.relayed');
    const counters = r.items[relayed].data;
    check(counters.mirrorFrames >= 1 && counters.controlFrames >= 2, `relay counters ${JSON.stringify(counters)}`);
    state.sessionHashes = r.items.map((e) => e.hash);
    return `${v.checked} entries; relay ${JSON.stringify(counters)}`;
  });

  await run.step('P2 audit: org export verifies from genesis; server verify ok', async () => {
    const r = await api.request('POST', '/api/v1/audit/export', {});
    eq(r.status, 200, 'export status');
    const v = verifyExport(shared, r.text, { orgId: state.org.id, region: state.region, mustContain: state.sessionHashes ?? [] });
    if (!v.ok) throw new Error(v.problems.join('; '));
    const s = await api.expect('POST', '/api/v1/audit/verify', {});
    check(s.ok === true, `server verify failed: ${JSON.stringify(s.failure ?? null)}`);
    const policyEntries = (await api.expect('GET', '/api/v1/audit?action=org.policy_updated')).items;
    check(policyEntries.length >= 2, 'org.policy_updated entries (extension + retention)');
    return `${v.checked} entries`;
  });
}
