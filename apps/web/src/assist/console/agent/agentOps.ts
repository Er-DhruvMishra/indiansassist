/**
 * Request / response pairing of the encrypted `ia.control` (B section 5.1 envelope reused by Phase C section 5.1):
 * one `ctl.res` per `ctl.req`, 10 s timeout, 65 s for the ops that wait on a Desk prompt. A timeout resolves with
 * `{ ok: false, error: { code: 'timeout' } }` so callers never hang.
 */
import { LIMITS, opIdFor, type AgentControlOp } from '@indiansassist/shared';
import { uuid } from '../../../lib/ids';

export type OpResult = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };

const PROMPT_OPS: readonly string[] = ['level.request'];

type Pending = { resolve: (r: OpResult) => void; timer: ReturnType<typeof setTimeout>; op: string; at: number };

export class OpTracker {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly sessionId: string,
    /** Sends one sealed `ctl.req`; false when the channel is not usable. */
    private readonly sendReq: (msg: { t: 'ctl.req'; id: string; op: AgentControlOp; args: Record<string, unknown>; ts: number }) => boolean,
  ) {}

  /** A fresh request id (<= 40 chars) and its chain correlation id. */
  newId(): { id: string; opId: string } {
    const id = uuid().replace(/-/g, '').slice(0, 24);
    return { id, opId: opIdFor(this.sessionId, id) };
  }

  request(op: AgentControlOp, args: Record<string, unknown>, id = this.newId().id): Promise<OpResult> {
    return new Promise<OpResult>((resolve) => {
      const ms = PROMPT_OPS.includes(op) ? LIMITS.promptRequestTimeoutMs : LIMITS.controlRequestTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: 'timeout', message: 'The Desk did not answer in time.' });
      }, ms);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, timer, op, at: Date.now() });
      if (!this.sendReq({ t: 'ctl.req', id, op, args, ts: Date.now() })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, code: 'not_connected', message: 'The secure channel is not open.' });
      }
    });
  }

  /** Applies a `ctl.res`; returns true when it matched a pending request. */
  settle(res: { id: string; ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }): boolean {
    const p = this.pending.get(res.id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(res.id);
    p.resolve(res.ok ? { ok: true, result: res.result ?? {} } : { ok: false, code: res.error?.code ?? 'internal', message: res.error?.message ?? '' });
    return true;
  }

  /** The oldest unanswered request of `op` (for the pointer-move coalescing rule), as its age in ms. */
  oldestAge(op: string, now = Date.now()): number | null {
    let age: number | null = null;
    for (const p of this.pending.values()) if (p.op === op) age = Math.max(age ?? 0, now - p.at);
    return age;
  }

  clear(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, code: 'not_connected', message: 'The connection closed.' });
    }
    this.pending.clear();
  }
}
