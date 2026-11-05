/**
 * P3 console controller, signaling and link half (docs/specs/phase-c-contracts.md sections 1.3, 3.4, 3.6, 3.7, 4.4,
 * 13.4). Framework-agnostic: React reads immutable snapshots through `subscribe` / `snapshot`. The Desk (agent)
 * offers; every offer with `restart: true` (resume, third media-recovery failure, hand-over) rebuilds the link with
 * the next key generation and re-arms the security-code gate. The user-facing actions live in
 * `agentConsoleController.ts`. Hard rule 2 is `teardown()`.
 *
 * Orderly end (A section 7.4 hard rule 2): the Desk tears its channels and connection down before its WS end frame
 * reaches the server, so once the end is known (`stop.sharing` / `consent.revoked` on a channel, `session.ended` or
 * `consent.changed { revoked }` over signaling, or our own End) channel closes and connection state changes are
 * teardown, never `sec.fail { reason: 'channel' }`. After a Desk stop message the Desk's own `session.end` wins: the
 * console waits for `session.ended` and only sends a plain `session.end` (idempotent on the server) if none arrives
 * within `AGENT_PEER_END_FALLBACK_MS`.
 */
import { type AgentCapabilities, type SessionCreated, type SessionEnded, type SecFailReason, type StopSharingReason } from '@indiansassist/shared';
import { errorMessage } from '../../../lib/api';
import { lateConsentFor, type ConsentChangedLike } from '../../signal/lateConsent';
import { agentPolicyApi, p3Event } from '../../../lib/agentApi';
import { sessionsApi } from '../../../lib/endpoints';
import { uuid } from '../../../lib/ids';
import { addChat } from '../../../lib/link';
import { toRtcIceServers } from '../../../lib/peer';
import type { SecureHubOptions, InboundMessage } from '../../../lib/secureHub';
import type { SignalClient } from '../../../lib/signal';
import { computeNetStats } from '../../../lib/stats';
import { asClient } from '../../../lib/wire';
import { InputReporter, type InputReport } from './agentInput';
import { AgentLink } from './agentLink';
import { OpTracker } from './agentOps';
import { applyEnd, applyOutput } from './agentPlaybooks';
import { AGENT_INITIAL, hasFeature, type AgentSnapshot } from './agentState';
import { glassFromReport, sessionStatsFrame } from './agentStatsFold';

export type AgentControllerDeps = {
  signal: SignalClient;
  sessionId: string;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
  /** Test hooks (the fake connection has no descriptions; fixed handshake keys). */
  fingerprints?: () => { own: string; remote: string } | null;
  handshake?: SecureHubOptions['handshake'];
  /** `POST /sessions/:id/events`; defaults to the REST client. */
  report?: (body: { action: string; data: Record<string, unknown>; reason?: string }) => Promise<unknown>;
  loadPolicy?: () => Promise<{ requireSasConfirm: boolean }>;
  /** Overrides `AGENT_PEER_END_FALLBACK_MS` (tests). */
  peerEndFallbackMs?: number;
  /** Overrides the F9 channel-close grace (tests). */
  channelCloseGraceMs?: number;
};

/** How the session is ending, once known; `null` while it is live. */
type EndingBy = 'desk_stopped' | 'consent_revoked' | 'server' | 'local';

export const AGENT_STATS_SAMPLE_MS = 2500;
/** After a Desk stop message, how long the console waits for `session.ended` before sending its own (plain) end. */
export const AGENT_PEER_END_FALLBACK_MS = 10_000;
const SHOWN_ERRORS = ['forbidden', 'session_not_found', 'bad_state', 'consent_required', 'relay_closed'];

/** The notice for a Desk's `stop.sharing`: a plain Stop, or the reason a native Desk gave. */
export function stopNotice(reason: StopSharingReason | undefined): string {
  if (reason === 'indicator_failed')
    return 'The Desk ended the session because its on-screen indicator could not be shown. IndiansAssist never shares a screen without it.';
  return 'The Desk stopped sharing.';
}

export class AgentControllerCore {
  protected snap: AgentSnapshot = AGENT_INITIAL;
  private listeners = new Set<() => void>();
  protected disposed = false;
  protected link: AgentLink | null = null;
  protected readonly ops: OpTracker;
  protected readonly input: InputReporter;
  protected iceServers: RTCIceServer[] = [];
  private offs: (() => void)[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private statTick = 0;
  private oldTransfers: AgentSnapshot['transfers'] = [];
  private endingBy: EndingBy | null = null;
  private peerEndTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * C2: the highest key generation this console has ever built a link for, kept independently of `this.link` (which
   * is cleared on every rebuild). A restart offer must advance it by exactly one; it is never reset for the life of
   * the controller, so a replayed or omitted `gen` can never reuse a stale SAS confirmation.
   */
  private lastGen: number | null = null;

  constructor(protected readonly deps: AgentControllerDeps) {
    this.ops = new OpTracker(deps.sessionId, (m) => this.link?.hub.send(m as never) ?? false);
    this.input = new InputReporter((r) => this.sendReport(r), () => (typeof this.snap.viewed === 'number' ? this.snap.viewed : null));
  }

  get snapshot(): AgentSnapshot {
    return this.snap;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  protected set(patch: Partial<AgentSnapshot>): void {
    if (this.disposed) return;
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  protected get id(): string {
    return this.deps.sessionId;
  }

  /** `POST /sessions/:id/events` (the console reporter, actor user); failures are surfaced, never thrown. */
  protected report(body: { action: string; data: Record<string, unknown>; reason?: string }): Promise<unknown> {
    const fn = this.deps.report ?? ((b) => p3Event(this.id, b));
    return fn(body).catch((e: unknown) => this.set({ error: `Could not record ${body.action}: ${errorMessage(e)}` }));
  }

  private sendReport(r: InputReport): void {
    void this.report({ action: r.action, data: r.data });
  }

  setCapabilities(capabilities: AgentCapabilities): void {
    this.set({ capabilities });
  }

  /** `cached` = the `session.created` received at accept; `helloReady` = hello already acknowledged. */
  start(cached: SessionCreated | undefined, helloReady: boolean, capabilities?: AgentCapabilities | null): void {
    if (capabilities) this.set({ capabilities });
    const s = this.deps.signal;
    const mine = <T extends { sessionId?: string }>(fn: (m: T) => void) => (m: T) => {
      if (m.sessionId === this.id) fn(m);
    };
    this.offs.push(
      s.on('assist.hello.ok', () => this.resume()),
      s.on('session.created', mine((m: SessionCreated) => this.onCreated(m))),
      s.on('consent.changed', mine((m) => this.onConsentChanged(m))),
      s.on('webrtc.offer', mine((m) => this.onOffer(m.sdp, m.restart === true, m.gen))),
      s.on('webrtc.answer', mine((m) => void this.link?.handleSignal({ t: 'webrtc.answer', sdp: m.sdp }))),
      s.on('webrtc.ice', mine((m) => void this.link?.handleSignal({ t: 'webrtc.ice', candidate: m.candidate }))),
      s.on('desk.reconnected', mine((m) => {
        if (m.state === 'consent_pending') {
          this.teardown();
          this.set({ phase: 'waiting_consent', notice: 'The Desk reconnected and must consent again.' });
        } else this.set({ notice: 'The Desk reconnected; rebuilding the secure connection.' });
      })),
      s.on('ice.refresh', mine((m) => {
        this.iceServers = toRtcIceServers(m.iceServers);
        this.link?.peer.refreshIce(this.iceServers, false);
      })),
      s.on('chat.message', mine((m) => this.receiveWsChat(m))),
      s.on('session.ended', mine((m: SessionEnded) => {
        this.endingBy = 'server';
        this.clearPeerEndTimer();
        this.teardown();
        this.set({ phase: 'ended', ended: m });
      })),
      s.on('error', (m) => {
        if (SHOWN_ERRORS.includes(m.code)) this.set({ error: m.message || m.code });
      }),
    );
    this.timers.push(setInterval(() => void this.sampleStats(), AGENT_STATS_SAMPLE_MS));
    this.input.start();
    void (this.deps.loadPolicy ?? agentPolicyApi.get)()
      .then((p) => this.set({ requireSasConfirm: p.requireSasConfirm }))
      .catch(() => undefined);
    if (cached) this.onCreated(cached);
    else if (helloReady) this.resume();
    // A `consent.changed` that arrived before this controller subscribed (`lateConsent.ts`).
    const late = lateConsentFor(cached);
    if (late && late.sessionId === this.id) this.onConsentChanged(late);
  }

  private onConsentChanged(m: ConsentChangedLike): void {
    if (m.state === 'revoked') {
      this.endingBy ??= 'consent_revoked';
      this.teardown();
      return this.set({ notice: 'The Desk revoked consent.' });
    }
    if (m.state !== 'granted') return;
    const level = m.level === 'view' || m.level === 'control' || m.level === 'elevated' ? m.level : this.snap.consent.level;
    const consent = { level, monitors: m.monitors ?? this.snap.consent.monitors, clipboard: m.clipboard ?? this.snap.consent.clipboard };
    const lower = level === 'view' && this.snap.inputMode === 'control';
    const elevation = level === 'elevated' && this.snap.elevation ? { ...this.snap.elevation, state: 'granted' as const } : this.snap.elevation;
    this.set({ consent, elevation, ...(lower ? { inputMode: 'view' as const } : {}), ...(this.snap.phase === 'waiting_consent' ? { phase: 'connecting' as const } : {}) });
  }

  private resume(): void {
    if (this.snap.phase === 'ended' || this.snap.phase === 'ending') return;
    this.deps.signal.send({ t: 'assist.resume', sessionId: this.id });
  }

  protected onCreated(m: SessionCreated): void {
    this.iceServers = toRtcIceServers(m.iceServers ?? []);
    const playbooks = m.agent?.playbooks ?? this.snap.playbooks;
    this.set({ created: m, error: null, playbooks, playbooksTruncated: m.agent?.truncated === true });
    if (m.state === 'ended') return this.set({ phase: 'ended' });
    if (m.state === 'active') {
      // A resumed Assist: the Desk rebuilds and sends a restart offer (section 3.7).
      this.closeLink();
      return this.set({ phase: 'connecting', consent: { ...this.snap.consent, level: this.snap.consent.level ?? 'view' } });
    }
    this.closeLink();
    this.set({ phase: 'waiting_consent' });
  }

  private onOffer(sdp: string, restart: boolean, gen: number | undefined): void {
    if (restart || !this.link || this.link.isClosed) {
      let next: number;
      if (this.lastGen === null) {
        // The first peer connection this console builds (the initial handshake, or a resume after a reload): there
        // is no earlier confirmation to replay against, so the offered generation is accepted as the baseline.
        next = typeof gen === 'number' ? gen : 0;
      } else {
        // C2: a rebuild must advance the generation by exactly one. A restart offer that replays an old / equal
        // generation, or omits it, is the MITM-at-rebuild case (it would reuse a stale SAS confirmation); refuse it
        // outright as a handshake-order violation (section 1.3 step 9, `commit`).
        if (typeof gen !== 'number' || gen !== this.lastGen + 1) return void this.onSecFailed('commit');
        next = gen;
      }
      this.lastGen = next;
      this.closeLink();
      this.buildLink(next);
    }
    void this.link?.handleSignal({ t: 'webrtc.offer', sdp });
  }

  private buildLink(gen: number): void {
    const confirmedBefore = this.snap.sasConfirmedGen !== null;
    // C2: every new link starts with no confirmed generation, so the SAS must be re-compared even if a rebuild
    // happens to reuse a generation number; the gate can never ride on a stale confirmation.
    this.set({ phase: 'securing', sec: { state: 'securing', gen, sas: null, failReason: null }, inputMode: 'view', sasConfirmedGen: null });
    this.link = new AgentLink({
      sessionId: this.id,
      gen,
      iceServers: this.iceServers,
      signal: this.deps.signal,
      RTCPeerConnectionImpl: this.deps.RTCPeerConnectionImpl,
      fingerprints: this.deps.fingerprints,
      handshake: this.deps.handshake,
      channelCloseGraceMs: this.deps.channelCloseGraceMs,
      isOrderlyEnd: () => this.endingBy !== null,
      voice: () => hasFeature(this.snap, 'voice'),
      localAudio: () => this.localAudio(),
      attest: async (action, data) => {
        await sessionsApi.fileEvent(this.id, action, data);
        return true;
      },
      events: {
        onTrack: (track, streams, mid) => {
          if (track.kind === 'audio') return this.set({ remoteAudio: new MediaStream([track]) });
          const key = mid ?? String(Object.keys(this.snap.streams).length);
          this.set({ streams: { ...this.snap.streams, [key]: streams[0] ?? new MediaStream([track]) } });
        },
        onConnectionState: (st) => {
          if (this.endingBy) return;
          if (st === 'failed') this.set({ notice: 'The media connection failed; waiting for the Desk to rebuild it.' });
        },
        onEstablished: (r) => {
          // C13: announce the encrypted chat channel to the server so it stops relaying WS `chat.message`
          // (mirrors controller.ts / mirrorController.ts). A relay that keeps forwarding afterwards is then
          // detectable and dropped in `receiveWsChat`.
          this.deps.signal.send({ t: 'chat.channel_open', sessionId: this.id });
          // C2: sasHistory is append-only; a generation already recorded is never overwritten.
          const history = this.snap.sasHistory.some((h) => h.gen === r.gen) ? this.snap.sasHistory : [...this.snap.sasHistory, { gen: r.gen, sas: r.sas }];
          this.set({
            phase: 'live',
            sec: { state: 'established', gen: r.gen, sas: r.sas, failReason: null },
            sasHistory: history,
            sasPrompt: confirmedBefore,
            notice: r.gen > 0 ? 'Security code changed. Confirm the new code with the user before controlling.' : null,
          });
          this.onSecured();
        },
        onFailed: (reason) => void this.onSecFailed(reason),
        onMessage: (m) => this.route(m),
        onTransfers: (list) => this.set({ transfers: [...this.oldTransfers, ...list] }),
      },
    });
  }

  /**
   * Section 1.3 step 9: `sec.failed`, teardown, `session.end { note: 'sec:<reason>' }`. Not during an orderly end:
   * the closes of a Desk teardown are not a security failure, and the Desk's own end frame must win.
   */
  private async onSecFailed(reason: SecFailReason): Promise<void> {
    if (this.endingBy) {
      this.teardown();
      return;
    }
    this.set({ sec: { ...this.snap.sec, state: 'failed', failReason: reason }, error: `The secure channel failed (${reason}). The session is ending.` });
    await this.report({ action: 'sec.failed', data: { reason } });
    this.teardown();
    if (this.snap.phase === 'ended') return;
    this.endingBy ??= 'local';
    this.set({ phase: 'ending' });
    this.deps.signal.send({ t: 'session.end', sessionId: this.id, note: `sec:${reason}` });
  }

  /** Inbound messages of the encrypted channels; the action half extends the `ctl.event` handling. */
  protected route(m: InboundMessage): void {
    switch (m.t) {
      case 'ctl.res':
        this.ops.settle(m as never);
        return;
      case 'ctl.event':
        this.onControlEvent(m as never);
        return;
      case 'pb.output':
        return this.set({ runs: applyOutput(this.snap.runs, m) });
      case 'pb.end':
        return this.set({ runs: applyEnd(this.snap.runs, m) });
      case 'agent.stats':
        return this.set({ agentStats: m });
      case 'chat':
        this.receiveChat(m);
        this.link?.hub.send({ t: 'chat.ack', msgId: m.msgId, ts: Date.now() });
        return;
      case 'typing':
        return this.set({ peerTyping: m.active });
      case 'ping':
        this.link?.hub.send({ t: 'pong', ts: Date.now() });
        return;
      case 'voice.state':
        // The Desk's microphone indicator; our own state never echoes back as the Desk's.
        if (m.from !== 'desk') return;
        return this.set({ peerMuted: m.muted });
      case 'stop.sharing':
        return this.onPeerEnd('desk_stopped', m.reason);
      case 'consent.revoked':
        return this.onPeerEnd('consent_revoked');
      default:
        return;
    }
  }

  /**
   * The Desk announced its hard rule 2 teardown: tear down here too (input first), mark the end orderly so the closes
   * that follow are not channel violations, and wait for the Desk's own end to come back as `session.ended`.
   */
  private onPeerEnd(kind: 'desk_stopped' | 'consent_revoked', reason?: StopSharingReason): void {
    const notice = kind === 'consent_revoked' ? 'The Desk revoked consent.' : stopNotice(reason);
    if (this.endingBy) return this.set({ notice });
    this.endingBy = kind;
    this.input.flush(true);
    this.teardown();
    this.set({ phase: 'ending', notice, deskStopReason: reason ?? null });
    this.peerEndTimer = setTimeout(() => {
      this.peerEndTimer = null;
      if (this.disposed || this.snap.phase === 'ended') return;
      // The Desk's end frame never came back as session.ended; a repeated session.end is idempotent server side.
      void this.endSession(`peer:${kind}`);
    }, this.deps.peerEndFallbackMs ?? AGENT_PEER_END_FALLBACK_MS);
  }

  private clearPeerEndTimer(): void {
    if (this.peerEndTimer) clearTimeout(this.peerEndTimer);
    this.peerEndTimer = null;
  }

  protected onControlEvent(_e: { kind: string } & Record<string, unknown>): void {
    void _e;
  }

  /** The technician's microphone for a new link (the action half owns it); null = none. */
  protected localAudio(): { track: MediaStreamTrack; stream: MediaStream } | null {
    return null;
  }

  /** Called once per link when its secure channel is established (after the snapshot update). */
  protected onSecured(): void {}

  protected receiveChat(m: { msgId: string; text: string; ts?: unknown }): void {
    const ts = typeof m.ts === 'number' ? m.ts : Date.now();
    this.set({ chat: addChat(this.snap.chat, { msgId: m.msgId, from: 'desk', text: m.text, ts, mine: false }) });
  }

  /**
   * C13: the WS `chat.message` relay (A X7) is the one declared plaintext gap, usable only while the encrypted
   * `ia.chat` channel is not yet established. Once it is open, the console has sent `chat.channel_open` and the
   * server must stop relaying; a WS `chat.message` arriving then can only be a forgery by a compromised relay, so it
   * is dropped rather than shown as if it came from the Desk.
   */
  private receiveWsChat(m: { msgId: string; text: string; ts?: unknown }): void {
    if (this.link?.hub.isOpen('ia.chat')) return;
    this.receiveChat(m);
  }

  sendChat(text: string): void {
    const t = text.trim().slice(0, 4000);
    if (!t) return;
    const item = { msgId: uuid(), from: 'assist' as const, text: t, ts: Date.now(), mine: true };
    const viaDc = this.link?.hub.send({ t: 'chat', msgId: item.msgId, from: 'assist', text: t, ts: item.ts }) ?? false;
    // The WS relay is the one declared plaintext gap (A X7), used only while ia.chat is not established.
    if (!viaDc) this.deps.signal.send(asClient({ t: 'chat.message', sessionId: this.id, msgId: item.msgId, from: 'assist', text: t, ts: item.ts }));
    this.set({ chat: addChat(this.snap.chat, item) });
  }

  setTyping(active: boolean): void {
    this.link?.hub.send({ t: 'typing', from: 'assist', active, ts: Date.now() });
  }

  private async sampleStats(): Promise<void> {
    const link = this.link;
    if (!link || link.isClosed) return;
    try {
      const report = await link.peer.getStats();
      const net = computeNetStats(report, this.snap.net);
      const glassMs = glassFromReport(report, net.rttMs, this.snap.agentStats?.encodeMs ?? null);
      this.set({ net, glassMs });
      if (++this.statTick % 2 === 0) this.deps.signal.send(asClient(sessionStatsFrame(this.id, net, this.snap.agentStats, glassMs)));
    } catch {
      /* closed between ticks */
    }
  }

  protected closeLink(): void {
    if (!this.link) return;
    this.oldTransfers = [...this.oldTransfers, ...this.link.files.list];
    this.ops.clear();
    this.link.close();
    this.link = null;
    this.set({ transfers: this.oldTransfers, streams: {}, remoteAudio: null, peerTyping: false });
  }

  /** Hard rule 2: input stops first, then the link and its keys. */
  teardown(): void {
    this.set({ inputMode: 'view' });
    this.closeLink();
  }

  async endSession(note?: string): Promise<void> {
    this.endingBy ??= 'local';
    this.clearPeerEndTimer();
    this.input.flush(true);
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

  dispose(): void {
    this.clearPeerEndTimer();
    this.input.stop();
    this.teardown();
    for (const off of this.offs) off();
    this.offs = [];
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.disposed = true;
    this.listeners.clear();
  }
}
