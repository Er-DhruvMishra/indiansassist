/**
 * Desk room controller (contracts sections 6.13, 7.2-7.7, 8, 12.1). Framework-agnostic; React reads
 * snapshots. Consent gate (D2): `getDisplayMedia` runs only from `share()`, which is reachable only in the
 * `consent` phase (after `session.created`); the peer connection is built only after `consent.ok`.
 * Hard rule 2 is `teardown()`, applied before every screen change caused by an end or a resume (D9).
 */
import { STORAGE_KEYS, type DcAnnot, type FileEventData, type SessionCreated, type SessionEnded } from '@indiansassist/shared';
import { EMPTY_ANNOT, applyAnnot, pruneAnnot } from '../lib/annotation';
import { errorMessage } from '../lib/api';
import { PeerLink } from '../lib/link';
import { toRtcIceServers } from '../lib/peer';
import { SessionControllerBase, type GetUserMedia } from '../lib/sessionBase';
import { SignalClient, type SignalStatus } from '../lib/signal';
import { removeStore, writeStore } from '../lib/storage';
import { displayMediaOptions, localEnded, surfaceOf } from './deskMedia';
import type { DeskPhase, DeskSnapshot } from './deskTypes';

export type { DeskPhase, DeskSnapshot } from './deskTypes';
export { displayMediaOptions, surfaceOf } from './deskMedia';

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

const INITIAL: DeskSnapshot = {
  phase: 'connecting',
  signalStatus: 'idle',
  hello: null,
  sessionId: null,
  created: null,
  surface: null,
  localStream: null,
  sharingSince: null,
  recording: false,
  recordingSeen: false,
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

const FATAL = new Set(['token_malformed', 'token_bad_signature', 'token_not_found', 'token_gone', 'region_mismatch', 'token_busy', 'join_unsupported', 'not_authenticated']);

export class DeskController extends SessionControllerBase<DeskSnapshot> {
  readonly signal: SignalClient;
  private iceServers: RTCIceServer[] = [];
  private resumeKey: string | null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private pending = new Map<string, (ok: boolean) => void>();
  private evSeq = 0;
  private endFallback: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: DeskDeps) {
    super(deps.resume ? { ...INITIAL, sessionId: deps.resume.sessionId } : INITIAL, 'desk', deps.getUserMedia);
    this.resumeKey = deps.resume?.resumeKey ?? null;
    this.signal = new SignalClient({
      url: deps.url,
      WebSocketImpl: deps.WebSocketImpl,
      onOpen: (c) =>
        c.send({
          t: 'desk.hello',
          token: deps.token,
          ...(deps.deskLabel ? { deskLabel: deps.deskLabel } : {}),
          ...(this.resumeKey ? { resumeKey: this.resumeKey } : {}),
        }),
      onStatus: (s, code) => this.onStatus(s, code),
    });
    this.wire();
  }

  protected signalClient(): SignalClient {
    return this.signal;
  }

  protected currentSessionId(): string | null {
    return this.snap.sessionId;
  }

  /** Unnarrowed read (the phase changes while awaiting the picker). */
  private phaseNow(): DeskPhase {
    return this.snap.phase;
  }

  start(): void {
    this.signal.connect();
    this.timers.push(
      setInterval(() => {
        if (this.snap.phase === 'waiting' || this.snap.phase === 'held') this.signal.send({ t: 'desk.poll' });
      }, this.deps.pollMs ?? 3000),
      setInterval(() => {
        const next = pruneAnnot(this.snap.annot);
        if (next !== this.snap.annot) this.set({ annot: next });
      }, 500),
    );
  }

  private onStatus(s: SignalStatus, code?: number): void {
    this.set({ signalStatus: s });
    if (s === 'closed' && code !== undefined && code >= 4400 && !['ended', 'error'].includes(this.snap.phase)) {
      this.teardown();
      this.set({ phase: 'error', error: this.snap.error ?? { t: 'error', code: 'forbidden', message: `The connection was closed (${code}).` } });
    }
  }

  private wire(): void {
    const s = this.signal;
    const mine = <T extends { sessionId?: string }>(fn: (m: T) => void) => (m: T) => {
      if (!this.snap.sessionId || m.sessionId === undefined || m.sessionId === this.snap.sessionId) fn(m);
    };
    s.on('desk.hello.ok', (m) => {
      this.set({ hello: m, error: null });
      if (m.resume) {
        this.setSession(m.resume.sessionId);
        // A resumed active session needs consent again (section 7.5): hard rule 2 first (D9).
        if (m.resume.state !== 'knocked') this.teardown();
        this.set({ phase: 'waiting', notice: m.resume.state === 'knocked' ? null : 'Reconnected. Waiting for the session to resume.' });
        return;
      }
      if (this.resumeKey) {
        this.resumeKey = null;
        removeStore('session', STORAGE_KEYS.roomResume);
      }
      this.set({ phase: 'waiting' });
      this.knock();
    });
    s.on('knock.ok', (m) => {
      this.resumeKey = m.resumeKey;
      writeStore('session', STORAGE_KEYS.roomResume, JSON.stringify({ sessionId: m.sessionId, resumeKey: m.resumeKey }));
      this.setSession(m.sessionId);
      this.set({ phase: 'waiting', notice: null });
    });
    s.on('knock.held', () => this.set({ phase: 'held', technicianOnline: false }));
    s.on('poll.status', (m) => {
      this.set({ technicianOnline: m.technicianOnline });
      if (m.state === 'held' && this.snap.phase === 'waiting') this.set({ phase: 'held' });
    });
    s.on('session.created', mine((m: SessionCreated) => {
      this.teardown();
      this.setSession(m.sessionId);
      this.set({ created: m, phase: 'consent', ended: null, notice: null });
    }));
    s.on('consent.ok', (m) => {
      if (m.state !== 'active') return;
      if (m.iceServers) this.iceServers = toRtcIceServers(m.iceServers);
      this.buildLink();
      this.set({ phase: 'sharing', sharingSince: this.snap.sharingSince ?? Date.now() });
    });
    s.on('webrtc.offer', mine((m) => void this.link?.handleSignal({ t: 'webrtc.offer', sdp: m.sdp })));
    s.on('webrtc.answer', mine((m) => void this.link?.handleSignal({ t: 'webrtc.answer', sdp: m.sdp })));
    s.on('webrtc.ice', mine((m) => void this.link?.handleSignal({ t: 'webrtc.ice', candidate: m.candidate })));
    s.on('assist.reconnected', mine((m) => {
      if (m.iceServers) this.iceServers = toRtcIceServers(m.iceServers);
      if (m.state === 'active' && this.snap.localStream) {
        // Hard rule 2 minus the capture track: a fresh connection, same screen (section 7.5).
        this.closeLink();
        this.buildLink();
        this.set({ notice: 'Your technician reconnected.' });
      }
    }));
    s.on('ice.refresh', mine((m) => {
      this.iceServers = toRtcIceServers(m.iceServers);
      this.link?.peer.refreshIce(this.iceServers, true);
    }));
    s.on('session.recording', mine((m) => this.set({ recording: m.recording, recordingSeen: this.snap.recordingSeen || m.recording })));
    s.on('chat.message', mine((m) => this.receiveChat(m)));
    s.on('event.ok', (m) => {
      const key = m.re && this.pending.has(m.re) ? m.re : this.pending.keys().next().value;
      if (key === undefined) return;
      this.pending.get(key)?.(true);
      this.pending.delete(key);
    });
    s.on('session.ended', mine((m: SessionEnded) => this.onEnded(m)));
    s.on('error', (m) => {
      if (FATAL.has(m.code)) {
        this.teardown();
        this.set({ phase: 'error', error: m });
      } else {
        this.set({ notice: m.code === 'rate_limited' ? 'Too many attempts. Please wait a few minutes and try again.' : m.message || m.code });
      }
    });
  }

  private setSession(id: string): void {
    if (this.snap.sessionId !== id) this.set({ sessionId: id });
    this.deps.onSession?.(id);
  }

  private knock(): void {
    this.signal.send({ t: 'desk.knock', ...(this.deps.deskLabel ? { deskLabel: this.deps.deskLabel } : {}) });
  }

  private onEnded(m: SessionEnded): void {
    if (this.endFallback) clearTimeout(this.endFallback);
    this.teardown();
    this.resumeKey = null;
    removeStore('session', STORAGE_KEYS.roomResume);
    this.set({ phase: 'ended', ended: m, recording: false });
  }

  // ---------- consent (D1, D2, D4, D5) ----------

  /** D2: the picker first; consent only after it resolves; nothing is sent when it is cancelled. */
  async share(singleWindow: boolean): Promise<void> {
    if (this.snap.phase !== 'consent') return;
    this.set({ phase: 'picking', notice: null });
    let stream: MediaStream;
    try {
      const gdm = this.deps.getDisplayMedia ?? ((o) => navigator.mediaDevices.getDisplayMedia(o));
      stream = await gdm(displayMediaOptions(singleWindow));
    } catch (e) {
      if (this.phaseNow() === 'picking') this.set({ phase: 'consent', notice: `Screen sharing did not start (${errorMessage(e)}). Nothing was shared.` });
      return;
    }
    if (this.phaseNow() !== 'picking' || this.disposed) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    const track = stream.getVideoTracks()[0];
    const surface = surfaceOf(track);
    if (track) track.addEventListener('ended', () => this.stopSharing());
    this.set({ localStream: stream, surface, phase: 'starting' });
    this.signal.send({ t: 'desk.consent', state: 'granted', surface });
  }

  decline(): void {
    if (!['consent', 'picking'].includes(this.snap.phase)) return;
    this.teardown();
    this.signal.send({ t: 'desk.consent', state: 'revoked' });
    this.set({ phase: 'ending' });
  }

  /** D4: stop.sharing on ia.ctrl, hard rule 2, then WS session.end. */
  stopSharing(): void {
    if (!['sharing', 'starting'].includes(this.snap.phase) || !this.snap.sessionId) return;
    this.link?.send({ t: 'stop.sharing', ts: Date.now() });
    this.teardown();
    this.signal.send({ t: 'session.end', sessionId: this.snap.sessionId });
    this.awaitEnd('desk_stopped');
  }

  /** D5: consent.revoked on ia.ctrl, hard rule 2, then desk.consent revoked. */
  revokeConsent(): void {
    if (!['sharing', 'starting'].includes(this.snap.phase)) return;
    this.link?.send({ t: 'consent.revoked', ts: Date.now() });
    this.teardown();
    this.signal.send({ t: 'desk.consent', state: 'revoked' });
    this.awaitEnd('consent_revoked');
  }

  private awaitEnd(reason: SessionEnded['endReason']): void {
    this.set({ phase: 'ending' });
    this.endFallback = setTimeout(() => {
      const { phase, sessionId, created } = this.snap;
      if (phase !== 'ending' || !sessionId || !created) return;
      const ended = localEnded({ sessionId, reason, sharingSince: this.snap.sharingSince, assist: created.assist, surface: this.snap.surface, recordingSeen: this.snap.recordingSeen });
      this.set({ phase: 'ended', ended });
    }, 5000);
  }

  /** After `denied` / `timeout` the socket stays open: knock again on the same token. */
  tryAgain(): void {
    if (this.snap.phase !== 'ended') return;
    this.set({ phase: 'waiting', ended: null, created: null, sessionId: null, notice: null, sharingSince: null });
    this.knock();
  }

  // ---------- connection ----------

  private buildLink(): void {
    const created = this.snap.created;
    const stream = this.snap.localStream;
    if (!created || !stream || this.link) return;
    const link = new PeerLink({
      side: 'desk',
      sessionId: created.sessionId,
      polite: created.polite,
      iceServers: this.iceServers,
      signal: this.signal,
      createChannels: true,
      RTCPeerConnectionImpl: this.deps.RTCPeerConnectionImpl,
      attest: (action, data) => this.attest(action, data),
      events: {
        onTrack: (track) => {
          if (track.kind === 'audio') this.set({ remoteAudio: new MediaStream([track]) });
        },
        onChat: (m) => this.receiveChat(m),
        onTyping: (active) => this.set({ peerTyping: active }),
        onAnnot: (m: DcAnnot) => this.set({ annot: applyAnnot(this.snap.annot, m) }),
        onTransfers: (list) => this.set({ transfers: [...this.oldTransfers, ...list] }),
        onChannelOpen: (label) => {
          if (label === 'ia.ctrl') this.sendVoiceState();
        },
        onCtrl: (m) => {
          if (m.t === 'recording.state') this.set({ recording: m.recording, recordingSeen: this.snap.recordingSeen || m.recording });
          else if (m.t === 'voice.state') this.set({ peerMuted: m.muted });
        },
      },
    });
    this.link = link;
    for (const t of stream.getVideoTracks()) link.addTrack(t, stream);
    const micTrack = this.mic?.getAudioTracks()[0];
    if (micTrack && this.mic) link.addTrack(micTrack, this.mic);
  }

  /** F7: the Desk's attestation over WS `desk.event`, resolved by `event.ok`. */
  private attest(action: 'file.sent' | 'file.received', data: FileEventData): Promise<boolean> {
    const sessionId = this.snap.sessionId;
    if (!sessionId) return Promise.resolve(false);
    const id = `ev${++this.evSeq}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      if (!this.signal.send({ t: 'desk.event', id, sessionId, action, data })) {
        this.pending.delete(id);
        resolve(false);
        return;
      }
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(false);
      }, 10000);
    });
  }

  /** Hard rule 2: stop every local track (screen and microphone), close channels and the connection. */
  teardown(): void {
    this.closeLink();
    for (const t of this.snap.localStream?.getTracks() ?? []) t.stop();
    this.stopMic();
    this.set({ localStream: null, annot: EMPTY_ANNOT });
  }

  /** Unmount: hard rule 2 and close the socket (the server's 30 s grace allows a resume after reload). */
  dispose(): void {
    this.teardown();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.endFallback) clearTimeout(this.endFallback);
    for (const r of this.pending.values()) r(false);
    this.pending.clear();
    this.signal.close();
    this.stopListening();
  }
}
