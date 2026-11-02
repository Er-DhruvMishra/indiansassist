/**
 * Freshdesk (docs/specs/phase-e-contracts.md section 4.6): `https://<domain>.freshdesk.com/api/v2`, basic auth with the
 * API key as user name and `X` as password, HTML bodies, private notes for append.
 */
import type { AdapterCtx, TicketingAdapter } from '../adapter.js';
import { basicAuth, fail, failure, FRESHDESK_PRIORITY, oneLine, originOf, pick, toHtml, upstream } from '../http.js';

type Ctx = AdapterCtx<'freshdesk'>;

export type FreshdeskAdapterOptions = {
  /** `https://<domain>.freshdesk.com` in production; tests point every domain at an in-process fake. */
  baseUrlOf?: (domain: string) => string;
};

export function createFreshdeskAdapter(opts: FreshdeskAdapterOptions = {}): TicketingAdapter<'freshdesk'> {
  const site = (c: Ctx) => originOf(opts.baseUrlOf ? opts.baseUrlOf(c.config.domain) : `https://${c.config.domain}.freshdesk.com`);
  const headers = (c: Ctx) => ({ Authorization: basicAuth(c.credentials.apiKey, 'X') });
  const link = (c: Ctx, id: string) => `${site(c)}/a/tickets/${id}`;

  return {
    type: 'freshdesk',

    test: async (c) => {
      const r = await upstream(c, { method: 'GET', url: `${site(c)}/api/v2/agents/me`, headers: headers(c) });
      if (!r.ok) return { ok: false, failure: r.failure };
      return { ok: true, status: r.res.status, value: { account: pick(r.res.json, 'contact', 'name') } };
    },

    create: async (c, t) => {
      const r = await upstream(c, {
        method: 'POST',
        url: `${site(c)}/api/v2/tickets`,
        headers: headers(c),
        json: {
          subject: oneLine(t.title),
          description: toHtml(t.body),
          email: t.requesterEmail ?? c.config.defaultRequesterEmail,
          priority: t.priority ? FRESHDESK_PRIORITY[t.priority] : c.config.priority,
          status: 2,
          ...(c.config.groupId !== null ? { group_id: c.config.groupId } : {}),
        },
      });
      if (!r.ok) return { ok: false, failure: r.failure };
      const id = pick(r.res.json, 'id');
      if (!id || !/^\d{1,20}$/.test(id)) return { ok: false, failure: failure('upstream_error', { status: r.res.status, sent: true, detail: 'answer without a ticket id' }) };
      return { ok: true, status: r.res.status, value: { externalId: id, externalUrl: link(c, id) } };
    },

    append: async (c, externalId, t) => {
      if (!/^\d{1,20}$/.test(externalId)) return fail('validation', { detail: 'not a Freshdesk ticket id' });
      const r = await upstream(c, {
        method: 'POST',
        url: `${site(c)}/api/v2/tickets/${externalId}/notes`,
        headers: headers(c),
        json: { body: toHtml(t.body), private: true },
      });
      if (!r.ok) return { ok: false, failure: r.failure };
      return { ok: true, status: r.res.status, value: { externalId, externalUrl: link(c, externalId) } };
    },
  };
}
