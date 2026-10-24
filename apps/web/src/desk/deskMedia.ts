/** Desk capture helpers (contracts sections 7.7 and 12.1 D2 / D6). */
import { REGION_LABELS, serverRecords, type RecordingMode, type Region } from '@indiansassist/shared';
import type { ConsentSurface, DeskSnapshot, SessionEnded, UserRefLike } from './deskTypes';

/** A.2 U1: the consent screen's server recording paragraph for modes `server` / `both`, else null. */
export function serverRecordingNotice(mode: RecordingMode | null | undefined, orgName: string, region: Region | null | undefined): string | null {
  if (!serverRecords(mode)) return null;
  const where = region ? REGION_LABELS[region] : "the organisation's data region";
  const text =
    `This session will be recorded by ${orgName}'s server. The recording contains your shared screen and, if you turn it on, your microphone. ` +
    `It is stored in ${where} and its fingerprint is written to a tamper-evident audit log.`;
  return mode === 'both' ? `${text} Your technician may also record the session from their console.` : text;
}

/** A.2 U2: "Recording (server)" when only the server recorder records, else "Recording". */
export function recordingLabel(snap: Pick<DeskSnapshot, 'recordingServer' | 'recordingWs' | 'recordingCtrl'>): string {
  return snap.recordingServer && !snap.recordingWs && !snap.recordingCtrl ? 'Recording (server)' : 'Recording';
}

/** Section 7.7 options; `monitorTypeSurfaces` follows the "single window" toggle. */
export function displayMediaOptions(singleWindow: boolean): DisplayMediaStreamOptions {
  return {
    video: { frameRate: { ideal: 15, max: 30 } },
    audio: false,
    surfaceSwitching: 'include',
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: singleWindow ? 'exclude' : 'include',
  } as DisplayMediaStreamOptions;
}

/** `track.getSettings().displaySurface`, else `unknown` (D2). */
export function surfaceOf(track: MediaStreamTrack | undefined): ConsentSurface {
  const s = (track?.getSettings?.() as { displaySurface?: string } | undefined)?.displaySurface;
  return s === 'monitor' || s === 'window' || s === 'browser' ? s : 'unknown';
}

/** A `session.ended` built from local state when the server's push does not arrive (slow or lost socket). */
export function localEnded(input: {
  sessionId: string;
  reason: SessionEnded['endReason'];
  sharingSince: number | null;
  assist: UserRefLike;
  surface: ConsentSurface | null;
  recordingSeen: boolean;
  serverRecordingSeen?: boolean;
  now?: number;
}): SessionEnded {
  const now = input.now ?? Date.now();
  const since = input.sharingSince;
  return {
    t: 'session.ended',
    sessionId: input.sessionId,
    endReason: input.reason,
    endedAt: new Date(now).toISOString(),
    startedAt: since ? new Date(since).toISOString() : null,
    durationMs: since ? now - since : null,
    hashChainTail: null,
    assist: input.assist,
    surface: input.surface,
    recordingStarted: input.recordingSeen,
    reachedActive: since !== null,
    serverRecording: input.serverRecordingSeen ?? false,
  };
}
