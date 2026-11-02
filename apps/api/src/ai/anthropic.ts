/**
 * Phase E section 5.7: the `anthropic` summary provider, on the official TypeScript SDK (`@anthropic-ai/sdk` 1.x,
 * Apache-2.0). The request builder and the response interpreter are pure and fixture-tested
 * (test/fixtures/anthropic-*.json via packages/shared/test/fixtures/enterprise); the client is one per node with
 * `maxRetries: 0`, so the worker's schedule (5.8d) is the only retry policy. Prompt and response text are never
 * logged; only the cause, the status and the token counts leave this module.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  AI_INFERENCE_GEO,
  SESSION_SUMMARY_JSON_SCHEMA,
  SUMMARY_SYSTEM_PROMPT,
  renderSummaryInput,
  type AiAckScope,
  type Region,
  type SummaryPromptInput,
} from '@indiansassist/shared';
import type { SummaryProvider, SummaryProviderResult } from './provider.js';

/** The default model of section 5.2a (`AI_ANTHROPIC_MODEL`). */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
/** The server-side refusal fallback beta, sent only under an `outside_region` acknowledgement (5.2e, 5.7a). */
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const ANTHROPIC_MAX_TOKENS = 16000;

export type AnthropicRequest = MessageCreateParamsNonStreaming;

/**
 * Section 5.7: the request for one summary. Pure. Never carries `temperature`, `top_p`, `top_k`, `thinking`, the
 * deprecated top-level `output_format` or an assistant prefill; the fallback beta and `fallbacks` only under
 * `outside_region`.
 */
export function buildAnthropicRequest(
  input: SummaryPromptInput,
  region: Region,
  ackScope: AiAckScope | null,
  model: string = ANTHROPIC_DEFAULT_MODEL,
): AnthropicRequest {
  return {
    model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    ...(ackScope === 'outside_region' ? { betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    // Top-level; 'global' only happens for an unmapped region, which needs the outside_region acknowledgement (5.2d).
    inference_geo: AI_INFERENCE_GEO[region] ?? 'global',
    output_config: {
      // This model's default is 'medium'; set explicitly.
      effort: 'low',
      format: { type: 'json_schema', schema: SESSION_SUMMARY_JSON_SCHEMA as unknown as Record<string, unknown> },
    },
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: renderSummaryInput(input) }] }],
  };
}

const short = (s: string): string => (s.length > 200 ? s.slice(0, 200) : s);

function fail(cause: Extract<SummaryProviderResult, { ok: false }>['cause'], detail: string, retryAfterSec: number | null = null): SummaryProviderResult {
  return { ok: false, cause, detail: short(detail), retryAfterSec };
}

type LooseBlock = { type?: unknown; text?: unknown };
type LooseMessage = {
  model?: unknown;
  stop_reason?: unknown;
  stop_details?: { category?: unknown } | null;
  content?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; inference_geo?: unknown; iterations?: unknown } | null;
};

const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * Section 5.7b, 5.7c, 5.7e: reads `stop_reason` before `content`. `end_turn` -> the first `text` block after the last
 * `fallback` block (the first `text` block when there is none), `JSON.parse`d; `refusal` -> `refused` (with
 * `stop_details.category` when present); `max_tokens` -> `truncated`; anything else -> `invalid_output`. A
 * `fallback` block or a `fallback_message` usage iteration sets `fallbackUsed`; both are read defensively. Pure.
 */
export function interpretAnthropicResponse(message: BetaMessage | LooseMessage, requestedGeo: string): SummaryProviderResult {
  const m = message as LooseMessage;
  const stop = m.stop_reason;
  if (stop === 'refusal') {
    const category = typeof m.stop_details?.category === 'string' ? m.stop_details.category : null;
    return fail('refused', category ? `refused: ${category}` : 'refused');
  }
  if (stop === 'max_tokens') return fail('truncated', 'stop_reason max_tokens');
  if (stop !== 'end_turn') return fail('invalid_output', `stop_reason ${typeof stop === 'string' ? stop : 'missing'}`);
  const content: LooseBlock[] = Array.isArray(m.content) ? (m.content as LooseBlock[]) : [];
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b?.type === 'fallback') lastFallback = i;
  });
  const answer = content.slice(lastFallback + 1).find((b) => b?.type === 'text' && typeof b.text === 'string');
  if (!answer) return fail('invalid_output', 'no text block');
  let output: unknown;
  try {
    output = JSON.parse(answer.text as string);
  } catch {
    return fail('invalid_output', 'text is not JSON');
  }
  const iterations = Array.isArray(m.usage?.iterations) ? (m.usage.iterations as { type?: unknown }[]) : [];
  const fallbackUsed = lastFallback >= 0 || iterations.some((it) => it?.type === 'fallback_message');
  const geo = m.usage?.inference_geo;
  return {
    ok: true,
    output,
    servedModel: typeof m.model === 'string' ? m.model : 'unknown',
    inferenceGeo: typeof geo === 'string' && geo !== '' ? geo : requestedGeo,
    fallbackUsed,
    usage: { inputTokens: intOrNull(m.usage?.input_tokens), outputTokens: intOrNull(m.usage?.output_tokens) },
  };
}

/** `retry-after` in seconds (delta seconds or an HTTP date); null when absent or unreadable. */
export function retryAfterSeconds(headers: Headers | undefined | null, now: number = Date.now()): number | null {
  const v = headers?.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - now) / 1000));
}

/**
 * Section 5.7d: the SDK's typed errors, most specific first. An abort of the caller's signal (the worker's attempt
 * deadline) is a `timeout`, like the SDK's own connection timeout.
 */
export function mapAnthropicError(err: unknown): Extract<SummaryProviderResult, { ok: false }> {
  const out = (cause: Extract<SummaryProviderResult, { ok: false }>['cause'], detail: string, retry: number | null = null) =>
    fail(cause, detail, retry) as Extract<SummaryProviderResult, { ok: false }>;
  const tag = (e: InstanceType<typeof Anthropic.APIError>) => `anthropic ${e.status ?? '-'}${e.type ? ` ${e.type}` : ''}`;
  if (err instanceof Anthropic.APIUserAbortError) return out('timeout', 'anthropic request aborted at the attempt deadline');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return out('auth', tag(err));
  if (err instanceof Anthropic.RateLimitError) return out('rate_limited', tag(err), retryAfterSeconds(err.headers));
  if (err instanceof Anthropic.BadRequestError) return out('bad_request', tag(err));
  if (err instanceof Anthropic.APIConnectionTimeoutError) return out('timeout', 'anthropic connection timeout');
  if (err instanceof Anthropic.APIConnectionError) return out('provider_unavailable', 'anthropic connection error');
  if (err instanceof Anthropic.InternalServerError) return out('provider_unavailable', tag(err));
  if (err instanceof Anthropic.APIError) {
    if (typeof err.status === 'number' && err.status >= 500) return out('provider_unavailable', tag(err));
    return out('bad_request', tag(err));
  }
  return out('provider_unavailable', `anthropic client error: ${err instanceof Error ? err.name : 'unknown'}`);
}

export type AnthropicClientOptions = {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  /** Tests: the in-process fake. Production: the global fetch. */
  fetch?: typeof fetch;
  /** Tests: the fake's origin. Production: the SDK default (set explicitly so `ANTHROPIC_BASE_URL` cannot redirect it). */
  baseURL?: string;
};

/** One client per node (section 5.7). */
export function createAnthropicClient(o: AnthropicClientOptions): Anthropic {
  return new Anthropic({
    apiKey: o.apiKey,
    baseURL: o.baseURL ?? 'https://api.anthropic.com',
    // Milliseconds in the TypeScript SDK; bounds one attempt.
    timeout: o.timeoutMs,
    // 0 by default (the SDK's own default is 2): the worker owns retries (5.8d).
    maxRetries: o.maxRetries,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
}

export type ProviderLog = { error: (obj: object, msg: string) => void };

export class AnthropicSummaryProvider implements SummaryProvider {
  readonly kind = 'anthropic' as const;
  constructor(
    private readonly client: Anthropic,
    readonly model: string = ANTHROPIC_DEFAULT_MODEL,
    private readonly log?: ProviderLog,
  ) {}

  async summarize(
    input: SummaryPromptInput,
    opts: { signal: AbortSignal; region: Region; ackScope: AiAckScope | null },
  ): Promise<SummaryProviderResult> {
    const request = buildAnthropicRequest(input, opts.region, opts.ackScope, this.model);
    try {
      const message = await this.client.beta.messages.create(request, { signal: opts.signal });
      return interpretAnthropicResponse(message, request.inference_geo ?? 'global');
    } catch (err) {
      const r = mapAnthropicError(err);
      // 5.7d: an auth failure is the operator's to fix; logged at error, without any request content.
      if (r.cause === 'auth') this.log?.error({ provider: 'anthropic', cause: r.cause, detail: r.detail }, 'anthropic summary provider rejected the operator key');
      return r;
    }
  }
}
