/**
 * The service worker's WebSocket `/signal` client (sections 2.4, 9.2). Every inbound frame is validated with the
 * shared `parseServerSignal`; every outbound frame with `encodeSignal`. A server `ping` is answered with `pong`
 * at once (that traffic also keeps the MV3 worker alive, Chrome 116+). Reconnects with backoff 1, 2, 4, 8 s,
 * capped at 30 s, unless the close code is terminal; the owner re-sends `desk.hello` (with `resumeKey`) on open.
 */
import { WS_CLOSE, encodeSignal, parseServerSignal, type ClientSignalMessage, type ServerSignalMessage } from '@indiansassist/shared';
import { signalBackoffMs } from '../shared/constants';

export const TERMINAL_CLOSE_CODES: readonly number[] = [WS_CLOSE.unauthenticated, WS_CLOSE.forbidden, WS_CLOSE.tokenBusy, WS_CLOSE.sessionEnded];

export type SignalEvents = {
  onOpen: (reconnect: boolean) => void;
  onMessage: (msg: ServerSignalMessage) => void;
  onClose: (code: number, terminal: boolean) => void;
};

export class SignalClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private opened = false;
  private closedByOwner = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly events: SignalEvents,
    private readonly WebSocketImpl: typeof WebSocket = globalThis.WebSocket,
  ) {}

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  connect(): void {
    this.closedByOwner = false;
    this.open();
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnect = this.opened;
      this.opened = true;
      this.attempt = 0;
      this.events.onOpen(reconnect);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      const parsed = parseServerSignal(ev.data);
      if (!parsed.ok) {
        console.warn('[signal] dropped invalid frame', parsed.code);
        return;
      }
      if (parsed.msg.t === 'ping') this.send({ t: 'pong', ...(parsed.msg.id ? { re: parsed.msg.id } : {}) });
      this.events.onMessage(parsed.msg);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const terminal = TERMINAL_CLOSE_CODES.includes(ev.code);
      this.events.onClose(ev.code, terminal || this.closedByOwner);
      if (!this.closedByOwner && !terminal) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.timer) return;
    const delay = signalBackoffMs(this.attempt++);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closedByOwner) this.open();
    }, delay);
  }

  /** Sends now when open; false (frame dropped) otherwise. Invalid messages are refused (programming error). */
  send(msg: ClientSignalMessage): boolean {
    let frame: string;
    try {
      frame = encodeSignal(msg);
    } catch (e) {
      console.error('[signal] refusing to send an invalid message', msg.t, e);
      return false;
    }
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(frame);
    return true;
  }

  close(code: number = WS_CLOSE.normal): void {
    this.closedByOwner = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) ws.close(code);
  }
}
