/**
 * Media path recovery for one RTCPeerConnection (contracts section 7.7, perfect negotiation): when the
 * connection reaches `failed`, or stays `disconnected` longer than a grace period, the owner is asked to
 * restart ICE. Restarts are bounded: after `maxRestarts` attempts that did not reach `connected` within
 * `attemptTimeoutMs` each, `onGiveUp` fires once. Pure timer logic; the controllers decide what a restart
 * means for their side (the impolite Desk calls `pc.restartIce()`, the Assist may switch to relay only).
 */

export type IceRecoveryOptions = {
  /** Called for every restart attempt (1-based). */
  onRestart: (attempt: number) => void;
  /** Called when the visible "reconnecting" state changes. */
  onReconnecting: (reconnecting: boolean) => void;
  /** Called once when every attempt failed. */
  onGiveUp?: () => void;
  /** How long `disconnected` may last before a restart (browsers often recover by themselves). */
  disconnectGraceMs?: number;
  /** How long one attempt may take to reach `connected` before the next one. */
  attemptTimeoutMs?: number;
  maxRestarts?: number;
};

export const ICE_RECOVERY_DEFAULTS = { disconnectGraceMs: 5000, attemptTimeoutMs: 10000, maxRestarts: 3 } as const;

export class IceRecovery {
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private gaveUp = false;
  private disposed = false;

  constructor(private readonly opts: IceRecoveryOptions) {}

  get attempt(): number {
    return this.attempts;
  }

  get exhausted(): boolean {
    return this.gaveUp;
  }

  /** Feed every `connectionState` change of the peer connection. */
  update(state: RTCPeerConnectionState): void {
    if (this.disposed) return;
    switch (state) {
      case 'connected':
        this.clearTimer();
        this.attempts = 0;
        this.gaveUp = false;
        this.setReconnecting(false);
        return;
      case 'disconnected':
        this.setReconnecting(true);
        if (!this.timer) this.timer = setTimeout(() => this.restart(), this.opts.disconnectGraceMs ?? ICE_RECOVERY_DEFAULTS.disconnectGraceMs);
        return;
      case 'failed':
        this.setReconnecting(true);
        // A pending attempt timer is replaced: `failed` is definitive, restart now.
        this.clearTimer();
        this.restart();
        return;
      case 'closed':
        this.dispose();
        return;
      default:
        return;
    }
  }

  private restart(): void {
    this.clearTimer();
    if (this.disposed || this.gaveUp) return;
    const max = this.opts.maxRestarts ?? ICE_RECOVERY_DEFAULTS.maxRestarts;
    if (this.attempts >= max) {
      this.gaveUp = true;
      this.opts.onGiveUp?.();
      return;
    }
    this.attempts += 1;
    try {
      this.opts.onRestart(this.attempts);
    } catch (e) {
      console.warn('[ice] restart failed', e);
    }
    this.timer = setTimeout(() => this.restart(), this.opts.attemptTimeoutMs ?? ICE_RECOVERY_DEFAULTS.attemptTimeoutMs);
  }

  private setReconnecting(on: boolean): void {
    if (this.reconnecting === on) return;
    this.reconnecting = on;
    this.opts.onReconnecting(on);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Stops every timer; no callback fires afterwards. */
  dispose(): void {
    this.clearTimer();
    this.disposed = true;
  }
}
