/**
 * Shared base of the Assist console and Desk room controllers: snapshot store, chat (data channel first,
 * WS relay fallback, section 8.1), file transfer actions, voice (getUserMedia audio, mute, `voice.state`)
 * and link closing. Subclasses own signaling and their session state machine.
 */
import type { Side } from '@indiansassist/shared';
import { errorMessage } from './api';
import type { Transfer } from './fileTransfer';
import { uuid } from './ids';
import { addChat, type ChatItem, type PeerLink } from './link';
import type { SignalClient } from './signal';
import { asClient } from './wire';

export type BaseSnap = {
  chat: ChatItem[];
  peerTyping: boolean;
  transfers: Transfer[];
  voiceOn: boolean;
  muted: boolean;
  peerMuted: boolean | null;
  remoteAudio: MediaStream | null;
  notice: string | null;
};

export type GetUserMedia = (c: MediaStreamConstraints) => Promise<MediaStream>;

export abstract class SessionControllerBase<S extends BaseSnap> {
  protected snap: S;
  private listeners = new Set<() => void>();
  protected disposed = false;
  protected link: PeerLink | null = null;
  protected mic: MediaStream | null = null;
  protected oldTransfers: Transfer[] = [];

  constructor(
    initial: S,
    protected readonly side: Side,
    private readonly gum?: GetUserMedia,
  ) {
    this.snap = initial;
  }

  protected abstract signalClient(): SignalClient;
  protected abstract currentSessionId(): string | null;

  get snapshot(): S {
    return this.snap;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  protected set(patch: Partial<S>): void {
    if (this.disposed) return;
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  protected setBase(patch: Partial<BaseSnap>): void {
    this.set(patch as Partial<S>);
  }

  protected stopListening(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  protected peerSide(): Side {
    return this.side === 'assist' ? 'desk' : 'assist';
  }

  /** Records an inbound chat message (dc or relay), de-duplicated by msgId. */
  protected receiveChat(m: { msgId: string; text: string; ts?: unknown }): void {
    const ts = typeof m.ts === 'number' ? m.ts : Date.now();
    this.setBase({ chat: addChat(this.snap.chat, { msgId: m.msgId, from: this.peerSide(), text: m.text, ts, mine: false }) });
  }

  /** Closes the current connection; keeps the transfer history and the microphone. */
  protected closeLink(): void {
    if (!this.link) return;
    this.oldTransfers = [...this.oldTransfers, ...this.link.files.list];
    this.link.close();
    this.link = null;
    this.setBase({ transfers: this.oldTransfers, remoteAudio: null, peerTyping: false });
  }

  protected stopMic(): void {
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
    this.setBase({ voiceOn: false, muted: false });
  }

  // ---------- chat ----------

  sendChat(text: string): void {
    const t = text.trim().slice(0, 4000);
    const sessionId = this.currentSessionId();
    if (!t || !sessionId) return;
    const from = this.side;
    const item: ChatItem = { msgId: uuid(), from, text: t, ts: Date.now(), mine: true };
    const viaDc = this.link?.send({ t: 'chat', msgId: item.msgId, from, text: t, ts: item.ts }) ?? false;
    if (!viaDc) this.signalClient().send(asClient({ t: 'chat.message', sessionId, msgId: item.msgId, from, text: t, ts: item.ts }));
    this.setBase({ chat: addChat(this.snap.chat, item) });
  }

  setTyping(active: boolean): void {
    this.link?.send({ t: 'typing', from: this.side, active, ts: Date.now() });
  }

  // ---------- files ----------

  async sendFile(file: File): Promise<void> {
    if (!this.link) throw new Error('Not connected yet.');
    await this.link.files.send(file);
  }

  acceptFile(key: string): void {
    this.link?.files.accept(key);
  }

  rejectFile(key: string): void {
    this.link?.files.reject(key);
  }

  cancelFile(key: string): void {
    this.link?.files.cancel(key);
  }

  // ---------- voice ----------

  protected sendVoiceState(): void {
    this.link?.send({ t: 'voice.state', from: this.side, muted: !this.mic || this.snap.muted, ts: Date.now() });
  }

  async toggleVoice(): Promise<void> {
    if (this.mic) {
      const track = this.mic.getAudioTracks()[0];
      if (track) this.link?.removeTrack(track);
      this.stopMic();
      this.sendVoiceState();
      return;
    }
    try {
      const gum = this.gum ?? ((c) => navigator.mediaDevices.getUserMedia(c));
      const stream = await gum({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      this.mic = stream;
      const track = stream.getAudioTracks()[0];
      if (track) this.link?.addTrack(track, stream);
      this.setBase({ voiceOn: true, muted: false });
      this.sendVoiceState();
    } catch (e) {
      this.setBase({ notice: `Microphone unavailable: ${errorMessage(e)}` });
    }
  }

  toggleMute(): void {
    const track = this.mic?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.setBase({ muted: !track.enabled });
    this.sendVoiceState();
  }
}
