/**
 * Join page <-> IndiansAssist extension (Phase B 2.1 J2, 2.2). Detection: (a) `window.postMessage` beacons from the
 * bridge content script, accepted only when `event.source === window` and `event.origin === location.origin` and
 * the payload validates (`ia.ext.present` / `ia.join.reply`), anything else ignored silently; (b) a
 * `chrome.runtime.sendMessage(id, ia.ext.ping)` to each published id (Chromium, externally_connectable). The join
 * message carries the code only (`{ t: 'ia.join', v: 1, code }`): the extension never takes a server from the page.
 */
import {
  EXT_HANDSHAKE_VERSION,
  extPongSchema,
  extPresentSchema,
  joinReplySchema,
  type JoinReply,
} from '@indiansassist/shared';

export type Detected = { version: string; id: string; via: 'bridge' | 'external' };

type SendMessage = (id: string, msg: unknown, cb: (reply: unknown) => void) => void;
export type RuntimeLike = { sendMessage?: SendMessage; lastError?: { message?: string } | undefined };
export type WindowLike = Pick<Window, 'addEventListener' | 'removeEventListener' | 'postMessage'> & { location: { origin: string } };

export type BridgeAccepted = { kind: 'present'; version: string; id: string } | { kind: 'reply'; reply: JoinReply };

/** Validates one `message` event from the bridge; null for anything foreign (other source, other origin, bad shape). */
export function acceptBridgeMessage(ev: Pick<MessageEvent, 'source' | 'origin' | 'data'>, win: WindowLike): BridgeAccepted | null {
  if (ev.source !== (win as unknown) || ev.origin !== win.location.origin) return null;
  const present = extPresentSchema.safeParse(ev.data);
  if (present.success) return { kind: 'present', version: present.data.version, id: present.data.id };
  const d = ev.data as { source?: unknown; t?: unknown } | null;
  if (!d || d.source !== 'ia-ext' || d.t !== 'ia.join.reply') return null;
  const reply = joinReplySchema.safeParse(ev.data);
  return reply.success ? { kind: 'reply', reply: reply.data } : null;
}

export const JOIN_REPLY_TIMEOUT_MS = 10_000;

export type ExtensionLinkOptions = {
  win: WindowLike;
  runtime: RuntimeLike | undefined;
  ids: readonly string[];
  onDetected: (d: Detected) => void;
  timeoutMs?: number;
};

export type JoinOutcome = JoinReply | { ok: false; error: 'no_answer' };

export class ExtensionLink {
  private detected: Detected | null = null;
  private waiting: ((r: JoinOutcome) => void) | null = null;
  private stopped = false;

  constructor(private readonly opts: ExtensionLinkOptions) {}

  get current(): Detected | null {
    return this.detected;
  }

  private mark(d: Detected): void {
    // The externally_connectable carrier is preferred once known (it works where content scripts are blocked).
    if (this.detected && this.detected.via === 'external' && d.via === 'bridge') return;
    this.detected = d;
    this.opts.onDetected(d);
  }

  private onMessage = (ev: MessageEvent): void => {
    const a = acceptBridgeMessage(ev, this.opts.win);
    if (!a) return;
    if (a.kind === 'present') this.mark({ version: a.version, id: a.id, via: 'bridge' });
    else if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(a.reply);
    }
  };

  start(): void {
    this.opts.win.addEventListener('message', this.onMessage as EventListener);
    const send = this.opts.runtime?.sendMessage;
    if (typeof send !== 'function') return;
    for (const id of this.opts.ids) {
      try {
        send.call(this.opts.runtime, id, { t: 'ia.ext.ping', v: EXT_HANDSHAKE_VERSION }, (reply: unknown) => {
          void this.opts.runtime?.lastError; // reading lastError marks a missing extension as handled
          if (this.stopped) return;
          const p = extPongSchema.safeParse(reply);
          if (p.success && p.data.id === id) this.mark({ version: p.data.version, id, via: 'external' });
        });
      } catch {
        /* not installed / not externally connectable for this origin */
      }
    }
  }

  /** Hands the code to the extension over the carrier that answered (A first, else B). */
  join(code: string): Promise<JoinOutcome> {
    const msg = { t: 'ia.join', v: EXT_HANDSHAKE_VERSION, code };
    const d = this.detected;
    const send = this.opts.runtime?.sendMessage;
    return new Promise<JoinOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        resolve({ ok: false, error: 'no_answer' });
      }, this.opts.timeoutMs ?? JOIN_REPLY_TIMEOUT_MS);
      const done = (r: JoinOutcome) => {
        clearTimeout(timer);
        resolve(r);
      };
      if (d?.via === 'external' && typeof send === 'function') {
        try {
          send.call(this.opts.runtime, d.id, msg, (reply: unknown) => {
            void this.opts.runtime?.lastError;
            const p = joinReplySchema.safeParse(reply);
            done(p.success ? p.data : { ok: false, error: 'no_answer' });
          });
          return;
        } catch {
          /* fall through to the bridge */
        }
      }
      this.waiting = done;
      this.opts.win.postMessage(msg, this.opts.win.location.origin);
    });
  }

  stop(): void {
    this.stopped = true;
    this.waiting = null;
    this.opts.win.removeEventListener('message', this.onMessage as EventListener);
  }
}

/** Phase B 2.1 J6: Firefox / Safari, or no `window.chrome` object at all and no bridge beacon. */
export function isNonChromium(ua: string, hasChromeObject: boolean): boolean {
  if (/Firefox\//.test(ua)) return true;
  if (/Safari\//.test(ua) && !/(Chrome|Chromium|Edg)\//.test(ua)) return true;
  return !hasChromeObject;
}

/** Edge gets the Edge Add-ons listing when the low-entropy brands say so (J4). */
export function isEdge(brands: readonly { brand: string }[] | undefined): boolean {
  return (brands ?? []).some((b) => b.brand === 'Microsoft Edge');
}

export const JOIN_ERROR_TEXT: Record<string, string> = {
  busy: 'Finish the current session in the extension first.',
  bad_code: 'The extension could not verify this code. Ask your technician for a new link.',
  origin: 'The extension does not accept codes from this site.',
  version: 'Update the IndiansAssist extension and try again.',
  unsupported_tier: 'This code is for a different IndiansAssist package.',
  no_answer: 'The extension did not answer.',
};
