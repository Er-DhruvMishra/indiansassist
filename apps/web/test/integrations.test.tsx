/**
 * Phase E section 15.3 web: the integrations page (section 13.4). One card per type; write-only credentials (password
 * fields, blank keeps the saved value, never pre-filled); Test with its result announced; the webhook secret shown once
 * with the verification snippet; Delete behind a confirmation; auditors read-only. Phase F section 3.3 (fixes): Zoho
 * offers exactly the verified data centres, and each vendor card carries the unverified note with its items.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTEGRATION_VERIFICATION, ZOHO_DATA_CENTERS, type AuthResponse, type Integration, type UserRole } from '@indiansassist/shared';
import { MemoryRouter } from 'react-router';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { configOf, IntegrationsPage, WEBHOOK_VERIFY_SNIPPET } from '../src/assist/integrations/IntegrationsPage';
import { IDS, ISO, jsonResponse } from './fakes';

afterEach(() => vi.unstubAllGlobals());

function authAs(role: UserRole): AuthValue {
  const me: AuthResponse = {
    user: { id: IDS.user, orgId: IDS.org, email: 'admin@acme.test', name: 'Meera A', role, status: 'active', createdAt: ISO, lastLoginAt: ISO },
    org: { id: IDS.org, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p1_browser', branding: { displayName: 'Acme IT' }, createdAt: ISO },
    seat: null,
  };
  return { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };
}

const JIRA: Integration = {
  type: 'jira',
  enabled: true,
  config: { siteUrl: 'https://acme.atlassian.net', deployment: 'cloud', projectKey: 'OPS', issueType: 'Task', labels: ['remote'] },
  credentials: { set: true, setAt: ISO, fingerprint: 'a1b2c3d4' },
  lastTest: { at: ISO, ok: true, cause: null },
  updatedAt: ISO,
  updatedBy: { id: IDS.user, name: 'Meera A' },
};

type Call = { url: string; method: string; body?: unknown };

function stub(handler: (c: Call) => Response | undefined, initial: Integration[] = [JIRA]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c: Call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined };
      calls.push(c);
      return handler(c) ?? (c.method === 'GET' && c.url.endsWith('/integrations') ? jsonResponse(200, { items: initial }) : jsonResponse(404, { error: { code: 'not_found', message: 'nope' } }));
    }),
  );
  return calls;
}

function renderPage(role: UserRole = 'org_admin') {
  return render(
    <MemoryRouter>
      <StaticAuthProvider value={authAs(role)}>
        <IntegrationsPage />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
}

const card = (name: string) => screen.getByRole('heading', { name }).closest('section') as HTMLElement;

describe('IntegrationsPage', () => {
  it('shows one card per type with states in words and the credentials only as a fingerprint', async () => {
    stub(() => undefined);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Jira' })).toBeTruthy();
    for (const n of ['Zoho Desk', 'ServiceNow', 'Freshdesk', 'Webhook']) expect(screen.getByRole('heading', { name: n })).toBeTruthy();
    const jira = card('Jira');
    expect(within(jira).getByText('Enabled')).toBeTruthy();
    expect(within(jira).getByText('Leaves the region when used')).toBeTruthy();
    expect(within(jira).getByText(/Set, fingerprint a1b2c3d4/)).toBeTruthy();
    expect(within(card('ServiceNow')).getByText('Not configured')).toBeTruthy();
    // Credentials are write-only: password fields, empty.
    const token = within(jira).getByLabelText('API token') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(token.value).toBe('');
    expect(within(jira).getByText(/Leave these blank to keep them/)).toBeTruthy();
    // Zoho offers exactly the verified data centres (Phase F section 3.3 V6).
    const zoho = card('Zoho Desk');
    expect(within(zoho).queryByText(/no Zoho data centre has been verified/)).toBeNull();
    const dc = within(zoho).getByLabelText('Data centre') as HTMLSelectElement;
    expect([...dc.options].map((o) => o.value)).toEqual(ZOHO_DATA_CENTERS.map((d) => d.id));
    expect(within(zoho).getByRole('button', { name: 'Save Zoho Desk' })).toBeTruthy();
  });

  it('says on each vendor card when its request format is not fully verified, and lists the items (section 3.3 V5)', async () => {
    stub(() => undefined);
    renderPage();
    await screen.findByRole('heading', { name: 'Jira' });
    const vendors = { 'Zoho Desk': ['zoho_desk', 'Zoho'], ServiceNow: ['servicenow', 'ServiceNow'], Jira: ['jira', 'Atlassian'], Freshdesk: ['freshdesk', 'Freshdesk'] } as const;
    for (const [title, [type, vendor]] of Object.entries(vendors)) {
      const v = INTEGRATION_VERIFICATION[type];
      const note = within(card(title)).queryByRole('note');
      if (v.verified) {
        expect(note, title).toBeNull();
        continue;
      }
      const n = v.unconfirmed.length;
      expect(note!.textContent).toContain(
        `This request format has not been fully verified against ${vendor}'s documentation (${n} ${n === 1 ? 'item' : 'items'}). Use Test before relying on it.`,
      );
      expect(within(note!).getAllByRole('listitem').map((li) => li.textContent)).toEqual([...v.unconfirmed]);
    }
    // The webhook is ours: no vendor note.
    expect(within(card('Webhook')).queryByRole('note')).toBeNull();
  });

  it('saves without credentials when they are left blank, and with them when typed', async () => {
    const calls = stub((c) => (c.method === 'PUT' ? jsonResponse(200, JIRA) : undefined));
    renderPage();
    await screen.findByRole('heading', { name: 'Jira' });
    const jira = card('Jira');
    await userEvent.clear(within(jira).getByLabelText('Project key'));
    await userEvent.type(within(jira).getByLabelText('Project key'), 'SEC');
    await userEvent.click(within(jira).getByRole('button', { name: 'Save Jira' }));
    await waitFor(() => expect(within(jira).getByText('Jira saved.')).toBeTruthy());
    const first = calls.find((c) => c.method === 'PUT')!;
    expect(first.url).toMatch(/\/integrations\/jira$/);
    expect(first.body).toEqual({ enabled: true, config: { siteUrl: 'https://acme.atlassian.net', deployment: 'cloud', projectKey: 'SEC', issueType: 'Task', labels: ['remote'] } });
    await userEvent.type(within(jira).getByLabelText('Account email'), 'bot@acme.test');
    await userEvent.type(within(jira).getByLabelText('API token'), 'tok');
    await userEvent.click(within(jira).getByRole('button', { name: 'Save Jira' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PUT')[1]!.body).toMatchObject({ credentials: { email: 'bot@acme.test', apiToken: 'tok' } });
    // The typed secret is cleared from the form after saving.
    await waitFor(() => expect((within(jira).getByLabelText('API token') as HTMLInputElement).value).toBe(''));
  });

  it('announces an honest test result and an egress refusal', async () => {
    stub((c) => {
      if (c.url.endsWith('/integrations/jira/test')) return jsonResponse(200, { ok: false, cause: 'auth', detail: 'HTTP 401', account: null });
      if (c.method === 'PUT') return jsonResponse(400, { error: { code: 'egress_refused', message: 'this address may not be reached from the server', details: { cause: 'private_address' } } });
      return undefined;
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Jira' });
    const jira = card('Jira');
    await userEvent.click(within(jira).getByRole('button', { name: 'Test Jira' }));
    expect(await within(jira).findByText('Test failed: the credentials were refused (HTTP 401).')).toBeTruthy();
    await userEvent.click(within(jira).getByRole('button', { name: 'Save Jira' }));
    expect(await within(jira).findByText(/Jira was not saved: .*private_address/)).toBeTruthy();
  });

  it('shows the new webhook secret once, with the verification snippet, and rotates it', async () => {
    const secret = 'A'.repeat(43);
    const hook: Integration = { ...JIRA, type: 'webhook', config: { origin: 'https://hooks.example.test', pathSet: true }, lastTest: null };
    stub((c) => {
      if (c.method === 'PUT') return jsonResponse(201, { integration: hook, secret });
      if (c.url.endsWith('/rotate-secret')) return jsonResponse(200, { secret: 'B'.repeat(43) });
      return undefined;
    }, []);
    renderPage();
    await screen.findByRole('heading', { name: 'Webhook' });
    const wh = card('Webhook');
    await userEvent.type(within(wh).getByLabelText('Webhook URL'), 'https://hooks.example.test/T0/B0/secret');
    await userEvent.click(within(wh).getByRole('button', { name: 'Save Webhook' }));
    expect((await within(wh).findByTestId('webhook-secret')).textContent).toBe(secret);
    expect(within(wh).getByText(/shown only now/)).toBeTruthy();
    expect(within(wh).getByText('How the receiver verifies a delivery')).toBeTruthy();
    expect(WEBHOOK_VERIFY_SNIPPET).toContain("Buffer.from(secret, 'base64url')");
  });

  it('deletes only after confirmation', async () => {
    const calls = stub((c) => (c.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined));
    renderPage();
    await screen.findByRole('heading', { name: 'Jira' });
    const jira = card('Jira');
    await userEvent.click(within(jira).getByRole('button', { name: 'Delete Jira' }));
    expect(within(jira).getByText(/Pushes still pending or retrying will fail/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(jira).getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/integrations/jira'))).toBe(true));
    expect(await within(jira).findByText('Jira deleted.')).toBeTruthy();
  });

  it('auditors see the cards read-only', async () => {
    stub(() => undefined);
    renderPage('auditor');
    await screen.findByRole('heading', { name: 'Jira' });
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.queryByLabelText('API token')).toBeNull();
    expect(within(card('Jira')).getByText(/Set, fingerprint a1b2c3d4/)).toBeTruthy();
  });

  it('builds typed configs from the form strings', () => {
    expect(configOf('servicenow', { instanceUrl: ' https://x.service-now.com ', callerId: '', assignmentGroup: '', urgency: '2' })).toEqual({
      instanceUrl: 'https://x.service-now.com',
      callerId: null,
      assignmentGroup: null,
      urgency: 2,
    });
    expect(configOf('freshdesk', { domain: 'acme', defaultRequesterEmail: 'a@b.test', priority: '4', groupId: '' })).toEqual({ domain: 'acme', defaultRequesterEmail: 'a@b.test', priority: 4, groupId: null });
    expect(configOf('jira', { siteUrl: 'https://a.atlassian.net', deployment: 'data_center', projectKey: 'OPS', issueType: '', labels: 'a, b,,' })).toMatchObject({ deployment: 'data_center', issueType: 'Task', labels: ['a', 'b'] });
  });
});
