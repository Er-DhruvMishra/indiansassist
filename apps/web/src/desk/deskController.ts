/**
 * Desk room controller (contracts sections 6.13, 7.2-7.7, 8, 12.1). Framework-agnostic; React reads
 * snapshots. Consent gate (D2): `getDisplayMedia` runs only from `share()`, which is reachable only in the
 * `consent` phase (after `session.created`); the peer connection is built only after `consent.ok`.
 * Hard rule 2 is `teardown()`, applied before every screen change caused by an end or a resume (D9).
 * Phase A.2: a second peer connection toward the server recorder (`deskRecorder.ts`) carries the same tracks;
 * `webrtc.*` frames tagged `peer: 'recorder'` go to it, every other one to the Assist connection.
 *
 * Local end (prd-F1): Stop / Revoke / Decline end the session on this computer at once and for good. The
 * end frame is sent now or, while the socket reconnects, right after the next `desk.hello.ok` re-registers
 * this Desk (the in-memory `resumeKey` is kept for exactly that); the stored key is dropped immediately so a
 * reload never resumes, and a re-sent `session.created` never brings the consent screen back.
 */
import {
  STORAGE_KEYS,
  type ClientSignalMessage,
  type DcAnnot,
  type DeskHelloOk,
  type SessionCreated,
  type SessionEnded,
} from '@indiansassist/shared';
import { EMPTY_ANNOT, applyAnnot, pruneAnnot } from '../lib/annotation';
import { errorMessage } from '../lib/api';
import { IceRecovery } from '../lib/iceRecovery';
import { PeerLink } from '../lib/link';
import { toRtcIceServers } from '../lib/peer';
import { SessionControllerBase } from '../lib/sessionBase';
import { SignalClient, type SignalStatus } from '../lib/signal';
import { removeStore, writeStore } from '../lib/storage';
import { DeskAttestations } from './deskAttest';
import { displayMediaOptions, localEnded, surfaceOf } from './deskMedia';
import { DeskRecorderPeer } from './deskRecorder';
import { DESK_FATAL_CODES as FATAL, DESK_INITIAL, LOCAL_END_FALLBACK_MS, type DeskDeps, type DeskPhase, type DeskSnapshot } from './deskTypes';

export type { DeskDeps, DeskPhase, DeskSnapshot } from './deskTypes';
export { LOCAL_END_FALLBACK_MS } from './deskTypes';
export { displayMediaOptions, surfaceOf } from './deskMedia';

export class DeskController extends SessionControllerBase<DeskSnapshot> {
  readonly signal: SignalClient;
  private iceServers: RTCIceServer[] = [];
  private resumeKey: string | null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly attestations: DeskAttestations;
  private endFallback: ReturnType<typeof setTimeout> | null = null;
  /** The Desk ended the session itself (stop, revoke, decline): never resume it, never consent again. */
  private endedLocally = false;
  /** The end frame that could not be sent (socket reconnecting); delivered after the next resume. */
  private endPending: ClientSignalMessage | null = null;
  private recovery: IceRecovery | null = null;
  /** Phase A.2 N3: the receive-only server recorder's connection (same tracks as the Assist one). */
  private readonly recorder: DeskRecorderPeer;

  constructor(private readonly deps: DeskDeps) {
    super(deps.resume ? { ...DESK_INITIAL, sessionId: deps.resume.sessionId } : DESK_INITIAL, 'desk', deps.getUserMedia);
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
    this.attestations = new DeskAttestations(this.signal, () => this.snap.sessionId);
    this.recorder = new DeskRecorderPeer(this.signal, deps.RTCPeerConnectionImpl);
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
      // A local end already happened: show its receipt rather than an error screen.
      if (this.snap.phase === 'ending') return this.finishLocally();
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
      if (this.endedLocally) return this.afterLocalEndHello(m);
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
      // A resume re-sends session.created; a Desk that ended the session must not see consent again.
      if (this.endedLocally) return;
      this.teardown();
      this.setSession(m.sessionId);
      this.set({ created: m, phase: 'consent', ended: null, notice: null });
    }));
    s.on('consent.ok', (m) => {
      if (m.state !== 'active' || this.snap.phase !== 'starting') return;
      if (m.iceServers) this.iceServers = toRtcIceServers(m.iceServers);
      this.buildLink();
      this.set({ phase: 'sharing', sharingSince: this.snap.sharingSince ?? Date.now() });
    });
    // A.2 N2: `peer: 'recorder'` frames belong to the recorder connection; untagged ones to the Assist one.
    s.on('webrtc.offer', mine((m) => void (m.peer === 'recorder' ? this.onRecorderOffer(m.sdp) : this.link?.handleSignal({ t: 'webrtc.offer', sdp: m.sdp }))));
    s.on('webrtc.answer', mine((m) => void (m.peer === 'recorder' ? this.recorder.answer(m.sdp) : this.link?.handleSignal({ t: 'webrtc.answer', sdp: m.sdp }))));
    s.on('webrtc.ice', mine((m) => void (m.peer === 'recorder' ? this.recorder.ice(m.candidate) : this.link?.handleSignal({ t: 'webrtc.ice', candidate: m.candidate }))));
    s.on('assist.reconnected', mine((m) => {
      if (m.iceServers) this.iceServers = toRtcIceServers(m.iceServers);
      this.recorder.close(); // A.2 S3: an Assist rebuild never keeps a stale recorder connection
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
      this.recorder.refreshIce(this.iceServers);
    }));
    s.on('session.recording', mine((m) => {
      if (m.source === 'server' && !m.recording) this.recorder.close(); // A.2 S3: the recorder stopped
      this.setRecording(m.source === 'server' ? { server: m.recording } : { ws: m.recording });
    }));
    s.on('chat.message', mine((m) => this.receiveChat(m)));
    s.on('event.ok', (m) => this.attestations.acknowledge(m.re));
    s.on('session.ended', mine((m: SessionEnded) => this.onEnded(m)));
    s.on('error', (m) => {
      if (FATAL.has(m.code)) {
        this.teardown();
        if (this.snap.phase === 'ending') return this.finishLocally();
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
    this.endFallback = null;
    this.teardown();
    this.resumeKey = null;
    this.endPending = null;
    removeStore('session', STORAGE_KEYS.roomResume);
    this.set({ phase: 'ended', ended: m });
  }

  /** D3 / A.2 S1: the dot shows while any source says true; each source only changes its own flag (prd-F5). */
  private setRecording(p: { ws?: boolean; ctrl?: boolean; server?: boolean }): void {
    const recordingWs = p.ws ?? this.snap.recordingWs;
    const recordingCtrl = p.ctrl ?? this.snap.recordingCtrl;
    const recordingServer = p.server ?? this.snap.recordingServer;
    const recording = recordingWs || recordingCtrl || recordingServer;
    const recordingSeen = this.snap.recordingSeen || recordingWs || recordingCtrl;
    this.set({ recordingWs, recordingCtrl, recordingServer, recording, recordingSeen, serverRecordingSeen: this.snap.serverRecordingSeen || recordingServer });
  }

  /** A.2 N3: accepted only while sharing, under mode `server` / `both`, without a data channel. */
  private onRecorderOffer(sdp: string): Promise<boolean> {
    const { sessionId, phase, created, localStream } = this.snap;
    return this.recorder.offer(sdp, { sessionId, sharing: phase === 'sharing', recordingMode: created?.recordingMode, iceServers: this.iceServers, screen: localStream, mic: this.mic });
  }

  /** Voice on / off also attaches / detaches the microphone on the recorder connection (no renegotiation). */
  override async toggleVoice(): Promise<void> {
    await super.toggleVoice();
    this.recorder.setMic(this.mic?.getAudioTracks()[0] ?? null);
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
    this.endLocally({ t: 'desk.consent', state: 'revoked' }, 'consent_revoked');
  }

  /** D4: stop.sharing on ia.ctrl, hard rule 2, then WS session.end. */
  stopSharing(): void {
    if (!['sharing', 'starting'].includes(this.snap.phase) || !this.snap.sessionId) return;
    this.link?.send({ t: 'stop.sharing', ts: Date.now() });
    this.teardown();
    this.endLocally({ t: 'session.end', sessionId: this.snap.sessionId }, 'desk_stopped');
  }

  /** D5: consent.revoked on ia.ctrl, hard rule 2, then desk.consent revoked. */
  revokeConsent(): void {
    if (!['sharing', 'starting'].includes(this.snap.phase)) return;
    this.link?.send({ t: 'consent.revoked', ts: Date.now() });
    this.teardown();
    this.endLocally({ t: 'desk.consent', state: 'revoked' }, 'consent_revoked');
  }

  /** Sends the end now or keeps it for the next resume (prd-F1); the local receipt follows either way. */
  private endLocally(msg: ClientSignalMessage, reason: SessionEnded['endReason']): void {
    this.endedLocally = true;
    removeStore('session', STORAGE_KEYS.roomResume);
    if (this.signal.send(msg)) {
      this.resumeKey = null;
      this.endPending = null;
    } else {
      this.endPending = msg;
    }
    this.set({ phase: 'ending' });
    if (this.endFallback) clearTimeout(this.endFallback);
    this.endFallback = setTimeout(() => this.finishLocally(reason), LOCAL_END_FALLBACK_MS);
  }

  /** The socket re-opened after a local end: deliver the kept end on the re-registered socket, never knock. */
  private afterLocalEndHello(m: DeskHelloOk): void {
    const pending = this.endPending;
    this.endPending = null;
    this.resumeKey = null;
    if (pending && m.resume && m.resume.sessionId === this.snap.sessionId) this.signal.send(pending);
    else this.finishLocally();
  }

  /** The receipt from local state when the server's `session.ended` has not arrived. */
  private finishLocally(reason?: SessionEnded['endReason']): void {
    const { phase, sessionId, created } = this.snap;
    if (phase !== 'ending' || !sessionId || !created) return;
    const why = reason ?? (this.snap.sharingSince ? 'desk_stopped' : 'consent_revoked');
    const { sharingSince, surface, recordingSeen, serverRecordingSeen } = this.snap;
    const ended = localEnded({ sessionId, reason: why, sharingSince, assist: created.assist, surface, recordingSeen, serverRecordingSeen });
    this.set({ phase: 'ended', ended });
  }

  /** After `denied` / `timeout` the socket stays open: knock again on the same token. */
  tryAgain(): void {
    if (this.snap.phase !== 'ended') return;
    this.endedLocally = false;
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
      attest: (action, data) => this.attestations.attest(action, data),
      events: {
        onConnectionState: (st) => this.recovery?.update(st),
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
          if (m.t === 'recording.state') this.setRecording({ ctrl: m.recording });
          else if (m.t === 'voice.state') this.set({ peerMuted: m.muted });
        },
      },
    });
    this.link = link;
    // correctness-F6: the Desk is the impolite offerer, so it restarts ICE (perfect negotiation).
    this.recovery = new IceRecovery({
      onRestart: () => link.peer.restartIce(),
      onReconnecting: (on) => this.set({ mediaReconnecting: on }),
      onGiveUp: () => this.set({ notice: 'The connection to your technician could not be restored. Stop sharing and join again if it does not come back.' }),
    });
    for (const t of stream.getVideoTracks()) link.addTrack(t, stream);
    const micTrack = this.mic?.getAudioTracks()[0];
    if (micTrack && this.mic) link.addTrack(micTrack, this.mic);
  }

  /** The `ia.ctrl` state and the media recovery die with the connection (correctness-F11). */
  protected override closeLink(): void {
    this.recovery?.dispose();
    this.recovery = null;
    super.closeLink();
    this.set({ mediaReconnecting: false });
    this.setRecording({ ctrl: false });
  }

  /** Hard rule 2: stop every local track (screen and microphone), close channels and the connection. */
  teardown(): void {
    this.recorder.close();
    this.closeLink();
    for (const t of this.snap.localStream?.getTracks() ?? []) t.stop();
    this.stopMic();
    // No recording runs on a share that ended; the next share starts without the dot (correctness-F11).
    this.setRecording({ ws: false, ctrl: false, server: false });
    this.set({ localStream: null, annot: EMPTY_ANNOT });
  }

  /** Unmount: hard rule 2 and close the socket (the server's 30 s grace allows a resume after reload). */
  dispose(): void {
    this.teardown();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.endFallback) clearTimeout(this.endFallback);
    this.attestations.dispose();
    this.recovery?.dispose();
    this.signal.close();
    this.stopListening();
  }
}
