/**
 * One `/signal` socket and the per-session live registry entry (contracts section 7.2). A Conn talks through a
 * Transport: the local WebSocket, or (on the node that owns a session) the presence bridge to the node that holds
 * the real socket (section 7.6 N1, bridge.ts).
 */
import { randomUUID } from 'node:crypto';
import {
  isAgentConsentLevel,
  isConsentLevel,
  isNativeTier,
  LIMITS,
  type AgentConsentLevel,
  type ApprovedBy,
  type ConsentDecision,
  type UnattendedPolicy,
  type ConsentLevel,
  type DeskClient,
  type ElevationLevel,
  type ExtensionPolicy,
  type MirrorScope,
  type PackageTier,
  type RecordingMode,
  type SessionPath,
  type SessionState,
  type SignalErrorCode,
  type StoredConsentLevel,
} from '@indiansassist/shared';
import WebSocket from 'ws';
import type { Principal } from '../plugins/auth.js';
import { TokenBucket } from '../limiter.js';

export type DeskInfo = {
  /** The token of the Desk; `device:<deviceId>` for the P4 desktop worker (Phase D section 4.2, no token). */
  tokenId: string;
  /** Phase D: the device whose desktop worker this socket is (null / absent for every token Desk). */
  deviceId?: string | null;
  orgId: string;
  via: 'compact' | 'short_code' | 'desk_code';
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
  /**
   * Phase C section 3.1 (generalises Y21 / A.2 P5): an upgrade with a listed extension Origin or with no Origin at all.
   * The cookie is ignored (null principal); `desk.hello` / `recorder.hello` only, never `assist.hello`.
   */
  deskOnly = false;
  /** The upgrade carried `Origin: chrome-extension://<id>` (Y21): a recorder may never hello on it. */
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

/** Phase C section 3.4: the native consent of a P3 session and the attested integrity level. */
export type LiveAgent = { level: AgentConsentLevel; monitors: number; clipboard: boolean; elevation: ElevationLevel };

/** Phase C section 8.3: the manifest delivered at `session.created` (pinned for the `playbook_changed` check). */
export type LiveManifest = {
  msg: { playbooks: Record<string, unknown>[]; truncated?: true };
  /** playbook id -> pinned body hash. */
  hashes: Map<string, string>;
};

/** Phase D: the P4 part of a live device session (section 3.5, 5.4, 6.2). */
export type LiveP4 = {
  deviceId: string;
  /** `session.created.device` (rule 3.5b); null until loaded. */
  device: { id: string; name: string; keyId: string; publicKey: string } | null;
  unattended: boolean;
  /** The section 6.2 decision pushed in `device.session_open` (null when unknown on this node). */
  decision: ConsentDecision | null;
  reason: string | null;
  policy: UnattendedPolicy | null;
  /** The worker's last reported input-lock / privacy-screen state (rule 5.4d). */
  inputLock: boolean;
  privacyScreen: boolean;
  /** The worker key generation of the last credential (rebuilds increment it). */
  gen: number;
  /** The first Assist attach of a REST-opened session writes no `session.resumed`. */
  assistAttached: boolean;
  /** Who authorised the unattended session (set at active). */
  approvedBy: ApprovedBy | null;
};

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
  /** Null for a P4 device session. */
  tokenId: string | null;
  /** Phase D: set for a P4 device session. */
  p4: LiveP4 | null;
  tier: PackageTier;
  state: SessionState;
  path: SessionPath;
  /** The P2 consent decision in force (null for P1 / P3 or before consent). */
  consent: LiveConsent | null;
  /** The P3 consent in force (null for P1 / P2 or before consent). */
  agent: LiveAgent | null;
  /** P3: the playbook manifest of this session, loaded once at the first `session.created`. */
  manifest: LiveManifest | null;
  /** The org extension policy of a P2 session, loaded at first use (live sessions are not re-policed). */
  policy: ExtensionPolicy | null;
  relay: RelayCounters;
  /** Phase A.2 M1 snapshot (null = before A.2). */
  recordingMode: RecordingMode | null;
  recorder: LiveRecorder;
  /**
   * The session's native Desk advertises `capabilities.features` `recorder` (it answers the A.2 recorder offer). Read
   * from the stored `desk.hello.client`, so a hand-over re-evaluates it against the new Desk (Phase C section 9 R2).
   */
  deskRecorder: boolean;
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
  tokenId: string | null;
  deviceId?: string | null;
  unattended?: boolean | null;
  unattendedPolicy?: unknown;
  tier: PackageTier;
  state: SessionState;
  path: SessionPath;
  consentLevel?: StoredConsentLevel | null;
  consentScope?: MirrorScope | null;
  consentBackstage?: boolean | null;
  consentMonitors?: number | null;
  consentClipboard?: boolean | null;
  elevation?: ElevationLevel | null;
  recordingMode?: RecordingMode | null;
  serverRecording?: boolean;
  deskClient?: unknown;
};

/** Whether a stored `desk.hello.client` is a native Desk advertising the `recorder` feature (Phase C section 9 R2). */
export function deskAnswersRecorder(client: unknown): boolean {
  if (!client || typeof client !== 'object') return false;
  const c = client as { kind?: unknown; capabilities?: { features?: unknown } };
  const features = c.capabilities?.features;
  return c.kind === 'native' && Array.isArray(features) && features.includes('recorder');
}

/** The P2 consent triple of a session row, or null when it has none (P1 / P3, or not yet granted). */
export function consentOfRow(s: LiveSource): LiveConsent | null {
  if (s.tier !== 'p2_extension' || !isConsentLevel(s.consentLevel) || !s.consentScope) return null;
  return { level: s.consentLevel, scope: s.consentScope, backstage: s.consentBackstage === true };
}

/** The P3 consent of a session row, or null (Phase C section 3.4 family rule: only P3 levels are read here). */
export function agentOfRow(s: LiveSource): LiveAgent | null {
  if (!isNativeTier(s.tier) || !isAgentConsentLevel(s.consentLevel)) return null;
  return {
    level: s.consentLevel,
    monitors: s.consentMonitors ?? 1,
    clipboard: s.consentClipboard === true,
    elevation: s.elevation ?? 'user',
  };
}

export function newLive(s: LiveSource): Live {
  return {
    id: s.id,
    orgId: s.orgId,
    tokenId: s.tokenId,
    p4: s.deviceId
      ? {
          deviceId: s.deviceId,
          device: null,
          unattended: s.unattended === true,
          decision: null,
          reason: null,
          policy: (s.unattendedPolicy as UnattendedPolicy | null | undefined) ?? null,
          inputLock: false,
          privacyScreen: false,
          gen: 0,
          assistAttached: false,
          approvedBy: null,
        }
      : null,
    tier: s.tier,
    state: s.state,
    path: s.path,
    consent: consentOfRow(s),
    agent: agentOfRow(s),
    manifest: null,
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
    deskRecorder: deskAnswersRecorder(s.deskClient),
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
