/**
 * ServiceNow (docs/specs/phase-e-contracts.md section 4.6): incidents through the Table API with basic auth. Append
 * resolves an `INC...` number to its `sys_id` with one read (a 32-hex `sys_id` is used directly), then writes the body
 * as `work_notes`. `urgency` is sent as a string ('1' to '3'), the form the Table API reference shows
 * (docs/specs/phase-f-contracts.md section 3.3; E section 4.6 said a JSON number).
 */
import type { AdapterCtx, AdapterResult, TicketingAdapter, TicketRef } from '../adapter.js';
import { basicAuth, fail, failure, oneLine, originOf, pick, SERVICENOW_URGENCY, upstream } from '../http.js';

type Ctx = AdapterCtx<'servicenow'>;

const SYS_ID = /^[0-9a-f]{32}$/;
/** An incident number (letters and digits only, so it cannot extend the encoded query). */
const NUMBER = /^[A-Za-z0-9]{1,40}$/;

export function createServicenowAdapter(): TicketingAdapter<'servicenow'> {
  const base = (c: Ctx) => `${originOf(c.config.instanceUrl)}/api/now/table/incident`;
  const headers = (c: Ctx) => ({ Authorization: basicAuth(c.credentials.username, c.credentials.password) });
  const linkOf = (c: Ctx, sysId: string) => `${originOf(c.config.instanceUrl)}/nav_to.do?uri=incident.do?sys_id=${sysId}`;

  async function resolveSysId(c: Ctx, externalId: string): Promise<{ ok: true; sysId: string } | { ok: false; result: AdapterResult<never> }> {
    if (SYS_ID.test(externalId)) return { ok: true, sysId: externalId };
    if (!NUMBER.test(externalId)) return { ok: false, result: fail('validation', { detail: 'not a ServiceNow incident number' }) };
    const q = new URLSearchParams({ sysparm_query: `number=${externalId}`, sysparm_limit: '1', sysparm_fields: 'sys_id' });
    const r = await upstream(c, { method: 'GET', url: `${base(c)}?${q.toString()}`, headers: headers(c) });
    if (!r.ok) return { ok: false, result: { ok: false, failure: r.failure } };
    const list = (r.res.json as { result?: unknown } | null)?.result;
    const sysId = Array.isArray(list) ? pick(list[0], 'sys_id') : null;
    if (!sysId || !SYS_ID.test(sysId)) return { ok: false, result: fail('not_found', { sent: true, detail: 'no incident with this number' }) };
    return { ok: true, sysId };
  }

  return {
    type: 'servicenow',

    test: async (c) => {
      const r = await upstream(c, { method: 'GET', url: `${base(c)}?sysparm_limit=1&sysparm_fields=sys_id`, headers: headers(c) });
      if (!r.ok) return { ok: false, failure: r.failure };
      return { ok: true, status: r.res.status, value: { account: null } };
    },

    create: async (c, t) => {
      const urgency = t.priority ? SERVICENOW_URGENCY[t.priority] : c.config.urgency;
      const r = await upstream(c, {
        method: 'POST',
        url: base(c),
        headers: headers(c),
        json: {
          short_description: oneLine(t.title),
          description: t.body,
          ...(c.config.callerId ? { caller_id: c.config.callerId } : {}),
          ...(c.config.assignmentGroup ? { assignment_group: c.config.assignmentGroup } : {}),
          ...(urgency ? { urgency: String(urgency) } : {}),
        },
      });
      if (!r.ok) return { ok: false, failure: r.failure };
      const sysId = pick(r.res.json, 'result', 'sys_id');
      const number = pick(r.res.json, 'result', 'number');
      if (!sysId || !number) return { ok: false, failure: failure('upstream_error', { status: r.res.status, sent: true, detail: 'answer without an incident number' }) };
      return { ok: true, status: r.res.status, value: { externalId: number, externalUrl: SYS_ID.test(sysId) ? linkOf(c, sysId) : null } };
    },

    append: async (c, externalId, t) => {
      const s = await resolveSysId(c, externalId);
      if (!s.ok) return s.result;
      const r = await upstream(c, { method: 'PATCH', url: `${base(c)}/${s.sysId}`, headers: headers(c), json: { work_notes: t.body } });
      if (!r.ok) return { ok: false, failure: r.failure };
      return { ok: true, status: r.res.status, value: { externalId, externalUrl: linkOf(c, s.sysId) } satisfies TicketRef };
    },
  };
}
