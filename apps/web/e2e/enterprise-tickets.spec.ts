/**
 * Phase E stream tickets, keyboard-only accessibility spec (docs/specs/phase-e-contracts.md sections 11, 13.4, 15.3).
 *
 * An org_admin signs up; a real P1 session is knocked, accepted, consented and ended over `/signal` from two browser
 * contexts (the Assist page's own cookie, an anonymous Desk page), so the ended-session page has something to push.
 * An in-process webhook receiver runs in this test process on 127.0.0.1 and verifies every delivery's HMAC signature.
 * Everything a user does after that is keyboard only (Tab / Shift+Tab / Enter / Space / typing): reaching
 * Integrations from the main nav, configuring the webhook (its secret shown once), testing it, then on the ended
 * session opening the push dialog, writing a note and pushing it. Asserted: every control in `main` is reachable,
 * labelled and shows a focus ring; states are words that survive the colour being removed; the save, test and push
 * results land in polite live regions; the receiver saw a correctly signed delivery with the push id.
 *
 * The api reaches the receiver only with EGRESS_ALLOW_HTTP=1 and EGRESS_ALLOW_LOOPBACK=1 in its environment
 * (Playwright passes the runner's environment to the api it starts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { assertKeyboardReachable, assertTextNotColour, focused, tab, tabUntil } from './a11y';
import { captureConsole, shot } from './helpers';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
const HEADERS = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };

type Delivery = { headers: IncomingHttpHeaders; raw: Buffer; json: Record<string, unknown> | null };

async function startReceiver(): Promise<{ url: string; deliveries: Delivery[]; server: Server }> {
  const deliveries: Delivery[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        json = null;
      }
      deliveries.push({ headers: req.headers, raw, json });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json?.['event'] === 'ticket.push' ? { externalId: 'HOOK-1' } : {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, deliveries, server };
}

function verifies(secret: string, d: Delivery): boolean {
  const ts = String(d.headers['x-ia-timestamp'] ?? '');
  const mac = createHmac('sha256', Buffer.from(secret, 'base64url')).update(`${ts}.`).update(d.raw).digest('hex');
  return String(d.headers['x-ia-signature'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .some((v) => v.startsWith('v1=') && v.length === 67 && timingSafeEqual(Buffer.from(v.slice(3)), Buffer.from(mac)));
}

/** Opens a `/signal` socket in the page (its own cookie and Origin) and keeps it on `window.__ia`. */
async function openSocket(page: Page, signalUrl: string): Promise<void> {
  await page.evaluate(async (url) => {
    type W = Window & { __ia?: { ws: WebSocket; inbox: Record<string, unknown>[]; seq: number } };
    const w = window as W;
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
    w.__ia = box;
  }, signalUrl);
}

/** Sends a frame and waits for the first queued or future frame of type `t` (an `error` frame fails). */
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

async function homeByKeyboard(page: Page): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await page.keyboard.press('Shift+Tab');
    const s = await focused(page);
    if (s.name.includes('Skip to content')) return;
  }
  throw new Error('Shift+Tab never reached the skip link');
}

async function skipToMain(page: Page): Promise<void> {
  await homeByKeyboard(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
}

test('Phase E tickets: integrations and the ticket push are fully operable from the keyboard', async ({ browser }) => {
  const receiver = await startReceiver();
  const assistCtx = await browser.newContext();
  const deskCtx = await browser.newContext();
  const page = await assistCtx.newPage();
  const desk = await deskCtx.newPage();
  captureConsole(page, 'assist');
  const main = page.locator('main');
  let sessionId = '';
  let secret = '';

  try {
    await test.step('Assist signs up an org (org_admin)', async () => {
      await page.goto('/signup');
      await page.getByLabel('Organisation name').fill('E2E Tickets');
      await page.getByLabel('Your name').fill('Asha Tech');
      await page.getByLabel('Work email').fill(`asha+${Date.now()}@e2e.example.com`);
      await page.getByLabel('Password').fill('correct horse battery staple');
      await page.getByRole('button', { name: 'Create organisation' }).click();
      await expect(page).toHaveURL(/\/app$/);
    });

    await test.step('A real P1 session is knocked, accepted, consented and ended over /signal', async () => {
      const wk = await (await page.request.get(`${API}/.well-known/indiansassist.json`)).json();
      const tok = await page.request.post(`${API}/api/v1/tokens`, { headers: HEADERS, data: { tier: 'p1_browser', typ: 'one_time', ttlMinutes: 15, label: 'e2e tickets' } });
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
      await request(page, { t: 'session.end', sessionId, note: 'e2e tickets' }, 'session.ended');
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step('Integrations is reached by keyboard from the main nav', async () => {
      await page.goto('/app');
      await expect(page.getByRole('banner')).toBeVisible();
      const first = await tab(page);
      expect(first.name, 'the first tab stop is the skip link').toContain('Skip to content');
      await tabUntil(page, (s) => s.role === 'link' && s.name === 'Integrations');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/app\/settings\/integrations$/);
      await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Webhook' })).toBeVisible();
    });

    await test.step('Every control of the integrations page is reachable, labelled and shows a focus ring', async () => {
      await skipToMain(page);
      const stops = await assertKeyboardReachable(page, main, 'integrations page');
      expect(stops.some((s) => s.role === 'button' && s.name === 'Save Webhook')).toBe(true);
      expect(stops.some((s) => s.name === 'API token')).toBe(true);
      await assertTextNotColour(page, main, ['Not configured']);
    });

    await test.step('The webhook is configured from the keyboard; its secret is shown once; the result is announced', async () => {
      await skipToMain(page);
      await tabUntil(page, (s) => s.name.startsWith('Webhook URL'));
      await page.keyboard.type(`${receiver.url}/hooks/e2e?token=sealed-in-the-path`);
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Save Webhook');
      await page.keyboard.press('Enter');
      const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Webhook' }) });
      await expect(card.locator('[aria-live="polite"]').filter({ hasText: 'Webhook saved.' })).toBeVisible();
      secret = (await card.getByTestId('webhook-secret').textContent()) ?? '';
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(card.getByText('(path and query sealed)')).toBeVisible();
      await expect(card.getByText('sealed-in-the-path')).toHaveCount(0);
      await assertTextNotColour(page, card, ['Enabled', 'Leaves the region when used']);
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Test Webhook');
      const ring = await focused(page);
      expect(ring.ring, 'the Test button shows a focus ring').toBe(true);
      await page.keyboard.press('Enter');
      await expect(card.locator('[aria-live="polite"]').filter({ hasText: 'Test passed.' })).toBeVisible();
      const ping = receiver.deliveries.at(-1)!;
      expect(ping.headers['x-ia-event']).toBe('ping');
      expect(verifies(secret, ping), 'the ping is signed with the secret shown once').toBe(true);
      await shot(page, 'tickets-integrations');
    });

    await test.step('On the ended session the push dialog is operated from the keyboard', async () => {
      await page.goto(`/app/sessions/${sessionId}`);
      const tickets = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Tickets' }) });
      await expect(tickets.getByRole('button', { name: 'Push to ticketing' })).toBeVisible();
      await skipToMain(page);
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Push to ticketing');
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Push to ticketing' });
      await expect(dialog).toBeVisible();
      const first = await focused(page);
      expect(first.name, 'focus starts in the dialog on the integration picker').toBe('Integration');
      // No summary is ready: the manual note is the selected content and the summary choice says why it is off.
      await expect(dialog.getByRole('radio', { name: 'A note I write' })).toBeChecked();
      await expect(dialog.getByText('(no ready summary for this session)')).toBeVisible();
      // The dialog traps focus: Shift+Tab twice from the picker wraps to its last control, so the walk starts at the top.
      await page.keyboard.press('Shift+Tab');
      expect((await focused(page)).name).toBe('Close dialog');
      await page.keyboard.press('Shift+Tab');
      expect((await focused(page)).name, 'focus wraps inside the dialog').toBe('Cancel');
      await assertKeyboardReachable(page, dialog, 'push dialog');
      await tabUntil(page, (s) => s.name === 'Note');
      await page.keyboard.type('Cleared the print queue and restarted the spooler.');
      await tabUntil(page, (s) => s.name.startsWith('Requester email'));
      expect((await focused(page)).name).toContain('sent to Webhook');
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Push ticket');
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(tickets.locator('[aria-live="polite"]').filter({ hasText: 'Delivered to Webhook as HOOK-1.' })).toBeVisible();
      const list = tickets.getByRole('list', { name: 'Ticket pushes' });
      await assertTextNotColour(page, list, ['Delivered', 'Webhook', 'manual note']);
      const d = receiver.deliveries.at(-1)!;
      expect(d.headers['x-ia-event']).toBe('ticket.push');
      expect(d.headers['x-ia-push-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(d.headers['x-ia-attempt']).toBe('1');
      expect(verifies(secret, d), 'the delivery verifies at the receiver').toBe(true);
      expect((d.json?.['ticket'] as { body?: string } | undefined)?.body).toContain('Cleared the print queue');
      await shot(page, 'tickets-pushed');
    });
  } finally {
    await assistCtx.close();
    await deskCtx.close();
    await new Promise<void>((resolve) => receiver.server.close(() => resolve()));
  }
});
