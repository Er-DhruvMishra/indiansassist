/**
 * Assist console controller (contracts sections 7.3-7.7, 8, 9, 13.2). Framework-agnostic: React reads
 * immutable snapshots through `subscribe` / `snapshot`. Uses the shell's signaling socket (the accepting
 * socket is the session's Assist participant). Hard rule 2 is `teardown()`.
 */
import { assistMayRecord, type DcAnnot, type Session, type SessionCreated, type SessionEnded } from '@indiansassist/shared';
import { EMPTY_ANNOT, applyAnnot, pruneAnnot } from '../../lib/annotation';
import { errorMessage } from '../../lib/api';
import { sessionsApi } from '../../lib/endpoints';
import { IceRecovery } from '../../lib/iceRecovery';
import { PeerLink } from '../../lib/link';
import { toRtcIceServers } from '../../lib/peer';
import { SessionControllerBase, type GetUserMedia } from '../../lib/sessionBase';
import type { SignalClient } from '../../lib/signal';
import { computeNetStats, type NetStats } from '../../lib/stats';
import { asClient } from '../../lib/wire';
import { ConsoleRecording, type RecorderFactory } from './consoleRecording';
import { CONSOLE_INITIAL, serverRecordingFromPolicy, type ConsoleSnapshot } from './consoleState';

export type { RecordingPhase } from './consoleRecording';
export type { ConsolePhase, ConsoleSnapshot, ServerRecordingState } from './consoleState';

export type ControllerDeps = {
  signal: SignalClient;
  sessionId: string;
  getUserMedia?: GetUserMedia;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
  createRecorder?: RecorderFactory;
};

const SHOWN_ERRORS = ['forbidden', 'session_not_found', 'bad_state', 'consent_required', 'relay_closed'];

/** getStats() sampling for the network panel; every second sample is reported, i.e. every 5 s (13.2). */
export const STATS_SAMPLE_MS = 2500;
export const STATS_REPORT_EVERY = 2;
/** The server drops `session.stats` closer than 4 s to the previous one (section 7.3). */
const STATS_MIN_GAP_MS = 4000;

export class AssistConsoleController extends SessionControllerBase<ConsoleSnapshot> {
  private offs: (() => void)[] = [];
  private iceServers: RTCIceServer[] = [];
  private readonly rec: ConsoleRecording;
  private recovery: IceRecovery | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private statTick = 0;
  private lastStatsSentAt = 0;
  private consentGrantedAt: number | null = null;
  /** A.2 U4: a live server-source `session.recording` arrived; a later REST load never overrides it. */
  private serverRecordingSeen = false;

  constructor(private readonly deps: ControllerDeps) {
    super(CONSOLE_INITIAL, 'assist', deps.getUserMedia);
    this.rec = new ConsoleRecording({
      sessionId: deps.sessionId,
      set: (p) => this.set(p),
      isUsed: () => this.snap.recordingUsed,
      sendCtrl: (recording) => void this.link?.send({ t: 'recording.state', recording, ts: Date.now() }),
      audioSources: () => [this.snap.remoteAudio, this.mic].filter((s): s is MediaStream => s !== null),
      createRecorder: deps.createRecorder,
    });
  }

  protected signalClient(): SignalClient {
    return this.deps.signal;
  }

  protected currentSessionId(): string {
    return this.deps.sessionId;
  }

  private get id(): string {
    return this.deps.sessionId;
  }

  /** `cached` = the `session.created` the shell received at accept; `helloReady` = hello already acknowledged. */
  start(cached: SessionCreated | undefined, helloReady: boolean): void {
    const s = this.deps.signal;
    const mine = <T extends { sessionId?: string }>(fn: (m: T) => void) => (m: T) => {
      if (m.sessionId === this.id) fn(m);
    };
    this.offs.push(
      s.on('assist.hello.ok', () => this.resume()),
      s.on('session.created', mine((m: SessionCreated) => this.onCreated(m))),
      s.on('consent.changed', mine((m) => {
        if (m.state === 'granted') {
          this.consentGrantedAt = Date.now();
          this.set({ phase: 'connecting', notice: null, ttffMs: null });
          this.ensureLink();
        } else if (m.state === 'revoked') {
          this.teardown();
          this.set({ notice: 'The Desk revoked consent.' });
        }
      })),
      s.on('webrtc.offer', mine((m) => {
        this.ensureLink();
        void this.link?.handleSignal({ t: 'webrtc.offer', sdp: m.sdp });
      })),
      s.on('webrtc.answer', mine((m) => void this.link?.handleSignal({ t: 'webrtc.answer', sdp: m.sdp }))),
      s.on('webrtc.ice', mine((m) => void this.link?.handleSignal({ t: 'webrtc.ice', candidate: m.candidate }))),
      s.on('desk.reconnected', mine((m) => {
        if (m.state === 'consent_pending') {
          this.teardown();
          this.set({ phase: 'waiting_consent', notice: 'The Desk reconnected and must consent again.' });
        }
      })),
      s.on('ice.refresh', mine((m) => {
        this.iceServers = toRtcIceServers(m.iceServers);
        this.link?.peer.refreshIce(this.iceServers, false);
      })),
      s.on('chat.message', mine((m) => this.receiveChat(m))),
      // A.2 S1 / S3: the API copies the server recorder's state to the Assist (also on assist.resume).
      s.on('session.recording', mine((m) => {
        if (m.source !== 'server') return;
        this.serverRecordingSeen = true;
        this.set({ serverRecording: m.recording ? 'on' : 'stopped' });
      })),
      s.on('session.ended', mine((m: SessionEnded) => {
        this.teardown();
        this.set({ phase: 'ended', ended: m });
      })),
      s.on('error', (m) => {
        if (SHOWN_ERRORS.includes(m.code)) this.set({ error: m.message || m.code });
      }),
    );
    this.timers.push(
      setInterval(() => {
        const next = pruneAnnot(this.snap.annot);
        if (next !== this.snap.annot) this.set({ annot: next });
      }, 500),
      setInterval(() => void this.sampleStats(), STATS_SAMPLE_MS),
    );
    if (cached) this.onCreated(cached);
    else if (helloReady) this.resume();
  }

  private resume(): void {
    if (this.snap.phase === 'ended' || this.snap.phase === 'ending') return;
    this.deps.signal.send({ t: 'assist.resume', sessionId: this.id });
  }

  private onCreated(m: SessionCreated): void {
    this.iceServers = toRtcIceServers(m.iceServers ?? []);
    const recordingMode = m.recordingMode ?? this.snap.recordingMode;
    const serverRecording = serverRecordingFromPolicy(this.snap.serverRecording, recordingMode, undefined, this.serverRecordingSeen);
    this.set({ created: m, error: null, recordingMode, serverRecording });
    if (m.state === 'active') {
      // Assist resume of an active session: the Desk rebuilds its connection and sends a fresh offer.
      this.closeLink();
      this.set({ phase: 'connecting' });
      this.ensureLink();
    } else if (m.state === 'ended') {
      this.set({ phase: 'ended' });
    } else {
      this.closeLink();
      this.set({ phase: 'waiting_consent' });
    }
  }

  private ensureLink(): void {
    if (this.link && !this.link.isClosed) return;
    const link = new PeerLink({
      side: 'assist',
      sessionId: this.id,
      polite: this.snap.created?.polite ?? true,
      iceServers: this.iceServers,
      iceTransportPolicy: this.snap.relayOnly ? 'relay' : 'all',
      signal: this.deps.signal,
      createChannels: false,
      RTCPeerConnectionImpl: this.deps.RTCPeerConnectionImpl,
      attest: async (action, data) => {
        await sessionsApi.fileEvent(this.id, action, data);
        return true;
      },
      events: {
        onTrack: (track, streams) => {
          if (track.kind === 'video') this.set({ remoteVideo: streams[0] ?? new MediaStream([track]) });
          else {
            this.set({ remoteAudio: new MediaStream([track]) });
            this.rec.syncAudio();
          }
        },
        onConnectionState: (st) => {
          this.recovery?.update(st);
          this.set({ connectionState: st, ...(st === 'connected' ? { phase: 'live' as const } : {}) });
        },
        onChannelOpen: (label) => {
          if (label === 'ia.chat') this.deps.signal.send({ t: 'chat.channel_open', sessionId: this.id });
          if (label !== 'ia.ctrl') return;
          if (this.mic) this.sendVoiceState();
          // correctness-F11: every new ia.ctrl learns the current recorder state.
          link.send({ t: 'recording.state', recording: this.rec.active, ts: Date.now() });
        },
        onChat: (m) => this.receiveChat(m),
        onTyping: (active) => this.set({ peerTyping: active }),
        onTransfers: (list) => this.set({ transfers: [...this.oldTransfers, ...list] }),
        onCtrl: (m) => {
          if (m.t === 'voice.state') this.set({ peerMuted: m.muted });
          else if (m.t === 'stop.sharing') this.onPeerEnd('The Desk stopped sharing.');
          else if (m.t === 'consent.revoked') this.onPeerEnd('The Desk revoked consent.');
        },
      },
    });
    this.link = link;
    this.recovery = this.makeRecovery(link);
    const track = this.mic?.getAudioTracks()[0];
    if (track && this.mic) link.addTrack(track, this.mic);
  }

  /**
   * The Desk announced its hard rule 2 teardown (A section 8.1): tear down here as well, so the connection state
   * changes that follow are not treated as a media failure (no "Reconnecting", no ICE restart or relay switch), and
   * wait for the Desk's own `session.end` to come back as `session.ended`.
   */
  private onPeerEnd(notice: string): void {
    if (this.snap.phase === 'ending' || this.snap.phase === 'ended') return this.set({ notice });
    this.teardown();
    this.set({ phase: 'ending', notice });
  }

  /**
   * correctness-F6: the impolite Desk restarts ICE first; from the second attempt the Assist forces relay
   * (a direct path that keeps failing usually needs TURN), then restarts ICE itself.
   */
  private makeRecovery(link: PeerLink): IceRecovery {
    return new IceRecovery({
      onRestart: (attempt) => {
        if (attempt < 2) return;
        if (!this.snap.relayOnly) this.setRelayOnly(true);
        else link.peer.restartIce();
      },
      onReconnecting: (on) => {
        if (on && (this.snap.phase === 'live' || this.snap.phase === 'connecting'))
          this.set({ phase: 'reconnecting', notice: 'The media connection was interrupted. Reconnecting...' });
        else if (!on) this.set({ notice: null });
      },
      onGiveUp: () => this.set({ notice: 'The media connection could not be restored. Wait for the Desk to rejoin or end the session.' }),
    });
  }

  protected override closeLink(): void {
    const had = this.link !== null;
    this.recovery?.dispose();
    this.recovery = null;
    super.closeLink();
    if (had) {
      this.set({ remoteVideo: null, connectionState: 'closed', ...(this.snap.phase === 'reconnecting' ? { phase: 'connecting' as const } : {}) });
      this.rec.syncAudio();
    }
  }

  override async toggleVoice(): Promise<void> {
    await super.toggleVoice();
    this.rec.syncAudio();
  }

  /** Hard rule 2: stop the recorder (keeping its chunks for upload), stop local tracks, close everything. */
  teardown(): void {
    if (this.rec.active) void this.rec.stop(false);
    this.closeLink();
    this.stopMic();
    this.consentGrantedAt = null;
    this.set({ annot: EMPTY_ANNOT });
  }

  private async sampleStats(): Promise<void> {
    const link = this.link;
    if (!link || link.isClosed) return;
    try {
      const net = computeNetStats(await link.peer.getStats(), this.snap.net);
      this.set({ net });
      // prd-F9: displayed every 2.5 s, reported every 5 s (the server keeps one per >= 4 s).
      if (++this.statTick % STATS_REPORT_EVERY === 0) this.sendStats(net);
    } catch {
      /* the connection closed between ticks */
    }
  }

  private sendStats(net: NetStats): void {
    const int = (n: number | null) => (n === null ? null : Math.round(n));
    const sent = this.deps.signal.send(
      asClient({
        t: 'session.stats',
        sessionId: this.id,
        path: net.path,
        rttMs: net.rttMs,
        codec: net.codec,
        bitrateKbps: net.bitrateKbps,
        fps: net.fps,
        width: int(net.width),
        height: int(net.height),
        packetsLost: int(net.packetsLost),
        ts: Date.now(),
      }),
    );
    if (sent) this.lastStatsSentAt = Date.now();
  }

  /** RemoteView's first drawn frame (prd-F8); measured once per consent grant. */
  firstFrame(): void {
    if (this.consentGrantedAt === null) return;
    this.set({ ttffMs: Math.max(0, Date.now() - this.consentGrantedAt) });
    this.consentGrantedAt = null;
  }

  sendAnnot(msg: DcAnnot): void {
    this.link?.send(msg);
    this.set({ annot: applyAnnot(this.snap.annot, msg) });
  }

  // ---------- recording (section 9) ----------

  /** A.2 section 3: modes `off` / `server` refuse the console recording (the API answers 403 as well). */
  get mayRecord(): boolean {
    return assistMayRecord(this.snap.recordingMode);
  }

  startRecording(canvas: HTMLCanvasElement | null): void {
    if (this.mayRecord) this.rec.start(canvas);
  }

  /** The REST `Session` of the page (A.2 M4): fills the mode when `session.created` had none, and the badge. */
  applySession(d: Pick<Session, 'recordingMode' | 'serverRecording'>): void {
    const recordingMode = this.snap.recordingMode ?? d.recordingMode ?? null;
    const serverRecording = serverRecordingFromPolicy(this.snap.serverRecording, recordingMode, d.serverRecording, this.serverRecordingSeen);
    this.set({ recordingMode, serverRecording });
  }

  /** Stops and uploads. `notifyPeer` is false during teardown (nothing more is sent on ia.ctrl). */
  stopRecording(notifyPeer = true): Promise<void> {
    return this.rec.stop(notifyPeer);
  }

  retryUpload(): Promise<void> {
    return this.rec.retryUpload();
  }

  // ---------- session ----------

  async endSession(note?: string): Promise<void> {
    const net = this.snap.net;
    this.teardown();
    this.set({ phase: 'ending' });
    if (this.deps.signal.isOpen) {
      // prd-F9: a short session still records its path; the last sample is sent before the end.
      if (net.ts > 0 && Date.now() - this.lastStatsSentAt >= STATS_MIN_GAP_MS) this.sendStats(net);
      this.deps.signal.send({ t: 'session.end', sessionId: this.id, ...(note ? { note } : {}) });
      return;
    }
    try {
      await sessionsApi.end(this.id, note);
      this.set({ phase: 'ended' });
    } catch (e) {
      this.set({ error: errorMessage(e) });
    }
  }

  setRelayOnly(on: boolean): void {
    this.set({ relayOnly: on });
    this.link?.peer.setTransportPolicy(on ? 'relay' : 'all');
  }

  /** Unmount: hard rule 2 locally (an upload in flight continues); the 30 s grace allows `assist.resume`. */
  dispose(): void {
    this.teardown();
    for (const off of this.offs) off();
    this.offs = [];
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopListening();
  }
}
