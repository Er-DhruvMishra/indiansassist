/**
 * Phase C section 1.3 handshake driver: the state machine over the `sec.ts` primitives that both TS reporters use
 * (the console's `AgentConsole` and the Node fake agent of `smoke:p3`). Commit first, hello only once the peer's
 * commit is held, confirm after both hellos, `established` once the own confirm was sent and the peer's verified.
 * Every order or shape violation is `commit`, an unknown suite or version `suite` (steps 2a, 2b); any `sec.fail`
 * received ends the handshake. Mirrors the Rust `ia_core::sec` driver and the Kotlin `SecHandshake`.
 */
import { LIMITS, SEC_FAIL_REASONS, SEC_SUITE, type SecEncryptedLabel, type SecFailReason, type SecSide } from '../enums.js';
import {
  commitHash,
  deriveSecKeys,
  secConfirmMac,
  secGenerateKeyPair,
  SecChannel,
  SecError,
  secMessageSchema,
  secPublicKey,
  secSharedSecret,
  secTranscriptHash,
  verifyHelloAgainstCommit,
  verifyPeerFingerprint,
  verifySecConfirm,
  type SecHello,
  type SecMessage,
} from './sec.js';

export type SecHandshakeState = 'idle' | 'committed' | 'confirming' | 'established' | 'failed';

export interface SecHandshakeOptions {
  side: SecSide;
  sessionId: string;
  /** Key generation of this peer connection (0, then +1 per rebuild / hand-over). */
  gen: number;
  /** Own and remote `a=fingerprint:sha-256` of the current descriptions, 64 lower-case hex. */
  ownFpr: string;
  remoteFpr: string;
  /** Sends one `ia.sec` message (plaintext JSON on the handshake channel). */
  send: (msg: SecMessage) => void;
  /** Injectable for test vectors: a fixed 32-byte X25519 private key. */
  esk?: Uint8Array;
  now?: () => number;
  /** Arms the 10 s timeout (section 1.3 step 8); default true. */
  timer?: boolean;
}

export interface SecEstablished {
  sas: string;
  gen: number;
  kD2A: Uint8Array;
  kA2D: Uint8Array;
}

export class SecHandshake {
  state: SecHandshakeState = 'idle';
  failReason: SecFailReason | null = null;
  result: SecEstablished | null = null;
  onEstablished: ((r: SecEstablished) => void) | null = null;
  onFailed: ((reason: SecFailReason, sent: boolean) => void) | null = null;

  private esk: Uint8Array;
  private readonly epk: string;
  private readonly ownH: string;
  private peerH: string | null = null;
  private peerHello: SecHello | null = null;
  private helloSent = false;
  private confirmSent = false;
  private peerConfirmed = false;
  private transcript: Uint8Array | null = null;
  private kConf: Uint8Array | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly channels = new Map<SecEncryptedLabel, SecChannel>();

  constructor(private readonly o: SecHandshakeOptions) {
    if (o.esk) {
      this.esk = o.esk;
      this.epk = secPublicKey(o.esk);
    } else {
      const kp = secGenerateKeyPair();
      this.esk = kp.esk;
      this.epk = kp.epk;
    }
    this.ownH = commitHash(o.side, SEC_SUITE, this.epk, o.ownFpr);
  }

  private get peerSide(): SecSide {
    return this.o.side === 'desk' ? 'assist' : 'desk';
  }

  private ts(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Step 2a: sends the commit and arms the timeout. */
  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'committed';
    this.o.send({ t: 'sec.commit', v: 1, sessionId: this.o.sessionId, side: this.o.side, h: this.ownH, gen: this.o.gen, ts: this.ts() });
    if (this.o.timer !== false) {
      this.timer = setTimeout(() => this.fail('timeout'), LIMITS.secHandshakeTimeoutMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
    this.maybeHello();
  }

  /** Feeds one message received on `ia.sec` (a parsed object or the JSON text). */
  receive(raw: unknown): void {
    if (this.state === 'failed' || this.state === 'established') {
      if (this.state === 'established') this.fail('commit');
      return;
    }
    let value = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        return this.fail('commit');
      }
    }
    const v = value as { t?: unknown; v?: unknown; reason?: unknown };
    if (v?.t === 'sec.fail') {
      const reason = (SEC_FAIL_REASONS as readonly string[]).includes(String(v.reason)) ? (v.reason as SecFailReason) : 'commit';
      return this.failed(reason, false);
    }
    if (v?.t === 'sec.hello' && v.v !== 1) return this.fail('suite');
    const parsed = secMessageSchema.safeParse(value);
    if (!parsed.success) return this.fail('commit');
    try {
      this.handle(parsed.data);
    } catch (err) {
      this.fail(err instanceof SecError ? err.reason : 'commit');
    }
  }

  private handle(m: SecMessage): void {
    const { o } = this;
    switch (m.t) {
      case 'sec.commit':
        if (this.peerH !== null || m.sessionId !== o.sessionId || m.side !== this.peerSide || m.gen !== o.gen) throw new SecError('commit');
        this.peerH = m.h;
        this.maybeHello();
        return;
      case 'sec.hello':
        if (m.suite !== SEC_SUITE) throw new SecError('suite');
        if (this.peerH === null || this.peerHello !== null || m.sessionId !== o.sessionId || m.side !== this.peerSide)
          throw new SecError('commit');
        verifyHelloAgainstCommit(m, this.peerH);
        verifyPeerFingerprint(m.fpr, o.remoteFpr);
        this.peerHello = m;
        this.derive();
        return;
      case 'sec.confirm':
        if (!this.kConf || !this.transcript || this.peerConfirmed) throw new SecError('commit');
        verifySecConfirm(this.kConf, this.peerSide, this.transcript, m.mac);
        this.peerConfirmed = true;
        this.maybeEstablished();
        return;
      case 'sec.fail':
        return;
    }
  }

  private maybeHello(): void {
    if (this.helloSent || this.state !== 'committed' || this.peerH === null) return;
    this.helloSent = true;
    this.o.send({
      t: 'sec.hello',
      v: 1,
      sessionId: this.o.sessionId,
      side: this.o.side,
      suite: SEC_SUITE,
      epk: this.epk,
      fpr: this.o.ownFpr,
      ts: this.ts(),
    });
  }

  private derive(): void {
    const { o } = this;
    const peer = this.peerHello!;
    const ss = secSharedSecret(this.esk, peer.epk);
    const own = { h: this.ownH, epk: this.epk, fpr: o.ownFpr };
    const theirs = { h: this.peerH!, epk: peer.epk, fpr: peer.fpr };
    const T = secTranscriptHash({
      sessionId: o.sessionId,
      suite: SEC_SUITE,
      gen: o.gen,
      desk: o.side === 'desk' ? own : theirs,
      assist: o.side === 'assist' ? own : theirs,
    });
    const keys = deriveSecKeys(ss, T);
    this.transcript = T;
    this.kConf = keys.kConf;
    this.result = { sas: keys.sas, gen: o.gen, kD2A: keys.kD2A, kA2D: keys.kA2D };
    ss.fill(0);
    keys.prk.fill(0);
    this.esk.fill(0);
    this.state = 'confirming';
    this.confirmSent = true;
    o.send({ t: 'sec.confirm', mac: secConfirmMac(keys.kConf, o.side, T), ts: this.ts() });
    this.maybeEstablished();
  }

  private maybeEstablished(): void {
    if (!this.confirmSent || !this.peerConfirmed || this.state === 'established') return;
    this.state = 'established';
    if (this.timer) clearTimeout(this.timer);
    this.kConf?.fill(0);
    this.onEstablished?.(this.result!);
  }

  /** Sends `sec.fail { reason }` and ends the handshake (step 9: the caller tears down and ends the session). */
  fail(reason: SecFailReason): void {
    if (this.state === 'failed') return;
    try {
      this.o.send({ t: 'sec.fail', reason, ts: this.ts() });
    } finally {
      this.failed(reason, true);
    }
  }

  private failed(reason: SecFailReason, sent: boolean): void {
    if (this.state === 'failed') return;
    this.state = 'failed';
    this.failReason = reason;
    if (this.timer) clearTimeout(this.timer);
    this.esk.fill(0);
    this.onFailed?.(reason, sent);
  }

  /** The `SecChannel` of an encrypted label for this key generation (one per label, created on first use). */
  channel(label: SecEncryptedLabel): SecChannel {
    if (this.state !== 'established' || !this.result) throw new Error('secure channel is not established');
    let c = this.channels.get(label);
    if (!c) {
      c = new SecChannel({ side: this.o.side, sessionId: this.o.sessionId, label, gen: this.o.gen, kD2A: this.result.kD2A, kA2D: this.result.kA2D });
      this.channels.set(label, c);
    }
    return c;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.esk.fill(0);
    this.kConf?.fill(0);
    this.result?.kD2A.fill(0);
    this.result?.kA2D.fill(0);
    this.channels.clear();
  }
}

/** Console gate (section 1.3 step 7): compares the six digits the user read out, constant time, spaces ignored. */
export function sasMatches(typed: string, sas: string): boolean {
  const digits = typed.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits) || !/^\d{6}$/.test(sas)) return false;
  let diff = 0;
  for (let i = 0; i < 6; i++) diff |= digits.charCodeAt(i) ^ sas.charCodeAt(i);
  return diff === 0;
}
