/**
 * Zoho Desk (docs/specs/phase-e-contracts.md sections 4.2, 4.6, rule 4.4h). The adapter calls only the desk and
 * accounts hosts of a `ZOHO_DATA_CENTERS` row named by `config.dataCenter`, never a free host. Access tokens come
 * from the refresh-token grant and are cached in memory only, per integration (one per org), until 60 s before
 * `expires_in`; the cache entry is dropped on any `auth` failure and whenever the configuration or credentials change
 * (the entry is keyed by a digest of both). Nothing is persisted.
 */
import { canonicalJson, sha256Hex, type TicketContent, type ZohoDataCenter } from '@indiansassist/shared';
import type { AdapterCtx, AdapterResult, TicketingAdapter, TicketRef } from '../adapter.js';
import { fail, failure, httpsUrl, oneLine, pick, toHtml, upstream, ZOHO_PRIORITY } from '../http.js';

type Ctx = AdapterCtx<'zoho_desk'>;
type Token = { accessToken: string; expiresAt: number; digest: string };

export type ZohoAdapterOptions = {
  /** The verified host table (`ZOHO_DATA_CENTERS`); tests pass a row pointing at an in-process fake. */
  dataCenters: readonly ZohoDataCenter[];
  /** `https` in production; the in-process fakes are plain http. */
  scheme?: 'https' | 'http';
};

export type ZohoDeskAdapter = TicketingAdapter<'zoho_desk'> & {
  /** For tests: the number of cached tokens. */
  cachedTokens(): number;
  clearTokens(): void;
};

const TOKEN_EARLY_MS = 60_000;

export function createZohoDeskAdapter(opts: ZohoAdapterOptions): ZohoDeskAdapter {
  const scheme = opts.scheme ?? 'https';
  const tokens = new Map<string, Token>();

  const dcOf = (c: Ctx): ZohoDataCenter | null => opts.dataCenters.find((d) => d.id === c.config.dataCenter) ?? null;
  const digestOf = (c: Ctx) => sha256Hex(canonicalJson({ config: c.config, credentials: c.credentials }));

  async function token(c: Ctx, dc: ZohoDataCenter): Promise<{ ok: true; token: string } | { ok: false; result: AdapterResult<never> }> {
    const digest = digestOf(c);
    const cached = tokens.get(c.orgId);
    if (cached && cached.digest === digest && cached.expiresAt > c.now().getTime()) return { ok: true, token: cached.accessToken };
    tokens.delete(c.orgId);
    const r = await upstream(c, {
      method: 'POST',
      url: `${scheme}://${dc.accountsHost}/oauth/v2/token`,
      form: {
        grant_type: 'refresh_token',
        client_id: c.credentials.clientId,
        client_secret: c.credentials.clientSecret,
        refresh_token: c.credentials.refreshToken,
      },
    });
    if (!r.ok) {
      const f = r.failure;
      // Nothing of the ticket has been sent yet, so a lost token call is never ambiguous for the ticket.
      if (f.cause === 'timeout' || (f.cause === 'upstream_error' && f.status === null))
        return { ok: false, result: fail('unreachable', { sent: false, detail: `token endpoint: ${f.detail}` }) };
      if (f.status !== null && f.status >= 400 && f.status < 500 && f.cause !== 'rate_limited')
        return { ok: false, result: fail('auth', { status: f.status, sent: true, detail: `token refresh refused: ${f.detail}` }) };
      return { ok: false, result: { ok: false, failure: { ...f, detail: `token endpoint: ${f.detail}`.slice(0, 200) } } };
    }
    const access = pick(r.res.json, 'access_token');
    if (!access) {
      // Zoho answers 200 with `{ "error": "invalid_code" }` for a revoked or wrong refresh token.
      const code = pick(r.res.json, 'error');
      return { ok: false, result: fail('auth', { status: r.res.status, sent: true, detail: `token refresh refused${code && /^[A-Za-z0-9_.-]{1,60}$/.test(code) ? `: ${code}` : ''}` }) };
    }
    const expiresIn = Number(pick(r.res.json, 'expires_in') ?? 3600);
    const ttlMs = Math.max(0, (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000 - TOKEN_EARLY_MS);
    if (ttlMs > 0) tokens.set(c.orgId, { accessToken: access, expiresAt: c.now().getTime() + ttlMs, digest });
    return { ok: true, token: access };
  }

  async function call<R>(
    c: Ctx,
    req: { method: 'GET' | 'POST'; path: string; json?: unknown },
    map: (json: unknown, status: number) => AdapterResult<R>,
  ): Promise<AdapterResult<R>> {
    const dc = dcOf(c);
    if (!dc) return fail('misconfigured', { detail: 'not a verified Zoho data centre' });
    const t = await token(c, dc);
    if (!t.ok) {
      if (t.result.ok === false && t.result.failure.cause === 'auth') tokens.delete(c.orgId);
      return t.result;
    }
    const r = await upstream(c, {
      method: req.method,
      url: `${scheme}://${dc.deskHost}${req.path}`,
      headers: { Authorization: `Zoho-oauthtoken ${t.token}`, orgId: c.config.orgId },
      ...(req.json !== undefined ? { json: req.json } : {}),
    });
    if (!r.ok) {
      if (r.failure.cause === 'auth') tokens.delete(c.orgId);
      return { ok: false, failure: r.failure };
    }
    return map(r.res.json, r.res.status);
  }

  const priorityOf = (c: Ctx, t: TicketContent) => (t.priority ? ZOHO_PRIORITY[t.priority] : c.config.priority);

  return {
    type: 'zoho_desk',
    cachedTokens: () => tokens.size,
    clearTokens: () => tokens.clear(),

    test: (c) =>
      call(c, { method: 'GET', path: `/api/v1/departments/${c.config.departmentId}` }, (json, status) => ({
        ok: true,
        status,
        value: { account: pick(json, 'name') },
      })),

    create: (c, t) => {
      const priority = priorityOf(c, t);
      return call<TicketRef>(
        c,
        {
          method: 'POST',
          path: '/api/v1/tickets',
          json: {
            subject: oneLine(t.title),
            departmentId: c.config.departmentId,
            description: toHtml(t.body),
            contact: { email: t.requesterEmail ?? c.config.defaultContactEmail, lastName: 'IndiansAssist' },
            ...(priority ? { priority } : {}),
            channel: 'Web',
          },
        },
        (json, status) => {
          const id = pick(json, 'id');
          if (!id) return { ok: false, failure: failure('upstream_error', { status, sent: true, detail: 'answer without a ticket id' }) };
          return { ok: true, status, value: { externalId: id, externalUrl: httpsUrl(pick(json, 'webUrl')) } };
        },
      );
    },

    append: (c, externalId, t) => {
      if (!/^\d{1,20}$/.test(externalId)) return Promise.resolve(fail('validation', { detail: 'not a Zoho Desk ticket id' }));
      return call<TicketRef>(
        c,
        { method: 'POST', path: `/api/v1/tickets/${externalId}/comments`, json: { content: toHtml(t.body), contentType: 'html', isPublic: false } },
        (_json, status) => ({ ok: true, status, value: { externalId, externalUrl: null } }),
      );
    },
  };
}
