/**
 * The Desk's file attestations (contracts section 8.3 F7): WS `desk.event`, resolved by `event.ok`
 * (matched on `re`, else the oldest pending one), or `false` after 10 s or when the socket is down.
 */
import type { FileEventData } from '@indiansassist/shared';
import type { SignalClient } from '../lib/signal';

export class DeskAttestations {
  private pending = new Map<string, (ok: boolean) => void>();
  private seq = 0;

  constructor(
    private readonly signal: SignalClient,
    private readonly sessionId: () => string | null,
  ) {}

  attest(action: 'file.sent' | 'file.received', data: FileEventData): Promise<boolean> {
    const sessionId = this.sessionId();
    if (!sessionId) return Promise.resolve(false);
    const id = `ev${++this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      if (!this.signal.send({ t: 'desk.event', id, sessionId, action, data })) {
        this.pending.delete(id);
        resolve(false);
        return;
      }
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(false);
      }, 10000);
    });
  }

  /** `event.ok` from the server. */
  acknowledge(re: string | undefined): void {
    const key = re && this.pending.has(re) ? re : this.pending.keys().next().value;
    if (key === undefined) return;
    this.pending.get(key)?.(true);
    this.pending.delete(key);
  }

  dispose(): void {
    for (const r of this.pending.values()) r(false);
    this.pending.clear();
  }
}
