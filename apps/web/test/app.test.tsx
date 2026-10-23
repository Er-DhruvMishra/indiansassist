/** Routing and auth: only a 401 from /auth/me redirects to /login; Desk routes never call /auth/me. */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { jsonResponse } from './fakes';

let urls: string[];
let meStatus: number;

beforeEach(() => {
  urls = [];
  meStatus = 401;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/auth/me'))
        return meStatus === 401
          ? jsonResponse(401, { error: { code: 'unauthenticated', message: 'no' } })
          : jsonResponse(500, { error: { code: 'internal', message: 'boom' } });
      return jsonResponse(404, { error: { code: 'not_found', message: 'no' } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('App routes', () => {
  it('redirects /app to /login after a 401 from /auth/me', async () => {
    render(
      <MemoryRouter initialEntries={['/app/tokens']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Sign in to the Assist console' })).toBeTruthy();
  });

  it('shows Retry instead of redirecting on other /auth/me failures', async () => {
    meStatus = 500;
    render(
      <MemoryRouter initialEntries={['/app']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Could not reach the server' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('the Desk join page never calls the authenticated API', async () => {
    render(
      <MemoryRouter initialEntries={['/join']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('Paste your support code or link')).toBeTruthy();
    expect(urls.some((u) => u.includes('/auth/me'))).toBe(false);
  });

  it('signup defaults to India with the residency note', async () => {
    render(
      <MemoryRouter initialEntries={['/signup']}>
        <App />
      </MemoryRouter>,
    );
    const region = (await screen.findByLabelText('Data region')) as HTMLSelectElement;
    expect(region.value).toBe('in-mum');
    expect(screen.getByText(/Your data never leaves this region and this cannot be changed later/)).toBeTruthy();
  });
});
