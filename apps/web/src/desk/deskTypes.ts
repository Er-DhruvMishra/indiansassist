/** Desk room state types and the initial snapshot. */
import type { ConsentSurface, DeskHelloOk, SessionCreated, SessionEnded, SignalError } from '@indiansassist/shared';
import { EMPTY_ANNOT, type AnnotState } from '../lib/annotation';
import type { Transfer } from '../lib/fileTransfer';
import type { ChatItem } from '../lib/link';
import type { GetUserMedia } from '../lib/sessionBase';
import type { SignalStatus } from '../lib/signal';

export type { ConsentSurface, SessionEnded };
export type UserRefLike = { id: string; name: string };

export type DeskDeps = {
  url: string;
  token: string;
  deskLabel?: string;
  resume?: { sessionId: string; resumeKey: string } | null;
  onSession?: (sessionId: string) => void;
  getDisplayMedia?: (o: DisplayMediaStreamOptions) => Promise<MediaStream>;
  getUserMedia?: GetUserMedia;
  WebSocketImpl?: typeof WebSocket;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
  pollMs?: number;
};

/** Signal error codes after which the Desk room cannot continue. */
export const DESK_FATAL_CODES: ReadonlySet<string> = new Set(['token_malformed', 'token_bad_signature', 'token_not_found', 'token_gone', 'region_mismatch', 'token_busy', 'join_unsupported', 'not_authenticated']);

/** How long the Desk waits for the server's `session.ended` before showing its local receipt. */
export const LOCAL_END_FALLBACK_MS = 5000;

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
  /** D3 / A.2 U2: the banner's red dot, any of the three sources below (none can clear another). */
  recording: boolean;
  /** Server-attested WS `session.recording` of the Assist console (`source` absent or `assist`). */
  recordingWs: boolean;
  /** Assist's `recording.state` on `ia.ctrl`; reset whenever the channel goes away. */
  recordingCtrl: boolean;
  /** A.2 S1: WS `session.recording { source: 'server' }` (the server recorder joined). */
  recordingServer: boolean;
  /** The Assist console recorded during this share (the receipt's "Recorded"). */
  recordingSeen: boolean;
  /** The server recorder joined during this share (the local receipt's "Server recording"). */
  serverRecordingSeen: boolean;
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
  recordingServer: false,
  recordingSeen: false,
  serverRecordingSeen: false,
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
