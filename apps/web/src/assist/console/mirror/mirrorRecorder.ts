/**
 * Optional mirror recording on the Assist (Phase B 4.7): every received (sanitised) rrweb event becomes one JSONL
 * line after a header line that binds the file to the technician. Unless `policy.recordRevealed`, a revealed value is
 * never stored: while a reveal is in force on a tab, that tab's events are re-masked (`mirrorRedact.ts`: snapshot and
 * mutation text and values masked, Input dropped) and one `redacted` line per reveal is written. Because the Desk
 * takes the revealing FullSnapshot **before** `mirror.tab { state: 'revealed' }` and the `mask.request` answer reach
 * the console, the console calls `ask()` when it sends `mask.request`: from then on every line is held in memory
 * until the answer (refused: written unchanged; granted, `revealed` or `restored`: the tab's held events are
 * re-masked first). `finish()` gzips with `CompressionStream`; the upload uses the Phase A endpoints.
 */
import { RRWEB_RECORDING_MIME } from '@indiansassist/shared';
import { redact } from './mirrorRedact';

export { redact } from './mirrorRedact';

export type RecorderHeader = { sessionId: string; assist: { id: string; name: string }; rrweb: string; tabs: unknown[] };

type Scope = 'field' | 'tab';
type Reveal = { scope: Scope; from: number };
/** An unmask request in flight: `pending` holds lines; `resolved` = a reveal already started or ended for it. */
type Ask = { from: number; phase: 'pending' | 'resolved' };
type Line = Record<string, unknown>;

export class MirrorRecorder {
  private lines: string[] = [];
  private bytes = 0;
  private reveals = new Map<number, Reveal>();
  private asks = new Map<number, Ask>();
  private held: Line[] = [];
  readonly startedAt: number;

  constructor(
    header: RecorderHeader,
    private readonly recordRevealed: boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.write({ ia_rrweb: 1, sessionId: header.sessionId, assist: header.assist, startedAt: new Date(this.startedAt).toISOString(), rrweb: header.rrweb, tabs: header.tabs });
  }

  get mime(): string {
    return RRWEB_RECORDING_MIME;
  }

  get size(): number {
    return this.bytes;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** True when revealed values are kept out of the file (`policy.recordRevealed` is false). */
  get redactsRevealed(): boolean {
    return !this.recordRevealed;
  }

  private write(v: unknown): void {
    const line = JSON.stringify(v);
    this.lines.push(line);
    this.bytes += line.length + 1;
  }

  private holding(): boolean {
    for (const a of this.asks.values()) if (a.phase === 'pending') return true;
    return false;
  }

  /** Keeps receive order: while any ask is pending every line waits in `held`. */
  private push(v: Line): void {
    if (this.holding()) this.held.push(v);
    else this.write(v);
  }

  private flush(): void {
    if (this.holding()) return;
    const held = this.held;
    this.held = [];
    for (const v of held) this.write(v);
  }

  /** Re-masks the held events of a tab whose ask turned out to reveal values. */
  private redactHeld(tabId: number): void {
    this.held = this.held.flatMap((v) => {
      if (v.tabId !== tabId || !('e' in v)) return [v];
      const e = redact(v.e);
      return e === null ? [] : [{ ...v, e }];
    });
  }

  /** Settles a pending ask as revealing: held events re-masked, the reveal opened from the ask time. */
  private resolve(tabId: number, scope: Scope): void {
    const a = this.asks.get(tabId);
    if (!a || a.phase !== 'pending') return;
    a.phase = 'resolved';
    this.redactHeld(tabId);
    if (!this.reveals.has(tabId)) this.reveals.set(tabId, { scope, from: a.from });
  }

  /** One sanitised rrweb event of a tab, in receive order. */
  event(tabId: number, seq: number, e: unknown): void {
    const kept = this.reveals.has(tabId) && !this.recordRevealed ? redact(e) : e;
    if (kept === null) return;
    this.push({ tabId, seq, rx: this.now(), e: kept });
  }

  /** A `mirror.tab` / `mirror.tabs` message (`tabId` absent for the list). */
  meta(meta: unknown, tabId?: number): void {
    this.push(tabId === undefined ? { meta, rx: this.now() } : { tabId, meta, rx: this.now() });
  }

  /** Peer-connection rebuild marker (Phase B 3.5). */
  reconnect(): void {
    this.push({ meta: { t: 'reconnect' }, rx: this.now() });
  }

  /** The console sent `mask.request` for a tab (or holds one in flight): hold lines until it is answered. */
  ask(tabId: number): void {
    if (this.recordRevealed || this.asks.has(tabId)) return;
    this.asks.set(tabId, { from: this.now(), phase: 'pending' });
  }

  /** The `mask.request` answer (anything but `granted: true` counts as not granted). */
  answered(tabId: number, granted: boolean, scope: Scope): void {
    const a = this.asks.get(tabId);
    if (!a) return;
    if (granted) this.resolve(tabId, scope);
    this.asks.delete(tabId);
    this.flush();
  }

  /** A reveal started on a tab (`mirror.tab { state: 'revealed' }`). */
  revealStart(tabId: number, scope: Scope): void {
    if (this.asks.get(tabId)?.phase === 'pending') {
      this.resolve(tabId, scope);
      this.flush();
    } else if (!this.reveals.has(tabId)) this.reveals.set(tabId, { scope, from: this.now() });
  }

  /** The reveal ended (`restored` / `detached`); true when a `redacted` line was written. */
  revealEnd(tabId: number): boolean {
    // A `restored` with no open reveal belongs to the pending ask (its `revealed` was missed): fail closed.
    if (!this.reveals.has(tabId) && this.asks.get(tabId)?.phase === 'pending') this.resolve(tabId, 'field');
    const r = this.reveals.get(tabId);
    if (!r) return false;
    this.reveals.delete(tabId);
    if (!this.recordRevealed) this.push({ tabId, redacted: { scope: r.scope, from: r.from, to: this.now() }, rx: this.now() });
    this.flush();
    return !this.recordRevealed;
  }

  /** The written lines (held lines of an unanswered ask are not included yet). */
  text(): string {
    return this.lines.join('\n') + '\n';
  }

  /** Settles unanswered asks as revealing (fail closed), closes open reveals and returns the gzipped JSONL. */
  async finish(): Promise<Blob> {
    for (const [tabId, a] of [...this.asks]) if (a.phase === 'pending') this.resolve(tabId, 'field');
    this.asks.clear();
    this.flush();
    for (const tabId of [...this.reveals.keys()]) this.revealEnd(tabId);
    const stream = new Response(this.text()).body!.pipeThrough(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
    return new Response(stream).blob();
  }
}
