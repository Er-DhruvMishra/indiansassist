/**
 * Phase E section 13.4 (stream sso) in the console: the email-first login page with SSO discovery, the /sso/continue
 * interstitial, and the SSO settings page (write-only secret, domains, the SSO-required switch with its missing list,
 * live regions, auditor read-only). fetch is stubbed per route; no network.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SsoSettings, UserRole } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { SsoContinuePage } from '../src/assist/sso/SsoContinuePage';
import { configFrom, modelFrom, SsoSettingsPage } from '../src/assist/sso/SsoSettingsPage';
import { beginHref, SSO_ERROR_TEXT } from '../src/assist/sso/ssoApi';
import { API_URL } from '../src/config';
import { LoginPage } from '../src/pages/LoginPage';
import { IDS, ISO, jsonResponse } from './fakes';

type Handler = (body: unknown) => Response | Promise<Response>;
const calls: { method: string; path: string; body: unknown }[] = [];

function route(table: Record<string, Handler>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      const h = table[`${method} ${path}`];
      return h ? h(body) : jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

function auth(role: UserRole): AuthValue {
  return {
    status: 'authenticated',
    me: { user: { id: IDS.user, orgId: IDS.org, email: 'admin@acme.test', name: 'Asha', role, status: 'active', createdAt: ISO } as never, org: {} as never, seat: null },
    error: null,
    setMe: () => undefined,
    refresh: () => undefined,
    logout: async () => undefined,
  };
}

function renderLogin(path = '/login') {
  return render(
    <StaticAuthProvider value={auth('technician')}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/app" element={<p>console home</p>} />
        </Routes>
      </MemoryRouter>
    </StaticAuthProvider>,
  );
}

const BEGIN = '/api/v1/auth/sso/acme-it/begin?login_hint=asha%40acme.test';

describe('login page: email first', () => {
  it('a password domain shows the password form, and signs in', async () => {
    route({
      'POST /auth/sso/discover': () => jsonResponse(200, { mode: 'password' }),
      'POST /auth/login': () => jsonResponse(200, { user: { id: IDS.user }, org: {}, seat: null }),
    });
    renderLogin();
    expect(screen.queryByLabelText('Password')).toBeNull();
    await userEvent.type(screen.getByLabelText('Email'), 'asha@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const pw = await screen.findByLabelText('Password');
    await waitFor(() => expect(document.activeElement).toBe(pw));
    await userEvent.type(pw, 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('console home')).toBeTruthy();
    expect(calls.find((c) => c.path === '/auth/sso/discover')?.body).toEqual({ email: 'asha@acme.test' });
  });

  it('sso_required shows one Continue link and a small administrator password link', async () => {
    route({ 'POST /auth/sso/discover': () => jsonResponse(200, { mode: 'sso_required', displayName: 'Acme IdP', beginUrl: BEGIN }) });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Email'), 'asha@acme.test');
    await userEvent.keyboard('{Enter}');
    const link = await screen.findByRole('link', { name: 'Continue with Acme IdP' });
    expect(link.getAttribute('href')).toBe(`${API_URL}${BEGIN}`);
    expect(link.getAttribute('referrerpolicy')).toBe('origin');
    expect(screen.queryByLabelText('Password')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Administrator sign-in with password' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
  });

  it('sso_available shows both; a 403 sso_required after the password shows the SSO link', async () => {
    route({
      'POST /auth/sso/discover': () => jsonResponse(200, { mode: 'sso_available', displayName: 'Acme IdP', beginUrl: BEGIN }),
      'POST /auth/login': () => jsonResponse(403, { error: { code: 'sso_required', message: 'sso', details: { beginUrl: BEGIN } } }),
    });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Email'), 'asha@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('link', { name: 'Continue with Acme IdP' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Password'), 'pw pw pw pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/signs in with single sign-on/);
    expect(screen.getByRole('link', { name: 'Continue with Acme IdP' })).toBeTruthy();
  });

  it('shows ?sso_error= in plain words', async () => {
    route({});
    renderLogin('/login?sso_error=domain_not_verified');
    expect((await screen.findByRole('alert')).textContent).toBe(SSO_ERROR_TEXT.domain_not_verified);
  });

  it('discovery failing still offers the password form', async () => {
    route({ 'POST /auth/sso/discover': () => jsonResponse(500, { error: { code: 'internal', message: 'x' } }) });
    renderLogin();
    await userEvent.type(screen.getByLabelText('Email'), 'asha@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
  });

  it('beginHref accepts only an api begin path', () => {
    expect(beginHref(BEGIN)).toBe(`${API_URL}${BEGIN}`);
    expect(beginHref('https://evil.test/api/v1/auth/sso/x/begin')).toBeNull();
    expect(beginHref('//evil.test/api/v1/auth/sso/acme/begin')).toBeNull();
    expect(beginHref('/api/v1/auth/sso/acme/begin#x')).toBeNull();
  });
});

describe('/sso/continue interstitial', () => {
  function renderContinue(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <SsoContinuePage />
      </MemoryRouter>,
    );
  }

  it('names the org and the IdP; Continue is a same-origin navigation back to begin', async () => {
    route({ 'GET /auth/sso/acme-it/info': () => jsonResponse(200, { orgName: 'Acme IT', displayName: 'Acme IdP', protocol: 'saml' }) });
    renderContinue('/sso/continue?org=acme-it&login_hint=asha%40acme.test&return_to=%2Fapp%2Faudit');
    expect(await screen.findByText(/meant to sign in to this organisation/)).toBeTruthy();
    expect(screen.getByText('Acme IdP')).toBeTruthy();
    expect(screen.getByText('Acme IT')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Continue to Acme IdP' });
    expect(link.getAttribute('href')).toBe(`${API_URL}/api/v1/auth/sso/acme-it/begin?login_hint=asha%40acme.test&return_to=%2Fapp%2Faudit`);
    expect(link.getAttribute('referrerpolicy')).toBe('origin');
    expect(screen.getByRole('link', { name: 'Go to the sign-in page' }).getAttribute('href')).toBe('/login');
  });

  it('an org without SSO, or a link without an org, says so', async () => {
    route({});
    renderContinue('/sso/continue?org=nobody-here');
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not use single sign-on/);
    expect(screen.queryByRole('link', { name: /Continue to/ })).toBeNull();
  });

  it('without an org it links back to sign-in', () => {
    route({});
    renderContinue('/sso/continue');
    expect(screen.getByRole('alert').textContent).toMatch(/not complete/);
    expect(screen.getByRole('link', { name: 'Go to the sign-in page' }).getAttribute('href')).toBe('/login');
  });
});

const SETTINGS: SsoSettings = {
  config: {
    v: 1,
    protocol: 'oidc',
    enabled: true,
    displayName: 'Acme IdP',
    oidc: {
      issuer: 'https://idp.acme.test',
      clientId: 'ia',
      tokenEndpointAuth: 'client_secret_basic',
      scopes: ['openid', 'email'],
      emailClaim: 'email',
      nameClaim: 'name',
      groupsClaim: null,
      requiredClaims: [{ name: 'hd', values: ['acme.test'] }],
    },
    saml: null,
    jit: { enabled: true, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [{ group: 'audit', role: 'auditor' }] },
    sessionMaxAgeHours: 12,
  },
  required: false,
  secrets: { clientSecret: { set: true, setAt: ISO, fingerprint: 'abcd1234' }, spKey: { set: false, setAt: null, fingerprint: null } },
  sp: {
    entityId: 'https://ia.test/api/v1/auth/sso/saml/x/metadata',
    acsUrl: 'https://ia.test/api/v1/auth/sso/saml/x/acs',
    metadataUrl: 'https://ia.test/api/v1/auth/sso/saml/x/metadata',
    oidcRedirectUri: `https://ia.test/api/v1/auth/sso/oidc/${IDS.org}/callback`,
    certPem: null,
  },
  domains: [
    { id: IDS.other, domain: 'acme.test', status: 'pending', txtName: '_indiansassist.acme.test', txtValue: `ia-verify=${'a'.repeat(32)}`, verifiedAt: null, lastCheckedAt: null, createdAt: ISO },
  ],
  breakGlassUserIds: [],
  lastTest: null,
};

function renderSettings(role: UserRole, path = '/app/settings/sso') {
  return render(
    <StaticAuthProvider value={auth(role)}>
      <MemoryRouter initialEntries={[path]}>
        <SsoSettingsPage />
      </MemoryRouter>
    </StaticAuthProvider>,
  );
}

describe('SSO settings page', () => {
  const base = {
    'GET /orgs/current/sso': () => jsonResponse(200, SETTINGS),
    'GET /users': () =>
      jsonResponse(200, {
        items: [{ id: IDS.user, orgId: IDS.org, email: 'admin@acme.test', name: 'Asha', role: 'org_admin', status: 'active', createdAt: ISO, seat: null }],
        nextCursor: null,
      }),
    'PATCH /orgs/current/sso/required': () =>
      jsonResponse(409, { error: { code: 'sso_not_ready', message: 'x', details: { missing: ['verified_domain', 'break_glass', 'recent_test'] } } }),
  };

  it('shows the secret as status only, the redirect URI to copy and the domain TXT record', async () => {
    route(base);
    renderSettings('org_admin');
    const secret = await screen.findByLabelText('Client secret');
    expect((secret as HTMLInputElement).type).toBe('password');
    expect((secret as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/Set on .*fingerprint abcd1234/)).toBeTruthy();
    expect((screen.getByLabelText('Redirect URI') as HTMLInputElement).value).toBe(SETTINGS.sp.oidcRedirectUri);
    expect((screen.getByLabelText('TXT value for acme.test') as HTMLInputElement).value).toBe(`ia-verify=${'a'.repeat(32)}`);
    expect(screen.getByText('Pending')).toBeTruthy();
    expect((screen.getByLabelText('Required claims') as HTMLTextAreaElement).value).toBe('hd=acme.test');
  });

  it('disables the SSO-required switch and lists what is missing', async () => {
    route(base);
    renderSettings('org_admin');
    const sw = await screen.findByRole('switch');
    await waitFor(() => expect(screen.getByText('At least one domain is verified')).toBeTruthy());
    expect((sw as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('You completed a successful test sign-in as yourself in the last 24 hours')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ required: true, dryRun: true });
  });

  it('a failed verify is announced with what DNS returned', async () => {
    route({
      ...base,
      [`POST /orgs/current/sso/domains/${IDS.other}/verify`]: () =>
        jsonResponse(409, { error: { code: 'domain_unverified', message: 'x', details: { found: ['v=spf1 -all'] } } }),
    });
    renderSettings('org_admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Verify acme.test' }));
    const card = (await screen.findByRole('heading', { name: 'Verified domains' })).closest('section')!;
    await waitFor(() => expect(within(card).getByRole('status').textContent).toMatch(/not verified yet.*Found: v=spf1 -all/));
  });

  it('saves the config with the secret only when typed', async () => {
    const saved: unknown[] = [];
    route({
      ...base,
      'PUT /orgs/current/sso': (body) => {
        saved.push(body);
        return jsonResponse(200, SETTINGS);
      },
    });
    renderSettings('org_admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Save identity provider' }));
    await screen.findByText('Saved.');
    expect(saved[0]).toEqual({ config: SETTINGS.config });
    await userEvent.type(screen.getByLabelText('Client secret'), 'new-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save identity provider' }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect((saved[1] as { clientSecret: string }).clientSecret).toBe('new-secret');
  });

  it('announces a test result from ?test=', async () => {
    route(base);
    renderSettings('org_admin', '/app/settings/sso?test=ok');
    expect(await screen.findByText('Test sign-in succeeded.')).toBeTruthy();
  });

  it('auditors read but cannot change anything', async () => {
    route(base);
    renderSettings('auditor');
    await screen.findByLabelText('Client secret');
    expect(screen.queryByRole('button', { name: 'Save identity provider' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Verify/ })).toBeNull();
    expect((screen.getByLabelText('Issuer URL') as HTMLInputElement).closest('fieldset')!.disabled).toBe(true);
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('config model', () => {
  it('round-trips and refuses malformed lines', () => {
    expect(configFrom(modelFrom(SETTINGS.config))).toEqual(SETTINGS.config);
    const m = modelFrom(SETTINGS.config);
    expect(() => configFrom({ ...m, groupRoles: 'admins=org_admin' })).toThrow(/group=role/);
    expect(() => configFrom({ ...m, requiredClaims: 'nonsense' })).toThrow(/name=value1/);
  });
});
