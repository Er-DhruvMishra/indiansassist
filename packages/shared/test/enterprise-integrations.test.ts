/**
 * Phase E section 4 behaviour (stream tickets): the ticket body with its footer, the failure classification, the
 * retry rule and schedule, and the webhook signature against the cross-language vector
 * (fixtures/enterprise/webhook-signature.json, computed with node:crypto).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyHttpFailure,
  isAutoRetryable,
  LIMITS,
  nextRetryAt,
  renderTicketBody,
  ticketContentSchema,
  utf8Encode,
  verifyWebhookSignature,
  webhookSignature,
  type TicketFailure,
} from '../src/index.js';

type Vector = { name: string; secret: string; ts: number; rawBody: string; signature: string };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/enterprise/webhook-signature.json', import.meta.url), 'utf8')) as {
  vectors: Vector[];
  rotationHeader: string;
  notTheStringKey: string;
};

const SESSION = {
  id: '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
  url: 'https://assist.example.test/app/sessions/6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
  tier: 'p1_browser' as const,
  startedAt: '2026-11-02T09:00:00.000Z',
  endedAt: '2026-11-02T09:30:00.000Z',
  technician: 'Asha R',
  chainVerified: true as boolean | null,
};

describe('renderTicketBody (section 4.3)', () => {
  it('summary: ticket note, actions, follow-ups and the footer', () => {
    const body = renderTicketBody({
      source: 'summary',
      note: null,
      summary: { ticketNote: 'Printer queue was stuck.', actionsTaken: ['Cleared the queue', 'Restarted spooler'], followUps: ['Replace toner'] },
      session: SESSION,
    });
    expect(body).toBe(
      [
        'Printer queue was stuck.',
        '',
        'Actions taken:',
        '- Cleared the queue',
        '- Restarted spooler',
        '',
        'Follow-ups:',
        '- Replace toner',
        '',
        '—',
        `Remote session: ${SESSION.url}`,
        'Audit chain verified: yes',
        'IndiansAssist session 6f1c2a7e',
      ].join('\n'),
    );
  });

  it('summary without follow-ups leaves the heading out; chain words cover no and not checked', () => {
    const body = renderTicketBody({
      source: 'summary',
      note: null,
      summary: { ticketNote: 'Done.', actionsTaken: ['One'], followUps: [] },
      session: { ...SESSION, chainVerified: false },
    });
    expect(body).not.toContain('Follow-ups:');
    expect(body).toContain('Audit chain verified: no');
    const manual = renderTicketBody({ source: 'manual', note: '  Called the user back.  ', summary: null, session: { ...SESSION, chainVerified: null } });
    expect(manual.startsWith('Called the user back.\n\n—\n')).toBe(true);
    expect(manual).toContain('Audit chain verified: not checked');
  });

  it('keeps the whole body within ticketBodyMax, cutting the note at a word boundary', () => {
    const long = 'word '.repeat(5000);
    const body = renderTicketBody({ source: 'manual', note: long, summary: null, session: SESSION });
    expect(body.length).toBeLessThanOrEqual(LIMITS.ticketBodyMax);
    expect(body).toContain('…\n\n—');
    expect(body.endsWith('IndiansAssist session 6f1c2a7e')).toBe(true);
    // The rendered body is a valid TicketContent body.
    const content = { title: 't', body, source: 'manual', session: SESSION, summary: null, priority: null, requesterEmail: null };
    expect(ticketContentSchema.safeParse(content).success).toBe(true);
  });

  it('refuses a summary push without the output and a manual push without a note', () => {
    expect(() => renderTicketBody({ source: 'summary', note: null, summary: null, session: SESSION })).toThrow();
    expect(() => renderTicketBody({ source: 'manual', note: ' ', summary: null, session: SESSION })).toThrow();
  });
});

describe('classifyHttpFailure (section 4.1)', () => {
  it.each([
    [401, true, 'auth'],
    [403, true, 'forbidden'],
    [404, true, 'not_found'],
    [400, true, 'validation'],
    [409, true, 'validation'],
    [422, true, 'validation'],
    [413, true, 'validation'],
    [429, true, 'rate_limited'],
    [500, true, 'upstream_error'],
    [502, true, 'upstream_error'],
    [503, true, 'upstream_error'],
    [null, false, 'unreachable'],
    [null, true, 'timeout'],
  ] as const)('%s (sent %s) -> %s', (status, sent, cause) => {
    expect(classifyHttpFailure(status, sent)).toBe(cause);
  });
});

describe('isAutoRetryable (rule 4.4c)', () => {
  const f = (over: Partial<TicketFailure>): TicketFailure => ({ cause: 'upstream_error', status: null, retryAfterSec: null, sent: true, detail: '', ...over });
  it('retries what cannot have reached the far end, 429 and 503', () => {
    expect(isAutoRetryable(f({ cause: 'unreachable', sent: false }), 'jira')).toBe(true);
    expect(isAutoRetryable(f({ cause: 'rate_limited', status: 429 }), 'servicenow')).toBe(true);
    expect(isAutoRetryable(f({ cause: 'upstream_error', status: 503 }), 'freshdesk')).toBe(true);
  });
  it('never retries an ambiguous non-webhook failure or a configuration refusal', () => {
    for (const type of ['zoho_desk', 'servicenow', 'jira', 'freshdesk'] as const) {
      expect(isAutoRetryable(f({ cause: 'timeout', sent: true }), type)).toBe(false);
      expect(isAutoRetryable(f({ cause: 'upstream_error', status: 500 }), type)).toBe(false);
      expect(isAutoRetryable(f({ cause: 'upstream_error', status: 502 }), type)).toBe(false);
    }
    expect(isAutoRetryable(f({ cause: 'egress_refused', sent: false }), 'jira')).toBe(false);
    expect(isAutoRetryable(f({ cause: 'egress_refused', sent: false }), 'webhook')).toBe(false);
    expect(isAutoRetryable(f({ cause: 'auth', status: 401 }), 'webhook')).toBe(false);
    expect(isAutoRetryable(f({ cause: 'validation', status: 422 }), 'jira')).toBe(false);
    expect(isAutoRetryable(f({ cause: 'misconfigured', sent: false }), 'jira')).toBe(false);
  });
  it('webhook receivers de-duplicate, so its timeouts and 5xx are retried', () => {
    expect(isAutoRetryable(f({ cause: 'timeout' }), 'webhook')).toBe(true);
    expect(isAutoRetryable(f({ cause: 'upstream_error', status: 500 }), 'webhook')).toBe(true);
  });
});

describe('nextRetryAt (rule 4.4d)', () => {
  const now = new Date('2026-11-02T10:00:00.000Z');
  const wait = (attempt: number, ra: number | null) => (nextRetryAt(attempt, ra, now).getTime() - now.getTime()) / 1000;
  it('follows 30 s, 2 min, 10 min, 30 min, 2 h', () => {
    expect([1, 2, 3, 4, 5].map((n) => wait(n, null))).toEqual([30, 120, 600, 1800, 7200]);
    expect(wait(6, null)).toBe(7200);
  });
  it('honours a larger Retry-After, capped at 7200 s', () => {
    expect(wait(1, 90)).toBe(90);
    expect(wait(1, 10)).toBe(30);
    expect(wait(2, 99999)).toBe(7200);
  });
});

describe('webhook signature (section 4.5)', () => {
  it.each(fixture.vectors.map((v) => [v.name, v] as const))('matches the vector: %s', (_n, v) => {
    expect(webhookSignature(v.secret, v.ts, utf8Encode(v.rawBody))).toBe(v.signature);
  });
  it('the key is the decoded 32 bytes, not the 43-character string', () => {
    const v = fixture.vectors[0]!;
    expect(webhookSignature(v.secret, v.ts, utf8Encode(v.rawBody))).not.toBe(fixture.notTheStringKey);
    expect(() => webhookSignature('c2hvcnQ', v.ts, utf8Encode(v.rawBody))).toThrow();
  });
  it('verifies any listed v1= value within the 300 s window, in constant time', () => {
    const [cur, prev] = fixture.vectors as [Vector, Vector];
    const body = utf8Encode(cur.rawBody);
    const at = new Date(cur.ts * 1000);
    expect(verifyWebhookSignature([cur.secret], cur.signature, cur.ts, body, at)).toBe(true);
    expect(verifyWebhookSignature([prev.secret], fixture.rotationHeader, cur.ts, body, at)).toBe(true);
    expect(verifyWebhookSignature([cur.secret], prev.signature, cur.ts, body, at)).toBe(false);
    expect(verifyWebhookSignature([cur.secret], cur.signature, cur.ts, utf8Encode(`${cur.rawBody} `), at)).toBe(false);
    expect(verifyWebhookSignature([cur.secret], cur.signature, cur.ts, body, new Date((cur.ts + 300) * 1000))).toBe(true);
    expect(verifyWebhookSignature([cur.secret], cur.signature, cur.ts, body, new Date((cur.ts + 301) * 1000))).toBe(false);
    expect(verifyWebhookSignature([cur.secret], cur.signature, cur.ts, body, new Date((cur.ts - 301) * 1000))).toBe(false);
    expect(verifyWebhookSignature([cur.secret], 'v1=zz', cur.ts, body, at)).toBe(false);
    expect(verifyWebhookSignature(['not-a-secret'], cur.signature, cur.ts, body, at)).toBe(false);
  });
});
