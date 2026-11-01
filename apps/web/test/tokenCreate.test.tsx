import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthResponse, Token } from '@indiansassist/shared';
import { TokensPage } from '../src/assist/tokens/TokensPage';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { IDS, ISO, LATER, jsonResponse } from './fakes';

const me: AuthResponse = {
  user: { id: IDS.user, orgId: IDS.org, email: 'priya@acme.test', name: 'Priya S', role: 'technician', status: 'active', createdAt: ISO, lastLoginAt: ISO },
  org: { id: IDS.org, name: 'Acme IT', slug: 'acme-it', dataRegion: 'in-mum', planTier: 'p1_browser', branding: {}, createdAt: ISO },
  seat: { id: IDS.other, userId: IDS.user, tier: 'p1_browser', active: true },
};

const auth: AuthValue = { status: 'authenticated', me, error: null, setMe: () => {}, refresh: () => {}, logout: async () => {} };

/** Phase D: an enrollment token needs a p4_installed seat before the tier (and so the type) can be chosen. */
const p4Auth: AuthValue = {
  ...auth,
  me: { ...me, org: { ...me.org, planTier: 'p4_installed' }, seat: { ...me.seat!, tier: 'p4_installed' } },
};

const COMPACT = 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln';
const JOIN_URL = `http://localhost:5173/join#t=${COMPACT}`;

function token(over: Partial<Token> = {}): Token {
  return {
    id: IDS.token,
    tier: 'p1_browser',
    typ: 'timed',
    status: 'active',
    shortCode: '482193657710',
    shortCodeDisplay: '4821 9365 7710',
    label: 'Ticket 42',
    region: 'in-mum',
    createdBy: { id: IDS.user, name: 'Priya S' },
    issuedAt: ISO,
    expiresAt: LATER,
    usedAt: null,
    revokedAt: null,
    deniedCount: 0,
    joinUrl: JOIN_URL,
    joinHost: 'localhost:5173',
    ...over,
  };
}

type Call = { url: string; init: RequestInit };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const method = init.method ?? 'GET';
      if (method === 'GET' && url.includes('/api/v1/tokens')) return jsonResponse(200, { items: [], nextCursor: null });
      if (method === 'POST' && url.endsWith('/api/v1/tokens'))
        return jsonResponse(201, { token: token(), compact: COMPACT, joinUrl: JOIN_URL });
      return jsonResponse(404, { error: { code: 'not_found', message: 'nope' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(value: AuthValue = auth) {
  return render(
    <MemoryRouter>
      <StaticAuthProvider value={value}>
        <TokensPage />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
}

describe('token create flow', () => {
  it('creates a timed p1_browser token with the CSRF header and shows the link, QR and short code', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tokens yet/);
    expect(calls[0]!.url).toBe('http://localhost:4000/api/v1/tokens');
    expect(calls[0]!.init.credentials).toBe('include');

    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a support token' });
    const tier = within(dialog).getByLabelText('Package tier') as HTMLSelectElement;
    expect(tier.value).toBe('p1_browser');
    expect((within(dialog).getByRole('option', { name: /P2 Extension/ }) as HTMLOptionElement).disabled).toBe(true);

    await user.click(within(dialog).getByLabelText(/^Timed/));
    const lifetime = within(dialog).getByLabelText('Lifetime (minutes)') as HTMLInputElement;
    expect(lifetime.value).toBe('60');
    await user.clear(lifetime);
    await user.type(lifetime, '90');
    await user.type(within(dialog).getByLabelText('Label (optional)'), 'Ticket 42');
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));

    const success = await screen.findByRole('dialog', { name: 'Share this token with the Desk' });
    const post = calls.find((c) => c.init.method === 'POST')!;
    expect(post.url).toBe('http://localhost:4000/api/v1/tokens');
    expect(post.init.credentials).toBe('include');
    expect((post.init.headers as Record<string, string>)['X-Requested-With']).toBe('IndiansAssist');
    expect(JSON.parse(post.init.body as string)).toEqual({ tier: 'p1_browser', typ: 'timed', ttlMinutes: 90, label: 'Ticket 42' });

    expect(within(success).getByTestId('short-code').textContent).toBe('4821 9365 7710');
    expect(within(success).getByText('Valid on localhost:5173')).toBeTruthy();
    expect((within(success).getByLabelText('Join link') as HTMLInputElement).value).toBe(JOIN_URL);
    expect(within(success).getByRole('img', { name: 'QR code of the join link' })).toBeTruthy();
    expect(within(success).getByRole('button', { name: 'Copy link' })).toBeTruthy();

    await user.click(within(success).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = screen.getByText('Ticket 42').closest('tr')!;
    expect(within(row).getByText('active')).toBeTruthy();
    expect(within(row).getByText('4821 9365 7710')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });

  it('blocks a lifetime above the type maximum before calling the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog');
    const lifetime = within(dialog).getByLabelText('Lifetime (minutes)') as HTMLInputElement;
    expect(lifetime.value).toBe('15');
    await user.clear(lifetime);
    await user.type(lifetime, '61');
    expect(within(dialog).getByText('Enter 1 to 60 minutes.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Create token' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.init.method === 'POST')).toBe(false);
  });

  it('offers the device limit for an enrollment token only, checks it against the shared limit, and sends it (section 2.1)', async () => {
    const user = userEvent.setup();
    renderPage(p4Auth);
    await screen.findByText(/No tokens yet/);
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a support token' });
    const label = 'Devices this token may enroll';
    // An attended token has no device limit, and the enrollment type is not even offered below p4_installed.
    expect(within(dialog).queryByLabelText(label)).toBeNull();
    expect(within(dialog).queryByLabelText(/^Enrollment/)).toBeNull();

    await user.selectOptions(within(dialog).getByLabelText('Package tier'), 'p4_installed');
    await user.click(within(dialog).getByLabelText(/^Enrollment/));
    const field = within(dialog).getByLabelText(label) as HTMLInputElement;
    expect(field.value).toBe('1');

    // Out of range is caught in the browser, before any call: the shared LIMITS.enrollMaxDevices is 10000.
    await user.clear(field);
    await user.type(field, '10001');
    expect(within(dialog).getByText('Enter 1 to 10000 devices.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Create token' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(field);
    expect((within(dialog).getByRole('button', { name: 'Create token' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.init.method === 'POST')).toBe(false);

    await user.type(field, '250');
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    const post = await waitFor(() => calls.find((c) => c.init.method === 'POST')!);
    expect(JSON.parse(post.init.body as string)).toEqual({ tier: 'p4_installed', typ: 'enrollment', ttlDays: 7, maxDevices: 250 });
  });

  it('never sends a device limit with an attended token (the server refuses it there)', async () => {
    const user = userEvent.setup();
    renderPage(p4Auth);
    await screen.findByText(/No tokens yet/);
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a support token' });
    await user.selectOptions(within(dialog).getByLabelText('Package tier'), 'p4_installed');
    await user.click(within(dialog).getByLabelText(/^Enrollment/));
    await user.clear(within(dialog).getByLabelText('Devices this token may enroll'));
    await user.type(within(dialog).getByLabelText('Devices this token may enroll'), '40');
    // Back to an attended type: the field goes away and its value is not sent.
    await user.click(within(dialog).getByLabelText(/^One time/));
    expect(within(dialog).queryByLabelText('Devices this token may enroll')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    const post = await waitFor(() => calls.find((c) => c.init.method === 'POST')!);
    expect(JSON.parse(post.init.body as string)).toEqual({ tier: 'p4_installed', typ: 'one_time', ttlMinutes: 15 });
  });

  it('shows the API error inline when creation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) =>
        init.method === 'POST'
          ? jsonResponse(400, { error: { code: 'tier_not_licensed', message: 'Your seat does not cover this tier' } })
          : jsonResponse(200, { items: [], nextCursor: null }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Your seat does not cover this tier');
  });
});
