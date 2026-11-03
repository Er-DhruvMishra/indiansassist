/**
 * The mobile Assist console in real Android Chrome (docs/specs/phase-f-contracts.md section 15.6): Chrome on the
 * `Pixel7_API35` emulator is the Assist; a desktop Chromium with a fake screen is the Desk. The technician signs up and
 * signs in on the phone, accepts the Desk's knock, and drives a live P1 console by touch: a tap is a laser ping that
 * reaches the Desk's data channel, a pinch zooms the view and sends nothing.
 *
 * Run: `IA_EMULATOR=1 E2E_API_PORT=4320 E2E_WEB_PORT=5325 E2E_DATA_DIR=./data/e2e-mobile-emulator pnpm e2e:emulator --
 * mobile-emulator.spec.ts` (the mobile stream's emulator ports, section 1.5). The harness (`emulator-chrome.ts`)
 * holds `data/.emulator.lock`, maps both ports with `adb reverse` (so the phone's origin is a secure localhost) and
 * removes everything it set up; without `IA_EMULATOR=1`, the SDK or Chrome the spec reports itself skipped with why.
 */
import net from 'node:net';
import { chromium, expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { isNotRun, withEmulatorChrome } from './emulator-chrome';
import { captureConsole, probeRemoteVideo, recordPeerConnections, shot } from './helpers';

const API_PORT = Number(process.env.E2E_API_PORT || 4310);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5315);
const WEB = `http://localhost:${WEB_PORT}`;
const API = `http://localhost:${API_PORT}`;

/** Init script: every string the page sends on a data channel (P1 annotations travel this way). */
function recordDataChannelSends(): void {
  const w = window as unknown as { __dcSends: string[] };
  w.__dcSends = [];
  const proto = (window as unknown as { RTCDataChannel?: { prototype: RTCDataChannel } }).RTCDataChannel?.prototype;
  if (!proto) return;
  const send = proto.send;
  proto.send = function (this: RTCDataChannel, data: string | Blob | ArrayBuffer | ArrayBufferView) {
    if (typeof data === 'string') w.__dcSends.push(data);
    return (send as (d: unknown) => void).call(this, data);
  } as RTCDataChannel['send'];
}

const annots = (p: Page) =>
  p.evaluate(() => (window as unknown as { __dcSends: string[] }).__dcSends.filter((d) => d.includes('"annot"')));

/**
 * `vite dev` listens on `localhost`, which on Windows is only `[::1]`, while `adb reverse` connects to 127.0.0.1: the
 * phone then gets an empty response. When 127.0.0.1 does not answer, a small pipe on 127.0.0.1:<port> forwards to
 * [::1]:<port> for the run (the same port, another address, so nothing else is taken). Closed in `finally`.
 */
async function ipv4Bridge(port: number): Promise<net.Server | null> {
  const answers = await new Promise<boolean>((resolve) => {
    const c = net.connect({ host: '127.0.0.1', port }, () => {
      c.destroy();
      resolve(true);
    });
    c.on('error', () => resolve(false));
  });
  if (answers) return null;
  const server = net.createServer((inbound) => {
    const out = net.connect({ host: '::1', port });
    inbound.pipe(out).pipe(inbound);
    const end = () => {
      inbound.destroy();
      out.destroy();
    };
    inbound.on('error', end);
    out.on('error', end);
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', () => resolve()));
  return server;
}

async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  pts: { x: number; y: number; id: number }[],
) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p) => ({ ...p, radiusX: 4, radiusY: 4, force: 1 })),
  });
}

test('Android Chrome: sign in, a live P1 console, tap and pinch', async () => {
  const bridges = process.env.IA_EMULATOR === '1' ? [await ipv4Bridge(WEB_PORT), await ipv4Bridge(API_PORT)] : [];
  try {
    await run();
  } finally {
    for (const b of bridges) b?.close();
  }
});

async function run(): Promise<void> {
  const result = await withEmulatorChrome({ apiPort: API_PORT, webPort: WEB_PORT }, async ({ context, device }) => {
    // The emulator's screen times out after a minute; with the screen off Chrome hides the page and its socket stalls.
    // A wake-up key every 15 s keeps it on (no device setting is changed).
    const awake = setInterval(() => void device.shell('input keyevent KEYCODE_WAKEUP').catch(() => undefined), 15_000);
    try {
      return await live(context);
    } finally {
      clearInterval(awake);
    }
  });
  if (isNotRun(result)) test.skip(true, result.notRun);
}

async function live(context: BrowserContext): Promise<true> {
  {
    await context.addInitScript(recordDataChannelSends);
    await context.addInitScript(recordPeerConnections);
    const phone = await context.newPage();
    captureConsole(phone, 'phone');
    // Diagnostics on the phone: warnings and navigations (a dev-server reload mid-session shows up here).
    phone.on('console', (m) => {
      if (m.type() === 'warning') console.log(`[phone console.warn] ${m.text()}`);
    });
    phone.on('framenavigated', (f) => {
      if (f === phone.mainFrame()) console.log(`[phone navigated] ${f.url()}`);
    });
    const deskBrowser = await chromium.launch({
      channel: 'chromium',
      headless: process.env.E2E_HEADED !== '1',
      // The emulator cannot resolve the Desk's mDNS (.local) ICE candidates, so the Desk offers its real host addresses;
      // the phone reaches them through the emulator's NAT.
      args: [
        '--auto-select-desktop-capture-source=Entire screen',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    });
    try {
      const deskCtx = await deskBrowser.newContext();
      await deskCtx.addInitScript(recordPeerConnections);
      const desk = await deskCtx.newPage();
      captureConsole(desk, 'desk');

      await test.step('the technician signs up on the phone and lands in the console shell', async () => {
        // The dev server compiles the app on first load, through adb reverse: allow it time.
        await phone.goto(`${WEB}/signup`, { timeout: 180_000 });
        await phone.getByLabel('Organisation name').fill('E2E Emulator Clinic');
        await phone.getByLabel('Your name').fill('Asha Tech');
        await phone.getByLabel('Work email').fill(`asha+emu${Date.now()}@e2e.example.com`);
        await phone.getByLabel('Password').fill('correct horse battery staple');
        await phone.getByRole('button', { name: 'Create organisation' }).click();
        await expect(phone).toHaveURL(/\/app$/, { timeout: 90_000 });
        await expect(phone.locator('link[rel="manifest"]')).toHaveCount(1);
        await shot(phone, 'emulator-phone-dashboard');
      });

      const joinUrl = await phone.evaluate(async (api) => {
        const r = await fetch(`${api}/api/v1/tokens`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'IndiansAssist' },
          body: JSON.stringify({ tier: 'p1_browser', typ: 'one_time', label: 'E2E emulator' }),
        });
        return ((await r.json()) as { joinUrl: string }).joinUrl;
      }, API);
      expect(joinUrl).toContain('/join#t=');

      await test.step('the Desk joins and shares; the phone accepts and sees the video', async () => {
        await desk.goto(joinUrl);
        await desk.getByLabel('Your name (optional, shown to the technician)').fill('E2E Desk');
        await desk.getByRole('button', { name: 'Join support session' }).click();
        const knock = phone.getByRole('article', { name: /Support request/ }).first();
        await expect(knock).toBeVisible({ timeout: 30_000 });
        await knock.getByRole('button', { name: 'Accept', exact: true }).click();
        await expect(desk.getByRole('heading', { name: /is asking to see your screen/ })).toBeVisible({
          timeout: 30_000,
        });
        await desk.getByLabel('Share a single window instead of my whole screen').uncheck();
        await desk.getByLabel('I have closed or hidden anything private').check();
        await desk.getByRole('button', { name: 'Share my screen' }).click();
        await expect
          .poll(async () => (await probeRemoteVideo(phone))?.width ?? 0, {
            timeout: 60_000,
            message: 'video on the phone',
          })
          .toBeGreaterThan(0)
          .catch(async (e: unknown) => {
            const pcs = await phone.evaluate(() =>
              ((window as unknown as { __iaPcs?: RTCPeerConnection[] }).__iaPcs ?? []).map(
                (pc) => `${pc.connectionState}/${pc.iceConnectionState}`,
              ),
            );
            const text = await phone
              .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 600))
              .catch(() => '');
            const deskText = await desk
              .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300))
              .catch(() => '');
            await shot(phone, 'emulator-phone-no-video').catch(() => undefined);
            const sessions = await phone
              .evaluate(async (api) => {
                const r = await fetch(`${api}/api/v1/sessions?limit=5`, { credentials: 'include' });
                const b = (await r.json()) as { items?: { id: string; state: string }[] };
                return (b.items ?? []).map((x) => `${x.id.slice(0, 8)}:${x.state}`).join(',');
              }, API)
              .catch((err: unknown) => String(err));
            console.log(`[phone sessions] ${sessions}`);
            throw new Error(
              `${String(e)}; phone ${phone.url()} peer connections ${JSON.stringify(pcs)}; phone text "${text}"; desk text "${deskText}"`,
            );
          });
        await expect(phone.locator('[data-layout]')).toHaveAttribute('data-layout', /phone/);
        await shot(phone, 'emulator-phone-console');
      });

      await test.step('a tap is a laser ping on the Desk', async () => {
        const canvas = phone.locator('canvas[role="img"]').first();
        const b = (await canvas.boundingBox())!;
        const before = (await annots(phone)).length;
        // The Android context has no Playwright touchscreen (`hasTouch` is a desktop emulation option): real touch
        // events go in through CDP, as they would from a finger.
        const cdp = await context.newCDPSession(phone);
        await touch(cdp, 'touchStart', [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }]);
        await touch(cdp, 'touchEnd', []);
        await expect
          .poll(async () => (await annots(phone)).slice(before).some((d) => d.includes('"pointer"')))
          .toBe(true);
      });

      await test.step('a pinch zooms the view and sends nothing', async () => {
        const canvas = phone.locator('canvas[role="img"]').first();
        const b = (await canvas.boundingBox())!;
        const cdp = await context.newCDPSession(phone);
        const before = await phone.evaluate(() => (window as unknown as { __dcSends: string[] }).__dcSends.length);
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        const at = (gap: number) => [
          { x: cx - gap / 2, y: cy, id: 1 },
          { x: cx + gap / 2, y: cy, id: 2 },
        ];
        await touch(cdp, 'touchStart', at(60));
        for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', at(60 + i * 20));
        await touch(cdp, 'touchEnd', []);
        await expect(phone.getByText(/^Zoom \d\.\dx$/)).toBeVisible();
        const sent = await phone.evaluate(
          (n) => (window as unknown as { __dcSends: string[] }).__dcSends.slice(n),
          before,
        );
        expect(sent.filter((d) => d.includes('"annot"'))).toEqual([]);
        await shot(phone, 'emulator-phone-zoomed');
      });
      await deskCtx.close();
    } finally {
      await deskBrowser.close();
    }
    return true;
  }
}
