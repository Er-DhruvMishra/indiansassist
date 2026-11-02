/**
 * Phase E section 5.1: the summary provider seam (stream ai). `AppContext.summaryProviders(region)` defaults to
 * `noSummaryProviders` in app.ts; `aiRoutes` replaces that default with `buildSummaryProviders(config.ai)` (operator
 * configuration, section 5.2a) unless the app was given its own; tests install FakeSummaryProvider instances.
 */
import type { AiAckScope, Region, SummaryFailCause, SummaryPromptInput } from '@indiansassist/shared';
import type { AiConfig } from '../config.js';
import { AnthropicSummaryProvider, createAnthropicClient, type ProviderLog } from './anthropic.js';
import { LocalSummaryProvider } from './local.js';

export type SummaryProviderResult =
  | {
      ok: true;
      /** Validated by the caller with sessionSummaryOutputSchema. */
      output: unknown;
      servedModel: string;
      inferenceGeo: string | null;
      fallbackUsed: boolean;
      usage: { inputTokens: number | null; outputTokens: number | null };
    }
  | {
      ok: false;
      cause: SummaryFailCause;
      /** <= 200, never prompt or output text. */
      detail: string;
      retryAfterSec: number | null;
    };

export interface SummaryProvider {
  readonly kind: 'local' | 'anthropic';
  readonly model: string;
  summarize(input: SummaryPromptInput, opts: { signal: AbortSignal; region: Region; ackScope: AiAckScope | null }): Promise<SummaryProviderResult>;
}

/** What `ctx.summaryProviders(region)` returns: the providers this node can serve for one region. */
export type RegionSummaryProviders = { local: SummaryProvider | null; anthropic: SummaryProvider | null };

/** The foundation default: no provider anywhere (the ai stream replaces it when `aiRoutes` registers). */
export function noSummaryProviders(_region: Region): RegionSummaryProviders {
  return { local: null, anthropic: null };
}

export type BuildProvidersOptions = {
  /** Tests: the fetch both providers use (the in-process fakes). */
  localFetch?: typeof fetch;
  anthropicFetch?: typeof fetch;
  anthropicBaseURL?: string;
  log?: ProviderLog;
};

/**
 * Section 5.2a / 5.2c: the providers this node serves, from operator configuration (per region, never per org):
 * `local` where `AI_LOCAL_ENDPOINTS` names the region; `anthropic` where the region is in `AI_ANTHROPIC_REGIONS`
 * and `AI_ANTHROPIC_API_KEY` is set. One Anthropic client per node, built on first use.
 */
export function buildSummaryProviders(ai: AiConfig, o: BuildProvidersOptions = {}): (region: Region) => RegionSummaryProviders {
  const locals = new Map<Region, LocalSummaryProvider>();
  let anthropic: AnthropicSummaryProvider | null = null;
  return (region) => {
    let local: LocalSummaryProvider | null = null;
    const baseUrl = ai.local.endpoints[region];
    if (baseUrl) {
      local = locals.get(region) ?? null;
      if (!local) {
        local = new LocalSummaryProvider({
          baseUrl,
          model: ai.local.model,
          apiKey: ai.local.apiKey,
          timeoutMs: ai.local.timeoutMs,
          ...(o.localFetch ? { fetch: o.localFetch } : {}),
        });
        locals.set(region, local);
      }
    }
    let remote: AnthropicSummaryProvider | null = null;
    if (ai.anthropic.apiKey !== '' && ai.anthropic.regions.includes(region)) {
      anthropic ??= new AnthropicSummaryProvider(
        createAnthropicClient({
          apiKey: ai.anthropic.apiKey,
          timeoutMs: ai.anthropic.timeoutMs,
          maxRetries: ai.anthropic.maxRetries,
          ...(o.anthropicFetch ? { fetch: o.anthropicFetch } : {}),
          ...(o.anthropicBaseURL ? { baseURL: o.anthropicBaseURL } : {}),
        }),
        ai.anthropic.model,
        o.log,
      );
      remote = anthropic;
    }
    return { local, anthropic: remote };
  };
}

/** The attempt deadline of a provider: its own timeout (sections 5.6, 5.7d). */
export function providerTimeoutMs(ai: AiConfig, kind: 'local' | 'anthropic'): number {
  return kind === 'local' ? ai.local.timeoutMs : ai.anthropic.timeoutMs;
}
