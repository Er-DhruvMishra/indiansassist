/**
 * The WS relay fallback, Desk side (section 4.6, Y22): payloads sliced into `mirror.relay` parts of at most
 * 30 KiB raw (40960 base64url chars), at most 256 parts, and a pacing contract: the Desk tracks its own spend
 * against 512 KiB of `data` per sliding 10 s and delays parts until the window frees (a snapshot may span windows).
 */
import { LIMITS } from '@indiansassist/shared';

export const RELAY_SLICE_BYTES = (LIMITS.mirrorRelayDataChars / 4) * 3; // 30720 raw bytes -> 40960 chars

export type RelayFrame = {
  t: 'mirror.relay';
  tabId: number;
  seq: number;
  kind: 'batch' | 'snapshot' | 'json';
  enc: 'none' | 'deflate';
  part: number;
  parts: number;
  data: string;
};

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** Slices one payload into relay parts; null when it needs more than 256 parts. */
export function relayParts(payload: Uint8Array, h: { tabId: number; seq: number; kind: 'batch' | 'snapshot'; enc: 'none' | 'deflate' }): RelayFrame[] | null {
  const parts = Math.max(1, Math.ceil(payload.length / RELAY_SLICE_BYTES));
  if (parts > LIMITS.mirrorRelayMaxParts) return null;
  const out: RelayFrame[] = [];
  for (let i = 0; i < parts; i++) {
    const data = base64url(payload.subarray(i * RELAY_SLICE_BYTES, (i + 1) * RELAY_SLICE_BYTES));
    out.push({ t: 'mirror.relay', ...h, part: i + 1, parts, data });
  }
  return out;
}

/** A JSON text frame (`mirror.tabs`, `mirror.tab`) as a single `kind: 'json'` part; null when too long. */
export function relayJson(text: string): RelayFrame | null {
  const data = base64url(new TextEncoder().encode(text));
  if (data.length > LIMITS.mirrorRelayDataChars) return null;
  return { t: 'mirror.relay', tabId: 0, seq: 0, kind: 'json', enc: 'none', part: 1, parts: 1, data };
}

export class RelayPacer {
  private queue: RelayFrame[] = [];
  private spent: { at: number; chars: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;

  constructor(
    private readonly send: (frame: RelayFrame) => boolean,
    private readonly budgetChars: number = LIMITS.mirrorRelayBudgetBytes,
    windowSec: number = LIMITS.mirrorRelayBudgetWindowSec,
    private readonly now: () => number = Date.now,
  ) {
    this.windowMs = windowSec * 1000;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Characters of `data` sent in the current window. */
  used(): number {
    const t = this.now();
    this.spent = this.spent.filter((s) => t - s.at < this.windowMs);
    return this.spent.reduce((a, s) => a + s.chars, 0);
  }

  enqueue(frames: RelayFrame[]): void {
    this.queue.push(...frames);
    this.pump();
  }

  /** Drops queued parts of one tab (a new snapshot supersedes them) or everything. */
  drop(tabId?: number): void {
    this.queue = tabId === undefined ? [] : this.queue.filter((f) => f.tabId !== tabId || f.kind === 'json');
  }

  pump(): void {
    if (this.timer) return;
    while (this.queue.length > 0) {
      const f = this.queue[0]!;
      if (this.used() + f.data.length > this.budgetChars && this.spent.length > 0) {
        const wait = this.windowMs - (this.now() - this.spent[0]!.at) + 5;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, Math.max(10, wait));
        return;
      }
      if (!this.send(f)) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, 500);
        return;
      }
      this.queue.shift();
      this.spent.push({ at: this.now(), chars: f.data.length });
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }
}
