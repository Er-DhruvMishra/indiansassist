/**
 * AGPL-3.0-only section 13: every user of the web app over a network is offered the source. The console shell, the
 * Desk pages and the public pages each carry one "Source code" link to the repository, opening in a new tab so a live
 * session is never navigated away from.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthResponse } from '@indiansassist/shared';
import { AppShell } from '../src/assist/AppShell';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { DEFAULT_SOURCE_URL, SOURCE_URL } from '../src/config';
import { DeskLayout } from '../src/desk/DeskLayout';
import { PublicLayout } from '../src/pages/PublicLayout';
import { IDS, ISO, jsonResponse } from './fakes';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(404, { error: { code: 'not_found', message: 'no' } })),
  );
});
afterEach(() => vi.unstubAllGlobals());

function expectSourceLink() {
  const link = screen.getByRole('link', { name: /^Source code/ }) as HTMLAnchorElement;
  expect(link.href).toBe(`${DEFAULT_SOURCE_URL}`);
  expect(link.target).toBe('_blank');
  expect(link.rel).toContain('noopener');
  expect(link.rel).toContain('noreferrer');
  expect(link.closest('footer')).not.toBeNull();
  expect(screen.getAllByTestId('source-link')).toHaveLength(1);
}

describe('the AGPL section 13 source link', () => {
  it('defaults to the public repository', () => {
    expect(DEFAULT_SOURCE_URL).toBe('https://github.com/Er-DhruvMishra/indiansassist');
    expect(SOURCE_URL).toBe(DEFAULT_SOURCE_URL);
  });

  it('is in the footer of every Desk page', () => {
    render(
      <DeskLayout>
        <p>join</p>
      </DeskLayout>,
    );
    expectSourceLink();
    expect(screen.getByText(/cannot control your mouse or keyboard/)).toBeTruthy();
  });

  it('is in the footer of the public pages, beside their own footer', () => {
    render(
      <MemoryRouter>
        <PublicLayout title="Sign in" footer={<span>No account yet?</span>}>
          <p>form</p>
        </PublicLayout>
      </MemoryRouter>,
    );
    expectSourceLink();
    expect(screen.getByText('No account yet?')).toBeTruthy();
  });

  it('is in the footer of the Assist console', () => {
    const me = {
      user: {
        id: IDS.user,
        orgId: IDS.org,
        email: 'auditor@acme.test',
        name: 'Asha R',
        role: 'auditor',
        status: 'active',
        createdAt: ISO,
        lastLoginAt: ISO,
      },
      org: {
        id: IDS.org,
        name: 'Acme IT',
        slug: 'acme',
        dataRegion: 'in-mum',
        planTier: 'p1_browser',
        branding: {},
        createdAt: ISO,
      },
      seat: null,
    } as AuthResponse;
    const auth: AuthValue = {
      status: 'authenticated',
      me,
      error: null,
      setMe: () => undefined,
      refresh: () => undefined,
      logout: async () => undefined,
    };
    render(
      <StaticAuthProvider value={auth}>
        <MemoryRouter initialEntries={['/app']}>
          <Routes>
            <Route path="/app" element={<AppShell />}>
              <Route index element={<p>dashboard</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </StaticAuthProvider>,
    );
    expect(screen.getByText('dashboard')).toBeTruthy();
    expectSourceLink();
  });
});
