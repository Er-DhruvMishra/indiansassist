/**
 * Phase E section 5.1: the summary provider seam (stream ai). The foundation lands the types `AppContext` needs
 * (`summaryProviders(region)`, null for both until the ai stream builds them); tests replace it with fakes.
 */
import type { AiAckScope, Region, SummaryFailCause, SummaryPromptInput } from '@indiansassist/shared';

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

/** The foundation default: no provider anywhere (the ai stream replaces it). */
export function noSummaryProviders(_region: Region): RegionSummaryProviders {
  return { local: null, anthropic: null };
}
