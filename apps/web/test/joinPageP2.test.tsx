/**
 * Join page for a P2 token (Phase B 2.1, 2.2): extension detection with source / origin checks (foreign beacons
 * ignored), the handshake over both carriers, clipboard only on failure or the install path, the store link, the
 * non-Chromium notice, and no room storage / navigation for this tier.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS, type PublicToken } from '@indiansassist/shared';
import { JoinPage } from '../src/desk/JoinPage';
import { JoinP2, NON_CHROMIUM_TEXT } from '../src/desk/JoinP2';
import { acceptBridgeMessage, isEdge, isNonChromium, type RuntimeLike } from '../src/desk/extensionHandshake';
import { IDS, jsonResponse } from './fakes';

const ORIGIN = 'http://localhost:5173';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const CODE = 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function token(over: Partial<PublicToken> = {}): PublicToken {
  return {
    tokenId: IDS.token,
    tier: 'p2_extension',
    typ: 'one_time',
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
    region: 'in-mum',
    org: { displayName: 'Acme IT', logoData: null, accentColor: '#0f766e', supportEmail: null },
    technician: { name: 'Priya S' },
    signalUrl: 'ws://localhost:4000/signal',
    joinSupported: true,
    extension: { ids: [EXT_ID], webStoreUrl: `https://chromewebstore.google.com/detail/${EXT_ID}`, edgeAddonsUrl: null, minVersion: '0.2.0' },
    ...over,
  };
}

/** A window stand-in: listeners, a postMessage spy, an origin. */
class FakeWin {
  location = { origin: ORIGIN };
  posted: [unknown, string][] = [];
  private ls = new Set<(e: MessageEvent) => void>();
  addEventListener(_t: string, l: (e: MessageEvent) => void) {
    this.ls.add(l);
  }
  removeEventListener(_t: string, l: (e: MessageEvent) => void) {
    this.ls.delete(l);
  }
  postMessage(m: unknown, target: string) {
    this.posted.push([m, target]);
  }
  emit(data: unknown, opts: { source?: unknown; origin?: string } = {}) {
    const ev = { data, source: 'source' in opts ? opts.source : this, origin: opts.origin ?? ORIGIN } as unknown as MessageEvent;
    act(() => {
      for (const l of [...this.ls]) l(ev);
    });
  }
}

const present = { source: 'ia-ext', t: 'ia.ext.present', version: '0.2.0', id: EXT_ID };
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderP2(env: { win: FakeWin; runtime?: RuntimeLike; ua?: string; hasChrome?: boolean; brands?: { brand: string }[]; openTab?: (u: string) => void }, info = token()) {
  const full = { runtime: undefined, ua: CHROME_UA, hasChrome: true, openTab: vi.fn(), ...env };
  render(<JoinP2 info={info} code={CODE} accent="#0f766e" expired={false} env={full as never} />);
  return full;
}

const mev = (data: unknown, source: unknown, origin: string) => ({ data, source, origin }) as unknown as MessageEvent;

describe('handshake helpers', () => {
  it('accepts bridge messages only from this window and this origin, with a valid shape', () => {
    const win = new FakeWin() as never;
    expect(acceptBridgeMessage(mev(present, win, ORIGIN), win)).toEqual({ kind: 'present', version: '0.2.0', id: EXT_ID });
    expect(acceptBridgeMessage(mev(present, {}, ORIGIN), win)).toBeNull();
    expect(acceptBridgeMessage(mev(present, win, 'https://evil.example'), win)).toBeNull();
    expect(acceptBridgeMessage(mev({ ...present, id: 'not-an-id' }, win, ORIGIN), win)).toBeNull();
    expect(acceptBridgeMessage(mev({ ok: true, state: 'connecting' }, win, ORIGIN), win)).toBeNull();
    expect(acceptBridgeMessage(mev({ source: 'ia-ext', t: 'ia.join.reply', ok: true, state: 'connecting' }, win, ORIGIN), win)).toEqual({ kind: 'reply', reply: { source: 'ia-ext', t: 'ia.join.reply', ok: true, state: 'connecting' } });
  });

  it('classifies browsers', () => {
    expect(isNonChromium('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', true)).toBe(true);
    expect(isNonChromium('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', true)).toBe(true);
    expect(isNonChromium(CHROME_UA, true)).toBe(false);
    expect(isEdge([{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }])).toBe(true);
    expect(isEdge(undefined)).toBe(false);
  });
});

describe('JoinP2', () => {
  it('ignores a foreign-source or foreign-origin beacon, then detects the bridge and joins over it without the clipboard', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const win = new FakeWin();
    renderP2({ win });
    expect(screen.getByText(/never your whole screen/)).toBeTruthy();
    win.emit(present, { source: {} });
    win.emit(present, { origin: 'https://indiansassist.com.evil.example' });
    expect(screen.queryByText('Extension detected')).toBeNull();
    expect(screen.getByRole('button', { name: 'Install the extension' })).toBeTruthy();
    win.emit(present);
    expect(screen.getByText('Extension detected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open in extension' }));
    expect(win.posted).toEqual([[{ t: 'ia.join', v: 1, code: CODE }, ORIGIN]]);
    win.emit({ source: 'ia-ext', t: 'ia.join.reply', ok: true, state: 'connecting' }, { source: {} }); // forged reply ignored
    expect(screen.queryByText(/Continue in the extension/)).toBeNull();
    win.emit({ source: 'ia-ext', t: 'ia.join.reply', ok: true, state: 'connecting' });
    await screen.findByText(/Continue in the extension/);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('prefers externally_connectable once the pong arrives, and writes the clipboard only on a failed reply', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const calls: [string, unknown][] = [];
    const runtime: RuntimeLike = {
      sendMessage: (id, msg, cb) => {
        calls.push([id, msg]);
        const m = msg as { t: string };
        if (m.t === 'ia.ext.ping') cb({ t: 'ia.ext.pong', version: '0.2.1', id });
        else cb({ ok: false, error: 'busy' });
      },
    };
    const win = new FakeWin();
    renderP2({ win, runtime });
    await screen.findByText('Extension detected');
    expect(calls[0]).toEqual([EXT_ID, { t: 'ia.ext.ping', v: 1 }]);
    await user.click(screen.getByRole('button', { name: 'Open in extension' }));
    expect(calls[1]).toEqual([EXT_ID, { t: 'ia.join', v: 1, code: CODE }]);
    expect(win.posted).toEqual([]);
    await screen.findByText(/Finish the current session/);
    expect(writeText).toHaveBeenCalledWith(CODE);
  });

  it('install path copies the code and opens the store listing (Edge listing on Edge)', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const env = renderP2({ win: new FakeWin() });
    await user.click(screen.getByRole('button', { name: 'Install the extension' }));
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(env.openTab).toHaveBeenCalledWith(`https://chromewebstore.google.com/detail/${EXT_ID}`);
    expect(screen.getByText(/Token copied\. After installing/)).toBeTruthy();
  });

  it('shows the unpublished notice when there is no store URL, and the developer install details', () => {
    renderP2({ win: new FakeWin(), brands: [{ brand: 'Microsoft Edge' }] });
    expect(screen.getByText(/not yet published; use the developer install below/)).toBeTruthy();
    expect(screen.getByText('Developer install (load unpacked)')).toBeTruthy();
    expect(screen.getByText(/apps\/extension\/dist/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy token' })).toBeTruthy();
  });

  it('tells Firefox and Safari users this package needs Chrome or Edge', () => {
    renderP2({ win: new FakeWin(), ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', hasChrome: false });
    expect(screen.getByText(NON_CHROMIUM_TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install the extension' })).toBeNull();
  });
});

describe('join page routing for a P2 token', () => {
  it('renders the extension branch, stores nothing for the room and never navigates to /room', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, token())));
    render(
      <MemoryRouter initialEntries={[`/join#t=${CODE}`]}>
        <Routes>
          <Route path="/join" element={<JoinPage />} />
          <Route path="/room/new" element={<p>ROOM</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId('join-p2');
    expect(screen.queryByRole('button', { name: 'Join support session' })).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEYS.joinToken)).toBeNull();
    await waitFor(() => expect(screen.queryByText('ROOM')).toBeNull());
  });
});
