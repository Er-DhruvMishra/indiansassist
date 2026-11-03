/**
 * Phase F section 5 in the console (docs/specs/phase-f-contracts.md 5.2d, 5.6, 5.7, 13.4): the erasure page (request
 * with the typed slug, the single-admin offer, "Sign in again" on `reauth_required`, the once-shown confirmation link,
 * approval by a second admin, confirmation from the `#confirm=` fragment, Cancel, the live region, auditor read-only),
 * the banner (the notice for every role, Cancel for org_admins, nothing when no erasure is open) and the residency
 * line (states, the Phase E fallback, the 12 mm print budget). fetch is stubbed per route; no network.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgErasure, UserRole } from '@indiansassist/shared';
import { RequireAuth, StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { ErasureBanner } from '../src/assist/erasure/ErasureBanner';
import { ErasurePage } from '../src/assist/erasure/ErasurePage';
import { RESIDENCY_ERASURE_PRINT_CSS, ResidencyErasure } from '../src/assist/erasure/ResidencyErasure';
import { RESIDENCY_PRINT_CSS } from '../src/assist/ResidencyPage';
import { IDS, ISO, jsonResponse } from './fakes';

type Handler = (body: unknown) => Response | Promise<Response>;
const calls: { method: string; path: string; body: unknown }[] = [];
const ERASURE_ID = '7c2d4e6f-8a9b-4c0d-9e1f-2a3b4c5d6e7f';
const OTHER = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';

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
  globalThis.history.replaceState(null, '', '/');
});

function auth(role: UserRole, userId: string = IDS.user, logout: () => Promise<void> = async () => undefined): AuthValue {
  return {
    status: 'authenticated',
    me: {
      user: { id: userId, orgId: IDS.org, email: 'admin@example.test', name: 'Asha', role, status: 'active', createdAt: ISO } as never,
      org: { id: IDS.org, name: 'Acme Synthetic', slug: 'acme-synthetic' } as never,
      seat: null,
    },
    error: null,
    setMe: () => undefined,
    refresh: () => undefined,
    logout,
  };
}

function erasure(over: Partial<OrgErasure> = {}): OrgErasure {
  return {
    id: ERASURE_ID,
    state: 'pending_approval',
    requestedBy: { id: OTHER, name: 'Ravi' },
    requestedAt: ISO,
    approvedBy: null,
    approvedAt: null,
    coolingOffUntil: null,
    cancelledBy: null,
    cancelledAt: null,
    executedAt: null,
    completedAt: null,
    certificateUrl: `https://api.example.test/api/v1/erasures/${ERASURE_ID}/certificate`,
    ...over,
  };
}

function renderPage(role: UserRole = 'org_admin', userId?: string, logout?: () => Promise<void>) {
  return render(
    <StaticAuthProvider value={auth(role, userId, logout)}>
      <MemoryRouter>
        <ErasurePage />
      </MemoryRouter>
    </StaticAuthProvider>,
  );
}

describe('ErasurePage', () => {
  it('requests with the typed slug; the button stays disabled until the slug matches', async () => {
    let current: OrgErasure | null = null;
    route({
      'GET /orgs/current/erasure': () => jsonResponse(200, { erasure: current }),
      'POST /orgs/current/erasure': () => {
        current = erasure({ requestedBy: { id: IDS.user, name: 'Asha' } });
        return jsonResponse(201, { erasure: current });
      },
    });
    renderPage();
    const form = await screen.findByRole('form', { name: 'Request erasure' });
    const button = within(form).getByRole('button', { name: 'Request erasure' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(form).getByLabelText('Type the organisation slug to confirm'), 'acme-synthetic');
    await userEvent.type(within(form).getByLabelText(/Reason/), 'Closing down');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(button);
    await screen.findByText('Another administrator must approve it. They can approve on this page.');
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ confirmSlug: 'acme-synthetic', reason: 'Closing down' });
    expect(screen.getByTestId('erasure-state').getAttribute('data-state')).toBe('pending_approval');
    expect(screen.getByTestId('erasure-live').textContent).toContain("waiting for a second administrator's approval");
    expect(screen.getByRole('button', { name: 'Cancel the erasure' })).toBeTruthy();
  });

  it('offers the single-admin path, and shows a log-driver confirmation link once', async () => {
    let n = 0;
    route({
      'GET /orgs/current/erasure': () => jsonResponse(200, { erasure: n === 0 ? null : erasure({ state: 'pending_confirmation', requestedBy: { id: IDS.user, name: 'Asha' } }) }),
      'POST /orgs/current/erasure': (body) => {
        if (!(body as { solo?: boolean }).solo) return jsonResponse(409, { error: { code: 'erasure_second_admin', message: 'x', details: { soloAvailable: true } } });
        n++;
        return jsonResponse(201, {
          erasure: erasure({ state: 'pending_confirmation', requestedBy: { id: IDS.user, name: 'Asha' } }),
          confirmUrl: `http://localhost:5305/app/settings/erasure#confirm=${'A'.repeat(43)}`,
        });
      },
    });
    renderPage();
    const form = await screen.findByRole('form', { name: 'Request erasure' });
    await userEvent.type(within(form).getByLabelText('Type the organisation slug to confirm'), 'acme-synthetic');
    await userEvent.click(within(form).getByRole('button', { name: 'Request erasure' }));
    await screen.findByText(/You are the only administrator/);
    await userEvent.click(screen.getByRole('button', { name: 'Request erasure as the only administrator' }));
    await screen.findByText(/shown here once and never again/);
    expect(screen.getByRole('link', { name: /#confirm=A{43}/ })).toBeTruthy();
    expect((calls.filter((c) => c.method === 'POST')[1]!.body as { solo?: boolean }).solo).toBe(true);
  });

  it('reauth_required asks to sign in again (logout, then /login)', async () => {
    const logout = vi.fn(async () => undefined);
    route({
      'GET /orgs/current/erasure': () => jsonResponse(200, { erasure: erasure() }),
      'POST /orgs/current/erasure/7c2d4e6f-8a9b-4c0d-9e1f-2a3b4c5d6e7f/approve': () => jsonResponse(401, { error: { code: 'reauth_required', message: 'x' } }),
    });
    renderPage('org_admin', IDS.user, logout);
    const form = await screen.findByRole('form', { name: 'Approve the erasure' });
    await userEvent.type(within(form).getByLabelText('Type the organisation slug to confirm'), 'acme-synthetic');
    await userEvent.click(within(form).getByRole('button', { name: 'Approve the erasure' }));
    await screen.findByText(/needs a sign-in from the last 15 minutes/);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(logout).toHaveBeenCalled();
  });

  it('a second admin approves; the state change is announced; a cooling-off date and the certificate link show', async () => {
    let state: OrgErasure = erasure();
    route({
      'GET /orgs/current/erasure': () => jsonResponse(200, { erasure: state }),
      [`POST /orgs/current/erasure/${ERASURE_ID}/approve`]: () => {
        state = erasure({ state: 'cooling_off', approvedBy: { id: IDS.user, name: 'Asha' }, approvedAt: ISO, coolingOffUntil: '2026-10-30T10:15:30.123Z' });
        return jsonResponse(200, { erasure: state });
      },
    });
    renderPage();
    const form = await screen.findByRole('form', { name: 'Approve the erasure' });
    await userEvent.type(within(form).getByLabelText('Type the organisation slug to confirm'), 'acme-synthetic');
    await userEvent.click(within(form).getByRole('button', { name: 'Approve the erasure' }));
    await waitFor(() => expect(screen.getByTestId('erasure-state').getAttribute('data-state')).toBe('cooling_off'));
    expect(screen.getByTestId('erasure-live').textContent).toBe('The erasure is now scheduled; it can still be cancelled.');
    expect(screen.getByText(/Approved by a second administrator/).parentElement!.textContent).toContain('by Asha');
    expect(screen.getByRole('link', { name: /erasures\/7c2d4e6f/ })).toBeTruthy();
  });

  it('the requester confirms from the #confirm= fragment, which leaves the address bar at once', async () => {
    const token = 'b'.repeat(43);
    globalThis.history.replaceState(null, '', `/app/settings/erasure#confirm=${token}`);
    let state = erasure({ state: 'pending_confirmation', requestedBy: { id: IDS.user, name: 'Asha' } });
    route({
      'GET /orgs/current/erasure': () => jsonResponse(200, { erasure: state }),
      [`POST /orgs/current/erasure/${ERASURE_ID}/confirm`]: () => {
        state = erasure({ state: 'cooling_off', requestedBy: { id: IDS.user, name: 'Asha' }, approvedAt: ISO, coolingOffUntil: '2026-11-06T10:15:30.123Z' });
        return jsonResponse(200, { erasure: state });
      },
    });
    renderPage();
    expect(globalThis.location.hash).toBe('');
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm the erasure' }));
    await waitFor(() => expect(screen.getByTestId('erasure-state').getAttribute('data-state')).toBe('cooling_off'));
    expect(calls.find((c) => c.path.endsWith('/confirm'))!.body).toEqual({ token });
    expect(sessionStorage.getItem('ia.erasure.confirm')).toBeNull();
    expect(screen.getByText(/Confirmed from the mailed link/)).toBeTruthy();
  });

  it('an auditor reads the state and the steps but has no control', async () => {
    route({ 'GET /orgs/current/erasure': () => jsonResponse(200, { erasure: erasure({ state: 'cooling_off', approvedBy: { id: IDS.user, name: 'Asha' }, approvedAt: ISO, coolingOffUntil: ISO }) }) });
    renderPage('auditor');
    await screen.findByTestId('erasure-state');
    expect(screen.queryByRole('button', { name: 'Cancel the erasure' })).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download the audit export' })).toBeTruthy();
  });

  it('says so while the erasure runs (409 org_erasing)', async () => {
    route({ 'GET /orgs/current/erasure': () => jsonResponse(409, { error: { code: 'org_erasing', message: 'x' } }) });
    renderPage();
    await screen.findByText(/being erased now/);
  });
});

describe('RequireAuth keeps the #confirm= fragment through sign-in (5.6)', () => {
  function LoginProbe() {
    const location = useLocation();
    return <p>from={(location.state as { from?: string } | null)?.from ?? ''}</p>;
  }

  it('redirects an anonymous visitor to /login with the path and the fragment', () => {
    const token = 'C'.repeat(43);
    const anonymous: AuthValue = { ...auth('org_admin'), status: 'anonymous', me: null };
    render(
      <StaticAuthProvider value={anonymous}>
        <MemoryRouter initialEntries={[`/app/settings/erasure#confirm=${token}`]}>
          <Routes>
            <Route path="/login" element={<LoginProbe />} />
            <Route
              path="/app/settings/erasure"
              element={
                <RequireAuth>
                  <p>erasure page</p>
                </RequireAuth>
              }
            />
          </Routes>
        </MemoryRouter>
      </StaticAuthProvider>,
    );
    expect(screen.getByText(`from=/app/settings/erasure#confirm=${token}`)).toBeTruthy();
    expect(screen.queryByText('erasure page')).toBeNull();
  });
});

describe('ErasureBanner', () => {
  const renderBanner = (role: UserRole) =>
    render(
      <MemoryRouter>
        <ErasureBanner role={role} />
      </MemoryRouter>,
    );

  it('shows the notice to every role, without names; no Cancel for a technician', async () => {
    route({ 'GET /orgs/current/erasure': () => jsonResponse(200, { notice: { state: 'cooling_off', coolingOffUntil: '2026-10-30T10:15:30.123Z', certificateUrl: 'https://api.example.test/c' } }) });
    renderBanner('technician');
    const b = await screen.findByTestId('erasure-banner');
    expect(b.textContent).toContain('scheduled for permanent erasure');
    expect(b.textContent).toContain('It runs on 30 October 2026');
    expect(within(b).getByRole('link', { name: 'https://api.example.test/c' })).toBeTruthy();
    expect(within(b).queryByRole('button')).toBeNull();
    expect(within(b).queryByRole('link', { name: 'Erasure details' })).toBeNull();
  });

  it('an org_admin can cancel from it; nothing renders once no erasure is open', async () => {
    let open = true;
    route({
      'GET /orgs/current/erasure': () => jsonResponse(200, { erasure: open ? erasure() : erasure({ state: 'cancelled' }) }),
      [`POST /orgs/current/erasure/${ERASURE_ID}/cancel`]: () => {
        open = false;
        return jsonResponse(200, { erasure: erasure({ state: 'cancelled' }) });
      },
    });
    renderBanner('org_admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel the erasure' }));
    await waitFor(() => expect(screen.queryByTestId('erasure-banner')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('The erasure was cancelled.');
  });

  it('renders nothing without an open erasure', async () => {
    route({ 'GET /orgs/current/erasure': () => jsonResponse(200, { notice: null }) });
    const { container } = renderBanner('observer');
    await waitFor(() => expect(calls.length).toBe(1));
    expect(container.innerHTML).toBe('');
  });
});

describe('ResidencyErasure (5.7, 3.2b2)', () => {
  const note =
    "Erasure destroys this organisation's personal data and the audit pepper after two administrators approve it and a 7-day cooling-off period (an organisation with a single administrator: a mailed confirmation and a 14-day cooling-off period). Technician display names and typed reasons stay in the audit chain.";

  it('shows available, the state and date of an open erasure, and the note', () => {
    render(
      <dl>
        <ResidencyErasure erasure={{ available: true, state: 'cooling_off', scheduledFor: '2026-10-30T10:15:00.000Z', note }} />
      </dl>,
    );
    const row = screen.getByTestId('residency-erasure');
    expect(row.querySelector('dt')!.textContent).toBe('Erasure');
    expect(row.textContent).toContain('Available approved and scheduled, for 30 Oct 2026');
    expect(row.textContent).toContain(note);
  });

  it('no open erasure; and the Phase E line for an older server', () => {
    render(
      <dl>
        <ResidencyErasure erasure={{ available: true, state: 'none', scheduledFor: null, note }} />
        <ResidencyErasure erasure={{ available: false, note: 'not implemented' }} />
      </dl>,
    );
    const rows = screen.getAllByTestId('residency-erasure');
    expect(rows[0]!.textContent).toContain('Available no erasure is open.');
    expect(rows[1]!.querySelector('dd')!.textContent).toBe('Not available not implemented');
  });

  it('keeps the fixed 12 mm print budget: one 4 mm line plus a note of at most 6.4 mm', () => {
    expect(RESIDENCY_PRINT_CSS).toContain(RESIDENCY_ERASURE_PRINT_CSS);
    expect(RESIDENCY_ERASURE_PRINT_CSS).toContain('height: 12mm !important');
    expect(RESIDENCY_ERASURE_PRINT_CSS).toContain('overflow: hidden !important');
    const line = Number(/rr-erasure \* \{ font-size: 8pt !important; line-height: ([\d.]+)mm/.exec(RESIDENCY_ERASURE_PRINT_CSS)![1]);
    const noteMax = Number(/rr-erasure-note \{[^}]*max-height: ([\d.]+)mm/.exec(RESIDENCY_ERASURE_PRINT_CSS)![1]);
    expect(line + noteMax).toBeLessThanOrEqual(12);
  });
});
