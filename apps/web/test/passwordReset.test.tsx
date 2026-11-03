/**
 * Phase F section 15.3 (stream mail), web: the login page's "Forgot your password?" link driven by
 * `GET /auth/options`, and the /reset page: the request form with its one neutral sentence, and the confirm form read
 * from the `#t=` fragment, which the page removes from the address bar. fetch is stubbed per route; no network.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { LoginPage } from '../src/pages/LoginPage';
import { PasswordResetPage, REQUEST_SENT_TEXT } from '../src/pages/PasswordResetPage';
import { jsonResponse } from './fakes';

type Handler = (body: unknown) => Response | Promise<Response>;
const calls: { method: string; path: string; body: unknown }[] = [];
const TOKEN = 'Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

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

const ON = { 'GET /auth/options': () => jsonResponse(200, { passwordReset: true, inviteMail: true }) };
const OFF = { 'GET /auth/options': () => jsonResponse(200, { passwordReset: false, inviteMail: false }) };

const anon: AuthValue = { status: 'anonymous', me: null, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };

function renderAt(path: string) {
  return render(
    <StaticAuthProvider value={anon}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/reset" element={<PasswordResetPage />} />
        </Routes>
      </MemoryRouter>
    </StaticAuthProvider>,
  );
}

beforeEach(() => {
  globalThis.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe('login page link (rule 4.1c)', () => {
  it('shows "Forgot your password?" only when the server offers password reset', async () => {
    route(ON);
    renderAt('/login');
    const link = await screen.findByRole('link', { name: 'Forgot your password?' });
    expect(link.getAttribute('href')).toBe('/reset');
  });

  it('hides it when reset is off, and when the options cannot be read', async () => {
    route(OFF);
    const { unmount } = renderAt('/login');
    await waitFor(() => expect(calls.some((c) => c.path === '/auth/options')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('link', { name: 'Forgot your password?' })).toBeNull();
    unmount();
    route({});
    renderAt('/login');
    await waitFor(() => expect(calls.filter((c) => c.path === '/auth/options')).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('link', { name: 'Forgot your password?' })).toBeNull();
  });
});

describe('/reset request form', () => {
  it('posts the address and always ends with the same neutral sentence, focused', async () => {
    route({ ...ON, 'POST /auth/password-reset/request': () => jsonResponse(202, {}) });
    renderAt('/reset');
    await userEvent.type(await screen.findByLabelText('Email'), 'someone@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    const done = await screen.findByText(REQUEST_SENT_TEXT);
    expect(REQUEST_SENT_TEXT).toBe('If an account exists for that address, we sent a link to it.');
    expect(done.getAttribute('role')).toBe('status');
    await waitFor(() => expect(document.activeElement).toBe(done));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ email: 'someone@example.test' });
  });

  it('works from the keyboard alone', async () => {
    route({ ...ON, 'POST /auth/password-reset/request': () => jsonResponse(202, {}) });
    renderAt('/reset');
    const email = await screen.findByLabelText('Email');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send reset link' }) as HTMLButtonElement).disabled).toBe(false));
    // The layout's home link comes first; the email field is reached by Tab alone.
    for (let i = 0; i < 5 && document.activeElement !== email; i += 1) await userEvent.tab();
    expect(document.activeElement).toBe(email);
    await userEvent.keyboard('kbd@example.test{Enter}');
    expect(await screen.findByText(REQUEST_SENT_TEXT)).toBeTruthy();
  });

  it('says so plainly when the server cannot send mail', async () => {
    route(OFF);
    renderAt('/reset');
    expect(await screen.findByText(/Password reset by email is not available on this server/)).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });
});

describe('/reset#t=<token> confirm form (rules 4.3d, 4.3e)', () => {
  it('reads the token from the fragment, removes it from the address bar, and sets the password', async () => {
    globalThis.history.replaceState(null, '', `/reset#t=${TOKEN}`);
    route({ ...ON, 'POST /auth/password-reset/confirm': () => new Response(null, { status: 204 }) });
    renderAt('/reset');
    const pw = await screen.findByLabelText('New password');
    await waitFor(() => expect(globalThis.location.hash).toBe(''));
    expect(globalThis.location.href).not.toContain(TOKEN);
    await userEvent.type(pw, 'a long new passphrase');
    await userEvent.type(screen.getByLabelText('Repeat the new password'), 'a different passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('The two passwords do not match.')).toBeTruthy();
    expect(calls.some((c) => c.path === '/auth/password-reset/confirm')).toBe(false);
    await userEvent.clear(screen.getByLabelText('Repeat the new password'));
    await userEvent.type(screen.getByLabelText('Repeat the new password'), 'a long new passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    const done = await screen.findByText(/Your password was changed/);
    await waitFor(() => expect(document.activeElement).toBe(done));
    expect(calls.find((c) => c.path === '/auth/password-reset/confirm')?.body).toEqual({ token: TOKEN, newPassword: 'a long new passphrase' });
    expect(screen.getByRole('link', { name: 'Sign in with your new password' }).getAttribute('href')).toBe('/login');
  });

  it('an invalid link offers the request form with a plain explanation', async () => {
    globalThis.history.replaceState(null, '', `/reset#t=${TOKEN}`);
    route({ ...ON, 'POST /auth/password-reset/confirm': () => jsonResponse(400, { error: { code: 'reset_invalid', message: 'x' } }) });
    renderAt('/reset');
    await userEvent.type(await screen.findByLabelText('New password'), 'a long new passphrase');
    await userEvent.type(screen.getByLabelText('Repeat the new password'), 'a long new passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('This reset link is invalid, expired or was already used. Ask for a new link below.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeTruthy();
  });

  it('an SSO-required account is sent to single sign-on', async () => {
    globalThis.history.replaceState(null, '', `/reset#t=${TOKEN}`);
    const beginUrl = 'http://localhost:4000/api/v1/auth/sso/acme/begin?login_hint=a%40example.test';
    route({ ...ON, 'POST /auth/password-reset/confirm': () => jsonResponse(403, { error: { code: 'sso_required', message: 'x', details: { beginUrl } } }) });
    renderAt('/reset');
    await userEvent.type(await screen.findByLabelText('New password'), 'a long new passphrase');
    await userEvent.type(screen.getByLabelText('Repeat the new password'), 'a long new passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/there is no password to reset/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in with single sign-on' }).getAttribute('href')).toBe(beginUrl);
  });
});
