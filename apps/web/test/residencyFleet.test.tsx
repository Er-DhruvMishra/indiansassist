/**
 * The residency report's Phase D fleet counts (docs/specs/phase-d-contracts.md sections 7.2 and 13.4): devices,
 * online devices, unattended sessions, wake attempts, device actions and the AMT-over-plain-HTTP flag. The keys are
 * optional on the wire, so a node that does not send them must not grow empty rows. Since Phase E (section 6.4) they
 * sit in "Activity in the last 30 days" (the enrolled devices as a current count).
 * The retention texts are the Phase E strings (6.2e: the two `retention` literals were widened).
 */
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResidencyReport } from '@indiansassist/shared';
import { ResidencyPage, hasFleet } from '../src/assist/ResidencyPage';
import { IDS, ISO, jsonResponse } from './fakes';

const base: ResidencyReport = {
  org: { id: IDS.org, name: 'Acme IT Pvt Ltd', slug: 'acme-it', dataRegion: 'in-mum' },
  generatedAt: ISO,
  servedBy: { region: 'in-mum', apiOrigin: 'https://in.example', nodeId: 'node-1' },
  storage: { driver: 's3', bucket: 'ia-in', prefix: 'in-mum/org/' },
  ice: { stunUrls: [], turnUrls: [], thirdPartyHosts: [] },
  counts: { users: 4, tokens: 9, sessions: 12, recordings: 2, recordingBytes: 2048, auditEntries: 300 },
  chain: { length: 300, tail: 'a'.repeat(64), lastVerifiedAt: null, lastVerifiedOk: null, lastAnchor: null },
  retention: {
    auditEntries: 'append-only, never deleted',
    piiInChain: 'Personal data in the audit chain is stored only as hashes with a per-org pepper. Erasure by destroying the pepper is not implemented.',
    recordings: 'until deleted by an org_admin',
  },
  statement: 'All session metadata, recordings and audit entries for Acme IT Pvt Ltd are stored and served in India (Mumbai).',
};

const fleet: ResidencyReport = {
  ...base,
  devices: 42,
  onlineDevices: 17,
  unattendedSessions30d: 8,
  wakeAttempts30d: 5,
  deviceActions30d: 23,
  amtPlainHttpDevices: 3,
};

function stub(report: ResidencyReport) {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, report)));
}

beforeEach(() => {
  vi.stubGlobal('print', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const card = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('section')!;
const row = (c: HTMLElement, label: string) => within(c).getByText(label).closest('div')!;

describe('residency report: fleet counts', () => {
  it('shows every fleet count, with the online devices and the AMT plain-HTTP warning', async () => {
    stub(fleet);
    render(<ResidencyPage />);
    const activity = await card('Activity in the last 30 days');
    expect(row(activity, 'Enrolled devices').textContent).toContain('42');
    expect(within(activity).getByText(/17 online now/)).toBeTruthy();
    expect(within(activity).getByText('3 device(s)')).toBeTruthy();
    expect(within(activity).getByText(/without TLS/)).toBeTruthy();
    expect(row(activity, 'Unattended sessions').textContent).toContain('8');
    expect(row(activity, 'Wake attempts').textContent).toContain('5');
    expect(row(activity, 'Device actions').textContent).toContain('23');
  });

  it('says None when no device reaches AMT over plain HTTP', async () => {
    stub({ ...fleet, amtPlainHttpDevices: 0 });
    render(<ResidencyPage />);
    const c = await card('Activity in the last 30 days');
    expect(row(c, 'AMT over plain HTTP').textContent).toContain('None');
    expect(within(c).queryByText(/without TLS/)).toBeNull();
  });

  it('leaves the fleet rows out when the server sends no fleet counts', async () => {
    stub(base);
    render(<ResidencyPage />);
    const c = await card('Activity in the last 30 days');
    expect(within(c).queryByText('Enrolled devices')).toBeNull();
    expect(within(c).queryByText('Wake attempts')).toBeNull();
    expect(hasFleet(base)).toBe(false);
    expect(hasFleet(fleet)).toBe(true);
  });
});
