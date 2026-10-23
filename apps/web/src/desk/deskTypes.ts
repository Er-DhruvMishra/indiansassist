/** Desk room state types. */
import type { ConsentSurface, DeskHelloOk, SessionCreated, SessionEnded, SignalError } from '@indiansassist/shared';
import type { AnnotState } from '../lib/annotation';
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
  recording: boolean;
  recordingSeen: boolean;
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
