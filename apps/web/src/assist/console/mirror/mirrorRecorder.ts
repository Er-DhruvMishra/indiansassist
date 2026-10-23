/**
 * Optional mirror recording on the Assist (Phase B 4.7): every received (sanitised) rrweb event becomes one JSONL
 * line after a header line that binds the file to the technician; revealed values are redacted unless
 * `policy.recordRevealed` (Input events and Mutation `texts` of a revealed tab are dropped and one `redacted` line
 * per reveal is written instead). `finish()` gzips with `CompressionStream`; the upload uses the Phase A endpoints.
 */
import { RRWEB_RECORDING_MIME } from '@indiansassist/shared';

export type RecorderHeader = { sessionId: string; assist: { id: string; name: string }; rrweb: string; tabs: unknown[] };

const EV_INCREMENTAL = 3;
const SRC_MUTATION = 0;
const SRC_INPUT = 5;

type Reveal = { scope: 'field' | 'tab'; from: number };

export class MirrorRecorder {
  private lines: string[] = [];
  private bytes = 0;
  private reveals = new Map<number, Reveal>();
  readonly startedAt: number;

  constructor(
    header: RecorderHeader,
    private readonly recordRevealed: boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.push({ ia_rrweb: 1, sessionId: header.sessionId, assist: header.assist, startedAt: new Date(this.startedAt).toISOString(), rrweb: header.rrweb, tabs: header.tabs });
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

  private push(v: unknown): void {
    const line = JSON.stringify(v);
    this.lines.push(line);
    this.bytes += line.length + 1;
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

  /** A reveal started on a tab (`mirror.tab { state: 'revealed' }`). */
  revealStart(tabId: number, scope: 'field' | 'tab'): void {
    if (!this.reveals.has(tabId)) this.reveals.set(tabId, { scope, from: this.now() });
  }

  /** The reveal ended (`restored`): writes the `redacted` line when values were dropped. */
  revealEnd(tabId: number): void {
    const r = this.reveals.get(tabId);
    if (!r) return;
    this.reveals.delete(tabId);
    if (!this.recordRevealed) this.push({ tabId, redacted: { scope: r.scope, from: r.from, to: this.now() }, rx: this.now() });
  }

  text(): string {
    return this.lines.join('\n') + '\n';
  }

  /** Closes open reveals and returns the gzipped JSONL. */
  async finish(): Promise<Blob> {
    for (const tabId of [...this.reveals.keys()]) this.revealEnd(tabId);
    const stream = new Response(this.text()).body!.pipeThrough(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
    return new Response(stream).blob();
  }
}

/** Drops Input events and blanks Mutation `texts`; everything else is kept unchanged. */
export function redact(e: unknown): unknown {
  if (!e || typeof e !== 'object') return e;
  const ev = e as { type?: unknown; data?: { source?: unknown; texts?: unknown } };
  if (ev.type !== EV_INCREMENTAL || !ev.data) return e;
  if (ev.data.source === SRC_INPUT) return null;
  if (ev.data.source === SRC_MUTATION && Array.isArray(ev.data.texts) && ev.data.texts.length > 0) return { ...ev, data: { ...ev.data, texts: [] } };
  return e;
}
