/**
 * Phase E sections 5.3a-b, 5.8e, 13.4 (stream ai): the summary panel (states in words, edit and save against the
 * base version, the redaction-detector warning, version history, the fallback and chat-included notes) and the
 * transcript hook (the notice sent once at `live`, the post-notice chat and playbook tails redacted with one state
 * and uploaded at the end).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiSessionSummary, AuthResponse, SessionDetail, SessionSummaryOutput, UserRole } from '@indiansassist/shared';
import { emptyRedactionCounts } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { SummaryPanel, detectRedactions } from '../src/assist/summary/SummaryPanel';
import { registerLiveConsole, type LiveChatItem, type LiveConsoleHandle, type LiveRun } from '../src/assist/summary/liveConsoles';
import { attachTranscriptHook, buildTranscriptUpload, loadNotice, tailLines } from '../src/assist/summary/useEnterpriseLiveHooks';
import { IDS, ISO, jsonResponse } from './fakes';

afterEach(() => vi.unstubAllGlobals());

function authAs(role: UserRole): AuthValue {
  const me: AuthResponse = {
    user: { id: IDS.user, orgId: IDS.org, email: 'anil@acme.test', name: 'Anil K', role, status: 'active', createdAt: ISO, lastLoginAt: ISO },
    org: { id: IDS.org, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p1_browser', branding: {}, createdAt: ISO },
    seat: null,
  } as AuthResponse;
  return { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };
}

const OUTPUT: SessionSummaryOutput = {
  summary: 'The technician cleared the print queue.',
  outcome: 'resolved',
  actionsTaken: ['Restarted the spooler'],
  issuesFound: ['Stuck print job'],
  followUps: [],
  ticketNote: 'Cleared the queue and restarted the spooler.',
};

function version(v: number, over: Partial<AiSessionSummary> = {}): AiSessionSummary {
  return {
    id: `6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a${String(v).padStart(2, '0')}`,
    sessionId: IDS.session,
    version: v,
    state: 'ready',
    trigger: 'session_end',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    servedModel: 'claude-opus-5-5',
    inferenceGeo: 'global',
    fallbackUsed: false,
    transcriptIncluded: false,
    normalised: false,
    redactions: { ...emptyRedactionCounts(), email: 2 },
    sha256: 'a'.repeat(64),
    inputSha256: 'b'.repeat(64),
    cause: null,
    attempts: 1,
    createdBy: null,
    editedBy: null,
    createdAt: ISO,
    completedAt: ISO,
    output: OUTPUT,
    ...over,
  };
}
const meta = (s: AiSessionSummary) => {
  const { output: _o, ...m } = s;
  void _o;
  return m;
};

type Route = (url: string, method: string, body: unknown) => Response | undefined;
function stubApi(route: Route) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/orgs/current/ai-policy')) return jsonResponse(200, { provider: 'anthropic', autoSummarize: true, includeTranscript: true, anthropicAck: null });
      return route(url, method, body) ?? jsonResponse(404, { error: { code: 'not_found', message: 'no' } });
    }),
  );
  return calls;
}

const ended = { id: IDS.session, state: 'ended' } as unknown as SessionDetail;
const renderPanel = (role: UserRole = 'technician') =>
  render(
    <StaticAuthProvider value={authAs(role)}>
      <SummaryPanel session={ended} />
    </StaticAuthProvider>,
  );

describe('SummaryPanel', () => {
  it('renders nothing for a session that has not ended, or for an observer', () => {
    const { container } = render(
      <StaticAuthProvider value={authAs('technician')}>
        <SummaryPanel session={{ id: IDS.session, state: 'active' } as unknown as SessionDetail} />
      </StaticAuthProvider>,
    );
    expect(container.textContent).toBe('');
    stubApi(() => undefined);
    const obs = renderPanel('observer');
    expect(obs.container.textContent).toBe('');
  });

  it('shows the state in words, the fallback and chat notes, and the version history', async () => {
    const v1 = version(1, { fallbackUsed: true, servedModel: 'claude-opus-5', transcriptIncluded: true });
    const v2 = version(2, { trigger: 'edit', editedBy: { id: IDS.user, name: 'Anil K' }, output: { ...OUTPUT, summary: 'Edited text.' } });
    const calls = stubApi((url) => {
      if (url.endsWith(`/sessions/${IDS.session}/summary`)) return jsonResponse(200, { latest: v1, versions: [meta(v1)] });
      if (url.endsWith('/summary/versions/1')) return jsonResponse(200, v1);
      return undefined;
    });
    renderPanel();
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByText('Generated by claude-opus-5 after a fallback.')).toBeTruthy();
    expect(screen.getByText('chat included')).toBeTruthy();
    expect(screen.getByText(/Removed before sending: 2 email/)).toBeTruthy();
    expect(screen.getByText(/not reliably detected and are not removed/)).toBeTruthy();
    await userEvent.click(screen.getByText(/Version history/));
    await userEvent.click(screen.getByRole('button', { name: 'View version 1' }));
    const view = await screen.findByRole('region', { name: 'Version 1' });
    expect(within(view).getByText(OUTPUT.summary)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/summary/versions/1'))).toBe(true);
    void v2;
  });

  it('saves an edit against the base version, warning first when the detector finds personal data', async () => {
    const v1 = version(1);
    let latest: AiSessionSummary = v1;
    const calls = stubApi((url, method, body) => {
      if (url.endsWith(`/sessions/${IDS.session}/summary`) && method === 'GET') return jsonResponse(200, { latest, versions: [meta(v1)] });
      if (url.endsWith(`/sessions/${IDS.session}/summary`) && method === 'PUT') {
        latest = version(2, { trigger: 'edit', output: (body as { output: SessionSummaryOutput }).output });
        return jsonResponse(200, latest);
      }
      return undefined;
    });
    renderPanel();
    const summary = (await screen.findByLabelText('Summary')) as HTMLTextAreaElement;
    expect(summary.value).toBe(OUTPUT.summary);
    await userEvent.clear(summary);
    await userEvent.type(summary, 'Called the user at priya@example.com afterwards.');
    await userEvent.click(screen.getByRole('button', { name: 'Save as a new version' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/1 email/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.click(within(alert).getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ baseVersion: 1, output: { ...OUTPUT, summary: 'Called the user at priya@example.com afterwards.' } });
    expect(await screen.findByText('Saved as version 2.')).toBeTruthy();
  });

  it('regenerates, polls while pending, and explains a failure in words', async () => {
    let state: 'none' | 'pending' | 'failed' = 'none';
    const calls = stubApi((url, method) => {
      if (url.endsWith(`/sessions/${IDS.session}/summary`) && method === 'POST') {
        state = 'pending';
        return jsonResponse(202, { summary: version(1, { state: 'pending', output: null, completedAt: null, servedModel: null }) });
      }
      if (url.endsWith(`/sessions/${IDS.session}/summary`)) {
        if (state === 'none') return jsonResponse(200, { latest: null, versions: [] });
        const v = version(1, state === 'pending' ? { state: 'pending', output: null, servedModel: null } : { state: 'failed', cause: 'refused', output: null, servedModel: null });
        state = 'failed';
        return jsonResponse(200, { latest: v, versions: [meta(v)] });
      }
      return undefined;
    });
    renderPanel();
    expect(await screen.findByText('No summary yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Generate summary' }));
    expect(await screen.findAllByText('Waiting to generate')).toBeTruthy();
    expect(await screen.findByText('Failed', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByText('The model declined to summarise this session.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  }, 15_000);

  it('the detector counts each kind', () => {
    const c = detectRedactions({ ...OUTPUT, ticketNote: 'Card 4111 1111 1111 1111, mail a@b.co' });
    expect(c.card).toBe(1);
    expect(c.email).toBe(1);
  });
});

// ---------- the transcript hook ----------

class FakeConsole implements LiveConsoleHandle {
  snapshot: { phase: string; chat: LiveChatItem[]; runs: LiveRun[] } = { phase: 'connecting', chat: [], runs: [] };
  private listeners = new Set<() => void>();
  sent: string[] = [];
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(patch: Partial<FakeConsole['snapshot']>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l();
  }
  sendChat = (text: string) => {
    this.sent.push(text);
    this.set({ chat: [...this.snapshot.chat, { msgId: `m${this.snapshot.chat.length}`, from: 'assist', text, ts: Date.now(), mine: true }] });
  };
}

describe('the transcript hook (5.3a-b)', () => {
  const policy = async () => ({
    reply: { provider: 'local' as const, autoSummarize: true, includeTranscript: true, anthropicAck: null },
    regionLabel: 'India (Mumbai)',
  });

  it('sends the notice once at live and uploads the redacted post-notice chat and playbook tails at the end', async () => {
    const uploads: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        uploads.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
        return jsonResponse(202, { sha256: 'c'.repeat(64), redactions: emptyRedactionCounts() });
      }),
    );
    const con = new FakeConsole();
    con.set({ chat: [{ msgId: 'old', from: 'desk', text: 'before the notice: me@old.example', ts: Date.now() - 60_000 }] });
    const stop = attachTranscriptHook(IDS.session, con, policy);
    await new Promise((r) => setTimeout(r, 0));
    expect(con.sent).toHaveLength(0);
    con.set({ phase: 'live' });
    await waitFor(() => expect(con.sent).toHaveLength(1));
    expect(con.sent[0]).toBe(
      "This chat may be summarised for the support record by an automated assistant that runs inside IndiansAssist's India (Mumbai) infrastructure. Email addresses, phone numbers and recognised secrets are removed first.",
    );
    // Further snapshots never resend it, and a reload remembers it.
    con.set({ phase: 'live' });
    expect(loadNotice(IDS.session)?.provider).toBe('local');
    con.set({
      chat: [
        ...con.snapshot.chat,
        { msgId: 'd1', from: 'desk', text: 'my mail is priya@example.com', ts: Date.now() - 5000 },
        { msgId: 'd2', from: 'desk', text: 'again priya@example.com, phone +919876543210', ts: Date.now() },
      ],
      runs: [{ runId: 'a'.repeat(32), name: 'Clear queue', stdout: 'line1\nuser bob@corp.example\ndone', stderr: '' }],
    });
    con.set({ phase: 'ended' });
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(con.sent).toHaveLength(1);
    const body = uploads[0]!.body as { noticeSentAt: string; noticeProvider: string; messages: { from: string; at: string; text: string }[]; playbookOutputs: { stdoutTail: string }[]; consoleRedaction: string };
    expect(uploads[0]!.url).toMatch(new RegExp(`/sessions/${IDS.session}/summary-input$`));
    expect(body.noticeProvider).toBe('local');
    expect(body.consoleRedaction).toBe('redact-v1');
    expect(body.messages.map((m) => m.text)).toEqual([con.sent[0], 'my mail is [email-1]', 'again [email-1], phone [phone-1]']);
    expect(body.messages.map((m) => m.from)).toEqual(['technician', 'user', 'user']);
    // A Desk clock behind ours never dates a message before the notice.
    expect(body.messages.every((m) => m.at >= body.noticeSentAt)).toBe(true);
    expect(body.playbookOutputs[0]!.stdoutTail).toBe('line1\nuser [email-2]\ndone');
    expect(JSON.stringify(body)).not.toContain('old.example');
    stop();
  });

  it('does nothing when the policy leaves the transcript out', async () => {
    const con = new FakeConsole();
    const stop = attachTranscriptHook(IDS.other, con, async () => ({ reply: { provider: 'local', autoSummarize: true, includeTranscript: false, anthropicAck: null }, regionLabel: '' }));
    con.set({ phase: 'live' });
    await new Promise((r) => setTimeout(r, 10));
    con.set({ phase: 'ended' });
    await new Promise((r) => setTimeout(r, 10));
    expect(con.sent).toHaveLength(0);
    stop();
  });

  it('a registered console is found by session id', () => {
    const con = new FakeConsole();
    const off = registerLiveConsole('s-1', con);
    off();
    off();
  });

  it('builds the upload without a notice message id from the notice time, and tails the last lines', () => {
    const now = Date.now();
    const body = buildTranscriptUpload({ msgId: '', at: now, provider: 'local' }, [
      { msgId: 'a', from: 'desk', text: 'early', ts: now - 1 },
      { msgId: 'b', from: 'desk', text: 'late', ts: now + 1 },
    ], []);
    expect(body.messages.map((m) => m.text)).toEqual(['late']);
    expect(tailLines('line one\nline two\nend', 12)).toBe('line two\nend');
    expect(tailLines('first line\nsecond line is long', 16)).toBe('ond line is long');
  });
});
