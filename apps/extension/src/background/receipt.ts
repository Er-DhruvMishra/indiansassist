/**
 * The P2 consent receipt (section 7 "Session info", A D6): built from local state only and shown in the side
 * panel after the end, with a JSON download.
 */
import type { SessionEnded } from '@indiansassist/shared';
import type { PersistedSession } from '../shared/storage';
import type { Receipt } from '../shared/ui-state';

export function buildReceipt(s: PersistedSession, ended: SessionEnded | null, reason: string, now: number): Receipt {
  const endedAt = ended?.endedAt ?? new Date(now).toISOString();
  const startedAt = ended?.startedAt ?? (s.startedAt ? new Date(s.startedAt).toISOString() : null);
  const durationMs = ended?.durationMs ?? (s.startedAt ? Math.max(0, now - s.startedAt) : null);
  return {
    sessionId: s.sessionId ?? '',
    org: s.org?.displayName ?? '',
    technician: ended?.assist.name ?? s.assist?.name ?? s.technician ?? '',
    startedAt,
    endedAt,
    durationMs,
    endReason: ended?.endReason ?? reason,
    surface: 'browser',
    recordingSeen: s.log.recordingSeen || (ended?.recordingStarted ?? false),
    hashChainTail: ended?.hashChainTail ?? null,
    tabsShared: s.log.tabsShared.map((t) => ({ ...t, to: t.to ?? endedAt })),
    levelChanges: [...s.log.levelChanges],
    unmasks: [...s.log.unmasks],
    backstage: [...s.log.backstage],
    tabActions: s.counters.tabActions,
    inputs: s.counters.inputs,
    relayed: s.counters.relayed,
  };
}
