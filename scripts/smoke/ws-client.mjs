// WebSocket client for the smoke test (`ws` package, because the upgrade must carry Cookie and Origin headers,
// which the browser-style global WebSocket cannot set). Implements the JSON heartbeat of section 7.2: every
// server `{ t: 'ping' }` is answered with `{ t: 'pong' }`.

import WebSocket from 'ws';

export class SignalClient {
  /**
   * @param {string} name   label used in error messages ("assist" / "desk")
   * @param {string} url    ws(s)://.../signal
   * @param {Record<string,string>} headers  e.g. { Origin, Cookie }
   */
  constructor(name, url, headers = {}) {
    this.name = name;
    this.url = url;
    this.headers = headers;
    this.queue = [];
    this.waiters = [];
    this.closed = null; // { code, reason } once closed
    this.closeWaiters = [];
    this.seq = 0;
  }

  open(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: this.headers, handshakeTimeout: timeoutMs });
      this.ws = ws;
      ws.once('open', () => resolve(this));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`${this.name}: upgrade rejected with HTTP ${res.statusCode}`)));
      ws.once('error', (err) => reject(new Error(`${this.name}: ${err.message}`)));
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        if (msg && msg.t === 'ping') {
          this.send({ t: 'pong' });
          return;
        }
        this.#deliver(msg);
      });
      ws.on('close', (code, reason) => {
        this.closed = { code, reason: reason.toString('utf8') };
        for (const w of this.closeWaiters.splice(0)) w.resolve(this.closed);
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new Error(`${this.name}: socket closed (${code}) while waiting for ${w.label}`));
        }
      });
    });
  }

  /** Sends a message; adds a correlation `id` when none is given. Returns the id. */
  send(msg) {
    const out = msg.t === 'pong' || msg.id ? msg : { ...msg, id: `${this.name[0]}${++this.seq}` };
    this.ws.send(JSON.stringify(out));
    return out.id;
  }

  /**
   * Resolves with the first message matching `pred` (already queued or future). Messages that do not match stay
   * queued for later waits. `pred` may be a message type string.
   */
  next(pred, timeoutMs = 5000, label) {
    const match = typeof pred === 'string' ? (m) => m.t === pred : pred;
    const what = label ?? (typeof pred === 'string' ? pred : 'message');
    const idx = this.queue.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    if (this.closed) return Promise.reject(new Error(`${this.name}: socket closed (${this.closed.code}) before ${what}`));
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject, label: what };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        const seen = this.queue.map((m) => m.t).join(', ') || 'nothing';
        reject(new Error(`${this.name}: timed out after ${timeoutMs} ms waiting for ${what} (queued: ${seen})`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** Waits for `t` or an `error` frame; an `error` rejects with its code. */
  async reply(t, timeoutMs = 5000) {
    const m = await this.next((x) => x.t === t || x.t === 'error', timeoutMs, t);
    if (m.t === 'error') {
      const err = new Error(`${this.name}: expected ${t}, got error ${m.code}: ${m.message ?? ''}`);
      err.code = m.code;
      throw err;
    }
    return m;
  }

  waitClose(timeoutMs = 5000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: socket not closed within ${timeoutMs} ms`)), timeoutMs);
      this.closeWaiters.push({ resolve: (c) => (clearTimeout(timer), resolve(c)) });
    });
  }

  close() {
    if (this.ws && !this.closed) this.ws.close(1000);
  }

  #deliver(msg) {
    const i = this.waiters.findIndex((w) => w.match(msg));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }
}
