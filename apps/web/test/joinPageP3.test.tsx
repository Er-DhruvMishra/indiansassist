/**
 * Join page for a P3 token (Phase C section 2.7 J1-J6): download through prepare + `<a download>`, no clipboard write
 * by the page, Copy support code = the desk code, sha256 / version and signed lines, Download again after a 410,
 * ARM64, the deep link only after Keep or on "I already have IndiansAssist", the Android and iOS branches, the
 * `?kept=1` flag, and no room storage or navigation.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS, type DownloadPrepareReply, type PublicToken } from '@indiansassist/shared';
import { JoinPage } from '../src/desk/JoinPage';
import { JoinP3, P3_INTRO, P3_IOS, P3_UNAVAILABLE, type JoinP3Env } from '../src/desk/JoinP3';
import { AGENT_SEEN_KEY, deepLinkFor, detectPlatform, tryDeepLink } from '../src/desk/agentDownload';
import type * as AgentDownload from '../src/desk/agentDownload';
import { IDS, jsonResponse } from './fakes';

// jsdom implements neither navigation nor downloads (it logs "Not implemented: navigation"): the JoinPage test below
// runs the default env, so its deep link and `<a download>` click are no-ops here. Tests passing an env are unaffected.
vi.mock('../src/desk/agentDownload', async (importOriginal) => {
  const real = await importOriginal<typeof AgentDownload>();
  return {
    ...real,
    browserDeepLinkEnv: () => ({ ...real.browserDeepLinkEnv(), assign: () => undefined }),
    clickDownload: () => undefined,
  };
});

const CODE = 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';

function token(over: Partial<PublicToken> = {}): PublicToken {
  return {
    tokenId: IDS.token,
    tier: 'p3_portable',
    typ: 'one_time',
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
    region: 'in-mum',
    org: { displayName: 'Acme IT', logoData: null, accentColor: '#0f766e', supportEmail: null },
    technician: { name: 'Priya S' },
    signalUrl: 'ws://localhost:4000/signal',
    joinSupported: true,
    agent: { windows: { x64: true, arm64: true }, android: { apk: true, appUrl: null }, minVersion: '0.3.0' },
    ...over,
  };
}

const reply = (arch = 'x64', n = 1): DownloadPrepareReply => ({
  url: `http://localhost:4000/api/v1/download/grant${n}`,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  filename: 'IndiansAssist-in-mum-4821-9365-7715.exe',
  deskCode: '482193657715',
  version: '0.3.0',
  sha256: 'ab'.repeat(32),
  signed: arch === 'arm64',
});

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function env(over: Partial<JoinP3Env> = {}) {
  const e = {
    nav: { userAgent: WIN_UA },
    origin: 'http://localhost:5173',
    deepLink: { assign: vi.fn(), onLeave: () => () => undefined, setTimeout: (cb: () => void) => setTimeout(cb, 0) },
    storage: { getItem: () => null },
    download: vi.fn(),
    probe: vi.fn(async () => 410),
    prepare: vi.fn(async (_c: string, _p: string, arch: string) => reply(arch, (e.prepare as ReturnType<typeof vi.fn>).mock.calls.length)),
    setTimeout: (cb: () => void) => setTimeout(cb, 0),
    ...over,
  } as unknown as JoinP3Env & { download: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn>; probe: ReturnType<typeof vi.fn> };
  return e;
}

function setup() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return user;
}

describe('JoinP3 (Windows)', () => {
  it('downloads through prepare, shows the panel, copies only the desk code, and never writes the clipboard on its own', async () => {
    const user = setup();
    const e = env();
    render(<JoinP3 info={token()} code={CODE} accent="#0f766e" expired={false} env={e} />);
    expect(screen.getByText(P3_INTRO)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Download IndiansAssist' }));
    expect(e.prepare).toHaveBeenCalledWith(CODE, 'windows', 'x64');
    expect(e.download).toHaveBeenCalledWith('http://localhost:4000/api/v1/download/grant1', 'IndiansAssist-in-mum-4821-9365-7715.exe');
    expect(await screen.findByText('IndiansAssist-in-mum-4821-9365-7715.exe')).toBeTruthy();
    expect(screen.getByTestId('p3-sha').textContent).toContain('ab'.repeat(32));
    expect(screen.getByText(/unsigned development build/)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Copy support code' }));
    expect(writeText).toHaveBeenCalledWith('482193657715');
    expect(writeText).not.toHaveBeenCalledWith(CODE);
  });

  it('Download again re-runs prepare after a 410; ARM64 asks for arm64', async () => {
    const user = setup();
    const e = env();
    render(<JoinP3 info={token()} code={CODE} accent="#0f766e" expired={false} env={e} />);
    await user.click(screen.getByRole('button', { name: 'Download IndiansAssist' }));
    await user.click(await screen.findByRole('button', { name: 'Download again' }));
    expect(e.probe).toHaveBeenCalledWith('http://localhost:4000/api/v1/download/grant1');
    await waitFor(() => expect(e.prepare).toHaveBeenCalledTimes(2));
    expect(e.download).toHaveBeenLastCalledWith('http://localhost:4000/api/v1/download/grant2', expect.any(String));
    await user.click(screen.getByRole('button', { name: 'ARM64 version' }));
    await waitFor(() => expect(e.prepare).toHaveBeenLastCalledWith(CODE, 'windows', 'arm64'));
    expect(await screen.findByText('Signed by IndiansAssist.')).toBeTruthy();
  });

  it('Download again reuses a grant that still serves', async () => {
    const user = setup();
    const e = env({ probe: vi.fn(async () => 200) });
    render(<JoinP3 info={token()} code={CODE} accent="#0f766e" expired={false} env={e} />);
    await user.click(screen.getByRole('button', { name: 'Download IndiansAssist' }));
    await user.click(await screen.findByRole('button', { name: 'Download again' }));
    await waitFor(() => expect(e.download).toHaveBeenCalledTimes(2));
    expect(e.prepare).toHaveBeenCalledTimes(1);
  });

  it('shows the unavailable text when the server has no Windows build', async () => {
    render(<JoinP3 info={token({ agent: { windows: { x64: false, arm64: false }, android: { apk: false, appUrl: null }, minVersion: '0.3.0' } })} code={CODE} accent="#000" expired={false} env={env()} />);
    expect(screen.getByText(P3_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download IndiansAssist' })).toBeNull();
  });

  it('tries the deep link only on "I already have IndiansAssist" unless the Keep flag is set', async () => {
    const user = setup();
    const e = env();
    render(<JoinP3 info={token()} code={CODE} accent="#000" expired={false} env={e} />);
    expect(e.deepLink.assign).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'I already have IndiansAssist' }));
    expect(e.deepLink.assign).toHaveBeenCalledWith(deepLinkFor(CODE));
  });

  it('with ia.agent.seen = 1 it opens the deep link automatically and falls back to the download', async () => {
    const e = env({ storage: { getItem: (k: string) => (k === AGENT_SEEN_KEY ? '1' : null) } });
    render(<JoinP3 info={token()} code={CODE} accent="#000" expired={false} env={e} />);
    await waitFor(() => expect(e.deepLink.assign).toHaveBeenCalledWith('indiansassist://join?t=ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln'));
    expect(await screen.findByRole('button', { name: 'Download IndiansAssist' })).toBeTruthy();
  });

  it('renders a QR of the join link for another device', () => {
    render(<JoinP3 info={token()} code={CODE} accent="#000" expired={false} env={env()} />);
    expect(screen.getByRole('img', { name: /QR code of this join link/ })).toBeTruthy();
  });
});

describe('JoinP3 (Android, iOS)', () => {
  it('Android: App Link, then Get the app (prepare universal), Copy token and QR', async () => {
    const user = setup();
    const e = env({ nav: { userAgent: ANDROID_UA } });
    render(<JoinP3 info={token()} code={CODE} accent="#000" expired={false} env={e} />);
    const link = screen.getByRole('link', { name: 'Open in the IndiansAssist app' });
    expect(link.getAttribute('href')).toBe(`http://localhost:5173/join#t=${encodeURIComponent(CODE)}`);
    link.addEventListener('click', (ev) => ev.preventDefault()); // jsdom cannot follow the App Link; the onClick still runs
    await user.click(link);
    await user.click(await screen.findByRole('button', { name: 'Get the app' }));
    await waitFor(() => expect(e.prepare).toHaveBeenCalledWith(CODE, 'android', 'universal'));
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(screen.getByRole('img', { name: /QR code/ })).toBeTruthy();
  });
  it('iOS gets the Android-only text', () => {
    render(<JoinP3 info={token()} code={CODE} accent="#000" expired={false} env={env({ nav: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } })} />);
    expect(screen.getByText(P3_IOS)).toBeTruthy();
  });
  it('platform detection uses low-entropy signals', () => {
    expect(detectPlatform({ userAgent: WIN_UA, userAgentData: { platform: 'Android' } })).toBe('android');
    expect(detectPlatform({ userAgent: WIN_UA })).toBe('windows');
  });
  it('tryDeepLink resolves true when the page is left within 1500 ms', async () => {
    let leave: () => void = () => undefined;
    const p = tryDeepLink('indiansassist://join?c=482193657715', { assign: () => leave(), onLeave: (cb) => ((leave = cb), () => undefined), setTimeout: (cb) => setTimeout(cb, 0) });
    expect(await p).toBe(true);
  });
});

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname}</output>;
}

describe('JoinPage with a p3 token', () => {
  it('renders the P3 branch, stores nothing for the room, never navigates to /room; kept=1 sets the flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, token())));
    render(
      <MemoryRouter initialEntries={[`/join?kept=1#t=${CODE}`]}>
        <Routes>
          <Route path="/join" element={<><JoinPage /><Where /></>} />
          <Route path="/room/*" element={<p>room</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('join-p3')).toBeTruthy();
    expect(localStorage.getItem(AGENT_SEEN_KEY)).toBe('1');
    expect(screen.getByText(/kept on this computer/)).toBeTruthy();
    expect(sessionStorage.getItem(STORAGE_KEYS.joinToken)).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/join');
    expect(screen.queryByRole('button', { name: 'Join support session' })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });
});
