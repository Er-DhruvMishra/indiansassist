/** Desk capture helpers (contracts sections 7.7 and 12.1 D2 / D6). */
import type { ConsentSurface, SessionEnded, UserRefLike } from './deskTypes';

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
  };
}
