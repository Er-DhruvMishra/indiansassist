/**
 * Phase F phone camera on a real Android browser (docs/specs/phase-f-contracts.md sections 6, 15.5, 15.9): Chrome on
 * the `Pixel7_API35` emulator opens the camera link through `adb reverse` (so its origin is a secure
 * `http://localhost:<web port>`), the person allows the camera, and the emulated back camera streams to a desktop
 * Chromium Assist in a live P1 session (the Desk is a second desktop context sharing Chromium's fake screen). Run by
 * `IA_EMULATOR=1 pnpm e2e:emulator -- camera-emulator` under `e2e/emulator.config.ts` (camera stream ports: api 4310,
 * web 5315); the shared harness takes `data/.emulator.lock`, so it waits while the mobile stream holds the emulator.
 */
import { spawnSync } from 'node:child_process';
import { createConnection, createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { isNotRun, withEmulatorChrome } from './emulator-chrome';
import { captureConsole, probeRemoteVideo, shot } from './helpers';

const API_PORT = Number(process.env.E2E_API_PORT || '4310');
const WEB_PORT = Number(process.env.E2E_WEB_PORT || '5315');
const WEB = `http://localhost:${WEB_PORT}`;
const API = `http://localhost:${API_PORT}`;
const DESK_NAME = 'Emulator Desk';

async function newSide(ctx: BrowserContext, side: string): Promise<Page> {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write', 'camera', 'microphone'], { origin: WEB });
  const page = await ctx.newPage();
  captureConsole(page, side);
  return page;
}

async function liveP1(assist: Page, desk: Page): Promise<string> {
  await assist.goto('/signup');
  await assist.getByLabel('Organisation name').fill('Emulator Clinic');
  await assist.getByLabel('Your name').fill('Kiran Tech');
  await assist.getByLabel('Work email').fill(`kiran+${Date.now()}@e2e.example.com`);
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
  await assist
    .getByRole('article', { name: `Support request from ${DESK_NAME}` })
    .first()
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
  const sessionId = /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
  await desk.getByLabel('Share a single window instead of my whole screen').uncheck();
  await desk.getByLabel('I have closed or hidden anything private').check();
  await desk.getByRole('button', { name: 'Share my screen' }).click();
  await expect.poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  return sessionId;
}

/**
 * `adb reverse` reaches the host on 127.0.0.1, but the web dev server started by `emulator.config.ts` listens on
 * `localhost`, which Node resolves to `::1` first on this machine, so Chrome on the device got an empty response.
 * Until that config passes `--host 127.0.0.1` (proposed contract correction), the spec bridges an IPv4 loopback port
 * to the dev server and points the device's web port at it; the harness still removes the mapping afterwards.
 */
async function bridgeWebPort(webPort: number): Promise<Server> {
  const server = createServer((client) => {
    const upstream = createConnection({ host: 'localhost', port: webPort });
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end);
    upstream.on('error', end);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const r = spawnSync(adbPath(), ['reverse', `tcp:${webPort}`, `tcp:${port}`], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`adb reverse tcp:${webPort} tcp:${port} failed: ${r.stderr}`);
  return server;
}

function adbPath(): string {
  const sdk =
    process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
  return join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
}

type UiNode = { text: string; desc: string; x: number; y: number };

/** The device's current screen (`uiautomator dump`): every node with a text or description, and its centre. */
function uiNodes(): UiNode[] {
  const r = spawnSync(adbPath(), ['exec-out', 'uiautomator', 'dump', '/dev/tty'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out: UiNode[] = [];
  for (const m of (r.stdout ?? '').matchAll(/<node [^>]*>/g)) {
    const attr = (k: string) => new RegExp(` ${k}="([^"]*)"`).exec(m[0])?.[1] ?? '';
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
    const text = attr('text');
    const desc = attr('content-desc');
    if (!b || (!text && !desc)) continue;
    out.push({
      text,
      desc,
      x: Math.round((Number(b[1]) + Number(b[3])) / 2),
      y: Math.round((Number(b[2]) + Number(b[4])) / 2),
    });
  }
  return out;
}

/**
 * Chrome's own site prompt for the camera. Its wording differs by Chrome version ("Allow while visiting the site",
 * "Allow this time", "Allow", ...), so the screen is read with `uiautomator` and the Allow control is tapped by its
 * bounds. Chrome's first-run sheets (the "Chrome notifications make things easier" offer) can cover the prompt; they
 * are declined with their own "No thanks", tapped only while that sheet's text is on screen. Returns the label
 * tapped, or null when no prompt appeared within `ms` (a remembered grant shows none).
 */
async function allowCameraPrompt(ms = 60_000): Promise<string | null> {
  const end = Date.now() + ms;
  const allow = /^(allow while visiting the site|allow this time|only this time|while using the app|allow)$/i;
  const sheet = /chrome notifications make things easier/i;
  while (Date.now() < end) {
    const nodes = uiNodes();
    if (nodes.some((n) => sheet.test(n.text) || sheet.test(n.desc))) {
      const no = nodes.find((n) => /^no thanks$/i.test(n.text.trim()));
      if (no) spawnSync(adbPath(), ['shell', 'input', 'tap', String(no.x), String(no.y)], { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }
    const hit = nodes.find((n) => allow.test(n.text.trim()) || allow.test(n.desc.trim()));
    if (hit) {
      spawnSync(adbPath(), ['shell', 'input', 'tap', String(hit.x), String(hit.y)], { timeout: 30_000 });
      return hit.text || hit.desc;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
}

test('Phone camera: Chrome on the Android emulator streams its back camera to a desktop Assist', async ({
  browser,
}) => {
  test.skip(
    process.env.IA_EMULATOR !== '1',
    'not run: set IA_EMULATOR=1 (needs the Android SDK and the Pixel7_API35 emulator)',
  );
  const assistCtx = await browser.newContext();
  const deskCtx = await browser.newContext();
  const assist = await newSide(assistCtx, 'assist');
  const desk = await newSide(deskCtx, 'desk');
  const panel = assist
    .getByRole('heading', { name: 'Phone camera', exact: true })
    .locator('xpath=ancestor::section[1]');
  const after: (() => Promise<void>)[] = [];
  try {
    let sessionId = '';
    let url = '';
    await test.step('a live P1 session on the desktop', async () => {
      sessionId = await liveP1(assist, desk);
      await panel.getByRole('button', { name: 'Phone camera' }).click();
      url = ((await panel.getByText(/^Link /).textContent()) ?? '').replace(/^Link\s+/, '').trim();
      expect(url.startsWith(`${WEB}/c/`)).toBe(true);
    });

    const result = await withEmulatorChrome({ apiPort: API_PORT, webPort: WEB_PORT }, async ({ context }) => {
      const bridge = await bridgeWebPort(WEB_PORT);
      after.push(() => new Promise<void>((r) => bridge.close(() => r())));
      const phone = await context.newPage();
      await test.step('Chrome on the emulator opens the link (adb reverse: a secure localhost origin)', async () => {
        // Warm-up on the code-entry page (the same lazy chunk): Vite's dev server optimises dependencies on a new
        // client's first load and then reloads the page, which would resend the single-use code after it was spent.
        // The unbundled dev modules reach the emulated phone slowly, and a lazy route import can fail on the first
        // try: reload until the page renders (up to three times).
        let warm = false;
        for (let i = 0; i < 3 && !warm; i += 1) {
          await phone.goto(`${WEB}/c`, { waitUntil: 'commit', timeout: 180_000 });
          warm = await phone
            .getByLabel('Camera code')
            .waitFor({ state: 'visible', timeout: 180_000 })
            .then(() => true)
            .catch(() => false);
        }
        expect(warm, 'the phone page rendered on the emulator').toBe(true);
        await phone.waitForTimeout(3_000);
        await phone.goto(url, { waitUntil: 'commit', timeout: 180_000 });
        await expect(phone.getByRole('button', { name: 'Start camera' })).toBeVisible({ timeout: 120_000 });
        expect(await phone.evaluate(() => window.isSecureContext)).toBe(true);
        await expect(panel.getByText('Phone connected, waiting for consent').first()).toBeVisible();
      });
      await test.step('the person taps Start camera and allows the camera', async () => {
        await phone.getByRole('button', { name: 'Start camera' }).click();
        const tapped = await allowCameraPrompt();
        try {
          await expect(phone.getByText('Your camera is being shared with Kiran Tech').first()).toBeVisible({
            timeout: 60_000,
          });
        } catch (e) {
          const screen = uiNodes()
            .map((n) => n.text || n.desc)
            .join(' | ');
          const page = await phone
            .locator('main')
            .innerText()
            .catch(() => '(page unreadable)');
          throw new Error(
            `the phone did not go live (prompt tapped: ${tapped ?? 'none'}); screen: ${screen}; page: ${page}`,
            {
              cause: e,
            },
          );
        }
      });
      await test.step('the emulated back camera reaches the desktop Assist', async () => {
        const video = panel.getByLabel("Phone camera, live video from the person's phone");
        await expect(video).toBeVisible({ timeout: 60_000 });
        await expect
          .poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 90_000 })
          .toBeGreaterThan(0);
        const t0 = await video.evaluate((v) => (v as HTMLVideoElement).currentTime);
        await expect
          .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime), { timeout: 30_000 })
          .toBeGreaterThan(t0 + 0.5);
        await expect(panel.locator('span.font-mono').filter({ hasText: /^\d{3} \d{3}$/ })).toHaveText(
          (await phone.locator('span.font-mono').textContent({ timeout: 30_000 })) ?? 'x',
        );
        await shot(assist, 'camera-emulator-live');
      });
      await test.step('the phone stops', async () => {
        await phone.getByRole('button', { name: 'Stop' }).click();
        await expect(panel.getByText('Ended: the phone stopped').first()).toBeVisible();
      });
      return true;
    });
    if (isNotRun(result)) test.skip(true, result.notRun);

    await test.step('the chain holds camera.started with the phone facing environment', async () => {
      const res = await assistCtx.request.get(`${API}/api/v1/sessions/${sessionId}/audit`);
      const body = (await res.json()) as { items: { action: string; data: Record<string, unknown> }[] };
      const started = body.items.find((e) => e.action === 'camera.started');
      expect(started).toBeTruthy();
      expect(['environment', 'unknown']).toContain(started!.data.facing);
      expect(body.items.find((e) => e.action === 'camera.ended')!.data.by).toBe('phone_stopped');
    });
  } finally {
    for (const f of after) await f().catch(() => undefined);
    await deskCtx.close();
    await assistCtx.close();
  }
});
