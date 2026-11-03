/**
 * Phase F phone camera end-to-end (docs/specs/phase-f-contracts.md sections 6, 12 "Accessibility", 15.5): a P1 session
 * between a desktop Chromium Assist and Desk, and a phone context (`devices['Pixel 7']`, Chromium's fake camera)
 * joining by the link the Assist sent to the Desk's chat (where the room draws it as a QR code). The phone asks first,
 * then the Assist sees the camera live, both show the same camera code, the Assist freezes and takes a snapshot (a PNG
 * download whose sha256 is chained), and the phone stops. The console panel is driven by keyboard only.
 *
 *   E2E_API_PORT=4150 E2E_WEB_PORT=5310 E2E_DATA_DIR=./data/e2e-camera pnpm --filter @indiansassist/web exec playwright test f-camera
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { assertKeyboardReachable, tabUntil } from './a11y';
import { captureConsole, probeRemoteVideo, shot } from './helpers';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
const DESK_NAME = 'Camera Desk';

async function newSide(ctx: BrowserContext, side: string): Promise<Page> {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write', 'camera', 'microphone'], { origin: WEB });
  const page = await ctx.newPage();
  captureConsole(page, side);
  return page;
}

/** Sign up, create a P1 token, the Desk joins and shares, the Assist accepts: a live session. Returns its id. */
async function liveP1(assist: Page, desk: Page): Promise<string> {
  await assist.goto('/signup');
  await assist.getByLabel('Organisation name').fill('Camera Clinic');
  await assist.getByLabel('Your name').fill('Ravi Tech');
  await assist.getByLabel('Work email').fill(`ravi+${Date.now()}@e2e.example.com`);
  await assist.getByLabel('Password').fill('correct horse battery staple');
  await assist.getByRole('button', { name: 'Create organisation' }).click();
  await expect(assist).toHaveURL(/\/app$/);
  await expect(assist.getByRole('banner').getByText('Signaling: Online')).toBeVisible();
  const card = assist.locator('section').filter({ has: assist.getByRole('heading', { name: 'Quick create token' }) });
  await card.getByRole('button', { name: 'Create token' }).click();
  const joinUrl = await assist.locator('#join-link').inputValue();
  await desk.goto(joinUrl);
  await desk.getByLabel('Your name (optional, shown to the technician)').fill(DESK_NAME);
  await desk.getByRole('button', { name: 'Join support session' }).click();
  const knock = assist.getByRole('article', { name: `Support request from ${DESK_NAME}` }).first();
  await knock.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
  const sessionId = /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
  await desk.getByLabel('Share a single window instead of my whole screen').uncheck();
  await desk.getByLabel('I have closed or hidden anything private').check();
  await desk.getByRole('button', { name: 'Share my screen' }).click();
  await expect.poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  return sessionId;
}

test('Phone camera: a phone joins a P1 session by link, the Assist sees it, freezes, snapshots; keyboard only', async ({
  browser,
}) => {
  test.setTimeout(420_000); // three browser contexts and a live session; the default 180 s is tight on a loaded machine
  const assistCtx = await browser.newContext({ acceptDownloads: true });
  const deskCtx = await browser.newContext();
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'] });
  await phoneCtx.grantPermissions(['camera'], { origin: WEB });
  const assist = await newSide(assistCtx, 'assist');
  const desk = await newSide(deskCtx, 'desk');
  const phone = await phoneCtx.newPage();
  captureConsole(phone, 'phone');
  const panel = assist
    .getByRole('heading', { name: 'Phone camera', exact: true })
    .locator('xpath=ancestor::section[1]');
  let sessionId = '';
  let url = '';
  let snapSha = '';

  try {
    await test.step('a live P1 session', async () => {
      sessionId = await liveP1(assist, desk);
    });

    await test.step('keyboard: Phone camera -> the link step, Send to the Desk chat', async () => {
      await assist.locator('body').focus();
      await tabUntil(assist, (s) => s.name === 'Phone camera' && s.role === 'button', 160);
      await assist.keyboard.press('Enter');
      await expect(panel.getByRole('img', { name: 'QR code of the phone camera link' })).toBeVisible();
      await expect(panel.getByText('Waiting for the phone').first()).toBeVisible();
      url = ((await panel.getByText(/^Link /).textContent()) ?? '').replace(/^Link\s+/, '').trim();
      expect(url).toMatch(new RegExp(`^${WEB.replace(/[.:/]/g, (c) => `\\${c}`)}/c/[0-9A-HJKMNP-TV-Z]{12}$`));
      await tabUntil(assist, (s) => s.name === "Send to the Desk's chat", 20);
      await assist.keyboard.press('Enter');
      await expect(desk.getByRole('log', { name: 'Chat messages' })).toContainText(url);
      await expect(desk.getByRole('img', { name: /scan it with your phone/ })).toBeVisible();
      await shot(assist, 'camera-link');
      await shot(desk, 'camera-desk-qr');
    });

    await test.step('the phone opens the link and is asked first', async () => {
      await phone.goto(url);
      await expect(phone.getByRole('button', { name: 'Start camera' })).toBeVisible();
      await expect(phone.getByText(/Ravi Tech from .* asks to see what your phone's camera shows/)).toBeVisible();
      await expect(phone.getByText('The camera is not recorded.')).toBeVisible();
      await expect(phone).toHaveURL(url);
      await expect(panel.getByText('Phone connected, waiting for consent').first()).toBeVisible();
      await shot(phone, 'camera-phone-consent');
      await phone.getByRole('button', { name: 'Start camera' }).click();
      await expect(phone.getByText('Your camera is being shared with Ravi Tech').first()).toBeVisible();
    });

    await test.step('the Assist sees the camera live and both show the same camera code', async () => {
      const video = panel.getByLabel("Phone camera, live video from the person's phone");
      await expect(video).toBeVisible();
      await expect
        .poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 60_000 })
        .toBeGreaterThan(0);
      const phoneCode = phone.locator('span.font-mono');
      await expect(phoneCode).toHaveText(/^\d{3} \d{3}$/);
      const assistCode = panel.locator('span.font-mono').filter({ hasText: /^\d{3} \d{3}$/ });
      await expect(assistCode).toHaveText((await phoneCode.textContent()) ?? 'x');
      await expect(panel.getByText('Camera code not confirmed. If the codes differ, stop the camera.')).toBeVisible();
      await shot(assist, 'camera-live');
      await shot(phone, 'camera-phone-live');
    });

    await test.step('keyboard: every panel control is reachable; Codes match, Freeze, Resume, Snapshot', async () => {
      await tabUntil(assist, (s) => s.name === 'Codes match', 40);
      await assist.keyboard.press('Shift+Tab');
      await assertKeyboardReachable(assist, panel, 'camera panel');
      await assist.locator('body').focus();
      await tabUntil(assist, (s) => s.name === 'Codes match', 200);
      await assist.keyboard.press('Space');
      await expect(panel.getByText('Camera code not confirmed. If the codes differ, stop the camera.')).toHaveCount(0);
      await tabUntil(assist, (s) => s.name === 'Freeze', 10);
      await assist.keyboard.press('Enter');
      await expect(panel.getByText('Frozen', { exact: true }).first()).toBeVisible();
      await expect(panel.getByLabel('Phone camera, frozen picture')).toBeVisible();
      await expect(assist.getByRole('button', { name: 'Resume' })).toBeFocused();
      await tabUntil(assist, (s) => s.name === 'Snapshot', 10);
      const download = assist.waitForEvent('download');
      await assist.keyboard.press('Enter');
      const d = await download;
      expect(d.suggestedFilename()).toMatch(new RegExp(`^camera-${sessionId.slice(0, 8)}-\\d{8}-\\d{6}\\.png$`));
      snapSha = createHash('sha256')
        .update(readFileSync(await d.path()))
        .digest('hex');
      await expect(panel.getByText(/noted in the audit log/)).toBeVisible();
      await assist.getByRole('button', { name: 'Resume' }).focus();
      await assist.keyboard.press('Enter');
      await expect(panel.getByText('Live', { exact: true }).first()).toBeVisible();
    });

    await test.step('the phone stops; the console says so in words', async () => {
      await phone.getByRole('button', { name: 'Stop' }).click();
      await expect(phone.getByText(/You stopped sharing your camera/)).toBeVisible();
      await expect(panel.getByText('Ended: the phone stopped').first()).toBeVisible();
      await shot(assist, 'camera-ended');
    });

    await test.step('the chain holds the camera entries and the snapshot hash, never the code', async () => {
      const res = await assistCtx.request.get(`${API}/api/v1/sessions/${sessionId}/audit`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        items: { action: string; data: Record<string, unknown> }[];
        integrity: { ok: boolean };
      };
      const actions = body.items.map((e) => e.action);
      for (const a of ['camera.link_created', 'camera.started', 'camera.snapshot', 'camera.ended'])
        expect(actions).toContain(a);
      expect(body.items.find((e) => e.action === 'camera.snapshot')!.data.sha256).toBe(snapSha);
      expect(body.items.find((e) => e.action === 'camera.ended')!.data.by).toBe('phone_stopped');
      expect(JSON.stringify(body.items)).not.toContain(url.split('/c/')[1]);
      expect(body.integrity.ok).toBe(true);
    });
  } finally {
    await phoneCtx.close();
    await deskCtx.close();
    await assistCtx.close();
  }
});
