/**
 * Phase F foundation in the console (docs/specs/phase-f-contracts.md sections 1.4, 2.1, 3.2b2, 13.4): the section 2.1
 * capability names, the console slots that render today's output until their stream supplies a component, the
 * chat accessory hook, the placeholder pages behind the new routes, and the `ctl.event keep` plumbing.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { UserRole } from '@indiansassist/shared';
import { ErasurePage } from '../src/assist/erasure/ErasurePage';
import { RESIDENCY_ERASURE_PRINT_CSS } from '../src/assist/erasure/ResidencyErasure';
import { AGENT_INITIAL } from '../src/assist/console/agent/agentState';
import { CameraLinkAccessory, CameraSlot, DeskKeepSlot, ErasureBannerSlot, ResidencyErasureSlot } from '../src/assist/console/PhaseFSlots';
import { RESIDENCY_PRINT_CSS } from '../src/assist/ResidencyPage';
import { can, type Capability } from '../src/auth/permissions';
import { CameraJoinPage } from '../src/camera/CameraJoinPage';
import { ChatPanel } from '../src/components/ChatPanel';
import type { ChatItem } from '../src/lib/link';
import { PasswordResetPage } from '../src/pages/PasswordResetPage';

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

describe('console slots', () => {
  it('render nothing until their stream supplies a component', () => {
    render(
      <div data-testid="slots">
        <CameraSlot session={{ id: '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', live: true, consoleRecording: false }} sendChat={() => undefined} tier="p1_browser" />
        <DeskKeepSlot kept={true} />
        <ErasureBannerSlot role="org_admin" />
        <CameraLinkAccessory message={{ msgId: 'm1', from: 'assist', text: 'hello', ts: 1, mine: true }} />
      </div>,
    );
    expect(screen.getByTestId('slots').innerHTML).toBe('');
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

describe('placeholder pages', () => {
  it.each([
    ['Reset your password', PasswordResetPage],
    ['Phone camera', CameraJoinPage],
    ['Organisation erasure', ErasurePage],
  ] as const)('%s says it is not available yet', (title, Page) => {
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText(/not available on this server yet/)).toBeTruthy();
  });
});
