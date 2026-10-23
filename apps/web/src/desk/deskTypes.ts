/** Desk room state types and the initial snapshot. */
import type { ConsentSurface, DeskHelloOk, SessionCreated, SessionEnded, SignalError } from '@indiansassist/shared';
import { EMPTY_ANNOT, type AnnotState } from '../lib/annotation';
import type { Transfer } from '../lib/fileTransfer';
import type { ChatItem } from '../lib/link';
import type { SignalStatus } from '../lib/signal';

export type { ConsentSurface, SessionEnded };
export type UserRefLike = { id: string; name: string };

export type DeskPhase = 'connecting' | 'waiting' | 'held' | 'consent' | 'picking' | 'starting' | 'sharing' | 'ending' | 'ended' | 'error';

export type DeskSnapshot = {
  phase: DeskPhase;
  signalStatus: SignalStatus;
  hello: DeskHelloOk | null;
  sessionId: string | null;
  created: SessionCreated | null;
  surface: ConsentSurface | null;
  localStream: MediaStream | null;
  sharingSince: number | null;
  /** D3: the banner's red dot, `recordingWs || recordingCtrl` (either source; neither can clear the other). */
  recording: boolean;
  /** Server-attested WS `session.recording` (only a WS `recording: false` may clear it). */
  recordingWs: boolean;
  /** Assist's `recording.state` on `ia.ctrl`; reset whenever the channel goes away. */
  recordingCtrl: boolean;
  recordingSeen: boolean;
  /** The media connection failed or dropped and ICE is being restarted (correctness-F6). */
  mediaReconnecting: boolean;
  chat: ChatItem[];
  peerTyping: boolean;
  transfers: Transfer[];
  annot: AnnotState;
  voiceOn: boolean;
  muted: boolean;
  peerMuted: boolean | null;
  remoteAudio: MediaStream | null;
  ended: SessionEnded | null;
  error: SignalError | null;
  notice: string | null;
  technicianOnline: boolean;
};

export const DESK_INITIAL: DeskSnapshot = {
  phase: 'connecting',
  signalStatus: 'idle',
  hello: null,
  sessionId: null,
  created: null,
  surface: null,
  localStream: null,
  sharingSince: null,
  recording: false,
  recordingWs: false,
  recordingCtrl: false,
  recordingSeen: false,
  mediaReconnecting: false,
  chat: [],
  peerTyping: false,
  transfers: [],
  annot: EMPTY_ANNOT,
  voiceOn: false,
  muted: false,
  peerMuted: null,
  remoteAudio: null,
  ended: null,
  error: null,
  notice: null,
  technicianOnline: false,
};
