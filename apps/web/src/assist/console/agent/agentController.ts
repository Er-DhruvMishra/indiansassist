/**
 * P3 console controller, signaling and link half (docs/specs/phase-c-contracts.md sections 1.3, 3.4, 3.6, 3.7, 4.4,
 * 13.4). Framework-agnostic: React reads immutable snapshots through `subscribe` / `snapshot`. The Desk (agent)
 * offers; every offer with `restart: true` (resume, third media-recovery failure, hand-over) rebuilds the link with
 * the next key generation and re-arms the security-code gate. The user-facing actions live in
 * `agentConsoleController.ts`. Hard rule 2 is `teardown()`.
 */
import { type AgentCapabilities, type SessionCreated, type SessionEnded, type SecFailReason } from '@indiansassist/shared';
import { errorMessage } from '../../../lib/api';
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
import { AGENT_INITIAL, type AgentSnapshot } from './agentState';
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
};

export const AGENT_STATS_SAMPLE_MS = 2500;
const SHOWN_ERRORS = ['forbidden', 'session_not_found', 'bad_state', 'consent_required', 'relay_closed'];

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
      s.on('consent.changed', mine((m) => {
        if (m.state === 'revoked') {
          this.teardown();
          return this.set({ notice: 'The Desk revoked consent.' });
        }
        if (m.state !== 'granted') return;
        const level = m.level === 'view' || m.level === 'control' || m.level === 'elevated' ? m.level : this.snap.consent.level;
        const consent = { level, monitors: m.monitors ?? this.snap.consent.monitors, clipboard: m.clipboard ?? this.snap.consent.clipboard };
        const lower = level === 'view' && this.snap.inputMode === 'control';
        const elevation = level === 'elevated' && this.snap.elevation ? { ...this.snap.elevation, state: 'granted' as const } : this.snap.elevation;
        this.set({ consent, elevation, ...(lower ? { inputMode: 'view' as const } : {}), ...(this.snap.phase === 'waiting_consent' ? { phase: 'connecting' as const } : {}) });
      })),
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
      s.on('chat.message', mine((m) => this.receiveChat(m))),
      s.on('session.ended', mine((m: SessionEnded) => {
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
      const next = gen ?? (this.link ? this.link.o.gen + 1 : 0);
      this.closeLink();
      this.buildLink(next);
    }
    void this.link?.handleSignal({ t: 'webrtc.offer', sdp });
  }

  private buildLink(gen: number): void {
    const confirmedBefore = this.snap.sasConfirmedGen !== null;
    this.set({ phase: 'securing', sec: { state: 'securing', gen, sas: null, failReason: null }, inputMode: 'view' });
    this.link = new AgentLink({
      sessionId: this.id,
      gen,
      iceServers: this.iceServers,
      signal: this.deps.signal,
      RTCPeerConnectionImpl: this.deps.RTCPeerConnectionImpl,
      fingerprints: this.deps.fingerprints,
      handshake: this.deps.handshake,
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
          if (st === 'failed') this.set({ notice: 'The media connection failed; waiting for the Desk to rebuild it.' });
        },
        onEstablished: (r) => {
          const history = [...this.snap.sasHistory.filter((h) => h.gen !== r.gen), { gen: r.gen, sas: r.sas }];
          this.set({
            phase: 'live',
            sec: { state: 'established', gen: r.gen, sas: r.sas, failReason: null },
            sasHistory: history,
            sasPrompt: confirmedBefore,
            notice: r.gen > 0 ? 'Security code changed. Confirm the new code with the user before controlling.' : null,
          });
        },
        onFailed: (reason) => void this.onSecFailed(reason),
        onMessage: (m) => this.route(m),
        onTransfers: (list) => this.set({ transfers: [...this.oldTransfers, ...list] }),
      },
    });
  }

  /** Section 1.3 step 9: `sec.failed`, teardown, `session.end { note: 'sec:<reason>' }`. */
  private async onSecFailed(reason: SecFailReason): Promise<void> {
    this.set({ sec: { ...this.snap.sec, state: 'failed', failReason: reason }, error: `The secure channel failed (${reason}). The session is ending.` });
    await this.report({ action: 'sec.failed', data: { reason } });
    this.teardown();
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
        return this.set({ peerMuted: m.muted });
      case 'stop.sharing':
        return this.set({ notice: 'The Desk stopped sharing.' });
      case 'consent.revoked':
        return this.set({ notice: 'The Desk revoked consent.' });
      default:
        return;
    }
  }

  protected onControlEvent(_e: { kind: string } & Record<string, unknown>): void {
    void _e;
  }

  protected receiveChat(m: { msgId: string; text: string; ts?: unknown }): void {
    const ts = typeof m.ts === 'number' ? m.ts : Date.now();
    this.set({ chat: addChat(this.snap.chat, { msgId: m.msgId, from: 'desk', text: m.text, ts, mine: false }) });
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
