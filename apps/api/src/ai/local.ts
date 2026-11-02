/**
 * Phase E section 5.6: the `local` summary provider. Any operator-run server that serves the common chat-completions
 * JSON shape (vLLM, llama.cpp `llama-server`, Ollama, LocalAI). Operator infrastructure, possibly on a private
 * address, so the egress guard of section 2.2 does not apply; a plain `fetch` with a timeout, no SDK. The bearer is
 * sent only when `AI_LOCAL_API_KEY` is set; prompt and answer text are never logged.
 */
import {
  SESSION_SUMMARY_JSON_SCHEMA,
  SUMMARY_SYSTEM_PROMPT,
  renderSummaryInput,
  type AiAckScope,
  type Region,
  type SummaryPromptInput,
} from '@indiansassist/shared';
import { retryAfterSeconds } from './anthropic.js';
import type { SummaryProvider, SummaryProviderResult } from './provider.js';

export type LocalProviderOptions = {
  /** `AI_LOCAL_ENDPOINTS[region]`, without a trailing slash. */
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
};

type Fail = Extract<SummaryProviderResult, { ok: false }>;
const fail = (cause: Fail['cause'], detail: string, retryAfterSec: number | null = null): Fail => ({
  ok: false,
  cause,
  detail: detail.slice(0, 200),
  retryAfterSec,
});

/** Section 5.6: the request body (pure; exported for the request-shape test). */
export function buildLocalRequest(input: SummaryPromptInput, model: string): Record<string, unknown> {
  return {
    model,
    stream: false,
    temperature: 0,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: renderSummaryInput(input) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'ia_session_summary', strict: true, schema: SESSION_SUMMARY_JSON_SCHEMA },
    },
  };
}

const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

export class LocalSummaryProvider implements SummaryProvider {
  readonly kind = 'local' as const;
  readonly model: string;
  constructor(private readonly o: LocalProviderOptions) {
    this.model = o.model;
  }

  async summarize(
    input: SummaryPromptInput,
    opts: { signal: AbortSignal; region: Region; ackScope: AiAckScope | null },
  ): Promise<SummaryProviderResult> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const signal = AbortSignal.any([opts.signal, timeout]);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.o.apiKey) headers.authorization = `Bearer ${this.o.apiKey}`;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildLocalRequest(input, this.model)),
        signal,
      });
    } catch (err) {
      if (signal.aborted) return fail('timeout', `local model server did not answer within ${this.o.timeoutMs} ms`);
      return fail('provider_unavailable', `local model server unreachable (${err instanceof Error ? err.name : 'error'})`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const s = res.status;
      if (s === 401 || s === 403) return fail('auth', `local ${s}`);
      if (s === 429) return fail('rate_limited', 'local 429', retryAfterSeconds(res.headers));
      if (s >= 500) return fail('provider_unavailable', `local ${s}`);
      return fail('bad_request', `local ${s}`);
    }
    let body: { model?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: Record<string, unknown> };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      if (signal.aborted) return fail('timeout', `local model server did not answer within ${this.o.timeoutMs} ms`);
      return fail('invalid_output', 'response is not JSON');
    }
    const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
    if (!choice) return fail('invalid_output', 'no choices');
    if (choice.finish_reason === 'length') return fail('truncated', 'finish_reason length');
    const content = choice.message?.content;
    if (typeof content !== 'string') return fail('invalid_output', 'no message content');
    let output: unknown;
    try {
      output = JSON.parse(content);
    } catch {
      return fail('invalid_output', 'content is not JSON');
    }
    return {
      ok: true,
      output,
      servedModel: typeof body.model === 'string' && body.model !== '' ? body.model.slice(0, 100) : this.model,
      // 5.6: the operator's assertion of 5.2a (the server runs inside this region).
      inferenceGeo: opts.region,
      fallbackUsed: false,
      usage: { inputTokens: intOrNull(body.usage?.prompt_tokens), outputTokens: intOrNull(body.usage?.completion_tokens) },
    };
  }
}
