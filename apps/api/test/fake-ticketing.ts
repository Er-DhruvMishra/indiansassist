/**
 * In-process fake ticketing servers (docs/specs/phase-e-contracts.md sections 4.6, 15.3). One plain-http server on
 * 127.0.0.1 records every request (method, path, query, headers, raw body, parsed JSON) and answers from a script:
 * a route handler per service (Zoho Desk and its accounts host, ServiceNow, Jira cloud and data_center, Freshdesk, a
 * webhook receiver), overridden for the next requests by `script(...)` entries: any status with a JSON body and
 * headers (2xx, 401, 403, 404, 422, 429 with `Retry-After`, 500, 503), a hang (never answers), or a reset (the socket
 * is destroyed after the request arrived, before any response byte). `refusedUrl()` names a port nothing listens on.
 * Nothing here reaches the network; the api under test reaches it only with EGRESS_ALLOW_HTTP and
 * EGRESS_ALLOW_LOOPBACK set.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Recorded = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  raw: string;
  json: unknown;
};

export type Scripted =
  | { status: number; json?: unknown; headers?: Record<string, string> }
  | { hang: true }
  | { reset: true };

type Route = { method: string; path: RegExp; answer: (r: Recorded, m: RegExpMatchArray) => Scripted };

export class FakeTicketing {
  readonly requests: Recorded[] = [];
  private readonly routes: Route[] = [];
  private readonly queue: Scripted[] = [];
  private readonly hung: ServerResponse[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeTicketing> {
    let fake: FakeTicketing | null = null;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => fake!.handle(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    fake = new FakeTicketing(server, `http://127.0.0.1:${port}`);
    return fake;
  }

  /** The next responses, in order, whatever the route. */
  script(...s: Scripted[]): this {
    this.queue.push(...s);
    return this;
  }

  on(method: string, path: RegExp, answer: Route['answer']): this {
    this.routes.unshift({ method, path, answer });
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.queue.length = 0;
  }

  last(): Recorded {
    const r = this.requests[this.requests.length - 1];
    if (!r) throw new Error('no request recorded');
    return r;
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const u = new URL(req.url ?? '/', 'http://fake.test');
    let json: unknown;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    const rec: Recorded = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, raw, json };
    this.requests.push(rec);
    let answer: Scripted | undefined = this.queue.shift();
    if (!answer) {
      const route = this.routes.find((r) => r.method === rec.method && r.path.test(rec.path));
      const m = route ? rec.path.match(route.path) : null;
      answer = route && m ? route.answer(rec, m) : { status: 404, json: { error: 'no_route' } };
    }
    if ('hang' in answer) {
      this.hung.push(res);
      return;
    }
    if ('reset' in answer) {
      req.socket.destroy();
      return;
    }
    res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
    res.end(answer.json === undefined ? '' : JSON.stringify(answer.json));
  }

  async close(): Promise<void> {
    for (const r of this.hung) r.socket?.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** An http URL of a loopback port with no listener (a refused connection). */
export async function refusedUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

// ---------- the services (happy paths of section 4.6) ----------

export function zohoRoutes(f: FakeTicketing, opts: { token?: string; expiresIn?: number } = {}): FakeTicketing {
  let n = 0;
  return f
    .on('POST', /^\/oauth\/v2\/token$/, () => ({ status: 200, json: { access_token: `${opts.token ?? 'zoho-at'}-${++n}`, expires_in: opts.expiresIn ?? 3600, api_domain: 'x', token_type: 'Bearer' } }))
    .on('GET', /^\/api\/v1\/departments\/(\d+)$/, (_r, m) => ({ status: 200, json: { id: m[1], name: 'Support' } }))
    .on('POST', /^\/api\/v1\/tickets$/, () => ({ status: 200, json: { id: '1892000000143237', webUrl: 'https://desk.example.test/support/ShowHomePage.do#Cases/dv/1892000000143237' } }))
    .on('POST', /^\/api\/v1\/tickets\/(\d+)\/comments$/, () => ({ status: 200, json: { id: '77' } }));
}

export const SN_SYS_ID = '0123456789abcdef0123456789abcdef';

export function servicenowRoutes(f: FakeTicketing): FakeTicketing {
  return f
    .on('GET', /^\/api\/now\/table\/incident$/, (r) =>
      r.query.get('sysparm_query') === 'number=INC0010001'
        ? { status: 200, json: { result: [{ sys_id: SN_SYS_ID }] } }
        : r.query.get('sysparm_query')
          ? { status: 200, json: { result: [] } }
          : { status: 200, json: { result: [{ sys_id: SN_SYS_ID }] } },
    )
    .on('POST', /^\/api\/now\/table\/incident$/, () => ({ status: 201, json: { result: { sys_id: SN_SYS_ID, number: 'INC0010001' } } }))
    .on('PATCH', /^\/api\/now\/table\/incident\/([0-9a-f]{32})$/, (_r, m) => ({ status: 200, json: { result: { sys_id: m[1] } } }));
}

export function jiraRoutes(f: FakeTicketing): FakeTicketing {
  return f
    .on('GET', /^\/rest\/api\/[23]\/myself$/, () => ({ status: 200, json: { displayName: 'IndiansAssist Bot', accountId: 'abc' } }))
    .on('POST', /^\/rest\/api\/[23]\/issue$/, () => ({ status: 201, json: { id: '10001', key: 'OPS-42', self: 'x' } }))
    .on('POST', /^\/rest\/api\/[23]\/issue\/([A-Z0-9_-]+)\/comment$/, () => ({ status: 201, json: { id: '5' } }));
}

export function freshdeskRoutes(f: FakeTicketing): FakeTicketing {
  return f
    .on('GET', /^\/api\/v2\/agents\/me$/, () => ({ status: 200, json: { id: 1, contact: { name: 'Support Agent' } } }))
    .on('POST', /^\/api\/v2\/tickets$/, () => ({ status: 201, json: { id: 4321 } }))
    .on('POST', /^\/api\/v2\/tickets\/(\d+)\/notes$/, () => ({ status: 201, json: { id: 9 } }));
}

export function webhookRoutes(f: FakeTicketing, answer: Scripted = { status: 200, json: { externalId: 'HOOK-1', externalUrl: 'https://tickets.example.test/HOOK-1' } }): FakeTicketing {
  return f.on('POST', /.*/, () => answer);
}
