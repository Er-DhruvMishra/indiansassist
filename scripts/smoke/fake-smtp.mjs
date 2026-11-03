// In-process fake SMTP server for the Phase F mail smoke flow and the f-mail Playwright spec
// (docs/specs/phase-f-contracts.md sections 1.6 S8, 15.3). `node:net` only, no package. It binds 127.0.0.1 and
// nothing else, never relays (a message is recorded in memory and goes nowhere), never advertises STARTTLS or AUTH,
// and answers the end of each message by a script: `accept` (250), `tempfail` (451), `permfail` (550) or `hang`
// (no reply at all, so the client's own timeouts fire). The api under test is pointed at it with
// `MAIL_DRIVER=smtp SMTP_URL=smtp://127.0.0.1:<E2E_SMTP_PORT> SMTP_REQUIRE_TLS=0`.
//
// apps/api/test/fake-smtp.ts is the TypeScript twin used by the api's vitest suites; keep the two in step.

import net from 'node:net';

const HOST = '127.0.0.1';
const NAME = 'fake-smtp.example.test';

/** Decodes a quoted-printable body (nodemailer uses it for text with lines over 76 characters). */
export function decodeQuotedPrintable(s) {
  const bytes = [];
  const soft = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < soft.length; i += 1) {
    const c = soft[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(c, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Splits a raw RFC 5322 message into lower-cased headers (unfolded) and the decoded text body. */
export function parseMessage(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const bodyRaw = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  let text = bodyRaw;
  if (cte === 'quoted-printable') text = decodeQuotedPrintable(bodyRaw);
  else if (cte === 'base64') text = Buffer.from(bodyRaw.replace(/\s+/g, ''), 'base64').toString('utf8');
  return { headers, subject: headers['subject'] ?? '', text: text.replace(/\r\n/g, '\n') };
}

/** The first URL in `text` that contains `marker` (e.g. `/reset#t=`, `/invite#i=`), or null. */
export function findLink(text, marker) {
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) if (m[0].includes(marker)) return m[0].replace(/[.,;)]+$/, '');
  return null;
}

/**
 * Starts the fake. `port` 0 picks a free one.
 * @param {{ port?: number }} [opts]
 */
export async function startFakeSmtp(opts = {}) {
  /** @type {{ from: string, to: string[], raw: string, headers: Record<string, string>, subject: string, text: string, at: number }[]} */
  const messages = [];
  /** @type {string[]} commands seen, verbs only (never the payload) */
  const commands = [];
  const sockets = new Set();
  const waiters = [];
  const state = { mode: 'accept', queue: [], connections: 0, refused: 0 };

  const notify = () => {
    for (const w of [...waiters]) {
      const hit = messages.find(w.pred);
      if (hit) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(hit);
      }
    }
  };

  const server = net.createServer((sock) => {
    state.connections += 1;
    sockets.add(sock);
    sock.setEncoding('utf8');
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sockets.delete(sock));
    let buf = '';
    let inData = false;
    let data = [];
    let from = '';
    let to = [];
    const reply = (line) => {
      if (!sock.destroyed) sock.write(`${line}\r\n`);
    };
    reply(`220 ${NAME} ESMTP fake (records only, never relays)`);

    const endOfData = () => {
      const raw = data.join('\r\n');
      const mode = state.queue.length > 0 ? state.queue.shift() : state.mode;
      data = [];
      inData = false;
      if (mode === 'hang') return;
      if (mode === 'tempfail') {
        state.refused += 1;
        return reply('451 4.3.0 fake temporary failure');
      }
      if (mode === 'permfail') {
        state.refused += 1;
        return reply('550 5.7.1 fake permanent failure');
      }
      messages.push({ from, to: [...to], raw, ...parseMessage(raw), at: Date.now() });
      from = '';
      to = [];
      reply('250 2.0.0 queued (in memory; never relayed)');
      notify();
    };

    const onLine = (line) => {
      if (inData) {
        if (line === '.') return endOfData();
        data.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }
      const verb = line.split(' ')[0].toUpperCase();
      commands.push(verb);
      switch (verb) {
        case 'EHLO':
          return reply(`250-${NAME}\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE 10485760`);
        case 'HELO':
          return reply(`250 ${NAME}`);
        case 'MAIL': {
          const m = /<([^>]*)>/.exec(line);
          from = m ? m[1] : '';
          to = [];
          return reply('250 2.1.0 ok');
        }
        case 'RCPT': {
          const m = /<([^>]*)>/.exec(line);
          if (m) to.push(m[1]);
          return reply('250 2.1.5 ok');
        }
        case 'DATA':
          inData = true;
          data = [];
          return reply('354 end data with <CR><LF>.<CR><LF>');
        case 'RSET':
          from = '';
          to = [];
          return reply('250 2.0.0 ok');
        case 'NOOP':
          return reply('250 2.0.0 ok');
        case 'STARTTLS':
          // Never offered: a client that requires TLS must give up here (rule 4.1b).
          return reply('454 4.7.0 TLS not available');
        case 'QUIT':
          reply('221 2.0.0 bye');
          return sock.end();
        default:
          return reply('502 5.5.2 command not implemented');
      }
    };

    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, HOST, () => resolve(undefined));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    host: HOST,
    port,
    url: `smtp://${HOST}:${port}`,
    messages,
    commands,
    get connections() {
      return state.connections;
    },
    get refused() {
      return state.refused;
    },
    /** The reply to every following message. */
    setMode(mode) {
      state.mode = mode;
    },
    /** Replies for the next messages, in order, before falling back to the mode. */
    script(...modes) {
      state.queue.push(...modes);
    },
    /** Messages sent to `address` (case-insensitive). */
    to(address) {
      const a = address.toLowerCase();
      return messages.filter((m) => m.to.some((x) => x.toLowerCase() === a));
    },
    /** Resolves with the first recorded message matching `pred`, now or later. */
    waitFor(pred, timeoutMs = 10_000) {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            reject(new Error(`fake smtp: no matching message within ${timeoutMs} ms (have ${messages.length})`));
          }, timeoutMs),
        };
        waiters.push(w);
      });
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
