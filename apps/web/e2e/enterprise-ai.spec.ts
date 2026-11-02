/**
 * Phase E stream ai, keyboard-only accessibility spec (docs/specs/phase-e-contracts.md sections 11, 13.4, 15.4).
 *
 * An org_admin signs up; a fake local model server (chat completions, no model) runs in this test process; the api
 * reaches it because the runner's environment carries AI_LOCAL_ENDPOINTS=in-mum=http://127.0.0.1:<E2E_AI_MODEL_PORT>
 * (Playwright passes the runner's environment to the api it starts). Everything a user does is keyboard only: the AI
 * settings page is reached from the main nav, the in-region provider chosen with the arrow keys, both switches set
 * and the policy saved (announced in a live region); a real P1 session is ended over `/signal`; on the ended session
 * a summary is generated, shown with its state in words, edited (the redaction detector warns first) and saved as a
 * new version. Asserted: every control is reachable, labelled and shows a focus ring; states survive the colour
 * being removed; the fake model never received the planted address.
 */
import { createServer, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { assertKeyboardReachable, assertTextNotColour, focused, tab, tabUntil } from './a11y';
import { captureConsole, shot } from './helpers';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
const MODEL_PORT = Number(process.env.E2E_AI_MODEL_PORT || 4194);
const HEADERS = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };
const PLANTED = 'desk.user@e2e.example.com';

const ANSWER = {
  summary: 'The technician cleared a stuck print job.',
  outcome: 'resolved',
  actionsTaken: ['Cleared the print queue'],
  issuesFound: ['A stuck print job'],
  followUps: [],
  ticketNote: 'Cleared the print queue; printing works again.',
};

async function startModel(): Promise<{ bodies: string[]; server: Server }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'e2e-fake-model', choices: [{ message: { content: JSON.stringify(ANSWER) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(MODEL_PORT, '127.0.0.1', resolve));
  return { bodies, server };
}

/** Opens a `/signal` socket in the page (its own cookie and Origin) and keeps it on `window.__ia`. */
async function openSocket(page: Page, signalUrl: string): Promise<void> {
  await page.evaluate(async (url) => {
    type W = Window & { __ia?: { ws: WebSocket; inbox: Record<string, unknown>[]; seq: number } };
    const ws = new WebSocket(url);
    const box = { ws, inbox: [] as Record<string, unknown>[], seq: 0 };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (m['t'] === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
      else box.inbox.push(m);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('signal socket failed'));
    });
    (window as W).__ia = box;
  }, signalUrl);
}

async function request(page: Page, frame: Record<string, unknown> | null, t: string): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ({ frame, t }) => {
      type W = Window & { __ia: { ws: WebSocket; inbox: Record<string, unknown>[]; seq: number } };
      const box = (window as unknown as W).__ia;
      if (frame) box.ws.send(JSON.stringify({ id: `e${++box.seq}`, ...frame }));
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const i = box.inbox.findIndex((m) => m['t'] === t || m['t'] === 'error');
        if (i >= 0) {
          const m = box.inbox.splice(i, 1)[0]!;
          if (m['t'] === 'error') throw new Error(`expected ${t}, got error ${String(m['code'])}`);
          return m;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timed out waiting for ${t}`);
    },
    { frame, t },
  );
}

async function skipToMain(page: Page): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await page.keyboard.press('Shift+Tab');
    if ((await focused(page)).name.includes('Skip to content')) break;
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
}

test('Phase E ai: the AI policy and the summary panel are fully operable from the keyboard', async ({ browser }) => {
  const model = await startModel();
  const assistCtx = await browser.newContext();
  const deskCtx = await browser.newContext();
  const page = await assistCtx.newPage();
  const desk = await deskCtx.newPage();
  captureConsole(page, 'assist');
  const main = page.locator('main');
  let sessionId = '';

  try {
    await test.step('Assist signs up an org (org_admin)', async () => {
      await page.goto('/signup');
      await page.getByLabel('Organisation name').fill('E2E AI');
      await page.getByLabel('Your name').fill('Asha Tech');
      await page.getByLabel('Work email').fill(`asha+${Date.now()}@e2e.example.com`);
      await page.getByLabel('Password').fill('correct horse battery staple');
      await page.getByRole('button', { name: 'Create organisation' }).click();
      await expect(page).toHaveURL(/\/app$/);
      const caps = await (await page.request.get(`${API}/api/v1/ai/capabilities`)).json();
      expect(caps.local, `run the spec with AI_LOCAL_ENDPOINTS=in-mum=http://127.0.0.1:${MODEL_PORT} in the environment`).toBe(true);
    });

    await test.step('The AI settings are reached by keyboard from the main nav', async () => {
      await page.goto('/app');
      await expect(page.getByRole('banner')).toBeVisible();
      const first = await tab(page);
      expect(first.name, 'the first tab stop is the skip link').toContain('Skip to content');
      await tabUntil(page, (s) => s.role === 'link' && s.name === 'AI');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/app\/settings\/ai$/);
      await expect(page.getByRole('heading', { name: 'AI summaries', level: 1 })).toBeVisible();
      await expect(page.getByRole('radio', { name: /In-region model/ })).toBeVisible();
    });

    await test.step('Every control of the AI policy page is reachable, labelled and shows a focus ring', async () => {
      await skipToMain(page);
      const stops = await assertKeyboardReachable(page, main, 'AI policy page');
      expect(stops.some((s) => s.role === 'button' && s.name === 'Save AI policy')).toBe(true);
      await assertTextNotColour(page, main, ['not available on this server', 'not reliably detected']);
    });

    await test.step('The in-region provider and both switches are set from the keyboard; the save is announced', async () => {
      await skipToMain(page);
      await tabUntil(page, (s) => s.role === 'radio');
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('radio', { name: /In-region model/ })).toBeChecked();
      await tabUntil(page, (s) => s.name.startsWith('Summarise every session'));
      await page.keyboard.press('Space');
      await tabUntil(page, (s) => s.name.startsWith('Include the chat'));
      await page.keyboard.press('Space');
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Save AI policy');
      expect((await focused(page)).ring, 'the Save button shows a focus ring').toBe(true);
      await page.keyboard.press('Enter');
      await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'The AI policy was saved.' })).toBeAttached();
      await expect(page.getByRole('status').filter({ hasText: 'The AI policy was saved.' }).first()).toBeVisible();
      const policy = await (await page.request.get(`${API}/api/v1/orgs/current/ai-policy`)).json();
      expect(policy).toMatchObject({ provider: 'local', autoSummarize: true, includeTranscript: true });
      // Back to on-demand only, so the ended session below is summarised when the technician asks.
      const off = await page.request.patch(`${API}/api/v1/orgs/current/ai-policy`, { headers: HEADERS, data: { autoSummarize: false, includeTranscript: false } });
      expect(off.status()).toBe(200);
      await shot(page, 'ai-policy');
    });

    await test.step('A real P1 session is knocked, accepted, consented and ended over /signal', async () => {
      const wk = await (await page.request.get(`${API}/.well-known/indiansassist.json`)).json();
      const tok = await page.request.post(`${API}/api/v1/tokens`, { headers: HEADERS, data: { tier: 'p1_browser', typ: 'one_time', ttlMinutes: 15, label: 'e2e ai' } });
      expect(tok.status(), await tok.text()).toBe(201);
      const compact = (await tok.json()).compact as string;
      await desk.goto('/');
      await openSocket(page, wk.signal);
      await request(page, { t: 'assist.hello' }, 'assist.hello.ok');
      await openSocket(desk, wk.signal);
      await request(desk, { t: 'desk.hello', token: compact, deskLabel: 'E2E Desk' }, 'desk.hello.ok');
      sessionId = String((await request(desk, { t: 'desk.knock', deskLabel: 'E2E Desk' }, 'knock.ok'))['sessionId']);
      await request(page, { t: 'assist.accept', sessionId }, 'session.created');
      await request(desk, null, 'session.created');
      await request(desk, { t: 'desk.consent', state: 'granted', surface: 'monitor' }, 'consent.ok');
      await request(page, { t: 'session.end', sessionId, note: `user wrote from ${PLANTED}` }, 'session.ended');
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step('On the ended session a summary is generated from the keyboard; its state is in words', async () => {
      await page.goto(`/app/sessions/${sessionId}`);
      const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'AI summary' }) });
      await expect(panel.getByText('No summary yet.')).toBeVisible();
      await skipToMain(page);
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Generate summary');
      await page.keyboard.press('Enter');
      await expect(panel.getByText('Waiting to generate').first()).toBeVisible();
      // The sweeper runs every 10 s and the panel polls every 3 s.
      await expect(panel.getByText('Ready', { exact: true })).toBeVisible({ timeout: 40_000 });
      await assertTextNotColour(page, panel, ['Ready', 'events only', 'not reliably detected']);
      expect(model.bodies.length).toBeGreaterThanOrEqual(1);
      expect(model.bodies.join('\n')).not.toContain(PLANTED);
      expect(model.bodies.join('\n')).toContain('[email-1]');
    });

    await test.step('The summary form is reachable and labelled; an edit warns, then saves a new version', async () => {
      const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'AI summary' }) });
      await skipToMain(page);
      await tabUntil(page, (s) => s.name === 'Summary');
      await page.keyboard.press('End');
      await page.keyboard.type(` Call back on ${PLANTED}.`);
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Save as a new version');
      await page.keyboard.press('Enter');
      const warn = panel.getByRole('alert');
      await expect(warn).toContainText('1 email');
      await page.keyboard.press('Shift+Tab');
      expect((await focused(page)).name).toBe('Save anyway');
      await page.keyboard.press('Enter');
      await expect(panel.locator('[aria-live="polite"]').filter({ hasText: 'Saved as version 2.' })).toBeAttached();
      await expect(panel.getByText('Version 2, edit')).toBeVisible();
      await shot(page, 'ai-summary-edited');
    });
  } finally {
    await assistCtx.close();
    await deskCtx.close();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
