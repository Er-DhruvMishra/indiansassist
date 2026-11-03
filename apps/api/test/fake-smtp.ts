/**
 * In-process fake SMTP server for the mail suites (docs/specs/phase-f-contracts.md sections 1.6 S8, 15.3). `node:net`
 * only, no package. It binds 127.0.0.1 and nothing else, never relays (a message is recorded in memory and goes
 * nowhere), never advertises STARTTLS or AUTH, and answers the end of each message by a script: `accept` (250),
 * `tempfail` (451), `permfail` (550) or `hang` (no reply at all, so the client's own timeouts fire).
 *
 * scripts/smoke/fake-smtp.mjs is the JavaScript twin the smoke flow and the Playwright spec run; keep the two in step.
 */
import net from 'node:net';

const HOST = '127.0.0.1';
const NAME = 'fake-smtp.example.test';

export type SmtpMode = 'accept' | 'tempfail' | 'permfail' | 'hang';

export type SmtpMessage = {
  from: string;
  to: string[];
  raw: string;
  headers: Record<string, string>;
  subject: string;
  text: string;
  at: number;
};

export type FakeSmtp = {
  host: string;
  port: number;
  url: string;
  messages: SmtpMessage[];
  /** Command verbs seen, in order (never a payload). */
  commands: string[];
  readonly connections: number;
  readonly refused: number;
  setMode(mode: SmtpMode): void;
  script(...modes: SmtpMode[]): void;
  to(address: string): SmtpMessage[];
  waitFor(pred: (m: SmtpMessage) => boolean, timeoutMs?: number): Promise<SmtpMessage>;
  close(): Promise<void>;
};

/** Decodes a quoted-printable body (nodemailer uses it for text with lines over 76 characters). */
export function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  const soft = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < soft.length; i += 1) {
    const c = soft[i]!;
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(c, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Splits a raw RFC 5322 message into lower-cased headers (unfolded) and the decoded text body. */
export function parseMessage(raw: string): { headers: Record<string, string>; subject: string; text: string } {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const bodyRaw = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
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
export function findLink(text: string, marker: string): string | null {
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) if (m[0].includes(marker)) return m[0].replace(/[.,;)]+$/, '');
  return null;
}

export async function startFakeSmtp(opts: { port?: number } = {}): Promise<FakeSmtp> {
  const messages: SmtpMessage[] = [];
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  type Waiter = { pred: (m: SmtpMessage) => boolean; resolve: (m: SmtpMessage) => void; timer: NodeJS.Timeout };
  const waiters: Waiter[] = [];
  const state = { mode: 'accept' as SmtpMode, queue: [] as SmtpMode[], connections: 0, refused: 0 };

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
    let data: string[] = [];
    let from = '';
    let to: string[] = [];
    const reply = (line: string) => {
      if (!sock.destroyed) sock.write(`${line}\r\n`);
    };
    reply(`220 ${NAME} ESMTP fake (records only, never relays)`);

    const endOfData = () => {
      const raw = data.join('\r\n');
      const mode = state.queue.shift() ?? state.mode;
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

    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') return endOfData();
        data.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }
      const verb = (line.split(' ')[0] ?? '').toUpperCase();
      commands.push(verb);
      switch (verb) {
        case 'EHLO':
          return reply(`250-${NAME}\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE 10485760`);
        case 'HELO':
          return reply(`250 ${NAME}`);
        case 'MAIL':
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          return reply('250 2.1.0 ok');
        case 'RCPT': {
          const m = /<([^>]*)>/.exec(line);
          if (m) to.push(m[1]!);
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
          sock.end();
          return;
        default:
          return reply('502 5.5.2 command not implemented');
      }
    };

    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, HOST, () => resolve());
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
    setMode(mode) {
      state.mode = mode;
    },
    script(...modes) {
      state.queue.push(...modes);
    },
    to(address) {
      const a = address.toLowerCase();
      return messages.filter((m) => m.to.some((x) => x.toLowerCase() === a));
    },
    waitFor(pred, timeoutMs = 10_000) {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w: Waiter = {
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
