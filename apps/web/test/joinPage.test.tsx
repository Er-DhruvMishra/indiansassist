import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS, luhnCheckDigit, type PublicToken } from '@indiansassist/shared';
import { JoinPage } from '../src/desk/JoinPage';
import { IDS, jsonResponse } from './fakes';

const COMPACT = 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln';
const CODE_BODY = '48219365771';
const CODE = CODE_BODY + String(luhnCheckDigit(CODE_BODY));

function publicToken(over: Partial<PublicToken> = {}): PublicToken {
  return {
    tokenId: IDS.token,
    tier: 'p1_browser',
    typ: 'one_time',
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
    region: 'in-mum',
    org: { displayName: 'Acme IT', logoData: null, accentColor: '#0f766e', supportEmail: null },
    technician: { name: 'Priya S' },
    signalUrl: 'ws://localhost:4000/signal',
    joinSupported: true,
    ...over,
  };
}

/** user-event installs its own clipboard stub; put the mock back afterwards. */
function setupUser() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return user;
}

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search + l.hash}</output>;
}

let writeText: ReturnType<typeof vi.fn>;
let lookups: string[];
let respond: (code: string) => Response;

beforeEach(() => {
  lookups = [];
  respond = () => jsonResponse(200, publicToken());
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      expect(url).toBe('http://localhost:4000/api/v1/tokens/public-lookup');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['X-Requested-With']).toBe('IndiansAssist');
      const code = (JSON.parse(init.body as string) as { code: string }).code;
      lookups.push(code);
      return respond(code);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/join" element={<><JoinPage /><Where /></>} />
        <Route path="/room/new" element={<><p>ROOM</p><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('join page', () => {
  it('moves the token out of the URL, looks it up, and copies it on click and again', async () => {
    const user = setupUser();
    renderAt(`/join#t=${COMPACT}`);
    expect(await screen.findByText('Acme IT')).toBeTruthy();
    expect(screen.getByText('Priya S wants to help you')).toBeTruthy();
    expect(lookups).toEqual([COMPACT]);
    expect(screen.getByTestId('where').textContent).toBe('/join');

    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenLastCalledWith(COMPACT);
    expect(await screen.findByText('Copied')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Copy token again' }));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(COMPACT);
  });

  it('accepts the compatibility ?t= query and removes it too', async () => {
    renderAt(`/join?t=${COMPACT}`);
    expect(await screen.findByText('Acme IT')).toBeTruthy();
    expect(lookups).toEqual([COMPACT]);
    expect(screen.getByTestId('where').textContent).toBe('/join');
  });

  it('Join support session copies the token, stores it for the room and navigates', async () => {
    const user = setupUser();
    renderAt(`/join#t=${COMPACT}`);
    await user.type(await screen.findByLabelText(/Your name/), 'Rahul');
    await user.click(screen.getByRole('button', { name: 'Join support session' }));
    expect(await screen.findByText('ROOM')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(COMPACT);
    expect(sessionStorage.getItem(STORAGE_KEYS.joinToken)).toBe(COMPACT);
    expect(sessionStorage.getItem(STORAGE_KEYS.joinSignal)).toBe('ws://localhost:4000/signal');
  });

  it('still works when the clipboard is unavailable (best effort)', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const user = setupUser();
    renderAt(`/join#t=${COMPACT}`);
    await user.click(await screen.findByRole('button', { name: 'Join support session' }));
    expect(await screen.findByText('ROOM')).toBeTruthy();
  });

  it('falls back to the manual field: a 12-digit code with spaces, then Continue', async () => {
    respond = () => jsonResponse(200, publicToken({ technician: null }));
    const user = setupUser();
    renderAt('/join');
    const field = screen.getByLabelText('Paste your support code or link');
    await user.type(field, `${CODE.slice(0, 4)} ${CODE.slice(4, 8)} ${CODE.slice(8)}`);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Your technician wants to help you')).toBeTruthy();
    expect(lookups).toEqual([CODE]);
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(writeText).toHaveBeenLastCalledWith(CODE);
  });

  it('extracts the token from a pasted full join link', async () => {
    const user = setupUser();
    renderAt('/join');
    await user.type(screen.getByLabelText('Paste your support code or link'), `https://in.example.com/join#t=${COMPACT}`);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Acme IT');
    expect(lookups).toEqual([COMPACT]);
  });

  it('catches a mistyped code locally without calling the server', async () => {
    const user = setupUser();
    const wrong = CODE.slice(0, 11) + String((Number(CODE[11]) + 1) % 10);
    renderAt('/join');
    await user.type(screen.getByLabelText('Paste your support code or link'), wrong);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/looks mistyped/)).toBeTruthy();
    expect(lookups).toEqual([]);
  });

  it('explains 404 and 410 answers and keeps the manual field', async () => {
    respond = () => jsonResponse(410, { error: { code: 'token_gone', message: 'gone', details: { status: 'used' } } });
    renderAt(`/join#t=${COMPACT}`);
    expect((await screen.findByRole('alert')).textContent).toContain('already used');
    expect(screen.getByLabelText('Paste your support code or link')).toBeTruthy();
  });

  it('shows the stub for tiers other than p1_browser', async () => {
    respond = () => jsonResponse(200, publicToken({ tier: 'p3_portable', joinSupported: false }));
    renderAt(`/join#t=${COMPACT}`);
    expect(await screen.findByText(/not available yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join support session' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy token' })).toBeTruthy();
  });

  it('offers Retry when the server cannot be reached', async () => {
    let fail = true;
    respond = () => {
      if (fail) throw new TypeError('network');
      return jsonResponse(200, publicToken());
    };
    const user = setupUser();
    renderAt(`/join#t=${COMPACT}`);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach the server');
    fail = false;
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await waitFor(() => expect(screen.getByText('Acme IT')).toBeTruthy());
  });
});
