/**
 * Join page, Linux branch with the Wayland portal companion (Phase F section 9.5): one button, **Download for Linux
 * (x86-64)**, the "Works on X11 and Wayland desktops" line, the X11 binary's sha256 and the companion's on a second
 * line, and the `sha256sum` hint naming both files.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DownloadManifest, DownloadPrepareReply, PublicToken } from '@indiansassist/shared';
import { JoinP3, P3_LINUX_BOTH, P3_LINUX_DOWNLOAD, P3_LINUX_X11, type JoinP3Env } from '../src/desk/JoinP3';
import { IDS } from './fakes';

const CODE = 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SHA = 'cd'.repeat(32);
const PORTAL_SHA = 'ab'.repeat(32);
const NAME = 'IndiansAssist-in-mum-4821-9365-7715';

const info: PublicToken = {
  tokenId: IDS.token,
  tier: 'p3_portable',
  typ: 'one_time',
  expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
  region: 'in-mum',
  org: { displayName: 'Acme IT', logoData: null, accentColor: '#0f766e', supportEmail: null },
  technician: { name: 'Priya S' },
  signalUrl: 'ws://localhost:4105/signal',
  joinSupported: true,
  agent: { windows: { x64: true, arm64: false }, android: { apk: false, appUrl: null }, minVersion: '0.5.0' },
};

const reply: DownloadPrepareReply = {
  url: 'http://localhost:4105/api/v1/download/grant1',
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  filename: `${NAME}.tar.gz`,
  deskCode: '482193657715',
  version: '0.5.0',
  sha256: SHA,
  signed: false,
};

function env(manifest: DownloadManifest): JoinP3Env {
  return {
    nav: { userAgent: LINUX_UA },
    origin: 'http://localhost:5173',
    deepLink: { assign: vi.fn(), onLeave: () => () => undefined, setTimeout: (cb: () => void) => setTimeout(cb, 0) },
    storage: { getItem: () => null },
    download: vi.fn(),
    probe: vi.fn(async () => 410),
    prepare: vi.fn(async () => reply),
    manifest: vi.fn(async () => manifest),
    setTimeout: (cb: () => void) => setTimeout(cb, 0),
  };
}

const build = { platform: 'linux' as const, arch: 'x64' as const, version: '0.5.0', size: 1300, sha256: SHA, signed: false, minOs: 'glibc 2.34' };

describe('JoinP3 (Linux, Phase F section 9.5)', () => {
  it('one download for X11 and Wayland, with both sha256 values', async () => {
    const user = userEvent.setup();
    const e = env({ v: 1, builds: [{ ...build, companion: { sha256: PORTAL_SHA, size: 2100 } }] });
    render(<JoinP3 info={info} code={CODE} accent="#0f766e" expired={false} env={e} />);
    expect(P3_LINUX_DOWNLOAD).toBe('Download for Linux (x86-64)');
    expect(P3_LINUX_BOTH).toBe('Works on X11 and Wayland desktops. On Wayland the technician can see your screen but cannot control it.');
    await waitFor(() => expect(screen.getByTestId('p3-linux-line').textContent).toBe(P3_LINUX_BOTH));
    expect(screen.getAllByRole('button', { name: /Download for Linux/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: P3_LINUX_DOWNLOAD }));
    expect(e.prepare).toHaveBeenCalledWith(CODE, 'linux', 'x64');
    expect((await screen.findByTestId('p3-sha')).textContent).toContain(SHA);
    expect(screen.getByTestId('p3-sha-portal').textContent).toContain(PORTAL_SHA);
    expect(screen.getByTestId('p3-sha-portal').textContent).toContain('.ia-portal');
    expect(screen.getByText(`sha256sum ${NAME} .ia-portal`)).toBeTruthy();
    expect(screen.getByTestId('p3-linux-command').textContent).toBe(`cd ~/Downloads && tar -xzf ${NAME}.tar.gz && ./${NAME}`);
  });

  it('a build without the companion keeps the X11 line and one sha256', async () => {
    const user = userEvent.setup();
    const e = env({ v: 1, builds: [build] });
    render(<JoinP3 info={info} code={CODE} accent="#0f766e" expired={false} env={e} />);
    await waitFor(() => expect(e.manifest).toHaveBeenCalled());
    expect(screen.getByTestId('p3-linux-line').textContent).toBe(P3_LINUX_X11);
    await user.click(screen.getByRole('button', { name: P3_LINUX_DOWNLOAD }));
    await screen.findByTestId('p3-sha');
    expect(screen.queryByTestId('p3-sha-portal')).toBeNull();
    expect(screen.getByText(`sha256sum ${NAME}`)).toBeTruthy();
  });
});
