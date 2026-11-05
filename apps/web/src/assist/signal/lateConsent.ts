/**
 * The `consent.changed` a native console could miss. The server does not buffer it, and a native (P3 / P4) console
 * reads its consent level only from it: an agent that consents within a second or two of the accept (the e2e
 * `--auto-consent`, or a quick user) can answer before the session page has mounted its controller, which then sits
 * at "View only" for the whole session. The always-mounted signal provider keeps the latest one per accepted session
 * here, keyed by that session's cached `session.created`, and the controller applies it when it starts.
 */
import type { SessionCreated } from '@indiansassist/shared';

export type ConsentChangedLike = {
  sessionId?: string;
  state?: string;
  level?: unknown;
  monitors?: number;
  clipboard?: boolean;
};

const latest = new WeakMap<SessionCreated, ConsentChangedLike>();

export function rememberLateConsent(created: SessionCreated, m: ConsentChangedLike): void {
  latest.set(created, m);
}

export function lateConsentFor(created: SessionCreated | undefined): ConsentChangedLike | undefined {
  return created ? latest.get(created) : undefined;
}
