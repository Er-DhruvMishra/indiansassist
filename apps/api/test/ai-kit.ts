/** Phase E stream ai test helpers: a scripted FakeSummaryProvider and small policy / chain helpers. */
import type { AiAckScope, AiPolicy, Region, SummaryPromptInput } from '@indiansassist/shared';
import { auditEntry, org as orgTable } from '@indiansassist/db';
import { asc, eq } from 'drizzle-orm';
import type { RegionSummaryProviders, SummaryProvider, SummaryProviderResult } from '../src/ai/provider.js';
import type { TestApp } from './helpers.js';

export const GOOD_OUTPUT = {
  summary: 'The technician cleared a stuck print job and restarted the spooler.',
  outcome: 'resolved',
  actionsTaken: ['Cleared the print queue', 'Restarted the spooler'],
  issuesFound: ['A stuck print job'],
  followUps: [],
  ticketNote: 'Cleared the print queue and restarted the print spooler; printing works again.',
};

type Step = SummaryProviderResult | ((input: SummaryPromptInput) => SummaryProviderResult | Promise<SummaryProviderResult>);

/** Records every input it receives and answers from a script (the last step repeats). */
export class FakeSummaryProvider implements SummaryProvider {
  readonly inputs: SummaryPromptInput[] = [];
  readonly calls: { region: Region; ackScope: AiAckScope | null }[] = [];
  constructor(
    readonly kind: 'local' | 'anthropic',
    private readonly steps: Step[] = [FakeSummaryProvider.ok()],
    readonly model = kind === 'local' ? 'fake-local-model' : 'claude-opus-5-5',
  ) {}

  static ok(output: unknown = GOOD_OUTPUT, extra: Partial<Extract<SummaryProviderResult, { ok: true }>> = {}): SummaryProviderResult {
    return { ok: true, output, servedModel: 'fake-served-model', inferenceGeo: 'in-mum', fallbackUsed: false, usage: { inputTokens: 100, outputTokens: 50 }, ...extra };
  }

  static fail(cause: Extract<SummaryProviderResult, { ok: false }>['cause'], retryAfterSec: number | null = null): SummaryProviderResult {
    return { ok: false, cause, detail: `fake ${cause}`, retryAfterSec };
  }

  async summarize(input: SummaryPromptInput, opts: { signal: AbortSignal; region: Region; ackScope: AiAckScope | null }): Promise<SummaryProviderResult> {
    this.inputs.push(input);
    this.calls.push({ region: opts.region, ackScope: opts.ackScope });
    const step = this.steps.length > 1 ? this.steps.shift()! : this.steps[0]!;
    return typeof step === 'function' ? step(input) : step;
  }
}

/** Installs fakes for every region (null = not served). */
export function useProviders(t: TestApp, p: Partial<RegionSummaryProviders>): void {
  t.ctx.summaryProviders = () => ({ local: p.local ?? null, anthropic: p.anthropic ?? null });
}

/** Writes an org policy directly (tests of the lifecycle; the PATCH route is covered by ai-policy.test.ts). */
export async function setPolicy(t: TestApp, orgId: string, policy: Partial<AiPolicy>): Promise<void> {
  const full: AiPolicy = { provider: 'local', autoSummarize: false, includeTranscript: false, anthropicAck: null, ...policy };
  await t.db.update(orgTable).set({ aiPolicy: full }).where(eq(orgTable.id, orgId));
}

export type ChainRow = { action: string; actorType: string; sessionId: string | null; data: Record<string, unknown>; reason: string | null };

export async function chainOf(t: TestApp, orgId: string): Promise<ChainRow[]> {
  const rows = await t.db.select().from(auditEntry).where(eq(auditEntry.orgId, orgId)).orderBy(asc(auditEntry.seq));
  return rows.map((r) => ({ action: r.action, actorType: r.actorType, sessionId: r.sessionId, data: r.data as Record<string, unknown>, reason: r.reason }));
}
