/**
 * The residency report's Phase D fleet counts (docs/specs/phase-d-contracts.md sections 7.2 and 13.4): devices,
 * online devices, unattended sessions, wake attempts, device actions and the AMT-over-plain-HTTP flag. The keys are
 * optional on the wire, so a node that does not send them must not grow an empty card.
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
    piiInChain: 'hashed with a per-org pepper; pepper destruction is the erasure mechanism (Phase E)',
    recordings: 'until deleted by an org_admin (Phase B endpoint)',
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

const card = async (title: string) => (await screen.findByText(title)).closest('section')!;

describe('residency report: fleet counts', () => {
  it('shows every fleet count, with the online devices and the AMT plain-HTTP warning', async () => {
    stub(fleet);
    render(<ResidencyPage />);
    const c = await card('Fleet (installed devices)');
    expect(within(c).getByText('Enrolled devices').closest('div')!.textContent).toContain('42');
    expect(within(c).getByText(/17 online now/)).toBeTruthy();
    expect(within(c).getByText('Unattended sessions (30 days)').closest('div')!.textContent).toContain('8');
    expect(within(c).getByText('Wake attempts (30 days)').closest('div')!.textContent).toContain('5');
    expect(within(c).getByText('Device actions (30 days)').closest('div')!.textContent).toContain('23');
    expect(within(c).getByText('3 device(s)')).toBeTruthy();
    expect(within(c).getByText(/without TLS/)).toBeTruthy();
  });

  it('says None when no device reaches AMT over plain HTTP', async () => {
    stub({ ...fleet, amtPlainHttpDevices: 0 });
    render(<ResidencyPage />);
    const c = await card('Fleet (installed devices)');
    expect(within(c).getByText('AMT over plain HTTP').closest('div')!.textContent).toContain('None');
    expect(within(c).queryByText(/without TLS/)).toBeNull();
  });

  it('leaves the card out when the server sends no fleet counts', async () => {
    stub(base);
    render(<ResidencyPage />);
    await screen.findByText('Holdings');
    expect(screen.queryByText('Fleet (installed devices)')).toBeNull();
    expect(hasFleet(base)).toBe(false);
    expect(hasFleet(fleet)).toBe(true);
  });
});
