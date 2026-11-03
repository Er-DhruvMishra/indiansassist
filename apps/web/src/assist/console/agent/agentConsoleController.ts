/**
 * P3 console controller, action half (docs/specs/phase-c-contracts.md sections 1.3 step 7, 3.6, 5.1, 5.2, 5.6, 7, 8):
 * monitor selection, the security-code gate, the input mode and the `os.*` ops (sent only in Control), clipboard,
 * elevation, playbook runs, quality, files and annotations. Every control request is reported by the console
 * (`POST events`, actor user) with the `opId` the agent attests (two reporters, one chain).
 */
import {
  playbookRunOpArgs,
  type AgentControlOp,
  type DcAnnot,
  type NavAction,
  type PlaybookArgValue,
  type PlaybookManifest,
  type QualityPreset,
} from '@indiansassist/shared';
import { playbooksApi } from '../../../lib/agentApi';
import { errorMessage } from '../../../lib/api';
import { copyText } from '../../../lib/clipboard';
import type { GetUserMedia } from '../../../lib/sessionBase';
import { AgentControllerCore, type AgentControllerDeps } from './agentController';
import { TextBuffer, modifiersOf, norm, type KeyLike } from './agentInput';
import { addRun, applyOpError, runErrorText } from './agentPlaybooks';
import { controlBlocker, hasFeature, levelAllows, type ElevationUiState } from './agentState';
import { SAS_GATE_INITIAL, checkSas, type SasCheck, type SasGateState } from './sasGate';
import { registerLiveConsole } from '../../summary/liveConsoles';

type Mods = { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
const NO_MODS: Mods = { alt: false, ctrl: false, meta: false, shift: false };
/** Moves are coalesced to 60 / s and dropped while one is unanswered for more than 300 ms (section 5.1). */
const MOVE_GAP_MS = 1000 / 60;
const MOVE_STALL_MS = 300;

export type AgentConsoleDeps = AgentControllerDeps & {
  runPlaybook?: typeof playbooksApi.run;
  /** `navigator.mediaDevices.getUserMedia` (tests inject a fake). */
  getUserMedia?: GetUserMedia;
};

export class AgentConsoleController extends AgentControllerCore {
  private sasGate: SasGateState = SAS_GATE_INITIAL;
  private readonly text = new TextBuffer((t) => this.op('os.text', { text: t }));
  private lastMoveAt = 0;
  private pendingMove: Record<string, unknown> | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The technician's microphone (section 6.3): acquired on the first click, kept across rebuilds, stopped at the end. */
  private mic: MediaStream | null = null;
  private micPending = false;

  /** Phase E 5.3: the transcript hook finds this console by session id (stream ai). */
  private readonly unregisterLive: () => void;

  constructor(private readonly d: AgentConsoleDeps) {
    super(d);
    this.unregisterLive = registerLiveConsole(d.sessionId, this);
  }

  override dispose(): void {
    this.unregisterLive();
    super.dispose();
  }

  // ---------- control events ----------

  protected override onControlEvent(e: { kind: string } & Record<string, unknown>): void {
    switch (e.kind) {
      case 'monitors': {
        const monitors = e['monitors'] as AgentConsoleController['snap']['monitors'];
        const selected = e['selected'] as number[];
        const viewed = this.snap.viewed === 'all' || monitors.some((m) => m.id === this.snap.viewed) ? this.snap.viewed : (selected[0] ?? monitors[0]?.id ?? 1);
        return this.set({ monitors, selected, viewed });
      }
      case 'agent_level': {
        const agentLevel = { level: e['level'], clipboard: e['clipboard'], elevation: e['elevation'] } as NonNullable<AgentConsoleController['snap']['agentLevel']>;
        return this.set({ agentLevel });
      }
      case 'clipboard': {
        const text = String(e['text'] ?? '');
        if (!this.snap.clipboardSync) return;
        void copyText(text).then((ok) => this.set({ clipboardReceived: ok ? null : text }));
        return;
      }
      case 'elevation': {
        const state = e['state'] as ElevationUiState;
        const cause = typeof e['cause'] === 'string' ? (e['cause'] as string) : undefined;
        return this.set({ elevation: { opId: String(e['opId']), state, ...(cause ? { cause } : {}) } });
      }
      case 'capture': {
        const cause = e['cause'];
        const text =
          cause === 'secure_desktop'
            ? 'Waiting for the user to answer Windows.'
            : e['path'] === 'gdi'
              ? 'Compatibility capture (slower).'
              : cause === 'recovered'
                ? null
                : this.snap.captureNotice;
        return this.set({ captureNotice: text });
      }
      case 'input_blocked': {
        const cause = e['cause'];
        const text =
          cause === 'uipi'
            ? 'This window runs as administrator; request elevation to control it.'
            : cause === 'secure_window'
              ? 'This app blocks remote input (secure window).'
              : 'Waiting for the user to answer Windows.';
        return this.set({ captureNotice: text });
      }
      case 'prompt':
        return this.set({ notice: e['state'] === 'shown' ? 'The user is being asked on the Desk.' : null });
      case 'keep':
        // Phase F section 3.4b: the Desk user's Keep choice, shown read-only by `<DeskKeepSlot>`.
        return this.set({ kept: e['kept'] === true });
      default:
        return;
    }
  }

  // ---------- ops ----------

  private op(op: AgentControlOp, args: Record<string, unknown>, id?: string) {
    // Phase F section 15.6: an e2e spec may define `window.__iaOps` (an array) to read the ops the console sent.
    (globalThis as { __iaOps?: { op: string; args: Record<string, unknown> }[] }).__iaOps?.push({ op, args });
    if (this.input && ['os.pointer', 'os.scroll', 'os.key', 'os.text', 'os.nav'].includes(op)) this.input.record(op, args);
    return this.ops.request(op, args, id);
  }

  private get controlling(): boolean {
    return this.snap.inputMode === 'control' && controlBlocker(this.snap) === null;
  }

  /**
   * C9: the gate for control-level actions that do not travel over the input surface (playbooks, elevation). It is
   * exactly `controlBlocker(snap) === null`: the secure channel is established, the user granted at least `control`,
   * and this generation's security code is confirmed. Unlike `controlling` it does not require the input mode to be
   * `control`, but it must never be bypassed the way `runPlaybook` / `cancelPlaybook` / `requestElevation` used to.
   */
  private get controlGranted(): boolean {
    return controlBlocker(this.snap) === null;
  }

  // ---------- monitors (section 3.6) ----------

  /** Views one monitor (selecting it when it is not streaming) or `all` (selects every monitor, mosaic). */
  async view(target: number | 'all'): Promise<void> {
    const ids = target === 'all' ? this.snap.monitors.map((m) => m.id) : [target];
    this.set({ viewed: target });
    if (ids.length === 0) return;
    const same = ids.length === this.snap.selected.length && ids.every((i) => this.snap.selected.includes(i));
    if (same) return;
    const { id, opId } = this.ops.newId();
    void this.report({ action: 'monitor.selected', data: { monitorIds: ids, opId } });
    const r = await this.ops.request('os.monitor.select', { monitorIds: ids }, id);
    if (r.ok && Array.isArray(r.result['selected'])) this.set({ selected: r.result['selected'] as number[] });
    else if (!r.ok) this.set({ error: `Monitor selection failed: ${r.code}` });
  }

  quality(preset: QualityPreset): void {
    void this.ops.request('os.quality', { preset });
  }

  // ---------- security code gate (section 1.3 step 7) ----------

  openSasPrompt(open = true): void {
    this.set({ sasPrompt: open });
  }

  confirmSas(typed: string, now = Date.now()): SasCheck {
    const sas = this.snap.sec.sas ?? '';
    const r = checkSas(this.sasGate, typed, sas, now);
    this.sasGate = r.state;
    if (r.result === 'ok') {
      const gen = this.snap.sec.gen;
      this.set({ sasConfirmedGen: gen, sasPrompt: false });
      void this.report({ action: 'sec.verified', data: { sas, gen } });
    }
    return r;
  }

  /** Only when the org does not require the confirmation; chained as skipped. */
  skipSas(): boolean {
    if (this.snap.requireSasConfirm || this.snap.sec.state !== 'established') return false;
    const gen = this.snap.sec.gen;
    this.set({ sasConfirmedGen: gen, sasPrompt: false });
    void this.report({ action: 'sec.verified', data: { sas: null, gen, skipped: true } });
    return true;
  }

  // ---------- input mode and level (sections 3.4, 13.4) ----------

  setInputMode(mode: 'view' | 'control'): boolean {
    if (mode === 'view') {
      this.releaseModifiers();
      this.set({ inputMode: 'view' });
      return true;
    }
    if (controlBlocker(this.snap) !== null) {
      if (this.snap.sec.state === 'established' && levelAllows(this.snap.created?.tier ?? 'p3_portable', this.snap.consent.level, 'control'))
        this.set({ sasPrompt: true });
      return false;
    }
    this.set({ inputMode: 'control' });
    return true;
  }

  /** "Ask the user": `level.request { level: 'control', reason }`, reported as `level.requested`. */
  async requestControl(reason: string): Promise<boolean> {
    const { id, opId } = this.ops.newId();
    void this.report({ action: 'level.requested', data: { level: 'control', opId }, ...(reason ? { reason } : {}) });
    const r = await this.ops.request('level.request', { level: 'control', ...(reason ? { reason } : {}) }, id);
    if (!r.ok) this.set({ notice: r.code === 'refused' ? 'The user refused control.' : `The control request ended: ${r.code}` });
    return r.ok;
  }

  /** Section 7.3 step 1: report `elevation.requested` (reason column), then the op on `ia.control`. */
  async requestElevation(reason: string): Promise<boolean> {
    const why = reason.trim();
    if (why.length < 1 || why.length > 500) return false;
    // C9: elevation is a control-level action; never request it (and never POST `elevation.requested`) at view or
    // before the security code is confirmed. Prompt for the code instead.
    if (!this.controlGranted) {
      this.openSasPrompt(true);
      return false;
    }
    const { id, opId } = this.ops.newId();
    this.set({ elevation: { opId, state: 'requesting' } });
    await this.report({ action: 'elevation.requested', data: { opId }, reason: why });
    const r = await this.ops.request('elevation.request', { reason: why }, id);
    if (!r.ok) this.set({ elevation: { opId, state: 'failed', cause: r.code } });
    return r.ok;
  }

  // ---------- input ops (sections 5.1, 5.2) ----------

  pointer(monitorId: number, kind: 'move' | 'down' | 'up' | 'click' | 'dblclick', nx: number, ny: number, button = 0, modifiers: Mods = NO_MODS): void {
    if (!this.controlling) return;
    const args = { monitorId, kind, nx: norm(nx), ny: norm(ny), button, modifiers };
    if (kind !== 'move') return void this.op('os.pointer', args);
    const now = Date.now();
    const stalled = (this.ops.oldestAge('os.pointer', now) ?? 0) > MOVE_STALL_MS;
    if (now - this.lastMoveAt >= MOVE_GAP_MS && !stalled) {
      this.lastMoveAt = now;
      void this.op('os.pointer', args);
      return;
    }
    this.pendingMove = args;
    if (!this.moveTimer)
      this.moveTimer = setTimeout(() => {
        this.moveTimer = null;
        const m = this.pendingMove;
        this.pendingMove = null;
        if (m && this.controlling) this.pointer(m['monitorId'] as number, 'move', m['nx'] as number, m['ny'] as number, m['button'] as number, m['modifiers'] as Mods);
      }, MOVE_GAP_MS);
  }

  scroll(monitorId: number, nx: number, ny: number, dx: number, dy: number): void {
    if (!this.controlling || (dx === 0 && dy === 0)) return;
    void this.op('os.scroll', { monitorId, nx: norm(nx), ny: norm(ny), dx, dy });
  }

  key(kind: 'down' | 'up' | 'press', e: KeyLike): void {
    if (!this.controlling) return;
    this.text.flush();
    void this.op('os.key', { kind, key: e.key.slice(0, 64), code: (e.code || e.key).slice(0, 64), modifiers: modifiersOf(e) });
  }

  typeText(text: string): void {
    if (!this.controlling || text === '') return;
    this.text.push(text);
  }

  nav(action: NavAction): void {
    if (!this.controlling || !hasFeature(this.snap, 'nav')) return;
    void this.op('os.nav', { action });
  }

  /** Phase F section 7.3: Ctrl+Alt+Del from the keys bar (`os.sas`, offered only when the Desk advertises `sas`). */
  sas(): void {
    if (!this.controlling) return;
    void this.op('os.sas', {});
  }

  /** On overlay blur: `up` for every modifier, so nothing stays held on the Desk (section 5.2). */
  releaseModifiers(): void {
    if (this.snap.inputMode !== 'control' || this.snap.sec.state !== 'established') return;
    for (const code of ['ControlLeft', 'ShiftLeft', 'AltLeft', 'MetaLeft'])
      void this.ops.request('os.key', { kind: 'up', key: code.replace('Left', ''), code, modifiers: NO_MODS });
  }

  // ---------- clipboard (section 5.6) ----------

  setClipboardSync(on: boolean): void {
    this.set({ clipboardSync: on && this.clipboardAllowed, clipboardReceived: null });
  }

  get clipboardAllowed(): boolean {
    return this.snap.consent.clipboard && hasFeature(this.snap, 'clipboard');
  }

  /** The console's copy / paste on the overlay: `clipboard.set` while both halves are on. */
  sendClipboard(text: string): void {
    if (!this.snap.clipboardSync || !this.clipboardAllowed || !this.controlling || text === '') return;
    void this.ops.request('clipboard.set', { text: text.slice(0, 65536) });
  }

  // ---------- playbooks (section 8) ----------

  async runPlaybook(pb: PlaybookManifest, args: Record<string, PlaybookArgValue>, reason?: string): Promise<string | null> {
    // C9: a playbook runs arbitrary, pre-approved code at control level; gate it on the same predicate as input.
    if (!this.controlGranted) {
      this.openSasPrompt(true);
      return 'Confirm the security code before running a playbook.';
    }
    const run = this.d.runPlaybook ?? playbooksApi.run;
    let reply;
    try {
      reply = await run(this.id, pb.id, args, reason);
    } catch (e) {
      return runErrorText(e);
    }
    this.set({ runs: addRun(this.snap.runs, { runId: reply.runId, playbookId: pb.id, name: pb.name, stdout: '', stderr: '', end: null, opError: null }) });
    const r = await this.ops.request('playbook.run', playbookRunOpArgs(reply), reply.runId);
    if (!r.ok) this.set({ runs: applyOpError(this.snap.runs, reply.runId, r.code) });
    return null;
  }

  async cancelPlaybook(runId: string): Promise<void> {
    // C9: cancelling a run is also a control-level op; do not send it unless control is granted and the code confirmed.
    if (!this.controlGranted) {
      this.openSasPrompt(true);
      return;
    }
    await this.ops.request('playbook.cancel', { runId }, `${runId}:cancel`);
  }

  // ---------- files and annotations ----------

  async sendFile(file: File): Promise<void> {
    if (!this.link) throw new Error('The secure connection is not ready.');
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

  /** Annotations carry the viewed `monitorId` in P3 (section 3.6 M4). */
  sendAnnot(msg: DcAnnot): void {
    const monitorId = typeof this.snap.viewed === 'number' ? this.snap.viewed : (this.snap.selected[0] ?? 1);
    this.link?.hub.send({ ...msg, monitorId } as DcAnnot);
  }

  // ---------- voice (section 6.3, A D8) ----------

  get voiceSupported(): boolean {
    return hasFeature(this.snap, 'voice');
  }

  /**
   * The microphone toggle. The first click asks for the mic (audio only, in the click) and attaches it to the agent
   * link's audio sender (`replaceTrack` on the offered transceiver); later clicks only enable / disable the track,
   * so turning it back on needs no new prompt and no renegotiation. Every change is `voice.state` on `ia.ctrl`.
   */
  async toggleVoice(): Promise<void> {
    if (!this.voiceSupported || this.snap.sec.state !== 'established' || this.micPending) return;
    const current = this.mic?.getAudioTracks()[0];
    if (current) {
      current.enabled = !current.enabled;
      this.set({ voiceOn: current.enabled, muted: !current.enabled });
      this.sendVoiceState();
      return;
    }
    this.micPending = true;
    let stream: MediaStream;
    try {
      const gum = this.d.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
      stream = await gum({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    } catch (e) {
      this.set({ notice: `Microphone unavailable: ${errorMessage(e)}` });
      return;
    } finally {
      this.micPending = false;
    }
    const track = stream.getAudioTracks()[0];
    // The session ended (or the link went away) while the prompt was open: release the device at once.
    if (!track || this.disposed || !this.link || this.snap.phase === 'ending' || this.snap.phase === 'ended') {
      for (const t of stream.getTracks()) t.stop();
      if (!track) this.set({ notice: 'Microphone unavailable: no audio track.' });
      return;
    }
    track.enabled = true;
    this.mic = stream;
    this.set({ voiceOn: true, muted: false });
    await this.attachMic();
    this.sendVoiceState();
  }

  private async attachMic(): Promise<void> {
    const track = this.mic?.getAudioTracks()[0];
    if (!track || !this.mic || !this.link) return;
    try {
      await this.link.setLocalAudio(track, this.mic);
    } catch (e) {
      this.set({ notice: `Microphone could not be attached: ${errorMessage(e)}` });
    }
  }

  private sendVoiceState(): void {
    this.link?.hub.send({ t: 'voice.state', from: 'assist', muted: !this.snap.voiceOn, ts: Date.now() });
  }

  private stopMic(): void {
    if (!this.mic && !this.snap.voiceOn) return;
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
    this.set({ voiceOn: false, muted: false });
  }

  protected override localAudio(): { track: MediaStreamTrack; stream: MediaStream } | null {
    const track = this.mic?.getAudioTracks()[0];
    return track && this.mic ? { track, stream: this.mic } : null;
  }

  /** After every (re)build: make sure the mic rides the new link and tell the Desk its state. */
  protected override onSecured(): void {
    if (!this.mic) return;
    void this.attachMic().then(() => this.sendVoiceState());
  }

  override teardown(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.pendingMove = null;
    this.text?.dispose();
    super.teardown();
    // Hard rule 2: input first, then the link, then every local track (rebuilds use closeLink and keep the mic).
    this.stopMic();
  }
}
