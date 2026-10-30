/**
 * Playbook admin (Phase C section 13.4): the editor's client checks (required pattern, cmd lint refusal, PowerShell
 * warnings), the list with enable / disable, the requireSasConfirm policy toggle (GET / PATCH policy/agent).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybookEditor, draftProblems, emptyDraft } from '../src/assist/playbooks/PlaybookEditor';
import { PlaybooksPage } from '../src/assist/playbooks/PlaybooksPage';
import { IDS, ISO, jsonResponse } from './fakes';

afterEach(() => vi.unstubAllGlobals());

const pb = {
  id: IDS.other,
  name: 'Flush DNS cache',
  description: 'ipconfig /flushdns',
  interpreter: 'cmd',
  requiresElevation: false,
  parameters: [],
  timeoutSec: 30,
  enabled: true,
  bodyHash: 'c'.repeat(64),
  createdBy: { id: IDS.user, name: 'Anil K' },
  createdAt: ISO,
  updatedAt: ISO,
};

describe('PlaybookEditor', () => {
  it('requires a pattern for strings and refuses a cmd body that expands %IA_PARAM_ outside set', () => {
    const d = { ...emptyDraft(), name: 'Ping', interpreter: 'cmd' as const, body: 'ping %IA_PARAM_HOST%' };
    expect(draftProblems(d).join(' ')).toMatch(/set "x=%IA_PARAM_X%"/);
    const s = { ...d, body: 'set "h=%IA_PARAM_HOST%"\r\nping "%h%"', parameters: [{ name: 'host', label: 'Host', type: 'string' as const, required: true, pattern: '' }] };
    expect(draftProblems(s)).toEqual(['Parameter "host" needs a valid pattern.']);
    expect(draftProblems({ ...s, parameters: [{ ...s.parameters[0]!, pattern: '[a-z.]{1,64}' }] })).toEqual([]);
  });
  it('shows PowerShell lint warnings and saves', async () => {
    const onSave = vi.fn(async () => null);
    render(<PlaybookEditor initial={{ ...emptyDraft(), name: 'Clean', body: 'iex $x' }} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByText('iex runs text as code')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save playbook' }));
    expect(onSave).toHaveBeenCalled();
  });
});

describe('PlaybooksPage', () => {
  it('lists playbooks, disables one and toggles requireSasConfirm', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
        if (url.includes('/policy/agent')) return jsonResponse(200, { requireSasConfirm: method === 'PATCH' ? false : true });
        if (method === 'PATCH') return jsonResponse(200, { ...pb, enabled: false });
        return jsonResponse(200, { items: [pb], nextCursor: null });
      }),
    );
    render(<PlaybooksPage />);
    expect(await screen.findByText('Flush DNS cache')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(screen.getByText('disabled')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PATCH' && c.url.includes('/playbooks/'))?.body).toEqual({ enabled: false });
    const box = await screen.findByRole('checkbox', { name: /Require security-code confirmation/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    await userEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/policy/agent'))).toBe(true));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: /Require security-code confirmation/ }) as HTMLInputElement).checked).toBe(false));
  });
});
