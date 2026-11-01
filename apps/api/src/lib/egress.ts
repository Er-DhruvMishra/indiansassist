/**
 * The egress guard (docs/specs/phase-e-contracts.md section 2.2): the only way api code reaches a URL an org_admin
 * typed (IdP issuer or metadata, ticketing base URL, webhook URL). Built on `undici.fetch` with an `undici.Agent` from
 * the same package, never Node's built-in `fetch`:
 *   G1 https only (`http:` only with EGRESS_ALLOW_HTTP=1, never with NODE_ENV=production: config.ts refuses to boot);
 *   G2 the host is resolved once and every address, unmapped from IPv4-mapped / IPv4-compatible IPv6 first, must be
 *      global unicast (private and special ranges refused unless an EGRESS_PRIVATE_ALLOW entry matches host and
 *      port; metadata addresses always refused; loopback only with EGRESS_ALLOW_LOOPBACK=1);
 *   G3 the connection is pinned to the address that passed (the Agent's `connect.lookup` returns it), so DNS
 *      rebinding between check and connect cannot reach a refused address;
 *   G4 `redirect: 'manual'`; redirects only for GET, at most 3, same scheme, host and port, each re-checked;
 *   G5 one timeout from connect to the last body byte, and a response size cap;
 *   G6 one structured log line per call, never the path, query, headers or bodies.
 * A refusal throws EgressRefusedError and a transport failure EgressFailedError; callers turn both into a value
 * (G7), never an error past the route.
 */
import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import type { EgressPurpose, EgressRefuseCause } from '@indiansassist/shared';
import { Agent, fetch as undiciFetch } from 'undici';
import type { EgressAllowEntry, EgressConfig } from '../config.js';
import type { Metrics } from './metrics.js';

export const EGRESS_DEFAULT_TIMEOUT_MS = 10_000;
export const EGRESS_DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const EGRESS_MAX_REDIRECTS = 3;

/** Always refused, even when allow-listed (section 2.2 G2), plus any EGRESS_METADATA_ADDRESSES entry. */
export const BUILTIN_METADATA_ADDRESSES = ['169.254.169.254', 'fd00:ec2::254', '100.100.100.200'] as const;

/** `EgressRefusedError { cause }`: G1 scheme, G2 private_address, G4 redirect, G5 too_large. */
export class EgressRefusedError extends Error {
  override readonly cause: EgressRefuseCause;
  constructor(cause: EgressRefuseCause, message?: string) {
    super(message ?? `egress refused: ${cause}`);
    this.name = 'EgressRefusedError';
    this.cause = cause;
  }
}

/**
 * A call that was allowed but failed: `dns` (the host did not resolve; nothing sent), `connect` (refused or reset
 * before a response; `sent` false only when the connection never opened), `timeout`, `network` (any other transport
 * error after the request may have been written).
 */
export class EgressFailedError extends Error {
  readonly kind: 'dns' | 'connect' | 'timeout' | 'network';
  readonly sent: boolean;
  constructor(kind: 'dns' | 'connect' | 'timeout' | 'network', sent: boolean, message?: string) {
    super(message ?? `egress failed: ${kind}`);
    this.name = 'EgressFailedError';
    this.kind = kind;
    this.sent = sent;
  }
}

export type EgressOptions = {
  purpose: EgressPurpose;
  orgId: string;
  /** Connect through the last body byte; default 10000. */
  timeoutMs?: number;
  /** Default 1048576. */
  maxResponseBytes?: number;
};

/** `egressFetch(url, init, opts)` (section 2.2): the binding signature. */
export type EgressFetch = (url: string | URL, init: RequestInit, opts: EgressOptions) => Promise<Response>;

/** `dns.lookup(host, { all: true })` shape; tests inject a fake. */
export type EgressLookup = (host: string) => Promise<{ address: string; family: number }[]>;

export type EgressLogger = { info: (obj: Record<string, unknown>, msg?: string) => void };

export type EgressDeps = {
  config: EgressConfig;
  lookup?: EgressLookup;
  log?: EgressLogger;
  metrics?: Pick<Metrics, 'egressRequests'>;
};

export const systemLookup: EgressLookup = async (host) => {
  const rows = await dns.lookup(host, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family }));
};

// ---------- address arithmetic (pure) ----------

type Ip = { v: 4; n: number } | { v: 6; n: bigint };

function parseV4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function parseV6(input: string): bigint | null {
  let s = input.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // An embedded dotted IPv4 tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is two final groups.
  let tail: string[] = [];
  if (s.includes('.')) {
    const i = s.lastIndexOf(':');
    const v4 = parseV4(s.slice(i + 1));
    if (v4 === null) return null;
    s = s.slice(0, i + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
    tail = [((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16)];
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length + tail.length !== 8) return null;
    groups = [...head, ...tail];
  } else {
    const missing = 8 - (head.length + rest.length + tail.length);
    if (missing < 1) return null;
    groups = [...head, ...new Array<string>(missing).fill('0'), ...rest, ...tail];
  }
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Parses an address and unmaps IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) IPv6 to IPv4. */
export function normaliseAddress(address: string): Ip | null {
  const a = address.replace(/^\[|\]$/g, '');
  const v4 = parseV4(a);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(a);
  if (v6 === null) return null;
  const high96 = v6 >> 32n;
  const low32 = Number(v6 & 0xffffffffn);
  if (high96 === 0xffffn) return { v: 4, n: low32 }; // ::ffff:a.b.c.d
  // ::a.b.c.d (IPv4-compatible); `::` and `::1` stay IPv6 (unspecified, loopback).
  if (high96 === 0n && v6 > 1n) return { v: 4, n: low32 };
  return { v: 6, n: v6 };
}

function cidr(spec: string): { v: 4 | 6; base: bigint; bits: number } {
  const [addr, len] = spec.split('/');
  const ip = parseV4(addr!);
  if (ip !== null) return { v: 4, base: BigInt(ip), bits: Number(len) };
  return { v: 6, base: parseV6(addr!)!, bits: Number(len) };
}

function inCidr(ip: Ip, c: { v: 4 | 6; base: bigint; bits: number }): boolean {
  if (ip.v !== c.v) return false;
  const width = c.v === 4 ? 32n : 128n;
  if (c.bits < 0 || BigInt(c.bits) > width) return false;
  const shift = width - BigInt(c.bits);
  return BigInt(ip.n) >> shift === c.base >> shift;
}

const LOOPBACK = [cidr('127.0.0.0/8'), cidr('::1/128')];
/** Section 2.2 G2: every range that is not global unicast (loopback is listed separately above). */
const SPECIAL = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '64:ff9b::/96',
  '2002::/16',
  '2001::/32',
].map(cidr);

export type AddressClass = 'global' | 'loopback' | 'private' | 'metadata' | 'invalid';

/** Classifies one resolved address against the section 2.2 G2 lists (after unmapping). */
export function classifyAddress(address: string, metadataExtra: readonly string[] = []): AddressClass {
  const ip = normaliseAddress(address);
  if (!ip) return 'invalid';
  for (const m of [...BUILTIN_METADATA_ADDRESSES, ...metadataExtra]) {
    const mi = normaliseAddress(m);
    if (mi && mi.v === ip.v && BigInt(mi.n) === BigInt(ip.n)) return 'metadata';
  }
  if (LOOPBACK.some((c) => inCidr(ip, c))) return 'loopback';
  if (SPECIAL.some((c) => inCidr(ip, c))) return 'private';
  return 'global';
}

function allowListed(entries: readonly EgressAllowEntry[], host: string, port: number, address: string): boolean {
  const ip = normaliseAddress(address);
  return entries.some((e) => {
    if (e.port !== port) return false;
    if (e.kind === 'host') return e.host === host;
    return ip !== null && inCidr(ip, cidr(e.cidr));
  });
}

/** The effective port of a URL (443 for https, 80 for http when none is written). */
export function effectivePort(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === 'http:' ? 80 : 443;
}

/** G1: whether the scheme may be used at all. */
export function checkScheme(u: URL, config: Pick<EgressConfig, 'allowHttp'>): EgressRefuseCause | null {
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && config.allowHttp) return null;
  return 'scheme';
}

/**
 * G2 (pure): every resolved address must pass; returns the address to pin the connection to, or the refusal. Used by
 * `egressFetch` and by the save-time check of org-supplied URLs (`400 egress_refused { cause }`).
 */
export function checkAddresses(
  u: URL,
  addresses: readonly string[],
  config: Pick<EgressConfig, 'allowLoopback' | 'privateAllow' | 'metadataAddresses'>,
): { ok: true; address: string } | { ok: false; cause: EgressRefuseCause } {
  if (addresses.length === 0) return { ok: false, cause: 'private_address' };
  const host = hostOf(u);
  const port = effectivePort(u);
  for (const a of addresses) {
    const cls = classifyAddress(a, config.metadataAddresses);
    if (cls === 'global') continue;
    if (cls === 'loopback' && config.allowLoopback) continue;
    if (cls === 'private' && allowListed(config.privateAllow, host, port, a)) continue;
    return { ok: false, cause: 'private_address' };
  }
  return { ok: true, address: addresses[0]! };
}

function hostOf(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

// ---------- the fetch ----------

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function transportFailure(err: unknown, signalTimedOut: boolean): EgressFailedError {
  if (signalTimedOut) return new EgressFailedError('timeout', true);
  const code = String((err as { cause?: { code?: unknown } })?.cause?.code ?? (err as { code?: unknown })?.code ?? '');
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'UND_ERR_CONNECT_TIMEOUT')
    return new EgressFailedError('connect', false);
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return new EgressFailedError('connect', true);
  return new EgressFailedError('network', true);
}

async function readCapped(res: Awaited<ReturnType<typeof undiciFetch>>, max: number, abort: () => void): Promise<Uint8Array | null> {
  const len = res.headers.get('content-length');
  if (len !== null && Number(len) > max) {
    abort();
    throw new EgressRefusedError('too_large');
  }
  if (!res.body) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    const c = chunk as Uint8Array;
    total += c.byteLength;
    if (total > max) {
      abort();
      throw new EgressRefusedError('too_large');
    }
    chunks.push(c);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Builds `egressFetch` over the operator's egress settings (ctx.egressFetch). */
export function createEgressFetch(deps: EgressDeps): EgressFetch {
  const lookup = deps.lookup ?? systemLookup;
  const cfg = deps.config;
  return async (input, init, opts) => {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? EGRESS_DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxResponseBytes ?? EGRESS_DEFAULT_MAX_RESPONSE_BYTES;
    const method = (init.method ?? 'GET').toUpperCase();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const local = new AbortController();
    const signals = [timeoutSignal, local.signal, ...(init.signal ? [init.signal] : [])];
    const signal = AbortSignal.any(signals);
    let firstHost: string | null = null;
    let status: number | null = null;
    let result: 'ok' | 'refused' | 'timeout' | 'error' = 'error';
    const agents: Agent[] = [];
    try {
      let url: URL;
      try {
        url = new URL(String(input));
      } catch {
        throw new EgressRefusedError('scheme', 'egress refused: not a URL');
      }
      firstHost = hostOf(url);
      for (let hop = 0; ; hop++) {
        const schemeRefusal = checkScheme(url, cfg);
        if (schemeRefusal) throw new EgressRefusedError(schemeRefusal);
        const host = hostOf(url);
        let addresses: string[];
        if (isIP(host)) addresses = [host];
        else {
          try {
            addresses = (await lookup(host)).map((r) => r.address);
          } catch {
            throw new EgressFailedError('dns', false);
          }
          if (addresses.length === 0) throw new EgressFailedError('dns', false);
        }
        const verdict = checkAddresses(url, addresses, cfg);
        if (!verdict.ok) throw new EgressRefusedError(verdict.cause);
        const pinned = verdict.address;
        const family = isIP(pinned) === 6 ? 6 : 4;
        const agent = new Agent({
          connect: {
            // G3: every connection of this request goes to the checked address, whatever DNS says now.
            lookup: (_hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
              if (options?.all) cb(null, [{ address: pinned, family } satisfies LookupAddress]);
              else cb(null, pinned, family);
            },
          } as never,
        });
        agents.push(agent);
        let res: Awaited<ReturnType<typeof undiciFetch>>;
        try {
          res = await undiciFetch(url, {
            ...(init as Record<string, unknown>),
            method,
            redirect: 'manual',
            signal,
            dispatcher: agent,
          } as Parameters<typeof undiciFetch>[1]);
        } catch (err) {
          if (err instanceof EgressRefusedError) throw err;
          throw transportFailure(err, timeoutSignal.aborted);
        }
        status = res.status;
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          await res.body?.cancel().catch(() => undefined);
          if (method !== 'GET') throw new EgressRefusedError('redirect', 'egress refused: redirect on a non-GET request');
          if (hop >= EGRESS_MAX_REDIRECTS) throw new EgressRefusedError('redirect', 'egress refused: too many redirects');
          let next: URL;
          try {
            next = new URL(res.headers.get('location')!, url);
          } catch {
            throw new EgressRefusedError('redirect');
          }
          if (next.protocol !== url.protocol || hostOf(next) !== host || effectivePort(next) !== effectivePort(url))
            throw new EgressRefusedError('redirect', 'egress refused: cross-origin redirect');
          url = next;
          continue;
        }
        let body: Uint8Array | null;
        try {
          body = await readCapped(res, maxBytes, () => local.abort());
        } catch (err) {
          if (err instanceof EgressRefusedError) throw err;
          throw transportFailure(err, timeoutSignal.aborted);
        }
        const headers = new Headers();
        res.headers.forEach((v, k) => headers.append(k, v));
        result = 'ok';
        return new Response(NULL_BODY.has(res.status) ? null : (body as ConstructorParameters<typeof Response>[0]), {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
    } catch (err) {
      result = err instanceof EgressRefusedError ? 'refused' : err instanceof EgressFailedError && err.kind === 'timeout' ? 'timeout' : 'error';
      throw err;
    } finally {
      for (const a of agents) void a.close().catch(() => undefined);
      deps.metrics?.egressRequests.inc({ purpose: opts.purpose, result });
      // G6: purpose, org, host, status, duration and outcome only; never the path, query, headers or bodies.
      deps.log?.info({ purpose: opts.purpose, orgId: opts.orgId, host: firstHost, status, ms: Date.now() - started, result }, 'egress');
    }
  };
}

/**
 * Save-time check of an org-supplied URL (section 2.2 G1/G2 at save, `400 egress_refused { cause }`): scheme and the
 * resolved addresses, without connecting. A host that does not resolve is not refused here (the call fails later).
 */
export async function checkEgressUrl(
  raw: string,
  deps: Pick<EgressDeps, 'config' | 'lookup'>,
): Promise<{ ok: true } | { ok: false; cause: EgressRefuseCause }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, cause: 'scheme' };
  }
  const scheme = checkScheme(u, deps.config);
  if (scheme) return { ok: false, cause: scheme };
  const host = hostOf(u);
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await (deps.lookup ?? systemLookup)(host)).map((r) => r.address);
    } catch {
      return { ok: true };
    }
  }
  const v = checkAddresses(u, addresses, deps.config);
  return v.ok ? { ok: true } : { ok: false, cause: v.cause };
}

/**
 * `ctx.dnsResolver` (section 1.4): the egress guard's lookups and the sso stream's TXT proofs (rule 3.2b) go through
 * it, so tests inject a fake and production uses the system resolver.
 */
export type DnsResolver = { lookup: EgressLookup; resolveTxt: (host: string) => Promise<string[][]> };

export const systemDnsResolver: DnsResolver = {
  lookup: systemLookup,
  resolveTxt: (host) => dns.resolveTxt(host),
};
