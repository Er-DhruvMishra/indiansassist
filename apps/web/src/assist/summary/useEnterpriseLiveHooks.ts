/**
 * The live-console hook of Phase E (docs/specs/phase-e-contracts.md sections 5.3a, 5.3b, 13.4, stream ai): sends the
 * transcript notice once at `active` when the org policy includes the transcript, keeps the post-notice chat and the
 * playbook output tails, redacts them with one RedactionState and uploads them at session end. The foundation calls
 * it from every live console; it is a no-op until the ai stream fills it.
 */
import type { PackageTier } from '@indiansassist/shared';

/** What a live console knows about its session when it calls the hook. */
export type EnterpriseLiveSession = { sessionId: string; tier: PackageTier | null };

export function useEnterpriseLiveHooks(_session: EnterpriseLiveSession): void {
  // No-op until the ai stream lands section 5.3.
}
