/**
 * The action indicator (section 3.3): badge text and colour, title and icon follow the session phase, the
 * debugger state and backstage tabs. None of it can be turned off.
 */
import type { ExtensionPhase } from '../shared/constants';
import { ext } from '../shared/api';

export type BadgeInput = { phase: ExtensionPhase; technician: string | null; debuggerAttached: boolean; backstageCount: number };
export type Badge = { text: string; color: string; title: string; live: boolean };

const PENDING: readonly ExtensionPhase[] = ['waiting', 'held', 'knocked', 'consent_pending', 'connecting', 'have_token'];

export function computeBadge(i: BadgeInput): Badge {
  const who = i.technician ?? 'your technician';
  if (i.phase === 'active') {
    const title = `IndiansAssist: sharing with ${who}${i.backstageCount > 0 ? ' (background tab open)' : ''}`;
    if (i.debuggerAttached) return { text: 'DBG', color: '#b91c1c', title, live: true };
    return { text: 'ON', color: '#15803d', title, live: true };
  }
  if (PENDING.includes(i.phase)) return { text: '...', color: '#a16207', title: `IndiansAssist: connecting to ${who}`, live: false };
  return { text: '', color: '#15803d', title: 'IndiansAssist', live: false };
}

let last = '';

export async function applyBadge(i: BadgeInput): Promise<void> {
  const b = computeBadge(i);
  const key = JSON.stringify(b);
  if (key === last) return;
  last = key;
  const a = ext().action;
  try {
    await a.setBadgeText({ text: b.text });
    await a.setBadgeBackgroundColor({ color: b.color });
    await a.setTitle({ title: b.title });
    await a.setIcon({ path: b.live ? { '16': 'icons/live-16.png', '32': 'icons/live-32.png' } : { '16': 'icons/16.png', '32': 'icons/32.png' } });
  } catch {
    last = '';
  }
}
