/**
 * Phase E foundation in the console (docs/specs/phase-e-contracts.md sections 1.4, 2.3, 13.4): the section 2.3
 * capability names, the console slots that render nothing until their stream supplies a component, and the
 * placeholder settings pages behind the new routes.
 */
import { render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { SessionDetail, UserRole } from '@indiansassist/shared';
import { NoScreenSlot, SummaryPanelSlot, TicketPushSlot, useEnterpriseLiveHooks } from '../src/assist/console/EnterpriseSlots';
import { IntegrationsPage } from '../src/assist/integrations/IntegrationsPage';
import { SsoContinuePage } from '../src/assist/sso/SsoContinuePage';
import { SsoSettingsPage } from '../src/assist/sso/SsoSettingsPage';
import { AiPolicyPage } from '../src/assist/summary/AiPolicyPage';
import { can, type Capability } from '../src/auth/permissions';

const ROLES: UserRole[] = ['technician', 'senior_technician', 'org_admin', 'auditor', 'observer'];
const who = (cap: Capability) => ROLES.filter((r) => can(r, cap));

describe('section 2.3 capabilities', () => {
  it('match the Phase E rows of the matrix', () => {
    expect(who('sso.read')).toEqual(['org_admin', 'auditor']);
    expect(who('sso.admin')).toEqual(['org_admin']);
    expect(who('integrations.read')).toEqual(['org_admin', 'auditor']);
    expect(who('integrations.admin')).toEqual(['org_admin']);
    expect(who('integrations.push')).toEqual(['technician', 'senior_technician', 'org_admin']);
    expect(who('ai.admin')).toEqual(['org_admin']);
    expect(who('summary.write')).toEqual(['technician', 'senior_technician', 'org_admin']);
    expect(who('summary.read')).toEqual(['technician', 'senior_technician', 'org_admin', 'auditor']);
  });
});

describe('console slots', () => {
  const session = { id: '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b' } as unknown as SessionDetail;
  it('render nothing until their stream supplies a component', () => {
    const { container } = render(
      <div data-testid="slots">
        <SummaryPanelSlot session={session} />
        <TicketPushSlot session={session} />
      </div>,
    );
    expect(screen.getByTestId('slots').innerHTML).toBe('');
    expect(container.textContent).toBe('');
  });
  it('the no-screen slot renders the screen it wraps unchanged', () => {
    render(
      <NoScreenSlot capabilities={null}>
        <p>screen</p>
      </NoScreenSlot>,
    );
    expect(screen.getByText('screen')).toBeTruthy();
  });
  it('the live hook is a no-op', () => {
    const { result } = renderHook(() => useEnterpriseLiveHooks({ sessionId: 'x', tier: 'p3_portable' }));
    expect(result.current).toBeUndefined();
  });
});

describe('placeholder pages', () => {
  it.each([
    ['Single sign-on', SsoSettingsPage],
    ['Integrations', IntegrationsPage],
    ['AI summaries', AiPolicyPage],
  ] as const)('%s says it is not available yet', (title, Page) => {
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText(/not available on this server yet/)).toBeTruthy();
  });
  it('/sso/continue links back to sign-in', () => {
    render(
      <MemoryRouter>
        <SsoContinuePage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Go to the sign-in page' }).getAttribute('href')).toBe('/login');
  });
});
