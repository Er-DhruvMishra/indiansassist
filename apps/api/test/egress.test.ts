/**
 * Phase E section 2.2 (docs/specs/phase-e-contracts.md section 15.1): the egress guard against a fake resolver and
 * in-process servers only (no test reaches the network: every address that passes is loopback with
 * EGRESS_ALLOW_LOOPBACK, every other address is refused before any connection, and the global / allow-listed cases
 * are checked through the pure `checkAddresses`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, parseEgressAllow, type EgressConfig } from '../src/config.js';
import {
  checkAddresses,
  checkEgressUrl,
  classifyAddress,
  createEgressFetch,
  EgressFailedError,
  EgressRefusedError,
  normaliseAddress,
  type EgressLookup,
} from '../src/lib/egress.js';
import { createMetrics } from '../src/lib/metrics.js';

const OPTS = { purpose: 'ticketing' as const, orgId: '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b' };
const LOOSE: EgressConfig = { allowHttp: true, allowLoopback: true, privateAllow: [], metadataAddresses: [] };
const STRICT: EgressConfig = { allowHttp: true, allowLoopback: false, privateAllow: [], metadataAddresses: [] };

let server: Server;
let port = 0;
const hits: string[] = [];
const sockets = new Set<Socket>();

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  hits.push(url.pathname);
  switch (url.pathname) {
    case '/ok':
    case '/secret-path':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
      return;
    case '/json':
      res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ id: 'OPS-1' }));
      return;
    case '/empty':
      res.writeHead(204);
      res.end();
      return;
    case '/redirect-same':
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    case '/redirect-loop':
      res.writeHead(302, { location: `/redirect-loop?n=${Number(url.searchParams.get('n') ?? 0) + 1}` });
      res.end();
      return;
    case '/redirect-other':
      res.writeHead(302, { location: `http://other.test:${port}/ok` });
      res.end();
      return;
    case '/redirect-port':
      res.writeHead(302, { location: `http://api.test:${port + 1}/ok` });
      res.end();
      return;
    case '/hang':
      return; // never answers
    case '/big': {
      const body = Buffer.alloc(4096, 0x61);
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    case '/big-chunked': {
      res.writeHead(200);
      for (let i = 0; i < 8; i++) res.write(Buffer.alloc(1024, 0x62));
      res.end();
      return;
    }
    default:
      res.writeHead(404);
      res.end();
  }
}

beforeAll(async () => {
  server = createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  hits.length = 0;
  vi.unstubAllGlobals();
});

/** A resolver from a fixed table (names unknown to it fail like NXDOMAIN); counts calls per host. */
function fakeResolver(table: Record<string, string[] | (() => string[])>) {
  const calls: Record<string, number> = {};
  const lookup: EgressLookup = async (host) => {
    calls[host] = (calls[host] ?? 0) + 1;
    const entry = table[host];
    if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    const list = typeof entry === 'function' ? entry() : entry;
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { lookup, calls };
}

async function refusal(p: Promise<unknown>): Promise<EgressRefusedError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof EgressRefusedError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('G1: scheme', () => {
  it('refuses http unless EGRESS_ALLOW_HTTP, and anything but http(s)', async () => {
    const { lookup } = fakeResolver({ 'api.test': ['127.0.0.1'] });
    const strictHttp = createEgressFetch({ config: { ...LOOSE, allowHttp: false }, lookup });
    expect((await refusal(strictHttp(`http://api.test:${port}/ok`, {}, OPTS))).cause).toBe('scheme');
    expect(hits).toEqual([]);
    const loose = createEgressFetch({ config: LOOSE, lookup });
    expect((await refusal(loose('ftp://api.test/x', {}, OPTS))).cause).toBe('scheme');
    expect((await refusal(loose('file:///etc/passwd', {}, OPTS))).cause).toBe('scheme');
    const res = await loose(`http://api.test:${port}/ok`, {}, OPTS);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('EGRESS_ALLOW_HTTP or EGRESS_ALLOW_LOOPBACK with NODE_ENV=production is a boot problem; NODE_ENV never loosens it', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', EGRESS_ALLOW_HTTP: '1' }, { persistSecrets: false })).toThrow(/EGRESS_ALLOW_HTTP must not be set with NODE_ENV=production/);
    expect(() => loadConfig({ NODE_ENV: 'production', EGRESS_ALLOW_LOOPBACK: '1' }, { persistSecrets: false })).toThrow(/EGRESS_ALLOW_LOOPBACK must not be set/);
    for (const env of ['development', 'test', '']) {
      const c = loadConfig({ NODE_ENV: env }, { persistSecrets: false });
      expect(c.egress).toMatchObject({ allowHttp: false, allowLoopback: false, privateAllow: [] });
    }
    const t = loadConfig({ NODE_ENV: 'test', EGRESS_ALLOW_HTTP: '1', EGRESS_ALLOW_LOOPBACK: '1', EGRESS_METADATA_ADDRESSES: '10.10.10.10' }, { persistSecrets: false });
    expect(t.egress).toMatchObject({ allowHttp: true, allowLoopback: true, metadataAddresses: ['10.10.10.10'] });
  });
});

describe('G2: only global unicast', () => {
  const REFUSED = [
    '0.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.254',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::a00:1',
    '64:ff9b::8.8.8.8',
    '2002:c000:201::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '::10.0.0.1',
    '169.254.169.254',
    'fd00:ec2::254',
    '100.100.100.200',
  ];

  it.each(REFUSED)('refuses %s before connecting', async (address) => {
    const { lookup } = fakeResolver({ 'h.test': [address] });
    const f = createEgressFetch({ config: STRICT, lookup });
    expect((await refusal(f(`http://h.test:${port}/ok`, {}, OPTS))).cause).toBe('private_address');
    expect(hits).toEqual([]);
  });

  it('refuses when any one resolved address is refused, and IP-literal hosts too', async () => {
    const { lookup } = fakeResolver({ 'mixed.test': ['93.184.216.34', '10.0.0.1'] });
    const f = createEgressFetch({ config: STRICT, lookup });
    expect((await refusal(f('https://mixed.test/x', {}, OPTS))).cause).toBe('private_address');
    expect((await refusal(f(`http://127.0.0.1:${port}/ok`, {}, OPTS))).cause).toBe('private_address');
    expect((await refusal(f(`http://[::ffff:7f00:1]:${port}/ok`, {}, OPTS))).cause).toBe('private_address');
    expect(hits).toEqual([]);
  });

  it('unmaps IPv4-mapped and IPv4-compatible IPv6 and classifies global addresses', () => {
    expect(normaliseAddress('::ffff:127.0.0.1')).toEqual({ v: 4, n: 0x7f000001 });
    expect(normaliseAddress('::ffff:7f00:1')).toEqual({ v: 4, n: 0x7f000001 });
    expect(normaliseAddress('::127.0.0.1')).toEqual({ v: 4, n: 0x7f000001 });
    expect(normaliseAddress('::1')).toEqual({ v: 6, n: 1n });
    expect(normaliseAddress('not-an-ip')).toBeNull();
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyAddress('93.184.216.34')).toBe('global');
    expect(classifyAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe('global');
    expect(classifyAddress('198.20.0.1')).toBe('global');
    expect(classifyAddress('100.128.0.1')).toBe('global');
    expect(classifyAddress('169.254.169.254')).toBe('metadata');
    expect(classifyAddress('10.10.10.10', ['10.10.10.10'])).toBe('metadata');
    const u = new URL('https://idp.example.com/');
    expect(checkAddresses(u, ['93.184.216.34', '2606:2800:220:1::1'], STRICT)).toEqual({ ok: true, address: '93.184.216.34' });
    expect(checkAddresses(u, [], STRICT)).toEqual({ ok: false, cause: 'private_address' });
  });

  it('loopback passes only with EGRESS_ALLOW_LOOPBACK', async () => {
    const { lookup } = fakeResolver({ 'api.test': ['127.0.0.1'] });
    const strict = createEgressFetch({ config: STRICT, lookup });
    expect((await refusal(strict(`http://api.test:${port}/ok`, {}, OPTS))).cause).toBe('private_address');
    const loose = createEgressFetch({ config: LOOSE, lookup });
    expect((await loose(`http://api.test:${port}/ok`, {}, OPTS)).status).toBe(200);
  });

  it('an allow-listed host:port or CIDR:port passes only on its port; metadata is refused even when allow-listed', async () => {
    const allow = parseEgressAllow('jira.corp:8443, keycloak.corp, 10.20.0.0/16:443, 169.254.0.0/16:80');
    expect(allow).toEqual([
      { kind: 'host', host: 'jira.corp', port: 8443 },
      { kind: 'host', host: 'keycloak.corp', port: 443 },
      { kind: 'cidr', cidr: '10.20.0.0/16', port: 443 },
      { kind: 'cidr', cidr: '169.254.0.0/16', port: 80 },
    ]);
    const cfg: EgressConfig = { ...STRICT, privateAllow: allow, metadataAddresses: [] };
    const at = (url: string, address: string) => checkAddresses(new URL(url), [address], cfg);
    expect(at('https://jira.corp:8443/rest', '10.0.0.5')).toEqual({ ok: true, address: '10.0.0.5' });
    expect(at('https://jira.corp/rest', '10.0.0.5')).toEqual({ ok: false, cause: 'private_address' });
    expect(at('https://jira.corp:9443/rest', '10.0.0.5')).toEqual({ ok: false, cause: 'private_address' });
    expect(at('https://keycloak.corp/realms/x', '192.168.4.4')).toEqual({ ok: true, address: '192.168.4.4' });
    expect(at('https://other.corp/', '10.20.1.1')).toEqual({ ok: true, address: '10.20.1.1' });
    expect(at('https://other.corp:8443/', '10.20.1.1')).toEqual({ ok: false, cause: 'private_address' });
    expect(at('https://other.corp/', '10.21.1.1')).toEqual({ ok: false, cause: 'private_address' });
    expect(at('http://meta.corp/', '169.254.169.254')).toEqual({ ok: false, cause: 'private_address' });
    expect(at('http://link.corp/', '169.254.1.1')).toEqual({ ok: true, address: '169.254.1.1' });
    // Loopback is never opened by the allow list.
    expect(checkAddresses(new URL('https://lo.corp/'), ['127.0.0.1'], { ...cfg, privateAllow: parseEgressAllow('lo.corp, 127.0.0.0/8:443') })).toEqual({ ok: false, cause: 'private_address' });
    // Through the fetch: the wrong port is refused before any connection.
    const { lookup } = fakeResolver({ 'jira.corp': ['10.0.0.5'] });
    const f = createEgressFetch({ config: cfg, lookup });
    expect((await refusal(f('https://jira.corp:9443/rest/api/3/myself', {}, OPTS))).cause).toBe('private_address');
    expect(() => parseEgressAllow('10.0.0.0/8')).toThrow(/CIDR:port/);
    expect(() => loadConfig({ NODE_ENV: 'test', EGRESS_PRIVATE_ALLOW: 'bad host!' }, { persistSecrets: false })).toThrow(/EGRESS_PRIVATE_ALLOW/);
  });

  it('the save-time check refuses the same way without connecting', async () => {
    const { lookup } = fakeResolver({ 'h.test': ['10.0.0.1'], 'pub.test': ['93.184.216.34'] });
    expect(await checkEgressUrl('https://h.test/x', { config: STRICT, lookup })).toEqual({ ok: false, cause: 'private_address' });
    expect(await checkEgressUrl('https://pub.test/x', { config: STRICT, lookup })).toEqual({ ok: true });
    expect(await checkEgressUrl('http://pub.test/x', { config: { ...STRICT, allowHttp: false }, lookup })).toEqual({ ok: false, cause: 'scheme' });
    expect(await checkEgressUrl('https://nx.test/x', { config: STRICT, lookup })).toEqual({ ok: true });
  });
});

describe('G3: the connection is pinned to the checked address', () => {
  it('a rebinding resolver cannot redirect the connection: one lookup, then the checked address is used', async () => {
    let n = 0;
    const { lookup, calls } = fakeResolver({ 'rebind.test': () => (n++ === 0 ? ['127.0.0.1'] : ['10.0.0.1']) });
    const f = createEgressFetch({ config: LOOSE, lookup });
    const res = await f(`http://rebind.test:${port}/ok`, {}, OPTS);
    expect(res.status).toBe(200);
    expect(calls['rebind.test']).toBe(1);
    // A redirect is re-checked (G4): the second answer is now private and is refused.
    expect((await refusal(f(`http://rebind.test:${port}/redirect-same`, {}, OPTS))).cause).toBe('private_address');
  });

  it('reaches a host name the system resolver does not know only through the injected answer', async () => {
    const { lookup } = fakeResolver({ 'only-in-fake.invalid': ['127.0.0.1'] });
    const f = createEgressFetch({ config: LOOSE, lookup });
    expect(await (await f(`http://only-in-fake.invalid:${port}/ok`, {}, OPTS)).text()).toBe('hello');
    await expect(f(`http://unknown.invalid:${port}/ok`, {}, OPTS)).rejects.toMatchObject({ name: 'EgressFailedError', kind: 'dns', sent: false });
  });
});

describe('G4: redirects', () => {
  const { lookup } = fakeResolver({ 'api.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'] });
  const f = createEgressFetch({ config: LOOSE, lookup });

  it('follows a same-origin redirect on GET', async () => {
    const res = await f(`http://api.test:${port}/redirect-same`, {}, OPTS);
    expect(res.status).toBe(200);
    expect(hits).toEqual(['/redirect-same', '/ok']);
  });
  it('refuses a redirect on POST', async () => {
    const e = await refusal(f(`http://api.test:${port}/redirect-same`, { method: 'POST', body: '{}' }, OPTS));
    expect(e.cause).toBe('redirect');
    expect(hits).toEqual(['/redirect-same']);
  });
  it('refuses a cross-host or cross-port redirect on GET', async () => {
    expect((await refusal(f(`http://api.test:${port}/redirect-other`, {}, OPTS))).cause).toBe('redirect');
    expect((await refusal(f(`http://api.test:${port}/redirect-port`, {}, OPTS))).cause).toBe('redirect');
    expect(hits).not.toContain('/ok');
  });
  it('follows at most 3', async () => {
    expect((await refusal(f(`http://api.test:${port}/redirect-loop`, {}, OPTS))).cause).toBe('redirect');
    expect(hits).toHaveLength(4);
  });
});

describe('G5: timeout and size cap', () => {
  const { lookup } = fakeResolver({ 'api.test': ['127.0.0.1'] });
  const f = createEgressFetch({ config: LOOSE, lookup });

  it('times out a hung response', async () => {
    await expect(f(`http://api.test:${port}/hang`, {}, { ...OPTS, timeoutMs: 300 })).rejects.toMatchObject({ name: 'EgressFailedError', kind: 'timeout' });
  });
  it('aborts a body over maxResponseBytes, with or without Content-Length', async () => {
    expect((await refusal(f(`http://api.test:${port}/big`, {}, { ...OPTS, maxResponseBytes: 1024 }))).cause).toBe('too_large');
    expect((await refusal(f(`http://api.test:${port}/big-chunked`, {}, { ...OPTS, maxResponseBytes: 4096 }))).cause).toBe('too_large');
    expect((await f(`http://api.test:${port}/big`, {}, { ...OPTS, maxResponseBytes: 4096 })).status).toBe(200);
  });
  it('a refused connection is a transport failure with nothing sent', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = await f(`http://api.test:${deadPort}/ok`, {}, OPTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressFailedError);
    expect(err).toMatchObject({ kind: 'connect', sent: false });
  });
});

describe('transport: undici.fetch, response and log line', () => {
  it('uses undici.fetch, never the global fetch, and returns status, headers and body', async () => {
    const globalFetch = vi.fn(() => Promise.reject(new Error('global fetch must not be used')));
    vi.stubGlobal('fetch', globalFetch);
    const { lookup } = fakeResolver({ 'api.test': ['127.0.0.1'] });
    const f = createEgressFetch({ config: LOOSE, lookup });
    const res = await f(`http://api.test:${port}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }, OPTS);
    expect(res.status).toBe(201);
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect(await res.json()).toEqual({ id: 'OPS-1' });
    expect((await f(`http://api.test:${port}/empty`, {}, OPTS)).status).toBe(204);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('writes one log line per call without the path, query, headers or body, and counts the metric', async () => {
    const lines: Record<string, unknown>[] = [];
    const metrics = createMetrics({ defaults: false });
    const { lookup } = fakeResolver({ 'api.test': ['127.0.0.1'], 'priv.test': ['10.0.0.1'] });
    const f = createEgressFetch({ config: LOOSE, lookup, log: { info: (o) => lines.push(o) }, metrics });
    await f(`http://api.test:${port}/secret-path?token=abc123`, { headers: { authorization: 'Bearer s3cr3t' }, method: 'GET' }, { ...OPTS, purpose: 'webhook' });
    await refusal(f('http://priv.test/x?q=1', {}, OPTS));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ purpose: 'webhook', orgId: OPTS.orgId, host: 'api.test', status: 200, result: 'ok' });
    expect(typeof lines[0]!['ms']).toBe('number');
    expect(Object.keys(lines[0]!).sort()).toEqual(['host', 'ms', 'orgId', 'purpose', 'result', 'status']);
    expect(lines[1]).toMatchObject({ host: 'priv.test', status: null, result: 'refused' });
    const text = JSON.stringify(lines);
    for (const leak of ['secret-path', 'token', 'abc123', 's3cr3t', 'Bearer', '/x', 'q=1']) expect(text).not.toContain(leak);
    const series = (await metrics.registry.getSingleMetricAsString('ia_egress_requests_total')).split('\n');
    expect(series).toContain('ia_egress_requests_total{purpose="webhook",result="ok"} 1');
    expect(series).toContain('ia_egress_requests_total{purpose="ticketing",result="refused"} 1');
    expect(series).toContain('ia_egress_requests_total{purpose="sso_jwks",result="timeout"} 0');
  });
});

describe('foundation plumbing (sections 11, 14)', () => {
  it('registers every section 11 series zero-initialised', async () => {
    const m = createMetrics({ defaults: false });
    const text = await m.registry.metrics();
    for (const line of [
      'ia_sso_logins_total{protocol="saml",result="replay"} 0',
      'ia_sso_logins_total{protocol="oidc",result="ok"} 0',
      'ia_egress_requests_total{purpose="sso_discovery",result="error"} 0',
      'ia_ticket_pushes_total{type="webhook",state="retrying"} 0',
      'ia_summaries_total{provider="anthropic",result="refused"} 0',
      'ia_summaries_total{provider="local",result="ready"} 0',
      'ia_summary_seconds_count{provider="local"} 0',
      'ia_redactions_total{kind="long_token"} 0',
    ])
      expect(text).toContain(line);
  });

  it('redacts every section 14 secret path', async () => {
    const { REDACT_PATHS } = await import('../src/lib/logger.js');
    for (const k of ['clientSecret', 'credentials', 'apiKey', 'apiToken', 'personalAccessToken', 'refreshToken', 'password', 'privateKey', 'SAMLResponse', 'RelayState', 'id_token', 'access_token', 'codeVerifier', 'nonce', 'transcript', 'messages', 'output', 'ticket', 'note'])
      expect(REDACT_PATHS).toContain(`*.${k}`);
    expect(REDACT_PATHS).not.toContain('*.code');
  });
});
