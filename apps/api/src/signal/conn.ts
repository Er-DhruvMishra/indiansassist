/**
 * One `/signal` socket and the per-session live registry entry (contracts section 7.2). A Conn talks through a
 * Transport: the local WebSocket, or (on the node that owns a session) the presence bridge to the node that holds
 * the real socket (section 7.6 N1, bridge.ts).
 */
import { randomUUID } from 'node:crypto';
import {
  LIMITS,
  type ConsentLevel,
  type DeskClient,
  type ExtensionPolicy,
  type MirrorScope,
  type PackageTier,
  type RecordingMode,
  type SessionPath,
  type SessionState,
  type SignalErrorCode,
} from '@indiansassist/shared';
import WebSocket from 'ws';
import type { Principal } from '../plugins/auth.js';
import { TokenBucket } from '../limiter.js';

export type DeskInfo = {
  tokenId: string;
  orgId: string;
  via: 'compact' | 'short_code';
  /** `desk.hello.deskLabel`, the fallback for `desk.knock.deskLabel`. */
  helloLabel: string | null;
  /** The session this socket is the Desk participant of (null while waiting). */
  sessionId: string | null;
  /** A knock is held for a technician (section 7.5). */
  held: boolean;
  heldLabel: string | null;
  /** `token.expires_at` (ms) seen at hello; a waiting / held Desk past it is told `token_gone` (section 3.2). */
  tokenExpiresAt: number;
  /** `desk.hello.client` (Phase B 2.4); null when absent (a web Desk). */
  client: DeskClient | null;
};

/** A helloed recorder socket (Phase A.2 section 4). */
export type RecorderInfo = { recorderId: string; maxSessions: number };

/** Where a Conn's frames go. */
export interface Transport {
  isOpen(): boolean;
  send(frame: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

export function wsTransport(ws: WebSocket): Transport {
  return {
    isOpen: () => ws.readyState === WebSocket.OPEN,
    send: (frame) => ws.send(frame),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  };
}

/** Most session ids one socket remembers a remote owner for. */
const MAX_ROUTES = 64;

export class Conn {
  side: 'assist' | 'desk' | 'recorder' | null = null;
  desk: DeskInfo | null = null;
  recorder: RecorderInfo | null = null;
  readonly openedAt = Date.now();
  lastInbound = Date.now();
  lastPingAt = Date.now();
  violations: number[] = [];
  queue: Promise<void> = Promise.resolve();
  /** The socket is gone (peer close, or our own close); replies become no-ops. */
  closed = false;
  /**
   * The server ended this connection on purpose (close(), rate-limit kick, shutdown): frames still queued are
   * dropped. A peer-initiated close does NOT set it, so frames received before the close are still handled
   * (e.g. the Desk's final `session.end` / `desk.consent revoked`), then onConnClosed runs.
   */
  terminated = false;
  /** Replaced by a larger bucket once a recorder says hello (A.2 H3). */
  bucket = new TokenBucket(20, 60);
  /**
   * `ping` / `pong` / `session.end` / `desk.consent` skip the frame bucket (Phase B Y25); this separate, generous
   * bucket only stops a flood of them.
   */
  readonly exemptBucket = new TokenBucket(20, 100);
  /** The upgrade carried `Origin: chrome-extension://<id>` (Y21): Desk messages only, never `assist.hello`. */
  extensionOrigin = false;
  /** Last time the cookie principal was re-validated against auth_session / user (section 7.2). */
  lastAuthCheckAt = Date.now();
  authCheckInFlight = false;
  /** A proxy, on a session's owner node, for a socket held by another node (bridge.ts). */
  readonly remote: boolean = false;
  /** Desk socket resumed onto a session owned by another node: every frame after hello is forwarded there. */
  pipeTo: string | null = null;
  /** Nodes this socket's frames were forwarded to (told `closed` when the socket goes). */
  readonly pipes = new Set<string>();
  /** Assist socket: session id -> owner node for sessions owned by another node. */
  readonly routes = new Map<string, string>();

  constructor(
    readonly transport: Transport,
    readonly ip: string,
    readonly userAgent: string | null,
    /** Resolved from the upgrade cookie; required for `assist.hello`. */
    public principal: Principal | null,
    readonly id: string = randomUUID(),
  ) {}

  route(sessionId: string, nodeId: string): void {
    if (this.routes.size >= MAX_ROUTES && !this.routes.has(sessionId)) {
      const oldest = this.routes.keys().next().value;
      if (oldest !== undefined) this.routes.delete(oldest);
    }
    this.routes.set(sessionId, nodeId);
  }

  get helloed(): boolean {
    return this.side !== null;
  }

  send(msg: Record<string, unknown>): void {
    if (this.closed || !this.transport.isOpen()) return;
    this.transport.send(JSON.stringify(msg));
  }

  /** Forwards an already-serialised frame verbatim (webrtc.* relay). */
  sendRaw(frame: string): void {
    if (this.closed || !this.transport.isOpen()) return;
    this.transport.send(frame);
  }

  error(code: SignalErrorCode, message: string, re?: string, details?: Record<string, unknown>): void {
    this.send({ t: 'error', ...(re !== undefined ? { re } : {}), code, message, ...(details ? { details } : {}) });
  }

  /** Records a rate violation; true when the connection has had `limit` of them within a minute. */
  strike(limit = 3): boolean {
    const now = Date.now();
    this.violations = this.violations.filter((t) => t > now - 60_000);
    this.violations.push(now);
    return this.violations.length >= limit;
  }

  close(code: number, reason = ''): void {
    this.terminated = true;
    if (this.closed) return;
    this.closed = true;
    try {
      this.transport.close(code, reason);
    } catch {
      this.transport.terminate();
    }
  }
}

/** WS relay counters of a session (Phase B 4.6), written to `mirror.relayed` before `session.ended`. */
export type RelayCounters = { mirrorFrames: number; mirrorBytes: number; controlFrames: number; dropped: number };

export type LiveConsent = { level: ConsentLevel; scope: MirrorScope; backstage: boolean };

/** Server recorder state of a live session (Phase A.2 section 6). */
export type LiveRecorder = {
  /** Open assignment: the socket asked to join, its deadline, sockets already tried this activation. */
  assignedConnId: string | null;
  assignedUntil: number;
  tried: Set<string>;
  resume: boolean;
  /** The joined (or paused) recorder socket and its id; kept while paused for a resume. */
  connId: string | null;
  recorderId: string | null;
  joined: boolean;
  /** `recording.server_started` / `recording.server_stopped` written. */
  started: boolean;
  stopped: boolean;
};

export type Live = {
  id: string;
  orgId: string;
  tokenId: string;
  tier: PackageTier;
  state: SessionState;
  path: SessionPath;
  /** The P2 consent decision in force (null for P1 or before consent). */
  consent: LiveConsent | null;
  /** The org extension policy of a P2 session, loaded at first use (live sessions are not re-policed). */
  policy: ExtensionPolicy | null;
  relay: RelayCounters;
  /** Phase A.2 M1 snapshot (null = before A.2). */
  recordingMode: RecordingMode | null;
  recorder: LiveRecorder;
  /** Sliding window of relayed `data` lengths (`[atMs, chars]`) for the per-session mirror budget. */
  relayWindow: [number, number][];
  /** `control.relay` per direction, 10 / s (Phase B 4.6). */
  controlBuckets: { assist: TokenBucket; desk: TokenBucket };
  /** `control.refused` entries: at most one per second per session; the rest are counted as suppressed. */
  refusedAt: number;
  refusedSuppressed: number;
  assistConnId: string | null;
  deskConnId: string | null;
  chatCount: number;
  chatClosed: boolean;
  lastStatsAt: number;
  /** Last `session.path_changed` write (at most one per PATH_CHANGE_MIN_MS, section 7.3). */
  lastPathChangeAt: number;
  /** Desk file attestations already written, `${direction}:${fileId}` -> entry id (one per transfer). */
  deskAttested: Map<string, string>;
  /** Per-session budget for `desk.event` frames. */
  eventBucket: TokenBucket;
  timers: Map<string, NodeJS.Timeout>;
};

type LiveSource = {
  id: string;
  orgId: string;
  tokenId: string;
  tier: PackageTier;
  state: SessionState;
  path: SessionPath;
  consentLevel?: ConsentLevel | null;
  consentScope?: MirrorScope | null;
  consentBackstage?: boolean | null;
  recordingMode?: RecordingMode | null;
  serverRecording?: boolean;
};

/** The consent triple of a session row, or null when it has none (P1, or not yet granted). */
export function consentOfRow(s: LiveSource): LiveConsent | null {
  return s.consentLevel && s.consentScope ? { level: s.consentLevel, scope: s.consentScope, backstage: s.consentBackstage === true } : null;
}

export function newLive(s: LiveSource): Live {
  return {
    id: s.id,
    orgId: s.orgId,
    tokenId: s.tokenId,
    tier: s.tier,
    state: s.state,
    path: s.path,
    consent: consentOfRow(s),
    policy: null,
    relay: { mirrorFrames: 0, mirrorBytes: 0, controlFrames: 0, dropped: 0 },
    recordingMode: s.recordingMode ?? null,
    recorder: {
      assignedConnId: null,
      assignedUntil: 0,
      tried: new Set(),
      resume: false,
      connId: null,
      recorderId: null,
      joined: false,
      started: s.serverRecording === true,
      stopped: false,
    },
    relayWindow: [],
    controlBuckets: {
      assist: new TokenBucket(LIMITS.controlRelayPerSec, LIMITS.controlRelayPerSec),
      desk: new TokenBucket(LIMITS.controlRelayPerSec, LIMITS.controlRelayPerSec),
    },
    refusedAt: 0,
    refusedSuppressed: 0,
    assistConnId: null,
    deskConnId: null,
    chatCount: 0,
    chatClosed: false,
    lastStatsAt: 0,
    lastPathChangeAt: 0,
    deskAttested: new Map(),
    eventBucket: new TokenBucket(5, 20),
    timers: new Map(),
  };
}

export function setTimer(live: Live, name: string, ms: number, fn: () => void): void {
  clearTimer(live, name);
  const t = setTimeout(() => {
    live.timers.delete(name);
    fn();
  }, ms);
  t.unref?.();
  live.timers.set(name, t);
}

export function clearTimer(live: Live, name: string): void {
  const t = live.timers.get(name);
  if (t) clearTimeout(t);
  live.timers.delete(name);
}

export function clearTimers(live: Live): void {
  for (const t of live.timers.values()) clearTimeout(t);
  live.timers.clear();
}
