/**
 * The Phase D tokens-page additions (docs/specs/phase-d-contracts.md section 13.4, 12.1): an enrollment token shows
 * `devicesEnrolled / maxDevices` with its warnings, and only an org_admin can take the signed enrollment config
 * (`GET /devices/enroll-config`), the branded installer this server serves (`GET /download/installer`) and the
 * GPO / Intune snippets, which are labelled as secrets.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64urlEncode, utf8Encode, type AuthResponse, type DeviceGroup, type InstallerBuild, type Token, type UserRole } from '@indiansassist/shared';
import { TokensPage } from '../src/assist/tokens/TokensPage';
import { enrollmentUsage, nearExpiry, iaEnrollValue, NEAR_EXPIRY_MS } from '../src/assist/tokens/enroll';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { IDS, ISO, jsonResponse } from './fakes';

const GROUP_ID = '77777777-7777-4777-8777-777777777777';
const ENROLL_TOKEN_ID = '66666666-6666-4666-8666-666666666666';
const IACONFIG = '{"v":1,"apiOrigin":"https://in.example","token":"ia1.aa.bb.cc","groupId":null,"kid":"0123456789abcdef","sig":"sig"}';
const FAR = new Date(Date.now() + 30 * 86_400_000).toISOString();

function auth(role: UserRole): AuthValue {
  const me: AuthResponse = {
    user: { id: IDS.user, orgId: IDS.org, email: 'asha@acme.test', name: 'Asha', role, status: 'active', createdAt: ISO, lastLoginAt: ISO },
    org: { id: IDS.org, name: 'Acme IT Pvt Ltd', slug: 'acme-it', dataRegion: 'in-mum', planTier: 'p4_installed', branding: { displayName: 'Acme IT' }, createdAt: ISO },
    seat: null,
  };
  return { status: 'authenticated', me, error: null, setMe: () => {}, refresh: () => {}, logout: async () => {} };
}

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
    createdBy: { id: IDS.user, name: 'Asha' },
    issuedAt: ISO,
    expiresAt: FAR,
    usedAt: null,
    revokedAt: null,
    deniedCount: 0,
    joinUrl: 'http://localhost:5173/join#t=ia1.aa.bb.cc',
    joinHost: 'localhost:5173',
    ...over,
  };
}

function enrollmentToken(over: Partial<Token> = {}): Token {
  return token({
    id: ENROLL_TOKEN_ID,
    tier: 'p4_installed',
    typ: 'enrollment',
    label: 'Reception rollout',
    maxDevices: 50,
    devicesEnrolled: 12,
    ...over,
  });
}

const group: DeviceGroup = {
  id: GROUP_ID,
  name: 'Reception',
  description: null,
  defaultPolicy: {},
  defaultTags: ['reception'],
  notifyEmail: null,
  createdAt: ISO,
  updatedAt: ISO,
};

function build(over: Partial<InstallerBuild> = {}): InstallerBuild {
  return { arch: 'x64', version: '0.4.0', size: 9_000_000, sha256: 'a'.repeat(64), signed: true, minOs: '10.0.17763', ...over };
}

type Call = { url: string; init: RequestInit };
let calls: Call[];
let tokens: Token[];
/** What `GET /download/installer` answers; a node that serves no MSI answers `builds: []` (the default here). */
let installerBuilds: InstallerBuild[];

beforeEach(() => {
  calls = [];
  tokens = [enrollmentToken()];
  installerBuilds = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes('/api/v1/download/installer')) return jsonResponse(200, { v: 1, builds: installerBuilds });
      if (url.includes('/api/v1/devices/enroll-config')) return jsonResponse(200, { iaconfig: IACONFIG });
      if (url.includes('/api/v1/orgs/current/device-groups')) return jsonResponse(200, { items: [group] });
      if (url.includes('/api/v1/tokens')) return jsonResponse(200, { items: tokens, nextCursor: null });
      return jsonResponse(404, { error: { code: 'not_found', message: 'nope' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(role: UserRole = 'org_admin') {
  return render(
    <MemoryRouter>
      <StaticAuthProvider value={auth(role)}>
        <TokensPage />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
}

const enrollRow = async () => (await screen.findByText('Reception rollout')).closest('tr')!;

describe('tokens page: enrollment tokens (section 13.4)', () => {
  it('shows devicesEnrolled / maxDevices on an enrollment token and nothing on an attended one', async () => {
    tokens = [enrollmentToken(), token()];
    renderPage();
    const row = await enrollRow();
    expect(within(row).getByTestId('devices-enrolled').textContent).toBe('12 / 50 devices enrolled');
    const attended = screen.getByText('Ticket 42').closest('tr')!;
    expect(within(attended).queryByTestId('devices-enrolled')).toBeNull();
  });

  it('warns as the device limit fills, when it is spent, and when the token nears expiry', async () => {
    tokens = [
      enrollmentToken({ devicesEnrolled: 45 }),
      enrollmentToken({ id: IDS.other, label: 'Spent wave', devicesEnrolled: 50 }),
      enrollmentToken({ id: IDS.session, label: 'Last wave', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ];
    renderPage();
    const row = await enrollRow();
    expect(within(row).getByText('5 left')).toBeTruthy();

    const spent = screen.getByText('Spent wave').closest('tr')!;
    expect(within(spent).getByTestId('devices-enrolled').textContent).toBe('50 / 50 devices enrolled');
    expect(within(spent).getByText('Device limit reached')).toBeTruthy();

    const last = screen.getByText('Last wave').closest('tr')!;
    expect(within(last).getByText('Expires soon')).toBeTruthy();
    expect(within(row).queryByText('Expires soon')).toBeNull();
  });

  it('offers "Install and enroll" to an org_admin only', async () => {
    renderPage('org_admin');
    expect(within(await enrollRow()).getByRole('button', { name: 'Install and enroll' })).toBeTruthy();
  });

  it.each(['technician', 'senior_technician', 'auditor'] as const)('hides "Install and enroll" from a %s', async (role) => {
    renderPage(role);
    expect(within(await enrollRow()).queryByRole('button', { name: 'Install and enroll' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/enroll-config'))).toBe(false);
  });

  it('issues the signed config for the chosen group, calls it a secret, and pastes it into the GPO and Intune snippets', async () => {
    const createObjectURL = vi.fn(() => 'blob:enroll');
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    // jsdom cannot navigate to a blob: URL, so record the download instead of letting the anchor click through.
    const downloads: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    try {
      const user = userEvent.setup();
      renderPage();
      await user.click(within(await enrollRow()).getByRole('button', { name: 'Install and enroll' }));
      const dialog = await screen.findByRole('dialog', { name: 'Install and enroll devices with this token' });
      expect(within(dialog).getByText(/are secrets/)).toBeTruthy();
      expect(within(dialog).getByTestId('enroll-usage').textContent).toContain('enrolled 12 of 50 devices');

      const select = (await within(dialog).findByLabelText('Device group')) as HTMLSelectElement;
      await waitFor(() => expect(within(select).getByRole('option', { name: 'Reception' })).toBeTruthy());
      await user.selectOptions(select, GROUP_ID);
      await user.click(within(dialog).getByRole('button', { name: 'Get the signed enrollment config' }));

      const cfg = await waitFor(() => calls.find((c) => c.url.includes('/enroll-config'))!);
      expect(cfg.url).toBe(`http://localhost:4000/api/v1/devices/enroll-config?tokenId=${ENROLL_TOKEN_ID}&groupId=${GROUP_ID}`);
      expect(cfg.init.credentials).toBe('include');

      // The value is copyable but not on screen until it is asked for.
      await within(dialog).findByRole('button', { name: 'Copy the IA_ENROLL value' });
      const value = base64urlEncode(utf8Encode(IACONFIG));
      expect(within(dialog).queryByTestId('gpo-snippet')).toBeNull();
      await user.click(within(dialog).getByRole('button', { name: 'Show the secret value' }));
      expect(within(dialog).getByTestId('gpo-snippet').textContent).toContain(`IA_ENROLL=${value}`);
      expect(within(dialog).getByTestId('gpo-snippet').textContent).toContain('New-EnrollTransform.ps1');
      expect(within(dialog).getByTestId('gpo-snippet').textContent).toContain('Acme IT');
      const intune = within(dialog).getByTestId('intune-snippet').textContent ?? '';
      expect(intune).toContain(`msiexec /i IndiansAssist-Agent-<version>-windows-x64.msi IA_ENROLL=${value} /qn /norestart`);

      await user.click(within(dialog).getByRole('button', { name: 'Download enroll.iaconfig' }));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(downloads).toEqual(['enroll.iaconfig']);
    } finally {
      click.mockRestore();
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
  });

  it('offers the installer per architecture when this server serves one, as a per-token audited download', async () => {
    installerBuilds = [build({ arch: 'arm64', version: '0.4.1' }), build()];
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await enrollRow()).getByRole('button', { name: 'Install and enroll' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install and enroll devices with this token' });
    await user.click(within(dialog).getByRole('button', { name: 'Get the signed enrollment config' }));
    const downloads = await within(dialog).findByTestId('installer-downloads');
    // One link per served arch, in a stable order, each carrying the token the server audits the download against.
    const links = within(downloads).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Download the installer (arm64, 0.4.1)', 'Download the installer (x64, 0.4.0)']);
    expect(links[0]!.getAttribute('href')).toBe(`http://localhost:4000/api/v1/download/installer/arm64?tokenId=${ENROLL_TOKEN_ID}`);
    expect(links[1]!.getAttribute('href')).toBe(`http://localhost:4000/api/v1/download/installer/x64?tokenId=${ENROLL_TOKEN_ID}`);
    // The old "fetch it from your release share" wording is gone, and the config is still the carrier of the org.
    expect(within(dialog).queryByText(/does not serve the MSI itself/)).toBeNull();
    expect(within(dialog).getByText(/The installer carries no organisation of its own/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Copy the IA_ENROLL value' })).toBeTruthy();
  });

  it('warns rather than hides when a served build is unsigned', async () => {
    installerBuilds = [build(), build({ arch: 'arm64', signed: false })];
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await enrollRow()).getByRole('button', { name: 'Install and enroll' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Get the signed enrollment config' }));
    await within(dialog).findByTestId('installer-downloads');
    expect(within(dialog).getByText(/serves an unsigned build \(arm64\)/)).toBeTruthy();
    expect(within(dialog).getByText(/Do not deploy it/)).toBeTruthy();
  });

  it('keeps the release-share wording and offers no link when this server serves no installer', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await enrollRow()).getByRole('button', { name: 'Install and enroll' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Get the signed enrollment config' }));
    await within(dialog).findByRole('button', { name: 'Copy the IA_ENROLL value' });
    expect(within(dialog).getByText(/does not serve the MSI itself/)).toBeTruthy();
    expect(within(dialog).queryByTestId('installer-downloads')).toBeNull();
    expect(within(dialog).queryByText(/unsigned build/)).toBeNull();
  });

  it('shows the refusal and keeps the snippets hidden when the server declines the config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/v1/devices/enroll-config'))
          return jsonResponse(403, { error: { code: 'forbidden', message: 'org_admin only' } });
        if (url.includes('/api/v1/orgs/current/device-groups')) return jsonResponse(200, { items: [] });
        return jsonResponse(200, { items: tokens, nextCursor: null });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await enrollRow()).getByRole('button', { name: 'Install and enroll' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Get the signed enrollment config' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('org_admin only');
    expect(within(dialog).queryByRole('button', { name: 'Show the secret value' })).toBeNull();
  });
});

describe('enrollment helpers', () => {
  it('counts the devices a token may still enroll and warns at 80 %', () => {
    expect(enrollmentUsage({ devicesEnrolled: 12, maxDevices: 50 })).toMatchObject({ enrolled: 12, max: 50, remaining: 38, full: false, nearLimit: false });
    expect(enrollmentUsage({ devicesEnrolled: 40, maxDevices: 50 }).nearLimit).toBe(true);
    expect(enrollmentUsage({ devicesEnrolled: 50, maxDevices: 50 })).toMatchObject({ remaining: 0, full: true, nearLimit: false });
    // Both keys are optional on the wire: a one-device token reads as 0 / 1.
    expect(enrollmentUsage({})).toMatchObject({ enrolled: 0, max: 1, remaining: 1, full: false, nearLimit: false });
  });

  it('calls a token near expiry, but not one already expired or far off', () => {
    const now = Date.parse('2026-11-01T00:00:00.000Z');
    expect(nearExpiry(new Date(now + NEAR_EXPIRY_MS - 1000).toISOString(), now)).toBe(true);
    expect(nearExpiry(new Date(now + NEAR_EXPIRY_MS + 1000).toISOString(), now)).toBe(false);
    expect(nearExpiry(new Date(now - 1000).toISOString(), now)).toBe(false);
    expect(nearExpiry('not a date', now)).toBe(false);
  });

  it('encodes IA_ENROLL as base64url of the config bytes', () => {
    expect(iaEnrollValue(IACONFIG)).toBe(base64urlEncode(utf8Encode(IACONFIG)));
    expect(iaEnrollValue(IACONFIG)).not.toMatch(/[+/=]/);
  });
});
