/**
 * Assist console controller (contracts sections 7.3-7.7, 8, 9, 13.2). Framework-agnostic: React reads
 * immutable snapshots through `subscribe` / `snapshot`. Uses the shell's signaling socket (the accepting
 * socket is the session's Assist participant). Hard rule 2 is `teardown()`.
 */
import type { DcAnnot, Recording, SessionCreated, SessionEnded } from '@indiansassist/shared';
import { EMPTY_ANNOT, applyAnnot, pruneAnnot, type AnnotState } from '../../lib/annotation';
import { errorMessage } from '../../lib/api';
import { sessionsApi } from '../../lib/endpoints';
import { PeerLink, type ChatItem } from '../../lib/link';
import type { Transfer } from '../../lib/fileTransfer';
import { toRtcIceServers } from '../../lib/peer';
import { SessionRecorder } from '../../lib/recorder';
import { SessionControllerBase, type GetUserMedia } from '../../lib/sessionBase';
import type { SignalClient } from '../../lib/signal';
import { EMPTY_STATS, computeNetStats, type NetStats } from '../../lib/stats';
import { uploadRecording } from '../../lib/upload';
import { asClient } from '../../lib/wire';

export type ConsolePhase = 'resuming' | 'waiting_consent' | 'connecting' | 'live' | 'ending' | 'ended';
export type RecordingPhase = 'idle' | 'recording' | 'uploading' | 'stored' | 'failed';

export type ConsoleSnapshot = {
  phase: ConsolePhase;
  created: SessionCreated | null;
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
  uploadProgress: number;
  recordingResult: Recording | null;
  net: NetStats;
  relayOnly: boolean;
  ended: SessionEnded | null;
  notice: string | null;
  error: string | null;
};

const INITIAL: ConsoleSnapshot = {
  phase: 'resuming',
  created: null,
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
  uploadProgress: 0,
  recordingResult: null,
  net: EMPTY_STATS,
  relayOnly: false,
  ended: null,
  notice: null,
  error: null,
};

export type ControllerDeps = {
  signal: SignalClient;
  sessionId: string;
  getUserMedia?: GetUserMedia;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
};

const SHOWN_ERRORS = ['forbidden', 'session_not_found', 'bad_state', 'consent_required', 'relay_closed'];

export class AssistConsoleController extends SessionControllerBase<ConsoleSnapshot> {
  private offs: (() => void)[] = [];
  private iceServers: RTCIceServer[] = [];
  private recorder: SessionRecorder | null = null;
  private lastBlob: { blob: Blob; mime: string; durationMs: number } | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private statTick = 0;

  constructor(private readonly deps: ControllerDeps) {
    super(INITIAL, 'assist', deps.getUserMedia);
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
          this.set({ phase: 'connecting', notice: null });
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
      setInterval(() => void this.sampleStats(), 2000),
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
    this.set({ created: m, error: null });
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
          else this.set({ remoteAudio: new MediaStream([track]) });
        },
        onConnectionState: (st) => this.set({ connectionState: st, ...(st === 'connected' ? { phase: 'live' as const } : {}) }),
        onChannelOpen: (label) => {
          if (label === 'ia.chat') this.deps.signal.send({ t: 'chat.channel_open', sessionId: this.id });
          if (label === 'ia.ctrl' && this.mic) this.sendVoiceState();
        },
        onChat: (m) => this.receiveChat(m),
        onTyping: (active) => this.set({ peerTyping: active }),
        onTransfers: (list) => this.set({ transfers: [...this.oldTransfers, ...list] }),
        onCtrl: (m) => {
          if (m.t === 'voice.state') this.set({ peerMuted: m.muted });
          else if (m.t === 'stop.sharing') this.set({ notice: 'The Desk stopped sharing.' });
          else if (m.t === 'consent.revoked') this.set({ notice: 'The Desk revoked consent.' });
        },
      },
    });
    this.link = link;
    const track = this.mic?.getAudioTracks()[0];
    if (track && this.mic) link.addTrack(track, this.mic);
  }

  protected override closeLink(): void {
    const had = this.link !== null;
    super.closeLink();
    if (had) this.set({ remoteVideo: null, connectionState: 'closed' });
  }

  /** Hard rule 2: stop the recorder (keeping its chunks for upload), stop local tracks, close everything. */
  teardown(): void {
    if (this.recorder) void this.stopRecording(false);
    this.closeLink();
    this.stopMic();
    this.set({ annot: EMPTY_ANNOT });
  }

  private async sampleStats(): Promise<void> {
    const link = this.link;
    if (!link || link.isClosed) return;
    try {
      const net = computeNetStats(await link.peer.getStats(), this.snap.net);
      this.set({ net });
      // Displayed every 2 s; reported to the server every 10 s (the server keeps one per >= 4 s).
      if (++this.statTick % 5 === 0) {
        const int = (n: number | null) => (n === null ? null : Math.round(n));
        this.deps.signal.send(
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
      }
    } catch {
      /* the connection closed between ticks */
    }
  }

  sendAnnot(msg: DcAnnot): void {
    this.link?.send(msg);
    this.set({ annot: applyAnnot(this.snap.annot, msg) });
  }

  // ---------- recording (section 9) ----------

  startRecording(canvas: HTMLCanvasElement | null): void {
    if (!canvas || this.recorder || this.snap.recordingUsed) return;
    const rec = new SessionRecorder(canvas, () => [this.snap.remoteAudio, this.mic].filter((s): s is MediaStream => s !== null));
    try {
      rec.start();
    } catch (e) {
      this.set({ error: errorMessage(e) });
      return;
    }
    this.recorder = rec;
    this.set({ recording: 'recording', recordingUsed: true, error: null });
    this.link?.send({ t: 'recording.state', recording: true, ts: Date.now() });
    sessionsApi.recordingStarted(this.id).catch((e: unknown) => this.set({ error: `Could not report the recording: ${errorMessage(e)}` }));
  }

  /** Stops and uploads. `notifyPeer` is false during teardown (nothing more is sent on ia.ctrl). */
  async stopRecording(notifyPeer = true): Promise<void> {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    if (notifyPeer) this.link?.send({ t: 'recording.state', recording: false, ts: Date.now() });
    this.lastBlob = await rec.stop();
    await this.retryUpload();
  }

  async retryUpload(): Promise<void> {
    const b = this.lastBlob;
    if (!b) return;
    this.set({ recording: 'uploading', uploadProgress: 0 });
    try {
      const result = await uploadRecording(this.id, b.blob, { mime: b.mime, durationMs: Math.round(b.durationMs) }, (sent, total) =>
        this.set({ uploadProgress: total > 0 ? sent / total : 1 }),
      );
      this.set({ recording: 'stored', recordingResult: result, uploadProgress: 1 });
    } catch (e) {
      this.set({ recording: 'failed', error: `Recording upload failed: ${errorMessage(e)}` });
    }
  }

  // ---------- session ----------

  async endSession(note?: string): Promise<void> {
    this.teardown();
    this.set({ phase: 'ending' });
    if (this.deps.signal.isOpen) {
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
