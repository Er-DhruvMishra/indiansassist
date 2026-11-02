/**
 * The Phase E residency page (docs/specs/phase-e-contracts.md sections 6.1, 6.2, 6.4, 15.5): every B, C, D and E field
 * rendered with text states (never colour alone), recordings retention in words when a period is set (not the old
 * "until deleted" literal), no promised erasure mechanism, the signature block with the full public key, the print
 * stylesheet (A4 portrait, 12 mm, 9 pt), the signed download and the verify panel (published keys, a pasted key, a
 * tampered report, an extra unsigned field, an unknown key).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  kidOf,
  publicKeyFromSeed,
  publicKeyToBase64url,
  signResidencyReport,
  type DataFlow,
  type ResidencyReport,
} from '@indiansassist/shared';
import { RESIDENCY_PRINT_CSS, ResidencyPage, leavesRegionText, verifyReportText } from '../src/assist/ResidencyPage';
import { IDS, ISO, jsonResponse } from './fakes';

const SEED = '4'.repeat(64);
const OTHER_SEED = '5'.repeat(64);

const flows: DataFlow[] = [
  {
    kind: 'ai_provider',
    name: 'Anthropic (Claude)',
    host: 'api.anthropic.com',
    leavesInfrastructure: true,
    leavesRegion: 'yes',
    dataSent: 'redacted session events',
    enabled: true,
    since: '2026-10-30T08:15:00.000Z',
    enabledBy: 'Priya Admin',
    acknowledgement: { scope: 'outside_region', by: 'Priya Admin', at: '2026-10-30T08:15:00.000Z' },
  },
  {
    kind: 'ticketing',
    name: 'Jira Cloud',
    host: 'acme.atlassian.example',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: 'the ticket or note',
    enabled: true,
    since: '2026-10-29T08:00:00.000Z',
    enabledBy: 'Priya Admin',
    acknowledgement: null,
  },
  {
    kind: 'ticketing',
    name: 'Freshdesk',
    host: 'acme.freshdesk.com',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: 'the ticket or note',
    enabled: false,
    since: null,
    enabledBy: null,
    acknowledgement: null,
  },
  {
    kind: 'sso_idp',
    name: 'Okta (OIDC)',
    host: 'acme.okta.example',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: "sign-in requests; the IdP returns the user's email and name",
    enabled: true,
    since: null,
    enabledBy: null,
    acknowledgement: null,
  },
  {
    kind: 'recorder',
    name: 'Server recorder',
    host: null,
    leavesInfrastructure: false,
    leavesRegion: 'no',
    dataSent: 'the media of recorded sessions, stored in the region bucket',
    enabled: true,
    since: null,
    enabledBy: 'operator',
    acknowledgement: null,
  },
];

const unsigned: ResidencyReport = {
  org: { id: IDS.org, name: 'Acme IT Pvt Ltd', slug: 'acme-it', dataRegion: 'in-mum' },
  generatedAt: ISO,
  servedBy: { region: 'in-mum', apiOrigin: 'https://in.example', nodeId: 'node-1' },
  storage: { driver: 's3', bucket: 'ia-in', prefix: `in-mum/${IDS.org}/` },
  ice: { stunUrls: ['stun:turn.in.example:3478'], turnUrls: [], thirdPartyHosts: [] },
  counts: { users: 4, tokens: 9, sessions: 12, recordings: 2, recordingBytes: 2048, auditEntries: 300 },
  chain: { length: 300, tail: 'a'.repeat(64), lastVerifiedAt: ISO, lastVerifiedOk: true, lastAnchor: null },
  extensionPolicy: { allowRelayFallback: true, recordRevealed: false },
  relaySessions: 6,
  relayBytes: 4096,
  recordingRetentionDays: 90,
  agentSessions: 11,
  elevationGrants: 3,
  playbookRuns: 14,
  devices: 2,
  onlineDevices: 1,
  unattendedSessions30d: 7,
  wakeAttempts30d: 1,
  deviceActions30d: 4,
  amtPlainHttpDevices: 0,
  retention: {
    auditEntries: 'append-only, never deleted',
    piiInChain: 'Personal data in the audit chain is stored only as hashes with a per-org pepper. Erasure by destroying the pepper is not implemented.',
    recordings: 'deleted 90 days after recording (org setting)',
  },
  statement:
    'All session metadata, recordings and audit entries for Acme IT Pvt Ltd are stored and served in India (Mumbai). Redacted session summaries are processed by Anthropic (Claude), outside India (Mumbai), acknowledged by Priya Admin on 2026-10-30.',
  dataCategories: [
    { category: 'identity', stores: [{ kind: 'database', region: 'in-mum', detail: 'PostgreSQL of in-mum: users' }], retention: 'kept while the organisation exists', count: 4, bytes: null },
    { category: 'sessions', stores: [{ kind: 'database', region: 'in-mum', detail: 'PostgreSQL of in-mum: sessions' }], retention: 'kept while the organisation exists', count: 12, bytes: null },
    { category: 'recordings', stores: [{ kind: 'object_store', region: 'in-mum', detail: `bucket ia-in, prefix in-mum/${IDS.org}/` }], retention: 'deleted 90 days after recording (org setting)', count: 2, bytes: 2048 },
    { category: 'audit', stores: [{ kind: 'database', region: 'in-mum', detail: 'PostgreSQL of in-mum: audit' }], retention: 'append-only, never deleted', count: 300, bytes: null },
    { category: 'files', stores: [{ kind: 'database', region: 'in-mum', detail: 'names, sizes and hashes of transfers only' }], retention: 'kept while the organisation exists', count: 5, bytes: null },
    {
      category: 'fleet',
      stores: [
        { kind: 'database', region: 'in-mum', detail: 'PostgreSQL of in-mum: devices' },
        { kind: 'device', region: 'in-mum', detail: 'session receipts kept on each device' },
      ],
      retention: 'kept while the organisation exists',
      count: 2,
      bytes: null,
    },
    { category: 'summaries', stores: [{ kind: 'database', region: 'in-mum', detail: 'PostgreSQL of in-mum: summaries' }], retention: 'kept with the session record', count: 3, bytes: null },
    { category: 'tickets', stores: [{ kind: 'database', region: 'in-mum', detail: 'PostgreSQL of in-mum: push records' }], retention: 'kept with the session record', count: 2, bytes: null },
  ],
  dataFlows: flows,
  subprocessors: ['Anthropic (Claude)', 'Jira Cloud', 'Okta (OIDC)'],
  activity30d: { summaries: 9, ticketPushes: 8, ssoLogins: 21 },
  sso: { protocol: 'oidc', enabled: true, required: true, verifiedDomains: ['acme.example'] },
  recorder: { enabled: true },
  erasure: { available: false, note: 'Destroying the per-org pepper to erase hashed personal data is not implemented. Personal data in the audit chain is stored only as peppered hashes.' },
};

let signed: ResidencyReport & { signature: NonNullable<ResidencyReport['signature']> };
let key: { kid: string; pub: string };
let other: { kid: string; pub: string };

beforeAll(async () => {
  const pub = await publicKeyFromSeed(SEED);
  key = { kid: kidOf(pub), pub: publicKeyToBase64url(pub) };
  const opub = await publicKeyFromSeed(OTHER_SEED);
  other = { kid: kidOf(opub), pub: publicKeyToBase64url(opub) };
  signed = (await signResidencyReport(unsigned, SEED, key.kid)) as typeof signed;
});

const fetchCalls: string[] = [];

function stubApi(report: ResidencyReport, wellKnownKeys: { kid: string; pub: string }[] = [key]) {
  fetchCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.endsWith('/.well-known/indiansassist.json')) return jsonResponse(200, { v: 1, keys: wellKnownKeys.map((k) => ({ ...k, alg: 'Ed25519' })) });
      if (url.endsWith('/orgs/current/residency/signed.json'))
        return new Response(JSON.stringify(report, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="residency-acme-it-2026-10-23.json"' },
        });
      if (url.endsWith('/orgs/current/residency')) return jsonResponse(200, report);
      return jsonResponse(404, { error: { code: 'not_found', message: url } });
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal('print', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const card = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('section')!;
const row = (c: HTMLElement, label: string) => within(c).getByText(label).closest('div')!;

describe('residency page: every field, in words', () => {
  it('the header shows the region badge with text, the signer kid, the full public key and the full sha256', async () => {
    stubApi(signed);
    render(<ResidencyPage />);
    const c = await card('Report');
    expect(row(c, 'Data region').textContent).toContain('Data region: India (Mumbai)');
    expect(row(c, 'Signed by key').textContent).toContain(signed.signature.kid);
    expect(row(c, 'Public key').textContent).toContain(signed.signature.pub);
    expect(row(c, 'Report sha256').textContent).toContain(signed.signature.sha256);
    const sig = signed.signature.sig;
    expect(row(c, 'Signature').textContent).toContain(`${sig.slice(0, 8)}...${sig.slice(-8)}`);
    expect(screen.getByText(/acknowledged by Priya Admin on 2026-10-30/)).toBeTruthy();
  });

  it('where your data lives: one row per category with store, region, retention and count', async () => {
    stubApi(signed);
    render(<ResidencyPage />);
    const c = await card('Where your data lives');
    const rows = within(c).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'Identity',
      'Sessions',
      'Recordings',
      'Audit log',
      'File transfers',
      'Fleet devices',
      'AI summaries',
      'Ticket pushes',
    ]);
    expect(rows[2]!.textContent).toContain('Object storage, in-mum');
    expect(rows[2]!.textContent).toContain('deleted 90 days after recording (org setting)');
    expect(rows[2]!.textContent).toContain('2 (2.0 KiB)');
    expect(rows[5]!.textContent).toContain('On the device');
  });

  it('data that leaves the region: words for leavesRegion, status, acknowledgement and subprocessors', async () => {
    stubApi(signed);
    render(<ResidencyPage />);
    const c = await card('Data that leaves the region');
    const rows = within(c).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.textContent).toContain('Leaves the region');
    expect(rows[0]!.textContent).toContain('third party');
    expect(rows[0]!.textContent).toMatch(/Acknowledged \(outside the region\) by Priya Admin, 2026-10-30/);
    expect(rows[1]!.textContent).toContain('Location unknown');
    expect(rows[1]!.textContent).toContain('by Priya Admin');
    expect(rows[2]!.textContent).toContain('Configured, disabled');
    expect(rows[4]!.textContent).toContain('Stays in the region');
    expect(rows[4]!.textContent).toContain('this deployment');
    expect(within(c).getByText(/Subprocessors/).closest('p')!.textContent).toContain('Anthropic (Claude), Jira Cloud, Okta (OIDC)');
    expect(leavesRegionText('yes')).toBe('Leaves the region');
  });

  it('activity in the last 30 days: relay, agent, elevation, playbooks, unattended, wakes, actions, summaries, tickets, SSO', async () => {
    stubApi(signed);
    render(<ResidencyPage />);
    const c = await card('Activity in the last 30 days');
    const want: [string, string][] = [
      ['Relayed sessions (WS relay)', '6'],
      ['Agent sessions', '11'],
      ['Elevation grants', '3'],
      ['Playbook runs', '14'],
      ['Unattended sessions', '7'],
      ['Wake attempts', '1'],
      ['Device actions', '4'],
      ['AI summaries', '9'],
      ['Ticket pushes', '8'],
      ['SSO sign-ins', '21'],
    ];
    for (const [label, n] of want) expect(row(c, label).textContent).toContain(n);
    expect(row(c, 'Relayed sessions (WS relay)').textContent).toContain('4.0 KiB');
  });

  it('policies: relay fallback, revealed-field recording, retention in words, SSO required, AI provider', async () => {
    stubApi(signed);
    render(<ResidencyPage />);
    const c = await card('Policies');
    expect(row(c, 'Extension relay fallback').textContent).toContain('Allowed');
    expect(row(c, 'Revealed-field recording').textContent).toContain('Not recorded');
    expect(row(c, 'Recording retention').textContent).toContain('deleted 90 days after recording (org setting)');
    expect(row(c, 'Single sign-on').textContent).toContain('OIDC, enabled, required for sign-in; verified domains: acme.example');
    expect(row(c, 'AI provider').textContent).toContain('Anthropic (Claude)');
    expect(row(c, 'Server recorder').textContent).toContain('Enabled on this node');
    // The old literal claimed "until deleted" even with a retention period set.
    expect(screen.queryByText(/until deleted by an org_admin/)).toBeNull();
  });

  it('the audit chain and erasure: honest about the missing erasure mechanism', async () => {
    stubApi(signed);
    render(<ResidencyPage />);
    const c = await card('Audit chain and erasure');
    expect(row(c, 'Entries').textContent).toContain('300 (append-only, never deleted)');
    expect(row(c, 'Last verified').textContent).toContain('intact');
    expect(row(c, 'Erasure').textContent).toContain('Not available');
    expect(row(c, 'Erasure').textContent).toContain('is not implemented');
    expect(row(c, 'Personal data in the chain').textContent).toContain('Erasure by destroying the pepper is not implemented.');
    expect(document.body.textContent).not.toMatch(/pepper destruction is the erasure mechanism/);
  });

  it('an older server without the Phase E fields still renders, with no empty Phase E rows', async () => {
    const { dataCategories: _c, dataFlows: _f, subprocessors: _s, activity30d: _a, sso: _o, recorder: _r, erasure: _e, ...old } = unsigned;
    stubApi({ ...old, recordingRetentionDays: null, retention: { ...old.retention, recordings: 'until deleted by an org_admin' } });
    render(<ResidencyPage />);
    await card('Data that leaves the region');
    expect(screen.queryByRole('heading', { name: 'Where your data lives' })).toBeNull();
    expect(screen.getByText('This server does not sign its reports.')).toBeTruthy();
    expect(screen.queryByText('SSO sign-ins')).toBeNull();
    expect(screen.queryByText('AI provider')).toBeNull();
  });

  it('the print stylesheet: A4 portrait, 12 mm margins, 9 pt, buttons and the verify panel hidden', async () => {
    stubApi(signed);
    const { container } = render(<ResidencyPage />);
    await card('Report');
    const css = Array.from(container.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    expect(css).toBe(RESIDENCY_PRINT_CSS);
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/@page \{ size: A4 portrait; margin: 12mm; \}/);
    expect(css).toMatch(/font-size: 9pt/);
    for (const name of ['Print', 'Download signed JSON', 'Verify a report']) expect(screen.getByRole('button', { name }).className).toContain('no-print');
  });
});

describe('residency page: download and verify', () => {
  it('Print calls window.print', async () => {
    stubApi(signed);
    render(<ResidencyPage />);
    await card('Report');
    await userEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(window.print).toHaveBeenCalled();
  });

  it('Download signed JSON saves the signed.json body under the server file name', async () => {
    stubApi(signed);
    const created: Blob[] = [];
    const urlApi = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
    const saved = { create: urlApi.createObjectURL, revoke: urlApi.revokeObjectURL };
    urlApi.createObjectURL = (b: Blob) => (created.push(b), 'blob:residency');
    urlApi.revokeObjectURL = () => undefined;
    const clicks: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    };
    try {
      render(<ResidencyPage />);
      await card('Report');
      await userEvent.click(screen.getByRole('button', { name: 'Download signed JSON' }));
      await waitFor(() => expect(clicks).toEqual(['residency-acme-it-2026-10-23.json']));
      expect(fetchCalls.some((u) => u.endsWith('/api/v1/orgs/current/residency/signed.json'))).toBe(true);
      const text = await new Promise<string>((done) => {
        const fr = new FileReader();
        fr.onload = () => done(String(fr.result));
        fr.readAsText(created[0]!);
      });
      expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(signed)));
    } finally {
      HTMLAnchorElement.prototype.click = orig;
      urlApi.createObjectURL = saved.create;
      urlApi.revokeObjectURL = saved.revoke;
    }
  });

  it('Verify a report: a pasted signed report verifies against the published keys', async () => {
    stubApi(signed, [key, other]);
    render(<ResidencyPage />);
    await card('Report');
    const toggle = screen.getByRole('button', { name: 'Verify a report' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const box = screen.getByLabelText('Signed report JSON');
    await userEvent.click(box);
    await userEvent.paste(JSON.stringify(signed, null, 2));
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/^Verified: the report for Acme IT Pvt Ltd/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`signed by key ${signed.signature.kid}`))).toBeTruthy();
    expect(fetchCalls.some((u) => u.endsWith('/.well-known/indiansassist.json'))).toBe(true);
  });

  it('Verify a report: a tampered report and a report with an extra field are refused, in words', async () => {
    stubApi(signed);
    render(<ResidencyPage />);
    await card('Report');
    await userEvent.click(screen.getByRole('button', { name: 'Verify a report' }));
    const box = screen.getByLabelText('Signed report JSON');
    await userEvent.click(box);
    await userEvent.paste(JSON.stringify({ ...signed, statement: 'Nothing ever leaves India.' }));
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Not verified: its content or signature was changed after signing.')).toBeTruthy();
    await userEvent.clear(box);
    await userEvent.paste(JSON.stringify({ ...signed, addedLater: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Not verified: its content or signature was changed after signing.')).toBeTruthy();
  });

  it('Verify a report: against a pasted public key; the wrong key is reported as not in the list', async () => {
    stubApi(signed);
    render(<ResidencyPage />);
    await card('Report');
    await userEvent.click(screen.getByRole('button', { name: 'Verify a report' }));
    await userEvent.click(screen.getByLabelText('Signed report JSON'));
    await userEvent.paste(JSON.stringify(signed));
    await userEvent.click(screen.getByRole('radio', { name: 'A public key I paste' }));
    const pub = screen.getByLabelText('Public key (base64url)');
    await userEvent.type(pub, other.pub);
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Not verified: it was signed by a key that is not in the key list.')).toBeTruthy();
    await userEvent.clear(pub);
    await userEvent.type(pub, key.pub);
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/^Verified:/)).toBeTruthy();
    await userEvent.clear(pub);
    await userEvent.type(pub, 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/the public key is not a base64url Ed25519 key/)).toBeTruthy();
  });

  it('verifyReportText works over the raw JSON text', () => {
    expect(verifyReportText(JSON.stringify(signed), [key]).ok).toBe(true);
    expect(verifyReportText('{', [key])).toEqual({ ok: false, text: 'Not verified: the text is not JSON.' });
    const { signature: _s, ...bare } = signed;
    expect(verifyReportText(JSON.stringify(bare), [key])).toEqual({ ok: false, text: 'Not verified: it is not a signed residency report.' });
  });
});
