/**
 * Phase E section 15.3: each ticketing adapter against an in-process fake of its service, through the real egress
 * guard (http and loopback allowed, as for every local fake): the exact request of section 4.6 for test, create and
 * append; the body conversions (ADF, Jira wiki escaping, HTML, plain); Zoho's token refresh and its in-memory cache;
 * the ServiceNow number lookup; and the honest failure values (status classes, Retry-After, hang, reset, refused).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INTEGRATION_CONFIG_SCHEMAS,
  INTEGRATION_VERIFICATION,
  ZOHO_DATA_CENTERS,
  type IntegrationConfigOf,
  type IntegrationCredentialsOf,
  type IntegrationType,
  type TicketContent,
} from '@indiansassist/shared';
import type { EgressFetch } from '../src/lib/egress.js';
import { createEgressFetch } from '../src/lib/egress.js';
import type { AdapterCtx } from '../src/integrations/adapter.js';
import { createFreshdeskAdapter } from '../src/integrations/adapters/freshdesk.js';
import { createJiraAdapter } from '../src/integrations/adapters/jira.js';
import { createServicenowAdapter } from '../src/integrations/adapters/servicenow.js';
import { createZohoDeskAdapter } from '../src/integrations/adapters/zoho-desk.js';
import { parseRetryAfter, toAdf, toHtml, toJiraWiki } from '../src/integrations/http.js';
import { FakeTicketing, freshdeskRoutes, jiraRoutes, refusedUrl, servicenowRoutes, SN_SYS_ID, zohoRoutes } from './fake-ticketing.js';

const ORG = '11111111-2222-4333-8444-555555555555';
const egress = createEgressFetch({ config: { allowHttp: true, allowLoopback: true, privateAllow: [], metadataAddresses: [] } });
const STRICT = createEgressFetch({ config: { allowHttp: true, allowLoopback: false, privateAllow: [], metadataAddresses: [] } });

function ctxOf<T extends IntegrationType>(config: IntegrationConfigOf<T>, credentials: IntegrationCredentialsOf<T>, over: Partial<AdapterCtx<T>> = {}): AdapterCtx<T> {
  return { orgId: ORG, config, credentials, fetch: egress, delivery: { pushId: '', attempt: 1 }, now: () => new Date(), deadline: Date.now() + 5000, ...over };
}

const TICKET: TicketContent = {
  title: 'Remote support session 2026-11-02 — Asha R',
  body: 'Line one <b>& "quoted"</b>\nUse {code} [link] a|b *bold* _em_\n\n—\nRemote session: https://assist.example.test/app/sessions/6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
  source: 'manual',
  session: {
    id: '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
    url: 'https://assist.example.test/app/sessions/6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
    tier: 'p1_browser',
    startedAt: '2026-11-02T09:00:00.000Z',
    endedAt: '2026-11-02T09:30:00.000Z',
    technician: 'Asha R',
    chainVerified: true,
  },
  summary: null,
  priority: 'high',
  requesterEmail: null,
};

let f: FakeTicketing;
beforeAll(async () => {
  f = await FakeTicketing.start();
});
afterAll(async () => {
  await f.close();
});
beforeEach(() => f.reset());

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

describe('body conversions (section 4.3)', () => {
  it('ADF has one paragraph per line; empty lines are empty paragraphs', () => {
    expect(toAdf('a\n\nb')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
  });
  it('Jira wiki escapes { [ | * _ and HTML escapes inside <p> with <br>', () => {
    expect(toJiraWiki('{a} [b] c|d *e* _f_')).toBe('\\{a} \\[b] c\\|d \\*e\\* \\_f\\_');
    expect(toHtml('<x> & "y"\n\'z\'')).toBe('<p>&lt;x&gt; &amp; &quot;y&quot;<br>&#39;z&#39;</p>');
  });
  it('Retry-After: seconds or an HTTP date, capped at 7200', () => {
    const now = new Date('2026-11-02T10:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('99999', now)).toBe(7200);
    expect(parseRetryAfter('Mon, 02 Nov 2026 10:01:30 GMT', now)).toBe(90);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe('jira', () => {
  const jira = createJiraAdapter();
  const cloud = (): AdapterCtx<'jira'> =>
    ctxOf<'jira'>({ siteUrl: f.url, deployment: 'cloud', projectKey: 'OPS', issueType: 'Task', labels: ['remote'] }, { email: 'bot@example.test', apiToken: 'tok-123' });
  const dc = (): AdapterCtx<'jira'> =>
    ctxOf<'jira'>({ siteUrl: f.url, deployment: 'data_center', projectKey: 'OPS', issueType: 'Bug', labels: [] }, { personalAccessToken: 'pat-xyz' });
  beforeEach(() => jiraRoutes(f));

  it('cloud: test, create with ADF, append a comment', async () => {
    expect(await jira.test(cloud())).toEqual({ ok: true, status: 200, value: { account: 'IndiansAssist Bot' } });
    expect(f.last()).toMatchObject({ method: 'GET', path: '/rest/api/3/myself' });
    expect(f.last().headers.authorization).toBe(basic('bot@example.test', 'tok-123'));
    const created = await jira.create(cloud(), TICKET);
    expect(created).toEqual({ ok: true, status: 201, value: { externalId: 'OPS-42', externalUrl: `${f.url}/browse/OPS-42` } });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/rest/api/3/issue' });
    expect(f.last().json).toEqual({
      fields: { project: { key: 'OPS' }, issuetype: { name: 'Task' }, summary: TICKET.title, description: toAdf(TICKET.body), labels: ['remote'] },
    });
    expect((f.last().json as { fields: Record<string, unknown> }).fields).not.toHaveProperty('priority');
    const appended = await jira.append(cloud(), 'OPS-42', TICKET);
    expect(appended).toMatchObject({ ok: true, value: { externalId: 'OPS-42' } });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/rest/api/3/issue/OPS-42/comment', json: { body: toAdf(TICKET.body) } });
  });

  it('data_center: v2, bearer PAT, escaped plain text', async () => {
    await jira.test(dc());
    expect(f.last()).toMatchObject({ path: '/rest/api/2/myself' });
    expect(f.last().headers.authorization).toBe('Bearer pat-xyz');
    await jira.create(dc(), TICKET);
    expect(f.last().path).toBe('/rest/api/2/issue');
    expect((f.last().json as { fields: { description: string } }).fields.description).toBe(toJiraWiki(TICKET.body));
    await jira.append(dc(), 'OPS-42', TICKET);
    expect(f.last().json).toEqual({ body: toJiraWiki(TICKET.body) });
  });

  it('credentials that do not match the deployment are misconfigured, without a request', async () => {
    const bad = { ...cloud(), credentials: { personalAccessToken: 'x' } } as AdapterCtx<'jira'>;
    const r = await jira.create(bad, TICKET);
    expect(r).toMatchObject({ ok: false, failure: { cause: 'misconfigured', sent: false } });
    expect(f.requests).toHaveLength(0);
    expect(await jira.append(cloud(), 'not a key', TICKET)).toMatchObject({ ok: false, failure: { cause: 'validation', sent: false } });
  });
});

describe('servicenow', () => {
  const sn = createServicenowAdapter();
  const c = (): AdapterCtx<'servicenow'> =>
    ctxOf<'servicenow'>({ instanceUrl: f.url, callerId: 'a'.repeat(32), assignmentGroup: null, urgency: 3 }, { username: 'svc', password: 'pw!' });
  beforeEach(() => servicenowRoutes(f));

  it('test, create (plain text, urgency mapped from priority), number lookup then work_notes', async () => {
    expect(await sn.test(c())).toMatchObject({ ok: true });
    expect(f.last().path).toBe('/api/now/table/incident');
    expect(f.last().query.get('sysparm_limit')).toBe('1');
    expect(f.last().query.get('sysparm_fields')).toBe('sys_id');
    expect(f.last().headers.authorization).toBe(basic('svc', 'pw!'));
    expect(f.last().headers.accept).toBe('application/json');
    const created = await sn.create(c(), TICKET);
    expect(created).toEqual({
      ok: true,
      status: 201,
      value: { externalId: 'INC0010001', externalUrl: `${f.url}/nav_to.do?uri=incident.do?sys_id=${SN_SYS_ID}` },
    });
    expect(f.last().json).toEqual({ short_description: TICKET.title, description: TICKET.body, caller_id: 'a'.repeat(32), urgency: '1' });
    f.reset();
    servicenowRoutes(f);
    const appended = await sn.append(c(), 'INC0010001', TICKET);
    expect(appended).toMatchObject({ ok: true, value: { externalId: 'INC0010001' } });
    expect(f.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/now/table/incident', `PATCH /api/now/table/incident/${SN_SYS_ID}`]);
    expect(f.requests[0]!.query.get('sysparm_query')).toBe('number=INC0010001');
    expect(f.last().json).toEqual({ work_notes: TICKET.body });
  });

  it('a sys_id is used directly; an unknown number is not_found; a crafted number is refused', async () => {
    await sn.append(c(), SN_SYS_ID, TICKET);
    expect(f.requests.map((r) => r.method)).toEqual(['PATCH']);
    f.reset();
    servicenowRoutes(f);
    expect(await sn.append(c(), 'INC9999999', TICKET)).toMatchObject({ ok: false, failure: { cause: 'not_found' } });
    expect(f.requests.map((r) => r.method)).toEqual(['GET']);
    expect(await sn.append(c(), 'INC1^ORactive=true', TICKET)).toMatchObject({ ok: false, failure: { cause: 'validation', sent: false } });
  });

  it('no priority falls back to the configured urgency; none at all sends none', async () => {
    await sn.create(c(), { ...TICKET, priority: null });
    expect((f.last().json as Record<string, unknown>)['urgency']).toBe('3');
    await sn.create({ ...c(), config: { ...c().config, urgency: null, callerId: null } }, { ...TICKET, priority: null });
    expect(f.last().json).toEqual({ short_description: TICKET.title, description: TICKET.body });
  });
});

describe('freshdesk', () => {
  const fd = createFreshdeskAdapter({ baseUrlOf: () => f.url });
  const c = (): AdapterCtx<'freshdesk'> =>
    ctxOf<'freshdesk'>({ domain: 'acme', defaultRequesterEmail: 'help@acme.example.test', priority: 2, groupId: 7 }, { apiKey: 'fd-key' });
  beforeEach(() => freshdeskRoutes(f));

  it('test, create (HTML, mapped priority, status 2, group), private note', async () => {
    expect(await fd.test(c())).toEqual({ ok: true, status: 200, value: { account: 'Support Agent' } });
    expect(f.last()).toMatchObject({ method: 'GET', path: '/api/v2/agents/me' });
    expect(f.last().headers.authorization).toBe(basic('fd-key', 'X'));
    expect(await fd.create(c(), { ...TICKET, requesterEmail: 'user@customer.example.test' })).toEqual({
      ok: true,
      status: 201,
      value: { externalId: '4321', externalUrl: `${f.url}/a/tickets/4321` },
    });
    expect(f.last().json).toEqual({
      subject: TICKET.title,
      description: toHtml(TICKET.body),
      email: 'user@customer.example.test',
      priority: 3,
      status: 2,
      group_id: 7,
    });
    await fd.create(c(), { ...TICKET, priority: null });
    expect(f.last().json).toMatchObject({ email: 'help@acme.example.test', priority: 2 });
    await fd.append(c(), '4321', TICKET);
    expect(f.last()).toMatchObject({ path: '/api/v2/tickets/4321/notes', json: { body: toHtml(TICKET.body), private: true } });
  });

  it('production base URL is https://<domain>.freshdesk.com', async () => {
    const calls: string[] = [];
    const prod = createFreshdeskAdapter();
    const spy: AdapterCtx<'freshdesk'>['fetch'] = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    };
    await prod.create({ ...c(), fetch: spy }, TICKET);
    expect(calls).toEqual(['https://acme.freshdesk.com/api/v2/tickets']);
  });
});

describe('zoho desk', () => {
  const DC = { id: 'test', deskHost: '', accountsHost: '', region: null };
  const make = () => {
    const host = f.url.replace('http://', '');
    return createZohoDeskAdapter({ dataCenters: [{ ...DC, deskHost: host, accountsHost: host }], scheme: 'http' });
  };
  const c = (over: Partial<IntegrationConfigOf<'zoho_desk'>> = {}): AdapterCtx<'zoho_desk'> =>
    ctxOf<'zoho_desk'>(
      { dataCenter: 'test', orgId: '60001234', departmentId: '1892000000006907', defaultContactEmail: 'help@acme.example.test', priority: 'Low', ...over },
      { clientId: '1000.ABC', clientSecret: 'shh', refreshToken: '1000.refresh' },
    );
  beforeEach(() => zohoRoutes(f));

  it('refreshes a token, sends it with orgId, and caches it until 60 s before expiry', async () => {
    const z = make();
    expect(await z.test(c())).toEqual({ ok: true, status: 200, value: { account: 'Support' } });
    const [token, dept] = f.requests;
    expect(token).toMatchObject({ method: 'POST', path: '/oauth/v2/token' });
    expect(token!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(token!.raw))).toEqual({
      grant_type: 'refresh_token',
      client_id: '1000.ABC',
      client_secret: 'shh',
      refresh_token: '1000.refresh',
    });
    expect(dept).toMatchObject({ method: 'GET', path: '/api/v1/departments/1892000000006907' });
    expect(dept!.headers.authorization).toBe('Zoho-oauthtoken zoho-at-1');
    expect(dept!.headers.orgid).toBe('60001234');
    // Cached: the next call makes no token request.
    const created = await z.create(c(), { ...TICKET, priority: 'urgent' });
    expect(created).toMatchObject({ ok: true, value: { externalId: '1892000000143237', externalUrl: expect.stringMatching(/^https:\/\//) } });
    expect(f.requests.filter((r) => r.path === '/oauth/v2/token')).toHaveLength(1);
    expect(f.last().json).toEqual({
      subject: TICKET.title,
      departmentId: '1892000000006907',
      description: toHtml(TICKET.body),
      contact: { email: 'help@acme.example.test', lastName: 'IndiansAssist' },
      priority: 'Urgent',
      channel: 'Web',
    });
    await z.append(c(), '1892000000143237', TICKET);
    expect(f.last()).toMatchObject({ path: '/api/v1/tickets/1892000000143237/comments', json: { content: toHtml(TICKET.body), contentType: 'html', isPublic: false } });
    expect(z.cachedTokens()).toBe(1);
  });

  it('expires the cached token 60 s early, drops it on a config change and on an auth failure', async () => {
    const z = make();
    let now = new Date('2026-11-02T10:00:00Z');
    const at = (over: Partial<IntegrationConfigOf<'zoho_desk'>> = {}) => ({ ...c(over), now: () => now });
    await z.test(at());
    now = new Date(now.getTime() + 3540_000 - 1);
    await z.test(at());
    expect(f.requests.filter((r) => r.path === '/oauth/v2/token')).toHaveLength(1);
    now = new Date(now.getTime() + 2);
    await z.test(at());
    expect(f.requests.filter((r) => r.path === '/oauth/v2/token')).toHaveLength(2);
    await z.test(at({ departmentId: '42' }));
    expect(f.requests.filter((r) => r.path === '/oauth/v2/token')).toHaveLength(3);
    f.script({ status: 401, json: { errorCode: 'INVALID_OAUTH' } });
    // The cached token is used and refused: the failure is `auth` and the cache entry is dropped.
    expect(await z.test(at({ departmentId: '42' }))).toMatchObject({ ok: false, failure: { cause: 'auth', status: 401, detail: 'HTTP 401 INVALID_OAUTH' } });
    expect(z.cachedTokens()).toBe(0);
  });

  it('a refused refresh token is auth; a lost token call cannot have created a ticket', async () => {
    const z = make();
    f.script({ status: 200, json: { error: 'invalid_code' } });
    expect(await z.create(c(), TICKET)).toMatchObject({ ok: false, failure: { cause: 'auth', detail: 'token refresh refused: invalid_code' } });
    expect(f.requests).toHaveLength(1);
    f.script({ reset: true });
    expect(await z.create(c(), TICKET)).toMatchObject({ ok: false, failure: { cause: 'unreachable', sent: false } });
  });

  it('calls only hosts of the verified table: an unknown data centre is misconfigured without a request', async () => {
    const z = make();
    expect(await z.create(c({ dataCenter: 'com' }), TICKET)).toMatchObject({ ok: false, failure: { cause: 'misconfigured', sent: false } });
    expect(f.requests).toHaveLength(0);
    const empty = createZohoDeskAdapter({ dataCenters: [] });
    expect(await empty.test(c())).toMatchObject({ ok: false, failure: { cause: 'misconfigured' } });
    expect(f.requests).toHaveLength(0);
    expect(await z.append(c(), 'abc', TICKET)).toMatchObject({ ok: false, failure: { cause: 'validation' } });
  });
});

describe('failure values (section 4.1)', () => {
  const jira = createJiraAdapter();
  const c = (over: Partial<AdapterCtx<'jira'>> = {}) =>
    ctxOf<'jira'>({ siteUrl: f.url, deployment: 'data_center', projectKey: 'OPS', issueType: 'Task', labels: [] }, { personalAccessToken: 'p' }, over);

  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [422, 'validation'],
    [500, 'upstream_error'],
    [503, 'upstream_error'],
  ] as const)('HTTP %s -> %s (sent)', async (status, cause) => {
    f.script({ status, json: { errorMessages: ['secret text the detail must not carry'] } });
    const r = await jira.create(c(), TICKET);
    expect(r).toEqual({ ok: false, failure: { cause, status, retryAfterSec: null, sent: true, detail: `HTTP ${status}` } });
  });

  it('429 carries Retry-After, capped', async () => {
    f.script({ status: 429, headers: { 'retry-after': '90' } }, { status: 429, headers: { 'retry-after': '86400' } });
    expect(await jira.create(c(), TICKET)).toMatchObject({ ok: false, failure: { cause: 'rate_limited', status: 429, retryAfterSec: 90 } });
    expect(await jira.create(c(), TICKET)).toMatchObject({ ok: false, failure: { retryAfterSec: 7200 } });
  });

  it('a hang is a timeout (sent); a reset after the request is ambiguous (sent); a refused port was never sent', async () => {
    f.script({ hang: true });
    expect(await jira.create(c({ deadline: Date.now() + 300 }), TICKET)).toMatchObject({ ok: false, failure: { cause: 'timeout', status: null, sent: true } });
    f.script({ reset: true });
    expect(await jira.create(c(), TICKET)).toMatchObject({ ok: false, failure: { cause: 'upstream_error', status: null, sent: true } });
    const dead = await refusedUrl();
    expect(await jira.create(c({ config: { ...c().config, siteUrl: dead } }), TICKET)).toMatchObject({ ok: false, failure: { cause: 'unreachable', sent: false } });
  });

  it('an egress refusal is egress_refused and nothing is sent', async () => {
    const before = f.requests.length;
    expect(await jira.create(c({ fetch: STRICT }), TICKET)).toMatchObject({ ok: false, failure: { cause: 'egress_refused', sent: false, detail: 'egress refused: private_address' } });
    expect(f.requests.length).toBe(before);
  });
});

describe('vendor verification record (Phase F section 3.3)', () => {
  const VENDOR_DOCS = /^https:\/\/(developer\.atlassian\.com|support\.atlassian\.com|confluence\.atlassian\.com|docs\.atlassian\.com|www\.servicenow\.com|developers\.freshdesk\.com|desk\.zoho\.com|www\.zoho\.com)\//;

  it('records vendor documentation sources with the date read, and verified only when nothing is unconfirmed', () => {
    for (const [type, v] of Object.entries(INTEGRATION_VERIFICATION)) {
      expect(v.sources.length, type).toBeGreaterThan(0);
      for (const src of v.sources) {
        expect(src.url, type).toMatch(VENDOR_DOCS);
        expect(src.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(v.verified, type).toBe(v.unconfirmed.length === 0);
      for (const u of v.unconfirmed) expect(u.length).toBeLessThanOrEqual(160);
    }
  });

  it('ships only the Zoho data centres whose desk and accounts hosts both appear in Zoho documentation (V6)', () => {
    expect(ZOHO_DATA_CENTERS).toEqual([
      { id: 'us', deskHost: 'desk.zoho.com', accountsHost: 'accounts.zoho.com', region: null },
      { id: 'eu', deskHost: 'desk.zoho.eu', accountsHost: 'accounts.zoho.eu', region: null },
      { id: 'in', deskHost: 'desk.zoho.in', accountsHost: 'accounts.zoho.in', region: 'in-mum' },
      { id: 'au', deskHost: 'desk.zoho.com.au', accountsHost: 'accounts.zoho.com.au', region: null },
      { id: 'jp', deskHost: 'desk.zoho.jp', accountsHost: 'accounts.zoho.jp', region: null },
      { id: 'ca', deskHost: 'desk.zohocloud.ca', accountsHost: 'accounts.zohocloud.ca', region: null },
      { id: 'sa', deskHost: 'desk.zoho.sa', accountsHost: 'accounts.zoho.sa', region: null },
    ]);
    const urls = INTEGRATION_VERIFICATION.zoho_desk.sources.map((x) => x.url);
    expect(urls).toContain('https://desk.zoho.com/DeskAPIDocument');
    expect(urls).toContain('https://www.zoho.com/accounts/protocol/oauth/multi-dc.html');
    // No undocumented data centre (China, Singapore, the UAE, the UK) ships; a shipped row now validates.
    for (const id of ['cn', 'sg', 'ae', 'uk']) expect(ZOHO_DATA_CENTERS.some((d) => d.id === id)).toBe(false);
    const cfg = { orgId: '1', departmentId: '2', defaultContactEmail: 'desk@example.test', priority: null };
    expect(INTEGRATION_CONFIG_SCHEMAS.zoho_desk.safeParse({ ...cfg, dataCenter: 'in' }).success).toBe(true);
    expect(INTEGRATION_CONFIG_SCHEMAS.zoho_desk.safeParse({ ...cfg, dataCenter: 'cn' }).success).toBe(false);
  });

  it('the production Zoho adapter calls only the hosts of the named row, over https', async () => {
    const seen: string[] = [];
    const recording: EgressFetch = async (url) => {
      seen.push(String(url));
      const token = String(url).endsWith('/oauth/v2/token');
      return new Response(JSON.stringify(token ? { access_token: 'tok', expires_in: 3600 } : { id: '3', name: 'Support' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const zoho = createZohoDeskAdapter({ dataCenters: ZOHO_DATA_CENTERS });
    const r = await zoho.test(
      ctxOf<'zoho_desk'>(
        { dataCenter: 'in', orgId: '1', departmentId: '3', defaultContactEmail: 'desk@example.test', priority: null },
        { clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt' },
        { fetch: recording },
      ),
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['https://accounts.zoho.in/oauth/v2/token', 'https://desk.zoho.in/api/v1/departments/3']);
  });
});
