/**
 * The "Confirm security code" step of section 1.3 step 7: the technician types the six digits the user reads out,
 * the console compares locally in constant time (shared `sasMatches`), three attempts, then the step re-arms after
 * 10 s. Pure (time is passed in) so it is unit tested without timers.
 */
import { sasMatches } from '@indiansassist/shared';

export const SAS_ATTEMPTS = 3;
export const SAS_LOCK_MS = 10_000;

export type SasGateState = { attempts: number; lockedUntil: number };
export const SAS_GATE_INITIAL: SasGateState = { attempts: 0, lockedUntil: 0 };

export type SasCheck = { result: 'ok' | 'wrong' | 'locked'; state: SasGateState; attemptsLeft: number };

export function checkSas(state: SasGateState, typed: string, sas: string, now: number): SasCheck {
  if (now < state.lockedUntil) return { result: 'locked', state, attemptsLeft: 0 };
  const base = state.lockedUntil !== 0 && now >= state.lockedUntil ? SAS_GATE_INITIAL : state;
  if (sasMatches(typed, sas)) return { result: 'ok', state: SAS_GATE_INITIAL, attemptsLeft: SAS_ATTEMPTS };
  const attempts = base.attempts + 1;
  if (attempts >= SAS_ATTEMPTS) return { result: 'locked', state: { attempts, lockedUntil: now + SAS_LOCK_MS }, attemptsLeft: 0 };
  return { result: 'wrong', state: { attempts, lockedUntil: 0 }, attemptsLeft: SAS_ATTEMPTS - attempts };
}
