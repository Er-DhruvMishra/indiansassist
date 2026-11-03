/**
 * Phase F foundation in the console (docs/specs/phase-f-contracts.md sections 1.4, 2.1, 3.2b2, 13.4): the section 2.1
 * capability names, the console slots (each renders the component its stream built in wave 1), the
 * chat accessory hook, the pages behind the new routes, and the `ctl.event keep` plumbing.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@indiansassist/shared';
import { ErasurePage } from '../src/assist/erasure/ErasurePage';
import { RESIDENCY_ERASURE_PRINT_CSS } from '../src/assist/erasure/ResidencyErasure';
import { AGENT_INITIAL } from '../src/assist/console/agent/agentState';
import { KEEP_STATE_TEXT } from '../src/assist/console/agent/KeepState';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { CameraLinkAccessory, CameraSlot, DeskKeepSlot, ErasureBannerSlot, ResidencyErasureSlot } from '../src/assist/console/PhaseFSlots';
import { RESIDENCY_PRINT_CSS } from '../src/assist/ResidencyPage';
import { can, type Capability } from '../src/auth/permissions';
import { CameraJoinPage } from '../src/camera/CameraJoinPage';
import { ChatPanel } from '../src/components/ChatPanel';
import type { ChatItem } from '../src/lib/link';
import { PasswordResetPage } from '../src/pages/PasswordResetPage';
import { IDS, ISO, jsonResponse } from './fakes';

const ROLES: UserRole[] = ['technician', 'senior_technician', 'org_admin', 'auditor', 'observer'];
const who = (cap: Capability) => ROLES.filter((r) => can(r, cap));

describe('section 2.1 capabilities', () => {
  it('match the Phase F rows of the matrix', () => {
    expect(who('users.invite_mail')).toEqual(['org_admin']);
    expect(who('erasure.read')).toEqual(['org_admin', 'auditor']);
    expect(who('erasure.admin')).toEqual(['org_admin']);
    expect(who('camera.use')).toEqual(['technician', 'senior_technician', 'org_admin']);
  });
});

// The built slots and pages read the api; no request leaves the test (an unknown route answers 404).
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(404, { error: { code: 'not_found', message: 'not found' } })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('console slots', () => {
  it('render the component their stream built (wave 1)', () => {
    render(
      <div data-testid="camera">
        <CameraSlot session={{ id: '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', live: true, consoleRecording: false }} sendChat={() => undefined} tier="p1_browser" />
      </div>,
    );
    expect(screen.getByTestId('camera').textContent).toContain('Phone camera');
    render(<DeskKeepSlot kept={true} />);
    expect(screen.getByTestId('desk-keep-state').textContent).toBe(KEEP_STATE_TEXT);
    render(
      <div data-testid="quiet">
        <ErasureBannerSlot role="org_admin" />
        <CameraLinkAccessory message={{ msgId: 'm1', from: 'assist', text: 'hello', ts: 1, mine: true }} />
      </div>,
    );
    // No open erasure is known and the message carries no camera link: both render nothing.
    expect(screen.getByTestId('quiet').innerHTML).toBe('');
  });

  it('the residency erasure slot renders the Phase E line unchanged', () => {
    const { container } = render(
      <dl>
        <ResidencyErasureSlot erasure={{ available: false, note: 'Erasure by pepper destruction is not built.' }} />
      </dl>,
    );
    const row = screen.getByTestId('residency-erasure');
    expect(row.querySelector('dt')?.textContent).toBe('Erasure');
    expect(row.querySelector('dd')?.textContent).toBe('Not available Erasure by pepper destruction is not built.');
    expect(row.className).toContain('rr-erasure');
    render(
      <dl data-testid="absent">
        <ResidencyErasureSlot erasure={undefined} />
      </dl>,
    );
    expect(screen.getByTestId('absent').innerHTML).toBe('');
    expect(container).toBeTruthy();
  });

  it('the erasure block has a fixed 12 mm print budget in the residency print CSS (section 3.2b2)', () => {
    expect(RESIDENCY_ERASURE_PRINT_CSS).toContain('height: 12mm');
    expect(RESIDENCY_PRINT_CSS).toContain(RESIDENCY_ERASURE_PRINT_CSS);
  });
});

describe('chat message accessory', () => {
  const items: ChatItem[] = [
    { msgId: 'a', from: 'assist', text: 'first', ts: 1, mine: false },
    { msgId: 'b', from: 'desk', text: 'second', ts: 2, mine: true },
  ];
  it('is drawn beside each message when given', () => {
    render(<ChatPanel items={items} peerName="Tech" peerTyping={false} onSend={() => undefined} messageAccessory={(m) => <i data-testid={`acc-${m.msgId}`} />} />);
    expect(screen.getByTestId('acc-a')).toBeTruthy();
    expect(screen.getByTestId('acc-b')).toBeTruthy();
  });
  it('changes nothing when absent or null', () => {
    const a = render(<ChatPanel items={items} peerName="Tech" peerTyping={false} onSend={() => undefined} />);
    const before = a.container.innerHTML;
    a.unmount();
    const b = render(<ChatPanel items={items} peerName="Tech" peerTyping={false} onSend={() => undefined} messageAccessory={() => null} />);
    expect(b.container.innerHTML).toBe(before);
  });
});

describe('ctl.event keep plumbing (section 3.4b)', () => {
  it('starts unknown', () => {
    expect(AGENT_INITIAL.kept).toBeNull();
  });
});

describe('the pages behind the new routes (built in wave 1)', () => {
  it('the reset page asks for the email', () => {
    render(
      <MemoryRouter>
        <PasswordResetPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Ask for a reset link' })).toBeTruthy();
    expect(screen.queryByText(/not available on this server yet/)).toBeNull();
  });

  it('the phone camera page asks for the camera code', () => {
    render(
      <MemoryRouter>
        <CameraJoinPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Show the technician your camera' })).toBeTruthy();
    expect(screen.getByLabelText(/Camera code/)).toBeTruthy();
    expect(screen.queryByText(/not available on this server yet/)).toBeNull();
  });

  it('the erasure page renders for an org_admin', () => {
    const admin: AuthValue = {
      status: 'authenticated',
      me: {
        user: { id: IDS.user, orgId: IDS.org, email: 'admin@example.test', name: 'Asha', role: 'org_admin', status: 'active', createdAt: ISO } as never,
        org: { id: IDS.org, name: 'Acme Synthetic', slug: 'acme-synthetic' } as never,
        seat: null,
      },
      error: null,
      setMe: () => undefined,
      refresh: () => undefined,
      logout: async () => undefined,
    };
    render(
      <StaticAuthProvider value={admin}>
        <MemoryRouter>
          <ErasurePage />
        </MemoryRouter>
      </StaticAuthProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Organisation erasure' })).toBeTruthy();
    expect(screen.queryByText(/not available on this server yet/)).toBeNull();
  });
});
