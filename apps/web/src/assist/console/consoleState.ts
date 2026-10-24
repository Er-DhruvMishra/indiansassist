/** Assist console snapshot types, the initial snapshot and the Phase A.2 server recording badge state (U4). */
import {
  serverRecords,
  type Recording,
  type RecordingMode,
  type SessionCreated,
  type SessionEnded,
} from '@indiansassist/shared';
import { EMPTY_ANNOT, type AnnotState } from '../../lib/annotation';
import type { Transfer } from '../../lib/fileTransfer';
import type { ChatItem } from '../../lib/link';
import { EMPTY_STATS, type NetStats } from '../../lib/stats';
import type { RecordingFailure, RecordingPhase } from './consoleRecording';

export type ConsolePhase = 'resuming' | 'waiting_consent' | 'connecting' | 'live' | 'reconnecting' | 'ending' | 'ended';

/** A.2 U4: `none` = the session's mode has no server recorder; `waiting` = assigned but not joined yet. */
export type ServerRecordingState = 'none' | 'waiting' | 'on' | 'stopped';

export type ConsoleSnapshot = {
  phase: ConsolePhase;
  created: SessionCreated | null;
  /** A.2 M1: the session's recording policy snapshot (`session.created`, else the REST `Session`); null = unknown. */
  recordingMode: RecordingMode | null;
  serverRecording: ServerRecordingState;
  remoteVideo: MediaStream | null;
  remoteAudio: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  chat: ChatItem[];
  peerTyping: boolean;
  transfers: Transfer[];
  annot: AnnotState;
  voiceOn: boolean;
  muted: boolean;
  peerMuted: boolean | null;
  recording: RecordingPhase;
  recordingUsed: boolean;
  recordingFailure: RecordingFailure;
  uploadProgress: number;
  recordingResult: Recording | null;
  net: NetStats;
  /** Time to first frame (section 13.2): `consent.changed granted` to the first drawn remote frame. */
  ttffMs: number | null;
  relayOnly: boolean;
  ended: SessionEnded | null;
  notice: string | null;
  error: string | null;
};

export const CONSOLE_INITIAL: ConsoleSnapshot = {
  phase: 'resuming',
  created: null,
  recordingMode: null,
  serverRecording: 'none',
  remoteVideo: null,
  remoteAudio: null,
  connectionState: 'new',
  chat: [],
  peerTyping: false,
  transfers: [],
  annot: EMPTY_ANNOT,
  voiceOn: false,
  muted: false,
  peerMuted: null,
  recording: 'idle',
  recordingUsed: false,
  recordingFailure: null,
  uploadProgress: 0,
  recordingResult: null,
  net: EMPTY_STATS,
  ttffMs: null,
  relayOnly: false,
  ended: null,
  notice: null,
  error: null,
};

/**
 * The badge after learning the session's mode (and, from REST, whether the recorder ever joined). A live
 * `session.recording { source: 'server' }` always wins: `wsSeen` keeps a REST load from overriding it.
 */
export function serverRecordingFromPolicy(
  current: ServerRecordingState,
  mode: RecordingMode | null | undefined,
  joined: boolean | undefined,
  wsSeen: boolean,
): ServerRecordingState {
  if (wsSeen || current === 'on' || current === 'stopped') return current;
  if (joined) return 'on';
  return serverRecords(mode) ? 'waiting' : current;
}
