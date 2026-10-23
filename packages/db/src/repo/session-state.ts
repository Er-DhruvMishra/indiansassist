/** The section 7.4 session state machine as data, shared by the repository guard and the API. */
import { SESSION_STATES, type SessionState } from '@indiansassist/shared';

/**
 * Allowed `from -> to` edges. `active -> consent_pending` is the Desk resume edge (section 7.5); every non-ended
 * state may end; `ended` is terminal. Resumes that leave the state unchanged are not transitions.
 */
export const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  knocked: ['accepted', 'ended'],
  accepted: ['consent_pending', 'ended'],
  consent_pending: ['active', 'ended'],
  active: ['consent_pending', 'ended'],
  ended: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

/** Every state from which `to` is reachable in one step. */
export function statesLeadingTo(to: SessionState): SessionState[] {
  return SESSION_STATES.filter((s) => canTransition(s, to));
}

export const NON_ENDED_STATES: readonly SessionState[] = SESSION_STATES.filter((s) => s !== 'ended');
