/**
 * Phase E section 15.3 web: the ticket push of an ended session (section 13.4). The dialog (create and append, summary
 * with its version and manual, the optional fields with "sent to <type>"), the outcome announced in words, the push
 * list with states, and the ambiguous-retry warning of rule 4.4e before a manual retry.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthResponse, SessionDetail, TicketPush as Push, UserRole } from '@indiansassist/shared';
import { MemoryRouter } from 'react-router';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { TicketPushSlot } from '../src/assist/console/EnterpriseSlots';
import { outcomeText } from '../src/assist/integrations/TicketPush';
import { IDS, ISO, jsonResponse } from './fakes';

afterEach(() => vi.unstubAllGlobals());

function authAs(role: UserRole, id = IDS.user): AuthValue {
  const me: AuthResponse = {
    user: { id, orgId: IDS.org, email: 'asha@acme.test', name: 'Asha R', role, status: 'active', createdAt: ISO, lastLoginAt: ISO },
    org: { id: IDS.org, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p1_browser', branding: { displayName: 'Acme IT' }, createdAt: ISO },
    seat: null,
  };
  return { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };
}

const SESSION = { id: IDS.session, state: 'ended' } as unknown as SessionDetail;
const PUSH_ID = '66666666-6666-4666-8666-666666666666';

function push(over: Partial<Push> = {}): Push {
  return {
    id: PUSH_ID,
    sessionId: IDS.session,
    type: 'jira',
    mode: 'create',
    source: 'manual',
    summary: null,
    state: 'delivered',
    attempts: 1,
    manualRetries: 0,
    nextAttemptAt: null,
    externalId: 'OPS-42',
    externalUrl: 'https://acme.atlassian.net/browse/OPS-42',
    lastFailure: null,
    contentSha256: 'c'.repeat(64),
    createdBy: { id: IDS.user, name: 'Asha R' },
    createdAt: ISO,
    deliveredAt: ISO,
    ...over,
  };
}

const META = (version: number, state: string) => ({ version, state });

type Call = { url: string; method: string; body?: Record<string, unknown> };

function stub(opts: { pushes?: Push[]; available?: string[]; versions?: { version: number; state: string }[] | null; onPush?: (c: Call) => Response; onRetry?: () => Response }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c: Call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined };
      calls.push(c);
      if (url.endsWith('/integrations/available')) return jsonResponse(200, { items: (opts.available ?? ['jira', 'webhook']).map((type) => ({ type, enabled: true })) });
      if (url.endsWith(`/sessions/${IDS.session}/tickets`)) return jsonResponse(200, { items: opts.pushes ?? [] });
      if (url.endsWith(`/sessions/${IDS.session}/summary`))
        return opts.versions === null ? jsonResponse(404, { error: { code: 'not_found', message: 'x' } }) : jsonResponse(200, { latest: null, versions: opts.versions ?? [] });
      if (url.includes('/ticket') && c.method === 'POST') return opts.onPush ? opts.onPush(c) : jsonResponse(201, { push: push() });
      if (url.endsWith('/retry')) return opts.onRetry ? opts.onRetry() : jsonResponse(200, { push: push() });
      return jsonResponse(404, { error: { code: 'not_found', message: 'x' } });
    }),
  );
  return calls;
}

function renderSlot(role: UserRole = 'technician', session: SessionDetail = SESSION, userId = IDS.user) {
  return render(
    <MemoryRouter>
      <StaticAuthProvider value={authAs(role, userId)}>
        <TicketPushSlot session={session} />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
}

describe('TicketPush', () => {
  it('renders nothing for a session that has not ended, or when nothing is enabled or pushed', async () => {
    stub({});
    const { container, unmount } = renderSlot('technician', { ...SESSION, state: 'active' } as SessionDetail);
    expect(container.textContent).toBe('');
    unmount();
    stub({ available: [] });
    const r = renderSlot();
    await new Promise((res) => setTimeout(res, 50));
    expect(r.container.textContent).toBe('');
  });

  it('pushes a manual note to create a ticket and announces the outcome', async () => {
    const calls = stub({ versions: null });
    renderSlot();
    await userEvent.click(await screen.findByRole('button', { name: 'Push to ticketing' }));
    const dialog = screen.getByRole('dialog', { name: 'Push to ticketing' });
    // No ready summary: the summary choice is disabled and the manual note is selected.
    expect((within(dialog).getByRole('radio', { name: /The AI summary/ }) as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByRole('radio', { name: 'A note I write' }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByLabelText('Requester email (optional, sent to Jira)')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Note'), 'Reset the password.');
    await userEvent.selectOptions(within(dialog).getByLabelText('Priority (optional)'), 'high');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push ticket' }));
    expect(await screen.findByText('Delivered to Jira as OPS-42.', { selector: '[role="status"]' })).toBeTruthy();
    const sent = calls.find((c) => c.method === 'POST' && c.url.endsWith('/integrations/jira/ticket'))!;
    expect(sent.body).toEqual({ sessionId: IDS.session, clientPushId: expect.stringMatching(/^[0-9a-f-]{36}$/), mode: 'create', source: 'manual', note: 'Reset the password.', priority: 'high' });
    expect(screen.queryByRole('dialog')).toBeNull();
    const list = screen.getByRole('list', { name: 'Ticket pushes' });
    expect(within(list).getByText('Delivered')).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'OPS-42' }).getAttribute('href')).toBe('https://acme.atlassian.net/browse/OPS-42');
  });

  it('appends the chosen summary version to an existing ticket on another integration', async () => {
    const calls = stub({ versions: [META(1, 'ready'), META(2, 'ready'), META(3, 'pending')], onPush: () => jsonResponse(201, { push: push({ type: 'webhook', mode: 'append', source: 'summary', summary: { version: 1, sha256: 'a'.repeat(64) }, externalId: 'HOOK-9', externalUrl: null }) }) });
    renderSlot();
    await userEvent.click(await screen.findByRole('button', { name: 'Push to ticketing' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Integration'), 'webhook');
    expect(within(dialog).getByLabelText('Requester email (optional, sent to Webhook)')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Add a note to an existing ticket' }));
    await userEvent.type(within(dialog).getByLabelText('Existing ticket id'), 'HOOK-9');
    expect((within(dialog).getByRole('radio', { name: 'The AI summary' }) as HTMLInputElement).checked).toBe(true);
    const picker = within(dialog).getByLabelText('Summary version') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Version 2 (latest)', 'Version 1']);
    await userEvent.selectOptions(picker, '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push ticket' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/integrations/webhook/ticket'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/integrations/webhook/ticket'))!.body).toEqual({
      sessionId: IDS.session,
      clientPushId: expect.any(String),
      mode: 'append',
      externalId: 'HOOK-9',
      source: 'summary',
      summaryVersion: 1,
    });
    expect(await screen.findByText('Delivered to Webhook as HOOK-9.', { selector: '[role="status"]' })).toBeTruthy();
  });

  it('shows a server refusal inside the dialog', async () => {
    stub({ onPush: () => jsonResponse(409, { error: { code: 'summary_not_ready', message: 'this session has no ready summary' } }) });
    renderSlot();
    await userEvent.click(await screen.findByRole('button', { name: 'Push to ticketing' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Note'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push ticket' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByText('this session has no ready summary')).toBeTruthy();
  });

  it('lists push states in words and warns before retrying an ambiguous failure', async () => {
    const failed = push({ state: 'failed', externalId: null, externalUrl: null, lastFailure: { cause: 'timeout', status: null, retryAfterSec: null, sent: true, detail: 'x' } });
    const retrying = push({ id: '77777777-7777-4777-8777-777777777777', state: 'retrying', externalId: null, externalUrl: null, nextAttemptAt: ISO, lastFailure: { cause: 'rate_limited', status: 429, retryAfterSec: 90, sent: true, detail: 'HTTP 429' } });
    const calls = stub({ pushes: [retrying, failed], onRetry: () => jsonResponse(200, { push: push({ manualRetries: 1, attempts: 2 }) }) });
    renderSlot();
    const list = await screen.findByRole('list', { name: 'Ticket pushes' });
    expect(within(list).getByText('Retrying')).toBeTruthy();
    expect(within(list).getByText(/the ticketing system asked us to slow down\. Retrying automatically/)).toBeTruthy();
    expect(within(list).getByText('Failed')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Retry push to Jira' }));
    expect(within(list).getByText('The ticket may already exist in Jira. Check before retrying.')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/retry'))).toBe(false);
    await userEvent.click(within(list).getByRole('button', { name: 'Retry anyway' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/pushes/${PUSH_ID}/retry`))).toBe(true));
    expect(await screen.findByText('Delivered to Jira as OPS-42.', { selector: '[role="status"]' })).toBeTruthy();
  });

  it('retries an unambiguous failure without the warning; another technician cannot retry; auditors only read', async () => {
    const failed = push({ state: 'failed', externalId: null, externalUrl: null, lastFailure: { cause: 'auth', status: 401, retryAfterSec: null, sent: true, detail: 'HTTP 401' } });
    const calls = stub({ pushes: [failed] });
    const r = renderSlot();
    await userEvent.click(await screen.findByRole('button', { name: 'Retry push to Jira' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/retry'))).toBe(true));
    r.unmount();
    stub({ pushes: [failed] });
    const other = renderSlot('technician', SESSION, IDS.other);
    await screen.findByRole('list', { name: 'Ticket pushes' });
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    other.unmount();
    stub({ pushes: [failed] });
    renderSlot('auditor');
    await screen.findByRole('list', { name: 'Ticket pushes' });
    expect(screen.queryByRole('button', { name: /Retry|Push to ticketing/ })).toBeNull();
    expect(screen.getByText(/Failed: the credentials were refused/)).toBeTruthy();
  });

  it('describes each outcome in words', () => {
    expect(outcomeText(push({ state: 'failed', lastFailure: { cause: 'egress_refused', status: null, retryAfterSec: null, sent: false, detail: '' } }))).toBe(
      'Failed: the address may not be reached from this server.',
    );
    expect(outcomeText(push({ state: 'delivered', externalId: null }))).toBe('Delivered to Jira.');
  });
});
