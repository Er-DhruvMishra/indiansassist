/**
 * The generic signed webhook (docs/specs/phase-e-contracts.md sections 4.5, 4.6). The body is the canonical JSON of
 * the delivery object and exactly those bytes are signed; `X-IA-Timestamp`, `sentAt` and the signature are fresh on
 * every attempt and only `X-IA-Push-Id` stays the same, so receivers de-duplicate on it. During the rotation overlap
 * the header carries a second `v1=` signature under the previous secret.
 */
import { canonicalJsonBytes, webhookSignature, type TicketContent } from '@indiansassist/shared';
import type { AdapterCtx, AdapterResult, TicketingAdapter, TicketRef } from '../adapter.js';
import { httpsUrl, pick, upstream } from '../http.js';

type Ctx = AdapterCtx<'webhook'>;

export const WEBHOOK_USER_AGENT = 'IndiansAssist-Webhook/1';

/** The `X-IA-Signature` value: the current secret's `v1=`, then the previous one's while its overlap lasts. */
export function signatureHeader(c: Pick<Ctx, 'credentials'>, ts: number, raw: Uint8Array, now: Date): string {
  const parts = [webhookSignature(c.credentials.secret, ts, raw)];
  const prev = c.credentials.previousSecret;
  if (prev && Date.parse(prev.until) > now.getTime()) parts.push(webhookSignature(prev.secret, ts, raw));
  return parts.join(', ');
}

async function deliver(c: Ctx, event: 'ticket.push' | 'ping', payload: Record<string, unknown>, extraHeaders: Record<string, string>) {
  const now = c.now();
  const ts = Math.floor(now.getTime() / 1000);
  const raw = canonicalJsonBytes({ ...payload, sentAt: now.toISOString() });
  return upstream(c, {
    method: 'POST',
    url: c.credentials.url,
    purpose: 'webhook',
    raw,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': WEBHOOK_USER_AGENT,
      'X-IA-Event': event,
      ...extraHeaders,
      'X-IA-Timestamp': String(ts),
      'X-IA-Signature': signatureHeader(c, ts, raw, now),
    },
  });
}

/** The receiver's optional `{ externalId?, externalUrl? }` (an id of at most 100 characters, an https URL). */
function receiverRef(json: unknown, fallbackId: string | null): TicketRef {
  const id = pick(json, 'externalId');
  return { externalId: id && id.length <= 100 ? id : (fallbackId ?? null), externalUrl: httpsUrl(pick(json, 'externalUrl')) };
}

export function createWebhookAdapter(): TicketingAdapter<'webhook'> {
  async function push(c: Ctx, mode: 'create' | 'append', externalId: string | null, ticket: TicketContent): Promise<AdapterResult<TicketRef>> {
    const r = await deliver(
      c,
      'ticket.push',
      { v: 1, event: 'ticket.push', pushId: c.delivery.pushId, orgId: c.orgId, mode, externalId, ticket },
      { 'X-IA-Push-Id': c.delivery.pushId, 'X-IA-Attempt': String(c.delivery.attempt) },
    );
    if (!r.ok) return { ok: false, failure: r.failure };
    // A null externalId means the receiver named none.
    return { ok: true, status: r.res.status, value: receiverRef(r.res.json, externalId) };
  }

  return {
    type: 'webhook',
    test: async (c) => {
      const r = await deliver(c, 'ping', { v: 1, event: 'ping', orgId: c.orgId }, {});
      if (!r.ok) return { ok: false, failure: r.failure };
      return { ok: true, status: r.res.status, value: { account: null } };
    },
    create: (c, ticket) => push(c, 'create', null, ticket),
    append: (c, externalId, ticket) => push(c, 'append', externalId, ticket),
  };
}
