/**
 * Phase E section 5.7 / 15.4: the `anthropic` provider. `buildAnthropicRequest` against
 * fixtures/enterprise/anthropic-request.json, `interpretAnthropicResponse` against anthropic-responses.json, and the
 * real SDK client built with a `fetch` option pointed at an in-process fake (no network, no real model): one call
 * per attempt with `maxRetries: 0`, either authentication header accepted, and the typed error mapping.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REGIONS, SESSION_SUMMARY_JSON_SCHEMA, SUMMARY_SYSTEM_PROMPT, renderSummaryInput, type AiAckScope, type Region, type SummaryPromptInput } from '@indiansassist/shared';
import {
  ANTHROPIC_FALLBACK_BETA,
  AnthropicSummaryProvider,
  buildAnthropicRequest,
  createAnthropicClient,
  interpretAnthropicResponse,
  mapAnthropicError,
} from '../src/ai/anthropic.js';
import { buildSummaryProviders } from '../src/ai/provider.js';
import { loadConfig } from '../src/config.js';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../../packages/shared/test/fixtures/enterprise/${name}`, import.meta.url), 'utf8')) as T;

type RequestFixture = {
  input: SummaryPromptInput;
  cases: { region: Region; ackScope: AiAckScope; expect: { model: string; max_tokens: number; inference_geo: string; betas: string[] | null; fallbacks: string | null } }[];
  outputConfig: { effort: string; formatType: string };
  absent: string[];
};
type ResponseFixture = {
  requestedGeo: string;
  cases: { name: string; message: Record<string, unknown>; expect: Record<string, unknown> & { ok: boolean; cause?: string; detailContains?: string } }[];
};
const REQ = fixture<RequestFixture>('anthropic-request.json');
const RES = fixture<ResponseFixture>('anthropic-responses.json');

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  return out;
}

describe('buildAnthropicRequest (fixture)', () => {
  for (const c of REQ.cases) {
    it(`${c.region} under ${c.ackScope}`, () => {
      const r = buildAnthropicRequest(REQ.input, c.region, c.ackScope) as unknown as Record<string, unknown>;
      expect(r.model).toBe(c.expect.model);
      expect(r.max_tokens).toBe(c.expect.max_tokens);
      expect(r.inference_geo).toBe(c.expect.inference_geo);
      if (c.expect.betas === null) expect('betas' in r).toBe(false);
      else expect(r.betas).toEqual(c.expect.betas);
      if (c.expect.fallbacks === null) expect('fallbacks' in r).toBe(false);
      else expect(r.fallbacks).toBe(c.expect.fallbacks);
      expect(r.output_config).toEqual({ effort: REQ.outputConfig.effort, format: { type: REQ.outputConfig.formatType, schema: SESSION_SUMMARY_JSON_SCHEMA } });
      expect(r.system).toBe(SUMMARY_SYSTEM_PROMPT);
      expect(r.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: renderSummaryInput(REQ.input) }] }]);
      const keys = keysDeep(r);
      for (const k of REQ.absent) expect(keys.has(k), k).toBe(false);
      // No assistant prefill: the only message is the user's.
      expect((r.messages as { role: string }[]).every((m) => m.role === 'user')).toBe(true);
    });
  }
  it('never asks for the fallback under in_geo, whatever the region', () => {
    for (const region of REGIONS) {
      const r = buildAnthropicRequest(REQ.input, region, 'in_geo') as unknown as Record<string, unknown>;
      expect('fallbacks' in r).toBe(false);
      expect('betas' in r).toBe(false);
      expect(JSON.stringify(r)).not.toContain(ANTHROPIC_FALLBACK_BETA);
    }
  });
  it('takes the configured model', () => {
    expect(buildAnthropicRequest(REQ.input, 'us-east', 'in_geo', 'claude-opus-5-5-custom').model).toBe('claude-opus-5-5-custom');
  });
});

describe('interpretAnthropicResponse (fixture)', () => {
  for (const c of RES.cases) {
    it(c.name, () => {
      const r = interpretAnthropicResponse(c.message as never, RES.requestedGeo);
      expect(r.ok).toBe(c.expect.ok);
      if (r.ok) {
        expect(r.output).toEqual(c.expect.output);
        expect(r.servedModel).toBe(c.expect.servedModel);
        expect(r.inferenceGeo).toBe(c.expect.inferenceGeo);
        expect(r.fallbackUsed).toBe(c.expect.fallbackUsed);
        expect(r.usage).toEqual(c.expect.usage);
      } else {
        expect(r.cause).toBe(c.expect.cause);
        if (c.expect.detailContains) expect(r.detail).toContain(c.expect.detailContains);
        expect(r.detail.length).toBeLessThanOrEqual(200);
        // Never prompt or output text in the detail.
        expect(r.detail).not.toContain('summary');
      }
    });
  }
});

// ---------- the SDK client against an in-process fake ----------

type FakeReply = { status: number; body?: unknown; headers?: Record<string, string> } | 'hang' | 'reset';
type FakeCall = { url: string; headers: Headers; body: Record<string, unknown> };

/** An in-process Messages API: records each call, asserts an auth header and a version header are present. */
function fakeAnthropic(replies: FakeReply[]): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const headers = req.headers;
    const body = JSON.parse(await req.text()) as Record<string, unknown>;
    calls.push({ url: req.url, headers, body });
    const auth = headers.get('x-api-key') ?? (headers.get('authorization')?.startsWith('Bearer ') ? headers.get('authorization') : null);
    if (!auth) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'no key' } }, { status: 401 });
    if (!headers.get('anthropic-version')) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'no version' } }, { status: 400 });
    const r = replies.shift() ?? { status: 500 };
    if (r === 'reset') throw new TypeError('fetch failed');
    if (r === 'hang')
      return new Promise<Response>((_, reject) => {
        const s = init?.signal;
        if (s) s.addEventListener('abort', () => reject(s.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
      });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_fake', ...(r.headers ?? {}) },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

const OK_MESSAGE = RES.cases[0]!.message;
const errorBody = (type: string) => ({ type: 'error', error: { type, message: 'fake' } });

function provider(replies: FakeReply[], timeoutMs = 2_000) {
  const fake = fakeAnthropic(replies);
  const client = createAnthropicClient({ apiKey: 'sk-ant-test-key', timeoutMs, maxRetries: 0, fetch: fake.fetch, baseURL: 'http://anthropic.fake.test' });
  return { fake, p: new AnthropicSummaryProvider(client, 'claude-opus-5-5') };
}

const opts = (ackScope: AiAckScope = 'outside_region', region: Region = 'in-mum') => ({ signal: new AbortController().signal, region, ackScope });

describe('the SDK client against an in-process fake', () => {
  it('sends the built request once and interprets the answer', async () => {
    const { fake, p } = provider([{ status: 200, body: OK_MESSAGE }]);
    const r = await p.summarize(REQ.input, opts());
    expect(r.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(new URL(call.url).pathname).toBe('/v1/messages');
    expect(call.body.model).toBe('claude-opus-5-5');
    expect(call.body.fallbacks).toBe('default');
    expect(call.body.inference_geo).toBe('global');
    expect(call.headers.get('anthropic-beta') ?? '').toContain(ANTHROPIC_FALLBACK_BETA);
    for (const k of REQ.absent) expect(k in call.body, k).toBe(false);
    // The operator key travels in one of the two headers the SDK may use; nothing else identifies anyone.
    expect(call.headers.get('x-api-key') ?? call.headers.get('authorization')).toMatch(/sk-ant-test-key/);
  });

  it('under in_geo sends neither the beta nor fallbacks', async () => {
    const { fake, p } = provider([{ status: 200, body: OK_MESSAGE }]);
    await p.summarize(REQ.input, opts('in_geo', 'us-east'));
    expect('fallbacks' in fake.calls[0]!.body).toBe(false);
    expect(fake.calls[0]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
    expect(fake.calls[0]!.body.inference_geo).toBe('us');
  });

  const cases: [string, FakeReply, string, number | null][] = [
    ['401', { status: 401, body: errorBody('authentication_error') }, 'auth', null],
    ['403', { status: 403, body: errorBody('permission_error') }, 'auth', null],
    ['400', { status: 400, body: errorBody('invalid_request_error') }, 'bad_request', null],
    ['429 with retry-after', { status: 429, body: errorBody('rate_limit_error'), headers: { 'retry-after': '42' } }, 'rate_limited', 42],
    ['500', { status: 500, body: errorBody('api_error') }, 'provider_unavailable', null],
    ['529 overloaded', { status: 529, body: errorBody('overloaded_error') }, 'provider_unavailable', null],
    ['404', { status: 404, body: errorBody('not_found_error') }, 'bad_request', null],
    ['a reset connection', 'reset', 'provider_unavailable', null],
  ];
  for (const [name, reply, cause, retry] of cases) {
    it(`maps ${name} to ${cause}, with exactly one call (maxRetries 0)`, async () => {
      const { fake, p } = provider([reply]);
      const r = await p.summarize(REQ.input, opts());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.cause).toBe(cause);
        expect(r.retryAfterSec).toBe(retry);
        expect(r.detail.length).toBeLessThanOrEqual(200);
      }
      expect(fake.calls).toHaveLength(1);
    });
  }

  it('maps a connection timeout to timeout', async () => {
    const { fake, p } = provider(['hang'], 150);
    const r = await p.summarize(REQ.input, opts());
    expect(r.ok ? null : r.cause).toBe('timeout');
    expect(fake.calls).toHaveLength(1);
  });

  it('maps an abort of the attempt deadline to timeout', async () => {
    const { p } = provider(['hang'], 10_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await p.summarize(REQ.input, { signal: ac.signal, region: 'in-mum', ackScope: 'outside_region' });
    expect(r.ok ? null : r.cause).toBe('timeout');
  });

  it('maps a non-SDK error defensively', () => {
    expect(mapAnthropicError(new Error('boom')).cause).toBe('provider_unavailable');
  });
});

describe('operator configuration (section 5.2a)', () => {
  const cfg = (env: Record<string, string>) =>
    loadConfig({ NODE_ENV: 'test', SESSION_COOKIE_SECRET: 'x'.repeat(48), TURN_SECRET: 'y'.repeat(48), ...env }, { persistSecrets: false }).ai;
  it('anthropic only where the region is allowed and the key is set; local only where an endpoint is configured', () => {
    const ai = cfg({ AI_ANTHROPIC_API_KEY: 'sk-ant-op', AI_ANTHROPIC_REGIONS: 'us-east,in-mum', AI_LOCAL_ENDPOINTS: 'eu-fra=http://llm.eu.internal:8000' });
    const build = buildSummaryProviders(ai);
    expect(build('us-east').anthropic?.model).toBe('claude-opus-5-5');
    expect(build('in-mum').anthropic).not.toBeNull();
    expect(build('eu-fra').anthropic).toBeNull();
    expect(build('eu-fra').local?.model).toBe('local');
    expect(build('us-east').local).toBeNull();
    // One client per node.
    expect(build('us-east').anthropic).toBe(build('in-mum').anthropic);
    expect(ai.anthropic.maxRetries).toBe(0);
    expect(ai.anthropic.timeoutMs).toBe(90_000);
  });
  it('no key means no anthropic anywhere', () => {
    const build = buildSummaryProviders(cfg({ AI_ANTHROPIC_REGIONS: 'us-east' }));
    expect(build('us-east').anthropic).toBeNull();
  });
});
