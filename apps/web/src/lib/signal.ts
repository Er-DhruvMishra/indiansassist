/**
 * WebSocket `/signal` client shared by the Assist console and the Desk room (contracts section 7).
 *
 * - Every inbound frame is validated with the shared `parseServerSignal`; invalid frames are dropped.
 * - Every outbound frame is validated with the shared `encodeSignal` (throws on a programming error).
 * - JSON heartbeat: a server `ping` is answered with `pong` immediately (section 7.2); the client also
 *   sends its own `ping` every 15 s to measure signaling latency (section 13.2).
 * - Reconnects with exponential backoff unless the close code is terminal (4401, 4403, 4409, 4410) or the
 *   owner called `close()`. The owner re-sends its hello in `onOpen`; media is not touched here.
 */
import {
  WS_CLOSE,
  encodeSignal,
  parseServerSignal,
  type ClientSignalMessage,
  type ServerSignalMessage,
} from '@indiansassist/shared';

export type SignalStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export type ServerType = ServerSignalMessage['t'];
export type ServerOf<T extends ServerType> = Extract<ServerSignalMessage, { t: T }>;
type Handler = (msg: ServerSignalMessage) => void;

/** Close codes after which reconnecting cannot help (section 7.2). */
export const TERMINAL_CLOSE_CODES: readonly number[] = [
  WS_CLOSE.unauthenticated,
  WS_CLOSE.forbidden,
  WS_CLOSE.tokenBusy,
  WS_CLOSE.sessionEnded,
];

export type SignalClientOptions = {
  url: string;
  /** Called on every (re)open; send the hello here. */
  onOpen?: (client: SignalClient, reconnect: boolean) => void;
  onStatus?: (status: SignalStatus, closeCode?: number) => void;
  /** Injected in tests. */
  WebSocketImpl?: typeof WebSocket;
  reconnect?: boolean;
  latencyPingMs?: number;
};

export function backoffDelay(attempt: number): number {
  return Math.min(15000, 500 * 2 ** Math.min(attempt, 5));
}

export class SignalClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private status: SignalStatus = 'idle';
  private manualClose = false;
  private attempt = 0;
  private opened = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;
  private pendingPing: { id: string; at: number } | null = null;
  private queue: string[] = [];
  latencyMs: number | null = null;
  lastCloseCode: number | null = null;

  constructor(private readonly opts: SignalClientOptions) {}

  get state(): SignalStatus {
    return this.status;
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  connect(): void {
    this.manualClose = false;
    this.open();
  }

  private setStatus(s: SignalStatus, code?: number): void {
    this.status = s;
    this.opts.onStatus?.(s, code);
  }

  private open(): void {
    const Impl = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl) {
      this.setStatus('closed');
      return;
    }
    this.setStatus(this.opened ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new Impl(this.opts.url);
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
      this.setStatus('open');
      this.startLatencyPings();
      this.opts.onOpen?.(this, reconnect);
      const queued = this.queue;
      this.queue = [];
      for (const f of queued) ws.send(f);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      this.handleFrame(ev.data);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopLatencyPings();
      this.lastCloseCode = ev.code;
      if (this.manualClose || this.opts.reconnect === false || TERMINAL_CLOSE_CODES.includes(ev.code)) {
        this.setStatus('closed', ev.code);
        return;
      }
      this.scheduleReconnect(ev.code);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(code?: number): void {
    this.setStatus('reconnecting', code);
    const delay = backoffDelay(this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) this.open();
    }, delay);
  }

  private handleFrame(frame: string): void {
    const parsed = parseServerSignal(frame);
    if (!parsed.ok) {
      console.warn('[signal] dropped invalid frame', parsed.code, parsed.message);
      return;
    }
    const msg = parsed.msg;
    if (msg.t === 'ping') {
      this.sendRaw({ t: 'pong' });
    } else if (msg.t === 'pong' && this.pendingPing && (msg.re === undefined || msg.re === this.pendingPing.id)) {
      this.latencyMs = Date.now() - this.pendingPing.at;
      this.pendingPing = null;
    }
    this.emit(msg.t, msg);
    this.emit('*', msg);
  }

  private emit(key: string, msg: ServerSignalMessage): void {
    const set = this.handlers.get(key);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(msg);
      } catch (e) {
        console.error('[signal] handler failed', e);
      }
    }
  }

  private startLatencyPings(): void {
    this.stopLatencyPings();
    const every = this.opts.latencyPingMs ?? 15000;
    if (every <= 0) return;
    this.pingTimer = setInterval(() => {
      const id = `p${++this.pingSeq}`;
      this.pendingPing = { id, at: Date.now() };
      this.sendRaw({ t: 'ping', id });
    }, every);
  }

  private stopLatencyPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private sendRaw(msg: ClientSignalMessage): boolean {
    let frame: string;
    try {
      frame = encodeSignal(msg);
    } catch (e) {
      console.error('[signal] refusing to send an invalid message', msg.t, e);
      return false;
    }
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(frame);
      return true;
    }
    return false;
  }

  /** Sends now when open; returns false (and drops the frame) otherwise. */
  send(msg: ClientSignalMessage): boolean {
    return this.sendRaw(msg);
  }

  /** Sends now, or once the socket (re)opens (used for hellos racing the connect). */
  sendWhenOpen(msg: ClientSignalMessage): void {
    if (this.sendRaw(msg)) return;
    try {
      this.queue.push(encodeSignal(msg));
    } catch (e) {
      console.error('[signal] refusing to queue an invalid message', msg.t, e);
    }
  }

  on<T extends ServerType>(type: T, handler: (msg: ServerOf<T>) => void): () => void;
  on(type: '*', handler: Handler): () => void;
  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  close(code = 1000): void {
    this.manualClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopLatencyPings();
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) ws.close(code);
    this.setStatus('closed', code);
  }
}
