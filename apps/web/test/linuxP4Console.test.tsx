/**
 * Phase F section 8.11 (linux-p4 L3) in the console: the "Install and enroll" dialog's Linux and macOS tabs (the deb
 * and rpm with their sha256, the `sudo` commands, the Ansible snippet with the role-prefixed variables, the macOS PKG
 * only when the server lists one, with its "not signed" note), keyboard use of the tabs, and the device page's
 * platform, Linux display type, the rule 8.4e lock line and the rule 8.4f refusal.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UNATTENDED_POLICY,
  type AuthResponse,
  type DeviceDetail,
  type InstallerBuild,
  type Token,
  type UserRole,
} from '@indiansassist/shared';
import { TokensPage } from '../src/assist/tokens/TokensPage';
import { ansibleSnippet, linuxSudoCommand, macosCommands, MACOS_ENROLL_PATH } from '../src/assist/tokens/EnrollDeployDialog';
import { DeviceDetailPage } from '../src/assist/fleet/DeviceDetailPage';
import { linuxDisplayText, platformName, refusalText, SCREEN_LOCKED_TEXT } from '../src/assist/fleet/fleetText';
import { installerApi } from '../src/lib/fleetApi';
import { ApiRequestError } from '../src/lib/api';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { IDS, ISO, jsonResponse } from './fakes';

const ENROLL_TOKEN_ID = '66666666-6666-4666-8666-666666666666';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const IACONFIG = '{"v":1,"apiOrigin":"https://in.example","token":"ia1.aa.bb.cc","groupId":null,"kid":"0123456789abcdef","sig":"sig"}';
const FAR = new Date(Date.now() + 30 * 86_400_000).toISOString();
const DEB_SHA = 'd'.repeat(64);
const RPM_SHA = 'e'.repeat(64);
const PKG_SHA = 'f'.repeat(64);

function auth(role: UserRole): AuthValue {
  const me: AuthResponse = {
    user: { id: IDS.user, orgId: IDS.org, email: 'asha@acme.test', name: 'Asha', role, status: 'active', createdAt: ISO, lastLoginAt: ISO },
    org: { id: IDS.org, name: 'Acme IT Pvt Ltd', slug: 'acme-it', dataRegion: 'in-mum', planTier: 'p4_installed', branding: { displayName: 'Acme IT' }, createdAt: ISO },
    seat: null,
  };
  return { status: 'authenticated', me, error: null, setMe: () => {}, refresh: () => {}, logout: async () => {} };
}

const enrollToken: Token = {
  id: ENROLL_TOKEN_ID,
  tier: 'p4_installed',
  typ: 'enrollment',
  status: 'active',
  shortCode: '482193657710',
  shortCodeDisplay: '4821 9365 7710',
  label: 'Linux rollout',
  region: 'in-mum',
  createdBy: { id: IDS.user, name: 'Asha' },
  issuedAt: ISO,
  expiresAt: FAR,
  usedAt: null,
  revokedAt: null,
  deniedCount: 0,
  joinUrl: 'http://localhost:5173/join#t=ia1.aa.bb.cc',
  joinHost: 'localhost:5173',
  maxDevices: 50,
  devicesEnrolled: 0,
};

const msi: InstallerBuild = { arch: 'x64', version: '0.5.0', size: 9_000_000, sha256: 'a'.repeat(64), signed: true, minOs: '10.0.17763' };
const deb: InstallerBuild = { platform: 'linux', format: 'deb', arch: 'x64', version: '0.5.0', size: 7_000_000, sha256: DEB_SHA, signed: false, minOs: 'glibc 2.34+, x86_64' };
const rpm: InstallerBuild = { ...deb, format: 'rpm', sha256: RPM_SHA };
const pkg: InstallerBuild = { platform: 'macos', format: 'pkg', arch: 'arm64', version: '0.5.0', size: 12_000_000, sha256: PKG_SHA, signed: false, minOs: 'macOS 13' };

let builds: InstallerBuild[];
let calls: string[];

function stubFetch(detail?: DeviceDetail) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/api/v1/download/installer')) return jsonResponse(200, { v: 1, builds });
      if (url.includes('/api/v1/devices/enroll-config')) return jsonResponse(200, { iaconfig: IACONFIG });
      if (url.includes('/device-groups')) return jsonResponse(200, { items: [] });
      if (url.includes('/api/v1/tokens')) return jsonResponse(200, { items: [enrollToken], nextCursor: null });
      if (url.includes('/policy/unattended')) return jsonResponse(200, DEFAULT_UNATTENDED_POLICY);
      if (url.includes('/policy/fleet')) return jsonResponse(200, { fleetScopingEnabled: false, wakerMeshEnabled: true });
      if (url.includes('/orgs/current/playbooks')) return jsonResponse(200, { items: [], nextCursor: null });
      if (url.includes('/users')) return jsonResponse(200, { items: [], nextCursor: null });
      if (url.includes(`/devices/${DEVICE_ID}/actions`)) return jsonResponse(200, { items: [], nextCursor: null });
      if (detail && url.includes(`/devices/${DEVICE_ID}`)) return jsonResponse(200, detail);
      return jsonResponse(404, { error: { code: 'not_found', message: 'nope' } });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

async function openDialog() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <StaticAuthProvider value={auth('org_admin')}>
        <TokensPage />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
  const row = (await screen.findByText('Linux rollout')).closest('tr')!;
  await user.click(within(row).getByRole('button', { name: 'Install and enroll' }));
  const dialog = await screen.findByRole('dialog', { name: 'Install and enroll devices with this token' });
  await user.click(within(dialog).getByRole('button', { name: 'Get the signed enrollment config' }));
  await within(dialog).findByRole('tablist', { name: 'Platform' });
  return { user, dialog };
}

describe('Install and enroll: the Linux and macOS tabs (section 8.11)', () => {
  beforeEach(() => {
    builds = [msi, deb, rpm];
    stubFetch();
  });

  it('shows Windows first, and no macOS tab when the server lists no PKG', async () => {
    const { dialog } = await openDialog();
    const tabs = within(dialog).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Windows', 'Linux']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    // The Windows panel lists only the MSI, with the Phase D link shape.
    const links = within(within(dialog).getByTestId('installer-downloads')).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`http://localhost:4000/api/v1/download/installer/x64?tokenId=${ENROLL_TOKEN_ID}`]);
  });

  it('the Linux tab: deb and rpm with sha256, the config, the sudo commands and the Ansible snippet', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('tab', { name: 'Linux' }));
    const panel = within(dialog).getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('enroll-tab-linux');
    const list = within(panel).getByTestId('linux-downloads');
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Download the .deb package (x64, 0.5.0)', 'Download the .rpm package (x64, 0.5.0)']);
    expect(links[0]!.getAttribute('href')).toBe(`http://localhost:4000/api/v1/download/installer/x64?tokenId=${ENROLL_TOKEN_ID}&format=deb`);
    expect(links[1]!.getAttribute('href')).toBe(`http://localhost:4000/api/v1/download/installer/x64?tokenId=${ENROLL_TOKEN_ID}&format=rpm`);
    expect(list.textContent).toContain(DEB_SHA);
    expect(list.textContent).toContain(RPM_SHA);
    expect(within(panel).getByText(/not signed: compare the sha256/)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Download enroll.iaconfig' })).toBeTruthy();

    const cmds = within(panel).getByTestId('linux-commands').textContent ?? '';
    expect(cmds).toContain('sudo install -D -m 0600 enroll.iaconfig /etc/indiansassist/enroll.iaconfig && sudo apt install ./IndiansAssist-Agent-0.5.0-linux-x64.deb');
    expect(cmds).toContain('&& sudo dnf install ./IndiansAssist-Agent-0.5.0-linux-x64.rpm');

    const ansible = within(panel).getByTestId('ansible-snippet').textContent ?? '';
    for (const v of ['indiansassist_agent_state: present', 'indiansassist_agent_package_url:', `indiansassist_agent_package_sha256: "${DEB_SHA}"`, 'indiansassist_agent_enroll_config:'])
      expect(ansible).toContain(v);
    // The secret is read from a file, never pasted into the snippet.
    expect(ansible).not.toContain('ia1.aa.bb.cc');
    expect(within(panel).getByRole('button', { name: 'Copy the Ansible snippet (.rpm)' })).toBeTruthy();
  });

  it('the Linux tab without served packages points at the release share and offers no link', async () => {
    builds = [msi];
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('tab', { name: 'Linux' }));
    expect(within(dialog).getByTestId('linux-release-share')).toBeTruthy();
    expect(within(dialog).queryByTestId('linux-downloads')).toBeNull();
    expect(within(dialog).getByTestId('linux-commands').textContent).toContain('IndiansAssist-Agent-<version>-linux-x64.deb');
  });

  it('the macOS tab appears with a PKG row: download, sha256, the not-signed note and the installer command', async () => {
    builds = [msi, deb, rpm, pkg];
    const { user, dialog } = await openDialog();
    expect(within(dialog).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Windows', 'Linux', 'macOS']);
    await user.click(within(dialog).getByRole('tab', { name: 'macOS' }));
    const panel = within(dialog).getByRole('tabpanel');
    const link = within(within(panel).getByTestId('macos-downloads')).getByRole('link');
    expect(link.textContent).toBe('Download the PKG (arm64, 0.5.0)');
    expect(link.getAttribute('href')).toBe(`http://localhost:4000/api/v1/download/installer/arm64?tokenId=${ENROLL_TOKEN_ID}&format=pkg`);
    expect(panel.textContent).toContain(PKG_SHA);
    expect(within(panel).getByText(/This PKG is not signed \(arm64\)/)).toBeTruthy();
    const cmds = within(panel).getByTestId('macos-commands').textContent ?? '';
    expect(cmds).toContain(`sudo install -m 0600 enroll.iaconfig "${MACOS_ENROLL_PATH}"`);
    expect(cmds).toContain('sudo installer -pkg IndiansAssist-Agent-0.5.0-macos-arm64.pkg -target /');
    // A signed PKG carries no warning.
    expect(macosCommands('X.pkg').split('\n')).toHaveLength(3);
  });

  it('the tabs work from the keyboard: arrows, Home and End move the selection and the focus', async () => {
    builds = [msi, deb, rpm, pkg];
    const { user, dialog } = await openDialog();
    const windows = within(dialog).getByRole('tab', { name: 'Windows' });
    expect(windows.tabIndex).toBe(0);
    expect(within(dialog).getByRole('tab', { name: 'Linux' }).tabIndex).toBe(-1);
    windows.focus();
    await user.keyboard('{ArrowRight}');
    const linux = within(dialog).getByRole('tab', { name: 'Linux' });
    expect(linux.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(linux);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(within(dialog).getByRole('tab', { name: 'macOS' }));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(within(dialog).getByRole('tab', { name: 'Windows' }));
    await user.keyboard('{ArrowLeft}');
    expect(within(dialog).getByRole('tab', { name: 'macOS' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Home}');
    expect(within(dialog).getByRole('tab', { name: 'Windows' }).getAttribute('aria-selected')).toBe('true');
    // Tab from the selected tab reaches its panel.
    await user.tab();
    expect(document.activeElement?.getAttribute('role')).toBe('tabpanel');
  });
});

describe('the platform helpers (section 8.11)', () => {
  it('builds the commands, the snippet and the download URL', () => {
    expect(linuxSudoCommand('rpm', 'p.rpm')).toBe('sudo install -D -m 0600 enroll.iaconfig /etc/indiansassist/enroll.iaconfig && sudo dnf install ./p.rpm');
    expect(ansibleSnippet('p.deb', DEB_SHA)).toContain('    - role: indiansassist_agent');
    expect(installerApi.url('x64', ENROLL_TOKEN_ID)).not.toContain('format=');
    expect(installerApi.url('x64', ENROLL_TOKEN_ID, 'rpm')).toContain('&format=rpm');
  });
});

function linuxDetail(interactive: DeviceDetail['interactive']): DeviceDetail {
  return {
    id: DEVICE_ID,
    name: 'lab-ubuntu-01',
    platform: 'linux',
    status: 'enrolled',
    online: true,
    keyId: 'a1b2c3d4e5f60718',
    osVersion: 'Ubuntu 24.04.1 LTS',
    arch: 'x64',
    agentVersion: '0.5.0',
    serviceVersion: '0.5.0',
    groupId: null,
    tags: [],
    capabilities: {
      monitors: 1,
      elevation: 'user',
      features: ['screen', 'multi_monitor', 'input', 'chat', 'files', 'playbooks'],
      encoders: ['vp8', 'vp9'],
      hwEncoder: false,
      interpreters: ['sh'],
      serviceVersion: '0.5.0',
    },
    interactive,
    amt: null,
    tamperState: 'ok',
    lanSegmentHash: null,
    notifyEmail: null,
    lastSeenAt: ISO,
    firstSeenAt: ISO,
    enrolledAt: ISO,
    lastIp: null,
    unattendedPolicy: null,
    group: null,
    policy: { ...DEFAULT_UNATTENDED_POLICY, mode: 'allow' },
    recentSessions: [],
  } as DeviceDetail;
}

function renderDevice() {
  return render(
    <MemoryRouter initialEntries={[`/app/fleet/${DEVICE_ID}`]}>
      <StaticAuthProvider value={auth('technician')}>
        <Routes>
          <Route path="/app/fleet/:id" element={<DeviceDetailPage />} />
        </Routes>
      </StaticAuthProvider>
    </MemoryRouter>,
  );
}

describe('the device page on Linux (sections 8.4, 8.11)', () => {
  it('names the platform and the display type of an X11 session', async () => {
    stubFetch(linuxDetail({ state: 'active', idleSec: 0, at: 1, display: 'x11' }));
    renderDevice();
    expect(await screen.findByText('Linux x64 Ubuntu 24.04.1 LTS')).toBeTruthy();
    expect(screen.getByText('Signed-in X11 session')).toBeTruthy();
    expect(screen.queryByTestId('screen-locked')).toBeNull();
  });

  it('says the screen is locked while the session is locked (rule 8.4e)', async () => {
    stubFetch(linuxDetail({ state: 'locked', idleSec: 30, at: 1, display: 'x11' }));
    renderDevice();
    expect((await screen.findByTestId('screen-locked')).textContent).toBe("The Desk's screen is locked");
  });

  it('a Wayland session and nobody signed in', async () => {
    stubFetch(linuxDetail({ state: 'active', idleSec: 0, at: 1, display: 'wayland' }));
    const { unmount } = renderDevice();
    expect(await screen.findByText('Wayland session: chat and files only')).toBeTruthy();
    unmount();
    stubFetch(linuxDetail({ state: 'none', idleSec: null, at: 1, display: null }));
    renderDevice();
    expect(await screen.findByText('Nobody signed in: device actions only')).toBeTruthy();
    await waitFor(() => expect(calls.some((u) => u.includes(`/devices/${DEVICE_ID}`))).toBe(true));
  });

  it('the text helpers', () => {
    expect(platformName('linux')).toBe('Linux');
    expect(platformName('macos')).toBe('macOS');
    expect(platformName('windows')).toBe('Windows');
    expect(linuxDisplayText({ platform: 'windows', interactive: { state: 'active', idleSec: 0, at: 1 } })).toBeNull();
    expect(linuxDisplayText({ platform: 'linux', interactive: null })).toBeNull();
    expect(SCREEN_LOCKED_TEXT).toBe("The Desk's screen is locked");
    const e = new ApiRequestError(409, 'prelogin_unsupported', 'server text');
    expect(refusalText(e, 'x')).toBe('Nobody is signed in to this Linux computer. IndiansAssist can connect only to a signed-in desktop session.');
  });
});
