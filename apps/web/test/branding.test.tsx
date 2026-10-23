/** /app/branding (prd-F3, contracts sections 6.6 and 12): org_admin edits the white label shown to the Desk. */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AuthResponse, Org } from '@indiansassist/shared';
import { BrandingPage, brandingPatch } from '../src/assist/BrandingPage';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { can } from '../src/auth/permissions';
import { IDS, ISO, jsonResponse } from './fakes';

const org: Org = { id: IDS.org, name: 'Acme IT Pvt Ltd', slug: 'acme-it', dataRegion: 'in-mum', planTier: 'p1_browser', branding: { displayName: 'Acme IT' }, createdAt: ISO };
const me: AuthResponse = {
  user: { id: IDS.user, orgId: IDS.org, email: 'admin@acme.test', name: 'Asha', role: 'org_admin', status: 'active', createdAt: ISO, lastLoginAt: ISO },
  org,
  seat: null,
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let patches: unknown[];
let setMe: Mock<(me: AuthResponse | null) => void>;

beforeEach(() => {
  patches = [];
  setMe = vi.fn<(me: AuthResponse | null) => void>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method === 'PATCH' && url.endsWith('/api/v1/orgs/current/branding')) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push(body);
        return jsonResponse(200, { ...org, branding: { ...org.branding, ...body } });
      }
      return jsonResponse(404, { error: { code: 'not_found', message: 'nope' } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const auth: AuthValue = { status: 'authenticated', me, error: null, setMe, refresh: () => {}, logout: async () => {} };
  return render(
    <MemoryRouter>
      <StaticAuthProvider value={auth}>
        <BrandingPage />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
}

describe('branding page', () => {
  it('is an org_admin capability only', () => {
    expect(can('org_admin', 'branding')).toBe(true);
    for (const r of ['technician', 'senior_technician', 'auditor', 'observer'] as const) expect(can(r, 'branding')).toBe(false);
  });

  it('saves display name, accent and a PNG logo as a data: URL, then refreshes the org', async () => {
    const user = userEvent.setup();
    renderPage();
    const name = screen.getByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Acme Support');
    await user.type(screen.getByLabelText('Accent colour'), '#1d4ed8');
    await user.upload(screen.getByLabelText('Logo (PNG or JPEG)'), new File([PNG], 'logo.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByTestId('branding-preview').querySelector('img')).toBeTruthy());
    expect((screen.getByTestId('branding-preview') as HTMLElement).style.borderTopColor).toBe('rgb(29, 78, 216)');
    await user.click(screen.getByRole('button', { name: 'Save branding' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    const patch = patches[0] as Record<string, string>;
    expect(patch.displayName).toBe('Acme Support');
    expect(patch.accentColor).toBe('#1d4ed8');
    expect(patch.logoData).toMatch(/^data:image\/png;base64,/);
    expect(patch).not.toHaveProperty('supportEmail');
    await waitFor(() => expect(setMe).toHaveBeenCalledTimes(1));
    expect((setMe.mock.calls[0]![0] as AuthResponse).org.branding.displayName).toBe('Acme Support');
    expect(await screen.findByText(/Branding saved/)).toBeTruthy();
  });

  it('rejects a non-image logo and warns when the accent fails contrast', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    await user.upload(screen.getByLabelText('Logo (PNG or JPEG)'), new File(['GIF89a'], 'logo.gif', { type: 'image/gif' }));
    expect(await screen.findByText('Use a PNG or JPEG image.')).toBeTruthy();
    await user.type(screen.getByLabelText('Accent colour'), '#ffff00');
    expect(screen.getByText(/so Desk pages will use the default colour/)).toBeTruthy();
    await user.clear(screen.getByLabelText('Accent colour'));
    await user.type(screen.getByLabelText('Accent colour'), 'teal');
    await user.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(screen.getByText('Use the form #rrggbb.')).toBeTruthy();
    expect(patches).toHaveLength(0);
  });

  it('sends only changed fields and null for a cleared one', () => {
    expect(brandingPatch({ displayName: 'Acme IT' }, { displayName: '', supportEmail: '', accentColor: '', logoData: null })).toEqual({ displayName: null });
    expect(brandingPatch({ logoData: 'data:image/png;base64,AAAA' }, { displayName: '', supportEmail: '', accentColor: '', logoData: null })).toEqual({ logoData: null });
    expect(brandingPatch({}, { displayName: '', supportEmail: '', accentColor: '', logoData: null })).toEqual({});
  });
});
