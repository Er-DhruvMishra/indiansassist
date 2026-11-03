/**
 * Phase F erasure end-to-end (docs/specs/phase-f-contracts.md sections 5, 15.4), keyboard only on the erasure page.
 * A throwaway org with two administrators (the second invited by the first, so the second requests and the first
 * approves, rule 5.2b); the request and the approval typed from the keyboard with the slug; the banner and the live
 * region; the residency erasure line inside its fixed 12 mm print box with nothing clipped; Cancel from the keyboard;
 * then a second request runs through the api's own sweeper and the signed certificate is served.
 *
 * Needs the api started with ERASURE_DEV_COOLING_OFF_SEC (development only; the shortening of 5.2c), e.g.
 *   ERASURE_DEV_COOLING_OFF_SEC=5 E2E_API_PORT=4145 E2E_WEB_PORT=5305 E2E_DATA_DIR=./data/e2e-erasure \
 *     pnpm --filter @indiansassist/web exec playwright test f-erasure
 * Every address is synthetic (@e2e.example.com).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { focused, tabUntil } from './a11y';
import { captureConsole, shot } from './helpers';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
const HEADERS = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };
const DEV_SEC = Number(process.env.ERASURE_DEV_COOLING_OFF_SEC || '0');
const PASSWORD = 'correct horse battery staple';
const MM = 96 / 25.4;

test.skip(!(DEV_SEC > 0), 'start the api with ERASURE_DEV_COOLING_OFF_SEC (development only), e.g. 5');
// Never against the ports other suites own (section 1.5).
test.skip(['4000', '4100', '4105'].includes(process.env.E2E_API_PORT || '4000'), 'refused: the api port belongs to another process');

async function typeSlugAndSubmit(page: Page, slug: string, buttonName: string): Promise<void> {
  await page.locator('main').focus();
  await tabUntil(page, (s) => s.name.startsWith('Type the organisation slug'));
  await page.keyboard.type(slug);
  await tabUntil(page, (s) => s.role === 'button' && s.name === buttonName);
  expect((await focused(page)).ring, `the ${buttonName} button shows a focus ring`).toBe(true);
  await page.keyboard.press('Enter');
}

test('Phase F erasure: two admins, keyboard only, the 12 mm residency line, cancel, then a real erasure with its certificate', async ({ browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const first: BrowserContext = await browser.newContext();
  const second: BrowserContext = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();
  captureConsole(a, 'first-admin');
  captureConsole(b, 'second-admin');
  let slug = '';
  let signedUpAt = 0;

  try {
    await test.step('a throwaway org: the first admin signs up and invites a second admin', async () => {
      const r = await a.request.post(`${API}/api/v1/auth/signup`, {
        headers: HEADERS,
        data: { orgName: `E2E Erasure ${stamp}`, name: 'Asha First', email: `erasure-a+${stamp}@e2e.example.com`, password: PASSWORD },
      });
      expect(r.status(), await r.text()).toBe(201);
      slug = ((await r.json()) as { org: { slug: string } }).org.slug;
      signedUpAt = Date.now();
      const inv = await a.request.post(`${API}/api/v1/users/invite`, { headers: HEADERS, data: { email: `erasure-b+${stamp}@e2e.example.com`, name: 'Ravi Second', role: 'org_admin' } });
      expect(inv.status(), await inv.text()).toBe(201);
      const secret = ((await inv.json()) as { inviteUrl: string }).inviteUrl.split('#i=')[1]!;
      const acc = await b.request.post(`${API}/api/v1/auth/accept-invite`, { headers: HEADERS, data: { invite: secret, name: 'Ravi Second', password: PASSWORD } });
      expect(acc.status(), await acc.text()).toBe(200);
    });

    await test.step('keyboard: the second admin requests erasure with the typed slug', async () => {
      // The approver (the first admin) must be an admin for the shortened minimum age (5.2b, 5.2c).
      const wait = signedUpAt + DEV_SEC * 1000 + 500 - Date.now();
      if (wait > 0) await b.waitForTimeout(wait);
      await b.goto('/app/settings/erasure');
      await expect(b.getByRole('heading', { name: 'Organisation erasure' })).toBeVisible();
      await typeSlugAndSubmit(b, slug, 'Request erasure');
      await expect(b.getByTestId('erasure-state')).toHaveAttribute('data-state', 'pending_approval');
      await expect(b.getByTestId('erasure-banner')).toBeVisible();
      await shot(b, 'erasure-requested');
    });

    await test.step('the residency erasure line stays inside its 12 mm print box', async () => {
      await a.goto('/app/residency');
      const line = a.getByTestId('residency-erasure');
      await expect(line).toContainText('Available');
      await a.emulateMedia({ media: 'print' });
      await a.setViewportSize({ width: 703, height: 1032 });
      const box = await line.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const kids = [...el.querySelectorAll('dt, dd, .rr-erasure-state, .rr-erasure-note')].map((k) => k.getBoundingClientRect());
        const note = el.querySelector('.rr-erasure-note') as HTMLElement | null;
        return {
          height: r.height,
          clipped: el.scrollHeight > el.clientHeight + 1,
          outside: kids.some((k) => k.bottom > r.bottom + 1 || k.top < r.top - 1),
          noteClipped: note ? note.scrollHeight > note.clientHeight + 1 : true,
        };
      });
      expect(Math.abs(box.height - 12 * MM), `the erasure line is ${box.height} px, not 12 mm`).toBeLessThan(1.5);
      expect(box.clipped, 'the erasure line overflows its 12 mm box').toBe(false);
      expect(box.outside, 'a part of the erasure line lies outside its box').toBe(false);
      expect(box.noteClipped, 'the note is cut off in print').toBe(false);
      await a.setViewportSize({ width: 1440, height: 1000 });
      await a.emulateMedia({ media: 'screen' });
    });

    await test.step('keyboard: the first admin approves; the live region announces it; then cancels', async () => {
      await a.goto('/app/settings/erasure');
      await expect(a.getByTestId('erasure-state')).toHaveAttribute('data-state', 'pending_approval');
      await typeSlugAndSubmit(a, slug, 'Approve the erasure');
      await expect(a.getByTestId('erasure-state')).toHaveAttribute('data-state', 'cooling_off');
      await expect(a.getByTestId('erasure-live')).toHaveText('The erasure is now scheduled; it can still be cancelled.');
      await expect(a.getByTestId('erasure-banner')).toContainText('It runs on');
      await tabUntil(a, (s) => s.role === 'button' && s.name === 'Cancel the erasure');
      await a.keyboard.press('Enter');
      await expect(a.getByTestId('erasure-state')).toHaveAttribute('data-state', 'cancelled');
      await expect(a.getByTestId('erasure-banner')).toBeHidden();
      await shot(a, 'erasure-cancelled');
    });

    await test.step('a second request runs through the sweeper; the certificate is served and the org is closed', async () => {
      await b.reload();
      await typeSlugAndSubmit(b, slug, 'Request erasure');
      await expect(b.getByTestId('erasure-state')).toHaveAttribute('data-state', 'pending_approval');
      await a.reload();
      await typeSlugAndSubmit(a, slug, 'Approve the erasure');
      await expect(a.getByTestId('erasure-state')).toHaveAttribute('data-state', 'cooling_off');
      const certLink = a.getByRole('link', { name: /\/api\/v1\/erasures\/[0-9a-f-]{36}\/certificate$/ }).first();
      const url = (await certLink.getAttribute('href'))!;
      await expect
        .poll(async () => (await a.request.get(url)).status(), { timeout: 120_000, intervals: [2000] })
        .toBe(200);
      const cert = (await (await a.request.get(url)).json()) as { chain: { verified: boolean; finalEntry: { action: string } } };
      expect(cert.chain.verified).toBe(true);
      expect(cert.chain.finalEntry.action).toBe('org.erased');
      const me = await a.request.get(`${API}/api/v1/auth/me`, { headers: HEADERS });
      expect([401, 409]).toContain(me.status());
    });
  } finally {
    await first.close();
    await second.close();
  }
});
