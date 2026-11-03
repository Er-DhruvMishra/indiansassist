/**
 * Phase F section 15.3 (stream mail), web: the users page's invitation by email (the checkbox, the `sendEmail` field
 * and the three outcomes in words), "Invitation emailed <date>" and "Resend invitation". fetch is stubbed per route.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { UsersPage } from '../src/assist/UsersPage';
import { IDS, ISO, jsonResponse } from './fakes';

type Handler = (body: unknown) => Response | Promise<Response>;
const calls: { method: string; path: string; body: unknown }[] = [];
const INVITED = '66666666-6666-4666-8666-666666666666';

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
    me: { user: { id: IDS.user, orgId: IDS.org, email: 'admin@example.test', name: 'Asha', role, status: 'active', createdAt: ISO } as never, org: {} as never, seat: null },
    error: null,
    setMe: () => undefined,
    refresh: () => undefined,
    logout: async () => undefined,
  };
}

const user = (over: Record<string, unknown>) => ({
  orgId: IDS.org,
  role: 'technician',
  createdAt: ISO,
  lastLoginAt: null,
  inviteMailedAt: null,
  seat: null,
  ...over,
});

const LIST = () =>
  jsonResponse(200, {
    items: [
      user({ id: IDS.user, email: 'admin@example.test', name: 'Asha', role: 'org_admin', status: 'active' }),
      user({ id: INVITED, email: 'ravi@example.test', name: 'Ravi', status: 'invited', inviteMailedAt: '2026-11-01T09:30:00.000Z' }),
    ],
    nextCursor: null,
  });

const inviteReply = (mailed: boolean) => () =>
  jsonResponse(201, { user: user({ id: IDS.other, email: 'new@example.test', name: 'New', status: 'invited' }), inviteUrl: 'http://localhost:5173/invite#i=SECRET', mailed });

function renderPage(role: UserRole = 'org_admin') {
  return render(
    <StaticAuthProvider value={auth(role)}>
      <MemoryRouter>
        <UsersPage />
      </MemoryRouter>
    </StaticAuthProvider>,
  );
}

async function fillInvite() {
  await userEvent.type(screen.getByLabelText('Email'), 'new@example.test');
  await userEvent.type(screen.getByLabelText('Name'), 'New');
}

describe('invite by email', () => {
  it('emails by default and says so', async () => {
    route({ 'GET /auth/options': () => jsonResponse(200, { passwordReset: true, inviteMail: true }), 'GET /users': LIST, 'POST /users/invite': inviteReply(true) });
    renderPage();
    const box = (await screen.findByLabelText('Email the invitation to this address')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await fillInvite();
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByText(/It was emailed to new@example\.test/)).toBeTruthy();
    expect(screen.getByText('http://localhost:5173/invite#i=SECRET')).toBeTruthy();
    expect(calls.find((c) => c.path === '/users/invite')?.body).toEqual({ email: 'new@example.test', name: 'New', role: 'technician', tier: 'p1_browser', sendEmail: true });
  });

  it('unticked: sendEmail false and "No email was sent"; a failed send is reported in words', async () => {
    route({ 'GET /auth/options': () => jsonResponse(200, { passwordReset: true, inviteMail: true }), 'GET /users': LIST, 'POST /users/invite': inviteReply(false) });
    renderPage();
    await userEvent.click(await screen.findByLabelText('Email the invitation to this address'));
    await fillInvite();
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByText(/No email was sent/)).toBeTruthy();
    expect((calls.find((c) => c.path === '/users/invite')?.body as { sendEmail: boolean }).sendEmail).toBe(false);
    await userEvent.click(screen.getByLabelText('Email the invitation to this address'));
    await fillInvite();
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByText(/The email to new@example\.test could not be sent/)).toBeTruthy();
  });

  it('without a mail server there is no checkbox and no sendEmail field', async () => {
    route({ 'GET /auth/options': () => jsonResponse(200, { passwordReset: false, inviteMail: false }), 'GET /users': LIST, 'POST /users/invite': inviteReply(false) });
    renderPage();
    await screen.findByText('Ravi');
    await waitFor(() => expect(calls.some((c) => c.path === '/auth/options')).toBe(true));
    expect(screen.queryByLabelText('Email the invitation to this address')).toBeNull();
    await fillInvite();
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByText(/No email was sent/)).toBeTruthy();
    expect(calls.find((c) => c.path === '/users/invite')?.body).not.toHaveProperty('sendEmail');
  });
});

describe('invited users', () => {
  it('shows when the invitation was emailed and resends it with a new link', async () => {
    route({
      'GET /auth/options': () => jsonResponse(200, { passwordReset: true, inviteMail: true }),
      'GET /users': LIST,
      [`POST /users/${INVITED}/invite/resend`]: () =>
        jsonResponse(200, { inviteUrl: 'http://localhost:5173/invite#i=NEWSECRET', mailed: true, inviteExpiresAt: '2026-11-09T09:30:00.000Z' }),
    });
    renderPage();
    const row = (await screen.findByText('Ravi')).closest('tr')!;
    expect(within(row).getByText(/^Invitation emailed /)).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Resend invitation to Ravi' }));
    expect(await screen.findByText(/the earlier link no longer works\. It was emailed to ravi@example\.test/)).toBeTruthy();
    expect(screen.getByText('http://localhost:5173/invite#i=NEWSECRET')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === `/users/${INVITED}/invite/resend`)).toBe(true);
    // The active admin has no resend button.
    const adminRow = screen.getByText('Asha').closest('tr')!;
    expect(within(adminRow).queryByRole('button', { name: /Resend invitation/ })).toBeNull();
  });

  it('a resend error is shown; an auditor sees the date but no button', async () => {
    route({
      'GET /auth/options': () => jsonResponse(200, { passwordReset: true, inviteMail: true }),
      'GET /users': LIST,
      [`POST /users/${INVITED}/invite/resend`]: () => jsonResponse(429, { error: { code: 'rate_limited', message: 'x', details: { retryAfterSec: 60 } } }),
    });
    const { unmount } = renderPage();
    const row = (await screen.findByText('Ravi')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Resend invitation to Ravi' }));
    expect(await screen.findByText('Too many attempts, try again in 60 s.')).toBeTruthy();
    unmount();
    renderPage('auditor');
    const r2 = (await screen.findByText('Ravi')).closest('tr')!;
    expect(within(r2).getByText(/^Invitation emailed /)).toBeTruthy();
    expect(within(r2).queryByRole('button')).toBeNull();
  });
});
