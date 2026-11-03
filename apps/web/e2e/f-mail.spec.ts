/**
 * Phase F mail end-to-end, keyboard only (docs/specs/phase-f-contracts.md sections 4, 12 "Accessibility", 15.3). The
 * api runs with the runner's environment `MAIL_DRIVER=smtp SMTP_URL=smtp://127.0.0.1:<E2E_SMTP_PORT>
 * SMTP_REQUIRE_TLS=0` (playwright.config.ts passes the runner's environment through), and this spec runs the fake SMTP
 * server (scripts/smoke/fake-smtp.mjs: 127.0.0.1 only, never relays) in the test process.
 *
 *   invite by email from the users page -> the mail -> resend (new link, the old one dies) -> accept;
 *   "Forgot your password?" on the login page -> /reset -> the mail -> the confirm form (fragment removed) ->
 *   sign in with the new password.
 *
 * Nothing but `keyboard.press` / `keyboard.type` drives the pages (the admin's signup is a REST call). Every address
 * is synthetic (`@e2e.example.com`).
 *
 *   E2E_API_PORT=4140 E2E_WEB_PORT=5300 E2E_DATA_DIR=./data/e2e-mail E2E_SMTP_PORT=2526 MAIL_DRIVER=smtp \
 *     SMTP_URL=smtp://127.0.0.1:2526 SMTP_REQUIRE_TLS=0 pnpm --filter @indiansassist/web exec playwright test f-mail
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { focused, tabUntil } from './a11y';
import { captureConsole, shot } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
const HEADERS = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT || '2526');
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a fresh keyboard passphrase';

type Mail = { to: string[]; subject: string; text: string; raw: string };
type FakeSmtp = {
  host: string;
  url: string;
  messages: Mail[];
  to(address: string): Mail[];
  waitFor(pred: (m: Mail) => boolean, timeoutMs?: number): Promise<Mail>;
  close(): Promise<void>;
};
type SmtpLib = { startFakeSmtp(o: { port?: number }): Promise<FakeSmtp>; findLink(text: string, marker: string): string | null };
const loadLib = async () => (await import(pathToFileURL(resolve(here, '../../../scripts/smoke/fake-smtp.mjs')).href)) as SmtpLib;

for (const p of [4000, 4100, 4105]) if (process.env.E2E_API_PORT === String(p)) throw new Error(`f-mail: port ${p} is reserved (section 1.5)`);

let lib: SmtpLib;
let fake: FakeSmtp;

test.beforeAll(async () => {
  lib = await loadLib();
  fake = await lib.startFakeSmtp({ port: SMTP_PORT });
});

test.afterAll(async () => {
  await fake?.close();
});

/** Tabs to the control named `name` (exact) and checks it shows a focus ring. */
async function tabTo(page: Page, name: string | RegExp): Promise<void> {
  const match = (n: string) => (typeof name === 'string' ? n === name : name.test(n));
  const stops = await tabUntil(page, (s) => match(s.name));
  expect(stops.at(-1)!.ring, `focus ring on ${String(name)}`).toBe(true);
}

test('Phase F mail: invite by email, resend, accept; forgot password, reset, sign in (keyboard only)', async ({ browser }) => {
  const tag = Date.now().toString(36);
  const adminEmail = `mail-admin-${tag}@e2e.example.com`;
  const inviteeEmail = `mail-invitee-${tag}@e2e.example.com`;
  const admin = await browser.newContext();
  const page = await admin.newPage();
  captureConsole(page, 'admin');
  let firstLink = '';
  let secondLink = '';

  try {
    await test.step('the api sends mail through the fake SMTP server', async () => {
      const r = await admin.request.get(`${API}/api/v1/auth/options`);
      expect(await r.json(), `start the api with MAIL_DRIVER=smtp SMTP_URL=${fake.url} SMTP_REQUIRE_TLS=0`).toEqual({ passwordReset: true, inviteMail: true });
      const s = await admin.request.post(`${API}/api/v1/auth/signup`, {
        headers: HEADERS,
        data: { orgName: `E2E Mail ${tag}`, name: 'Asha Admin', email: adminEmail, password: PASSWORD },
      });
      expect(s.status()).toBe(201);
    });

    await test.step('invite by email from the users page', async () => {
      await page.goto('/app/users');
      await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
      await expect(page.getByLabel('Email the invitation to this address')).toBeChecked();
      await tabTo(page, 'Email');
      await page.keyboard.type(inviteeEmail);
      await page.keyboard.press('Tab');
      expect((await focused(page)).name).toBe('Name');
      await page.keyboard.type('Ravi Invitee');
      await tabTo(page, 'Email the invitation to this address');
      await tabTo(page, 'Create invitation');
      await page.keyboard.press('Enter');
      await expect(page.getByText(`It was emailed to ${inviteeEmail}`)).toBeVisible();
      const m = await fake.waitFor((x) => x.to.includes(inviteeEmail) && x.subject === 'Your invitation to IndiansAssist');
      expect(m.raw).not.toMatch(/text\/html/i);
      firstLink = lib.findLink(m.text, '/invite#i=')!;
      expect(firstLink.startsWith(`${WEB}/invite#i=`)).toBe(true);
      await expect(page.getByText(firstLink)).toBeVisible();
      await expect(page.getByText(/^Invitation emailed /)).toBeVisible();
      await shot(page, 'f-mail-invited');
    });

    await test.step('resend from the keyboard: a new link is mailed', async () => {
      // Focus sits on the link panel the invite announced; the row's button is further along the tab order.
      await tabTo(page, 'Resend invitation to Ravi Invitee');
      await page.keyboard.press('Enter');
      await expect(page.getByText(/the earlier link no longer works\. It was emailed to/)).toBeVisible();
      const m = await fake.waitFor((x) => x.to.includes(inviteeEmail) && lib.findLink(x.text, '/invite#i=') !== firstLink);
      secondLink = lib.findLink(m.text, '/invite#i=')!;
      expect(secondLink).not.toBe(firstLink);
      const stale = await admin.request.post(`${API}/api/v1/auth/accept-invite`, {
        headers: HEADERS,
        data: { invite: new URL(firstLink).hash.slice(3), name: 'X', password: PASSWORD },
      });
      expect(stale.status()).toBe(401);
    });

    await test.step('the invitee accepts the mailed link', async () => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto(secondLink);
      await expect(p.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();
      await tabTo(p, 'Your name');
      await p.keyboard.type('Ravi Invitee');
      await p.keyboard.press('Tab');
      await p.keyboard.type(PASSWORD);
      await p.keyboard.press('Enter');
      await p.waitForURL(/\/app/);
      await ctx.close();
    });

    await test.step('forgot password: login link, /reset, the neutral sentence', async () => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      captureConsole(p, 'invitee');
      await p.goto('/login');
      await tabTo(p, 'Forgot your password?');
      await p.keyboard.press('Enter');
      await p.waitForURL(/\/reset$/);
      await expect(p.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
      await tabTo(p, 'Email');
      await p.keyboard.type(inviteeEmail);
      await p.keyboard.press('Enter');
      const done = p.getByText('If an account exists for that address, we sent a link to it.');
      await expect(done).toBeVisible();
      await expect(done).toBeFocused();
      await shot(p, 'f-mail-reset-requested');
      await ctx.close();
    });

    await test.step('the mailed link: fragment removed, new password set, no session minted', async () => {
      const m = await fake.waitFor((x) => x.to.includes(inviteeEmail) && x.subject === 'Reset your IndiansAssist password');
      const link = lib.findLink(m.text, '/reset#t=')!;
      expect(link.startsWith(`${WEB}/reset#t=`)).toBe(true);
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto(link);
      await expect(p.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
      await expect.poll(() => p.evaluate(() => location.hash)).toBe('');
      expect(p.url()).not.toContain('#t=');
      await tabTo(p, 'New password');
      await p.keyboard.type(NEW_PASSWORD);
      await p.keyboard.press('Tab');
      expect((await focused(p)).name).toBe('Repeat the new password');
      await p.keyboard.type(NEW_PASSWORD);
      await p.keyboard.press('Enter');
      const ok = p.getByText(/Your password was changed/);
      await expect(ok).toBeVisible();
      await expect(ok).toBeFocused();
      expect((await ctx.cookies()).some((c) => c.name === 'ia_session')).toBe(false);
      await shot(p, 'f-mail-reset-done');

      await tabTo(p, 'Sign in with your new password');
      await p.keyboard.press('Enter');
      await p.waitForURL(/\/login$/);
      await tabTo(p, 'Email');
      await p.keyboard.type(inviteeEmail);
      await p.keyboard.press('Enter');
      const pw = p.getByLabel('Password', { exact: true });
      await expect(pw).toBeFocused();
      await p.keyboard.type(NEW_PASSWORD);
      await p.keyboard.press('Enter');
      await p.waitForURL(/\/app/);
      await ctx.close();
      const old = await admin.request.post(`${API}/api/v1/auth/login`, { headers: HEADERS, data: { email: inviteeEmail, password: PASSWORD } });
      expect(old.status()).toBe(401);
    });
  } finally {
    await admin.close();
  }
});
