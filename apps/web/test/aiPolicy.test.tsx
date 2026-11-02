/**
 * Phase E sections 5.2, 13.4 (stream ai): the AI policy page. Providers limited to the capabilities, the exact
 * acknowledgement text with a typed confirmation before `anthropic` is sent, the switches, read-only for others.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiAckText, type AuthResponse, type UserRole } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { AiPolicyPage } from '../src/assist/summary/AiPolicyPage';
import { IDS, ISO, jsonResponse } from './fakes';

afterEach(() => vi.unstubAllGlobals());

function authAs(role: UserRole): AuthValue {
  const me = {
    user: { id: IDS.user, orgId: IDS.org, email: 'anil@acme.test', name: 'Anil K', role, status: 'active', createdAt: ISO, lastLoginAt: ISO },
    org: { id: IDS.org, name: 'Acme IT', slug: 'acme', dataRegion: 'in-mum', planTier: 'p1_browser', branding: {}, createdAt: ISO },
    seat: null,
  } as AuthResponse;
  return { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };
}

const CAPS = { region: 'in-mum', local: true, anthropic: { available: true, inferenceGeo: null, ackScope: 'outside_region' } };
const NONE = { provider: 'none', autoSummarize: false, includeTranscript: false, anthropicAck: null };

function stub(caps: unknown = CAPS, policy: Record<string, unknown> = NONE) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let current = policy;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/ai/capabilities')) return jsonResponse(200, caps);
      if (method === 'PATCH') {
        const { acknowledge, ...rest } = body ?? {};
        current = {
          ...current,
          ...rest,
          anthropicAck: rest.provider === 'anthropic' && acknowledge ? { scope: 'outside_region', textVersion: 'ai-ack-v2', by: { id: IDS.user, name: 'Anil K' }, at: ISO } : rest.provider === 'anthropic' ? current.anthropicAck : null,
        };
        return jsonResponse(200, current);
      }
      return jsonResponse(200, current);
    }),
  );
  return calls;
}

const renderPage = (role: UserRole = 'org_admin') =>
  render(
    <StaticAuthProvider value={authAs(role)}>
      <AiPolicyPage />
    </StaticAuthProvider>,
  );

describe('AiPolicyPage', () => {
  it('limits the providers to the capabilities and saves the in-region model with its switches', async () => {
    const calls = stub({ ...CAPS, anthropic: { available: false, inferenceGeo: null, ackScope: null } });
    renderPage();
    const local = (await screen.findByRole('radio', { name: /In-region model/ })) as HTMLInputElement;
    expect((screen.getByRole('radio', { name: /Anthropic/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/not available on this server/)).toBeTruthy();
    await userEvent.click(local);
    await userEvent.click(screen.getByRole('checkbox', { name: /Summarise every session/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Include the chat/ }));
    expect(screen.getByText(/not reliably detected and are not removed/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save AI policy' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ provider: 'local', autoSummarize: true, includeTranscript: true });
    expect(await screen.findAllByText('The AI policy was saved.')).toBeTruthy();
  });

  it('shows the exact acknowledgement for anthropic and sends it only after the typed confirmation', async () => {
    const calls = stub();
    renderPage();
    await userEvent.click(await screen.findByRole('radio', { name: /Anthropic/ }));
    const text = aiAckText('outside_region', 'Acme IT', 'India (Mumbai)');
    expect(screen.getByTestId('ack-text').textContent).toBe(text);
    const save = screen.getByRole('button', { name: 'Save AI policy' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Type the organisation name/), 'Acme');
    expect(save.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Type the organisation name/), ' IT');
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      provider: 'anthropic',
      autoSummarize: false,
      includeTranscript: false,
      acknowledge: { scope: 'outside_region', text },
    });
    expect(await screen.findByText(/Acknowledged by Anil K/)).toBeTruthy();
  });

  it('is read-only for everyone but an org_admin', async () => {
    stub();
    renderPage('technician');
    expect(await screen.findByText('Only an organisation administrator can change this policy.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save AI policy' })).toBeNull();
    expect((screen.getByRole('radio', { name: /In-region model/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it('says so when no provider is served for the region', async () => {
    stub({ region: 'in-mum', local: false, anthropic: { available: false, inferenceGeo: null, ackScope: null } });
    renderPage();
    expect(await screen.findByText(/No AI summary provider is available for India \(Mumbai\)/)).toBeTruthy();
  });
});
