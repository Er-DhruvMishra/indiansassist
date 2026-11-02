/**
 * Join page, Linux branch (Phase E section 7.6): Linux detection from low-entropy signals, **Download for Linux
 * (x86-64, X11)** through prepare with platform `linux`, the X11 line, the copy button for the exact
 * `cd ~/Downloads && tar -xzf ... && ./...` line, the ELF sha256, Download again after a 410, and the unavailable text
 * when the server has no Linux build (manifest) or answers `503 download_unavailable`.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadManifest, DownloadPrepareReply, PublicToken } from '@indiansassist/shared';
import { JoinP3, P3_INTRO, P3_LINUX_DOWNLOAD, P3_LINUX_X11, P3_UNAVAILABLE, type JoinP3Env } from '../src/desk/JoinP3';
import { detectPlatform, linuxRunCommand } from '../src/desk/agentDownload';
import { ApiRequestError } from '../src/lib/api';
import { IDS } from './fakes';

const CODE = 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_LINUX_UA = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const SHA = 'cd'.repeat(32);

function token(): PublicToken {
  return {
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
}

const NAMES = ['IndiansAssist-in-mum-4821-9365-7715', 'IndiansAssist-in-mum-1111-2222-3336'];
const reply = (n: number): DownloadPrepareReply => ({
  url: `http://localhost:4105/api/v1/download/grant${n}`,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  filename: `${NAMES[Math.min(n, 2) - 1]}.tar.gz`,
  deskCode: NAMES[Math.min(n, 2) - 1]!.slice(-14).replace(/-/g, ''),
  version: '0.5.0',
  sha256: SHA,
  signed: false,
});

const LINUX_MANIFEST: DownloadManifest = {
  v: 1,
  builds: [{ platform: 'linux', arch: 'x64', version: '0.5.0', size: 1300, sha256: SHA, signed: false, minOs: 'glibc 2.35' }],
};

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => vi.useRealTimers());

type TestEnv = JoinP3Env & { download: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn>; probe: ReturnType<typeof vi.fn>; manifest: ReturnType<typeof vi.fn> };

function env(over: Partial<Record<keyof JoinP3Env, unknown>> = {}): TestEnv {
  const e = {
    nav: { userAgent: LINUX_UA },
    origin: 'http://localhost:5173',
    deepLink: { assign: vi.fn(), onLeave: () => () => undefined, setTimeout: (cb: () => void) => setTimeout(cb, 0) },
    storage: { getItem: () => null },
    download: vi.fn(),
    probe: vi.fn(async () => 410),
    prepare: vi.fn(async () => reply((e.prepare as ReturnType<typeof vi.fn>).mock.calls.length)),
    manifest: vi.fn(async () => LINUX_MANIFEST),
    setTimeout: (cb: () => void) => setTimeout(cb, 0),
    ...over,
  } as unknown as TestEnv;
  return e;
}

describe('Linux detection and the run command', () => {
  it('detects Linux from the UA or userAgentData, never for Android', () => {
    expect(detectPlatform({ userAgent: LINUX_UA })).toBe('linux');
    expect(detectPlatform({ userAgent: FIREFOX_LINUX_UA })).toBe('linux');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0', userAgentData: { platform: 'Linux' } })).toBe('linux');
    expect(detectPlatform({ userAgent: ANDROID_UA })).toBe('android');
    expect(detectPlatform({ userAgent: ANDROID_UA, userAgentData: { platform: 'Android' } })).toBe('android');
    expect(detectPlatform({ userAgent: WIN_UA })).toBe('windows');
    expect(detectPlatform({ userAgent: WIN_UA, userAgentData: { platform: 'Windows' } })).toBe('windows');
  });

  it('builds the exact command for a served archive name and refuses anything else', () => {
    expect(linuxRunCommand('IndiansAssist-in-mum-4821-9365-7715.tar.gz')).toBe(
      'cd ~/Downloads && tar -xzf IndiansAssist-in-mum-4821-9365-7715.tar.gz && ./IndiansAssist-in-mum-4821-9365-7715',
    );
    expect(linuxRunCommand('IndiansAssist-in-mum-4821-9365-7715.exe')).toBeNull();
    expect(linuxRunCommand('IndiansAssist-in-mum-4821-9365-7715 (1).tar.gz')).toBeNull();
    expect(linuxRunCommand('IndiansAssist-in-mum-4821-9365-7715;rm -rf ~.tar.gz')).toBeNull();
    expect(linuxRunCommand('.tar.gz')).toBeNull();
  });
});

describe('JoinP3 (Linux)', () => {
  it('offers the Linux download with the X11 line, prepares linux/x64, and shows the exact command, sha256 and support code', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const e = env();
    render(<JoinP3 info={token()} code={CODE} accent="#0f766e" expired={false} env={e} />);
    expect(screen.getByTestId('join-p3-linux')).toBeTruthy();
    expect(screen.getByText(P3_INTRO)).toBeTruthy();
    expect(screen.getByText(`${P3_LINUX_X11}.`)).toBeTruthy();
    // No Windows wording on a Linux page.
    expect(screen.queryByRole('button', { name: 'Download IndiansAssist' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ARM64 version' })).toBeNull();
    await waitFor(() => expect(e.manifest).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: P3_LINUX_DOWNLOAD }));
    expect(e.prepare).toHaveBeenCalledWith(CODE, 'linux', 'x64');
    expect(e.download).toHaveBeenCalledWith('http://localhost:4105/api/v1/download/grant1', 'IndiansAssist-in-mum-4821-9365-7715.tar.gz');

    const cmd = 'cd ~/Downloads && tar -xzf IndiansAssist-in-mum-4821-9365-7715.tar.gz && ./IndiansAssist-in-mum-4821-9365-7715';
    expect((await screen.findByTestId('p3-linux-command')).textContent).toBe(cmd);
    expect(screen.getByText('IndiansAssist-in-mum-4821-9365-7715.tar.gz')).toBeTruthy();
    expect(screen.getByTestId('p3-sha').textContent).toContain(SHA);
    expect(screen.getByTestId('p3-sha').textContent).toContain('IndiansAssist-in-mum-4821-9365-7715');
    expect(screen.getByText(/not code-signed/)).toBeTruthy();
    expect(screen.getByText(/sha256sum IndiansAssist-in-mum-4821-9365-7715/)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenCalledWith(cmd);
    await user.click(screen.getByRole('button', { name: 'Copy support code' }));
    expect(writeText).toHaveBeenLastCalledWith('482193657715');
    expect(writeText).not.toHaveBeenCalledWith(CODE);
  });

  it('Download again re-prepares linux after a 410 and the command follows the new names', async () => {
    const user = userEvent.setup();
    const e = env();
    render(<JoinP3 info={token()} code={CODE} accent="#0f766e" expired={false} env={e} />);
    await user.click(screen.getByRole('button', { name: P3_LINUX_DOWNLOAD }));
    await user.click(await screen.findByRole('button', { name: 'Download again' }));
    expect(e.probe).toHaveBeenCalledWith('http://localhost:4105/api/v1/download/grant1');
    await waitFor(() => expect(e.prepare).toHaveBeenCalledTimes(2));
    expect(e.prepare).toHaveBeenLastCalledWith(CODE, 'linux', 'x64');
    expect(e.download).toHaveBeenLastCalledWith('http://localhost:4105/api/v1/download/grant2', 'IndiansAssist-in-mum-1111-2222-3336.tar.gz');
    await waitFor(() =>
      expect(screen.getByTestId('p3-linux-command').textContent).toBe(
        'cd ~/Downloads && tar -xzf IndiansAssist-in-mum-1111-2222-3336.tar.gz && ./IndiansAssist-in-mum-1111-2222-3336',
      ),
    );
  });

  it('Download again reuses a grant that still serves', async () => {
    const user = userEvent.setup();
    const e = env({ probe: vi.fn(async () => 200) });
    render(<JoinP3 info={token()} code={CODE} accent="#0f766e" expired={false} env={e} />);
    await user.click(screen.getByRole('button', { name: P3_LINUX_DOWNLOAD }));
    await user.click(await screen.findByRole('button', { name: 'Download again' }));
    await waitFor(() => expect(e.download).toHaveBeenCalledTimes(2));
    expect(e.prepare).toHaveBeenCalledTimes(1);
  });

  it('shows the unavailable text when the manifest has no Linux build', async () => {
    const e = env({ manifest: vi.fn(async () => ({ v: 1, builds: [{ ...LINUX_MANIFEST.builds[0]!, platform: 'windows' }] })) });
    render(<JoinP3 info={token()} code={CODE} accent="#000" expired={false} env={e} />);
    expect(await screen.findByText(P3_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: P3_LINUX_DOWNLOAD })).toBeNull();
  });

  it('keeps the button when the manifest cannot be read, and a 503 from prepare shows the unavailable text', async () => {
    const user = userEvent.setup();
    const e = env({
      manifest: vi.fn(async () => Promise.reject(new ApiRequestError(0, 'network_error', 'offline'))),
      prepare: vi.fn(async () => Promise.reject(new ApiRequestError(503, 'download_unavailable', 'no build'))),
    });
    render(<JoinP3 info={token()} code={CODE} accent="#000" expired={false} env={e} />);
    await waitFor(() => expect(e.manifest).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: P3_LINUX_DOWNLOAD }));
    expect(await screen.findByText(P3_UNAVAILABLE)).toBeTruthy();
    expect(e.download).not.toHaveBeenCalled();
  });

  it('expired: the download button is disabled', () => {
    render(<JoinP3 info={token()} code={CODE} accent="#000" expired env={env()} />);
    expect((screen.getByRole('button', { name: P3_LINUX_DOWNLOAD }) as HTMLButtonElement).disabled).toBe(true);
  });
});
