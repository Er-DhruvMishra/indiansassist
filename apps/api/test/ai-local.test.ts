/**
 * Phase E section 5.6 / 15.4: the `local` provider against an in-process fake chat-completions server (a real HTTP
 * listener on 127.0.0.1, no model): the request shape, `finish_reason: 'length'`, non-JSON content, 401, 429, 500,
 * a refused connection and the timeout.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_SUMMARY_JSON_SCHEMA, SUMMARY_PROMPT_VERSION, SUMMARY_SYSTEM_PROMPT, renderSummaryInput, type SummaryPromptInput } from '@indiansassist/shared';
import { LocalSummaryProvider } from '../src/ai/local.js';

const INPUT: SummaryPromptInput = {
  v: 1,
  promptVersion: SUMMARY_PROMPT_VERSION,
  session: { tier: 'p1_browser', startedAt: null, endedAt: '2026-11-02T10:00:00.000Z', durationMs: null, endReason: 'desk_left', path: 'relay', recorded: false, unattended: null },
  events: [{ t: '2026-11-02T10:00:00.000Z', actor: 'system', text: 'The session ended: desk left' }],
  transcript: null,
  truncated: false,
};
const ANSWER = { summary: 'Short session.', outcome: 'unknown', actionsTaken: [], issuesFound: [], followUps: [], ticketNote: 'No action.' };

type Mode = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; hang?: boolean };
let mode: Mode = {};
const seen: { headers: IncomingMessage['headers']; body: Record<string, unknown>; url: string }[] = [];
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(data || '{}') as Record<string, unknown>, url: req.url ?? '' });
      if (mode.hang) return; // never answers
      res.writeHead(mode.status ?? 200, { 'content-type': 'application/json', ...(mode.headers ?? {}) });
      res.end(mode.raw ?? JSON.stringify(mode.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const completion = (content: string, finish = 'stop') => ({
  model: 'llama-3.3-70b-instruct',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
  usage: { prompt_tokens: 900, completion_tokens: 120 },
});

function provider(o: { apiKey?: string; timeoutMs?: number; baseUrl?: string } = {}) {
  return new LocalSummaryProvider({ baseUrl: o.baseUrl ?? base, model: 'local', apiKey: o.apiKey ?? '', timeoutMs: o.timeoutMs ?? 2_000 });
}
const run = (p: LocalSummaryProvider) => p.summarize(INPUT, { signal: new AbortController().signal, region: 'in-mum', ackScope: null });

describe('local provider (section 5.6)', () => {
  it('posts the chat-completions shape and returns the parsed answer', async () => {
    seen.length = 0;
    mode = { body: completion(JSON.stringify(ANSWER)) };
    const r = await run(provider({ apiKey: 'local-op-key' }));
    expect(r).toEqual({ ok: true, output: ANSWER, servedModel: 'llama-3.3-70b-instruct', inferenceGeo: 'in-mum', fallbackUsed: false, usage: { inputTokens: 900, outputTokens: 120 } });
    const call = seen[0]!;
    expect(call.url).toBe('/v1/chat/completions');
    expect(call.headers['authorization']).toBe('Bearer local-op-key');
    expect(call.headers['content-type']).toContain('application/json');
    expect(call.body).toEqual({
      model: 'local',
      stream: false,
      temperature: 0,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: renderSummaryInput(INPUT) },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'ia_session_summary', strict: true, schema: SESSION_SUMMARY_JSON_SCHEMA } },
    });
  });

  it('sends no Authorization header without AI_LOCAL_API_KEY', async () => {
    seen.length = 0;
    mode = { body: completion(JSON.stringify(ANSWER)) };
    await run(provider());
    expect(seen[0]!.headers['authorization']).toBeUndefined();
  });

  const failures: [string, Mode, string, number | null][] = [
    ["finish_reason 'length'", { body: completion('{"summary":"cut', 'length') }, 'truncated', null],
    ['non-JSON content', { body: completion('Sure! The session went well.') }, 'invalid_output', null],
    ['a non-JSON body', { raw: '<html>oops</html>' }, 'invalid_output', null],
    ['no choices', { body: { choices: [] } }, 'invalid_output', null],
    ['401', { status: 401, body: { error: 'no' } }, 'auth', null],
    ['403', { status: 403, body: { error: 'no' } }, 'auth', null],
    ['429', { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '7' } }, 'rate_limited', 7],
    ['400', { status: 400, body: { error: 'bad' } }, 'bad_request', null],
    ['500', { status: 500, body: { error: 'boom' } }, 'provider_unavailable', null],
    ['503', { status: 503, body: { error: 'loading' } }, 'provider_unavailable', null],
  ];
  for (const [name, m, cause, retry] of failures) {
    it(`maps ${name} to ${cause}`, async () => {
      mode = m;
      const r = await run(provider());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.cause).toBe(cause);
        expect(r.retryAfterSec).toBe(retry);
        expect(r.detail).not.toContain('session went well');
      }
    });
  }

  it('maps a refused connection to provider_unavailable', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const r = await run(provider({ baseUrl: `http://127.0.0.1:${port}` }));
    expect(r.ok ? null : r.cause).toBe('provider_unavailable');
  });

  it('maps AI_LOCAL_TIMEOUT_MS passing to timeout', async () => {
    mode = { hang: true };
    const r = await run(provider({ timeoutMs: 200 }));
    expect(r.ok ? null : r.cause).toBe('timeout');
  });
});
