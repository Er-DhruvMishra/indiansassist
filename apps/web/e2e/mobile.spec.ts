/**
 * The mobile Assist console (docs/specs/phase-f-contracts.md sections 7, 15.6), run by `pnpm e2e:mobile` under
 * `mobile.config.ts` on three Chromium device projects (`pixel-7`, `iphone-15`, `ipad-pro-11`; real iPhone and iPad
 * Safari remain a manual check, W120). The Assist is the device context; the Desk is a desktop context of the same
 * Chromium with a fake screen.
 *
 * 1. Installable shell: the worker is not registered on `/join` and is registered on `/app`; the manifest link exists
 *    only on `/app`; the manifest is fetched and valid; Chromium reports no installability error; offline, the shell
 *    loads ("You are offline") and an `/api` call fails (the worker never answers it).
 * 2. P1 by touch: the layout for the width (phone, phone landscape after a rotation without remounting the view,
 *    tablet), every visible control at least 44 x 44 px, a tap is a laser ping and a drag draws a rectangle that the
 *    Desk sees, and a pinch zooms the view and sends nothing.
 * 3. P3 by touch (`E2E_P3=1`, the wave-0b dev agent with `--synthetic-capture --no-self-delete`): tap, long press,
 *    two-finger scroll and keys arrive as the expected `os.*` ops and the agent accepts them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { ARTIFACTS, captureConsole, probeRemoteVideo, recordPeerConnections, shot } from './helpers';
import { spawnAgent, type AgentProcess } from './agent-harness';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5320'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4155'}`;
const CSRF = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };
const DESK_NAME = 'E2E Mobile Desk';

type Op = { op: string; args: Record<string, unknown> };

/** Init script: every string the page sends on a data channel, by label (P1 annotations travel this way). */
function recordDataChannelSends(): void {
  const w = window as unknown as { __dcSends: { label: string; data: string }[] };
  w.__dcSends = [];
  const proto = (window as unknown as { RTCDataChannel?: { prototype: RTCDataChannel } }).RTCDataChannel?.prototype;
  if (!proto) return;
  const send = proto.send;
  proto.send = function (this: RTCDataChannel, data: string | Blob | ArrayBuffer | ArrayBufferView) {
    if (typeof data === 'string') w.__dcSends.push({ label: this.label, data });
    return (send as (d: unknown) => void).call(this, data);
  } as RTCDataChannel['send'];
}

/** Init script: the agent console pushes every op it sends to `window.__iaOps` when the array exists. */
function recordAgentOps(): void {
  (window as unknown as { __iaOps: unknown[] }).__iaOps = [];
}

async function annotSends(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __dcSends: { data: string }[] }).__dcSends.map((s) => s.data).filter((d) => d.includes('"annot"')));
}

async function agentOps(page: Page): Promise<Op[]> {
  return page.evaluate(() => (window as unknown as { __iaOps: Op[] }).__iaOps);
}

/**
 * True when a line of the agent's log matches (the agent logs every control answer as `ctl.res ok op=<op>`). Its
 * tracing output colours the fields even on a pipe, so the colour codes are removed first.
 */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
function agentSaid(agent: AgentProcess, re: RegExp): boolean {
  return agent.lines.some((l) => re.test(l.replace(ANSI, '')));
}

async function signUp(page: Page, org: string): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('Organisation name').fill(org);
  await page.getByLabel('Your name').fill('Asha Tech');
  await page.getByLabel('Work email').fill(`asha+${Date.now()}${Math.floor(Math.random() * 1000)}@e2e.example.com`);
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText('Signaling: Online')).toBeAttached();
}

async function mintToken(page: Page, tier: 'p1_browser' | 'p3_portable'): Promise<{ joinUrl: string; code: string }> {
  if (tier === 'p3_portable') {
    const me = await (await page.request.get(`${API}/api/v1/auth/me`)).json();
    const seat = await page.request.patch(`${API}/api/v1/users/${me.user.id}/role`, { headers: CSRF, data: { role: 'org_admin', tier: 'p3_portable' } });
    expect(seat.status(), 'seat raised to p3_portable').toBeLessThan(300);
  }
  const res = await page.request.post(`${API}/api/v1/tokens`, { headers: CSRF, data: { tier, typ: 'one_time', label: `E2E mobile ${tier}` } });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { joinUrl: body.joinUrl, code: body.token?.shortCode ?? body.compact };
}

async function acceptKnock(assist: Page): Promise<void> {
  const knock = assist.getByRole('article', { name: /Support request/ }).first();
  await expect(knock).toBeVisible({ timeout: 30_000 });
  await knock.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
}

async function newDesk(ctx: BrowserContext): Promise<Page> {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write', 'camera', 'microphone'], { origin: WEB });
  await ctx.addInitScript(recordPeerConnections);
  const page = await ctx.newPage();
  captureConsole(page, 'desk');
  return page;
}

/** One touch frame through CDP (the device context has touch). */
async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 4, radiusY: 4, force: 1 })) });
}

async function drag(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  await touch(cdp, 'touchStart', [{ ...from, id: 1 }]);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 }]);
    await new Promise((r) => setTimeout(r, 20));
  }
  await touch(cdp, 'touchEnd', []);
}

/** Two fingers, horizontally `gap0` apart about (cx, cy), spread to `gap1` (a pinch) or moved by `dy` (a scroll). */
async function twoFingers(cdp: CDPSession, cx: number, cy: number, gap0: number, gap1: number, dy = 0, steps = 8): Promise<void> {
  const at = (gap: number, y: number) => [
    { x: cx - gap / 2, y, id: 1 },
    { x: cx + gap / 2, y, id: 2 },
  ];
  await touch(cdp, 'touchStart', at(gap0, cy));
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', at(gap0 + ((gap1 - gap0) * i) / steps, cy + (dy * i) / steps));
    await new Promise((r) => setTimeout(r, 20));
  }
  await touch(cdp, 'touchEnd', []);
}

async function viewBox(page: Page) {
  const canvas = page.locator('canvas[role="img"]').first();
  await expect(canvas).toBeVisible();
  return (await canvas.boundingBox())!;
}

/** Visible controls of the shell and console smaller than 44 x 44 CSS px (section 7.4). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.ia-app button, .ia-app [role="tab"], .ia-app select, .ia-app nav a[href], .ia-app label:has(> input[type="radio"])')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none';
      })
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width < 43.5 || r.height < 43.5;
      })
      .map((el) => `${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`),
  );
}

test('installable shell: manifest, worker on /app only, offline shell, installability', async ({ page, context }, info) => {
  captureConsole(page, `assist ${info.project.name}`);
  await test.step('a Desk page registers no worker and has no manifest link', async () => {
    await page.goto('/join');
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    expect(await page.locator('link[rel="manifest"]').count()).toBe(0);
    await page.goto('/c');
    expect(await page.locator('link[rel="manifest"]').count()).toBe(0);
  });

  await test.step('the manifest is served and valid', async () => {
    const res = await page.request.get(`${WEB}/manifest.webmanifest`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/json/);
    const m = await res.json();
    expect(m).toMatchObject({ id: '/app/', start_url: '/app/', scope: '/app/', display: 'standalone', name: 'IndiansAssist', short_name: 'Assist' });
    for (const icon of m.icons as { src: string }[]) expect((await page.request.get(`${WEB}${icon.src}`)).status()).toBe(200);
  });

  await test.step('on /app the manifest link is present and /sw.js is registered with scope /', async () => {
    await signUp(page, `E2E Mobile ${info.project.name}`);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      return { scope: r.scope, script: r.active?.scriptURL ?? '' };
    });
    expect(reg.scope).toBe(`${WEB}/`);
    expect(reg.script).toBe(`${WEB}/sw.js`);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 15_000 }).toBe(true);
  });

  await test.step('Chromium finds no installability error (in a normal, non-incognito profile)', async () => {
    // Playwright's contexts are incognito, which Chromium reports as "in-incognito"; a persistent profile is not.
    const dir = mkdtempSync(join(ARTIFACTS, 'profile-'));
    const u = info.project.use;
    const ctx = await chromium.launchPersistentContext(dir, {
      channel: 'chromium',
      headless: process.env.E2E_HEADED !== '1',
      baseURL: WEB,
      serviceWorkers: 'allow',
      ...(u.viewport ? { viewport: u.viewport } : {}),
      ...(u.userAgent ? { userAgent: u.userAgent } : {}),
      ...(u.deviceScaleFactor ? { deviceScaleFactor: u.deviceScaleFactor } : {}),
      isMobile: u.isMobile ?? false,
      hasTouch: u.hasTouch ?? false,
    });
    try {
      const p = ctx.pages()[0] ?? (await ctx.newPage());
      await signUp(p, `E2E Install ${info.project.name}`);
      await p.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await expect.poll(() => p.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 15_000 }).toBe(true);
      const cdp = await ctx.newCDPSession(p);
      const r = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string }[] };
      expect(r.installabilityErrors.map((e) => e.errorId)).toEqual([]);
      const m = (await cdp.send('Page.getAppManifest')) as { url: string; errors: unknown[] };
      expect(m.url).toBe(`${WEB}/manifest.webmanifest`);
      expect(m.errors).toEqual([]);
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test.step('offline: the shell loads and API calls fail (the worker never answers them)', async () => {
    await context.setOffline(true);
    try {
      await page.goto('/app/');
      await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
      const sameOrigin = await page.evaluate(() => fetch('/api/v1/auth/me').then((r) => `status ${r.status}`, (e: Error) => `failed: ${e.name}`));
      expect(sameOrigin).toMatch(/^failed/);
      const api = await page.evaluate((u) => fetch(u, { credentials: 'include' }).then((r) => `status ${r.status}`, (e: Error) => `failed: ${e.name}`), `${API}/api/v1/auth/me`);
      expect(api).toMatch(/^failed/);
      await shot(page, `mobile-${info.project.name}-offline`);
    } finally {
      await context.setOffline(false);
    }
    await page.goto('/app/');
    await expect(page.getByRole('heading', { name: 'You are offline' })).toHaveCount(0);
  });
});

test('P1 by touch: layout, target sizes, annotation, pinch sends nothing', async ({ page, context, browser }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  await context.addInitScript(recordDataChannelSends);
  captureConsole(page, `assist ${info.project.name}`);
  const deskCtx = await browser.newContext();
  const desk = await newDesk(deskCtx);
  try {
    await signUp(page, `E2E P1 ${info.project.name}`);
    const { joinUrl } = await mintToken(page, 'p1_browser');

    await test.step('the Desk joins and shares; the Assist accepts on the device', async () => {
      await desk.goto(joinUrl);
      await desk.getByLabel('Your name (optional, shown to the technician)').fill(DESK_NAME);
      await desk.getByRole('button', { name: 'Join support session' }).click();
      await acceptKnock(page);
      await expect(desk.getByRole('heading', { name: /is asking to see your screen/ })).toBeVisible();
      await desk.getByLabel('Share a single window instead of my whole screen').uncheck();
      await desk.getByLabel('I have closed or hidden anything private').check();
      await desk.getByRole('button', { name: 'Share my screen' }).click();
      await expect.poll(async () => (await probeRemoteVideo(page))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    });

    const expected = info.project.name === 'ipad-pro-11' ? 'tablet' : 'phone';
    await test.step(`the ${expected} layout, with every control at least 44 x 44 px`, async () => {
      await expect(page.locator('[data-layout]')).toHaveAttribute('data-layout', expected);
      await expect(page.getByRole('tab', { name: 'Chat' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'More' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'End', exact: true })).toBeVisible();
      expect(await smallTargets(page)).toEqual([]);
      await shot(page, `mobile-${info.project.name}-p1-${expected}`);
      for (const tab of ['Chat', 'Files', 'More', 'View']) {
        await page.getByRole('tab', { name: tab }).click();
        expect(await smallTargets(page), `small targets on the ${tab} tab`).toEqual([]);
      }
    });

    await test.step('a tap is a laser ping; a drag with Rectangle draws on the Desk', async () => {
      const box = await viewBox(page);
      const before = (await annotSends(page)).length;
      await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await expect.poll(async () => (await annotSends(page)).slice(before).some((d) => d.includes('"pointer"'))).toBe(true);
      await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
      const cdp = await context.newCDPSession(page);
      const b = await viewBox(page);
      await drag(cdp, { x: b.x + b.width * 0.2, y: b.y + b.height * 0.2 }, { x: b.x + b.width * 0.6, y: b.y + b.height * 0.6 });
      await expect.poll(async () => (await annotSends(page)).some((d) => d.includes('"rect"'))).toBe(true);
      const deskOverlay = desk.getByRole('img', { name: 'Technician annotations on your shared screen' });
      await expect.poll(() => deskOverlay.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx || c.width === 0) return 0;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
        return n;
      })).toBeGreaterThan(50);
      await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
    });

    await test.step('a pinch zooms the view locally and sends nothing', async () => {
      const cdp = await context.newCDPSession(page);
      const b = await viewBox(page);
      const before = await page.evaluate(() => (window as unknown as { __dcSends: unknown[] }).__dcSends.length);
      await twoFingers(cdp, b.x + b.width / 2, b.y + b.height / 2, Math.min(80, b.width / 4), Math.min(240, b.width * 0.8));
      await expect(page.getByText(/^Zoom \d\.\dx$/)).toBeVisible();
      const sent = await page.evaluate((n) => (window as unknown as { __dcSends: { label: string; data: string }[] }).__dcSends.slice(n), before);
      expect(sent.filter((s) => s.data.includes('"annot"'))).toEqual([]);
      await shot(page, `mobile-${info.project.name}-p1-zoomed`);
      await page.getByRole('button', { name: 'Reset zoom' }).click();
      await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveCount(0);
    });

    if (expected === 'phone') {
      await test.step('rotating to landscape fills the screen without remounting the view', async () => {
        await page.locator('canvas[role="img"]').first().evaluate((el) => ((el as unknown as { __mark: number }).__mark = 1));
        const vp = page.viewportSize()!;
        await page.setViewportSize({ width: vp.height, height: vp.width });
        await expect(page.locator('[data-layout]')).toHaveAttribute('data-layout', 'phone_landscape');
        expect(await page.locator('canvas[role="img"]').first().evaluate((el) => (el as unknown as { __mark?: number }).__mark)).toBe(1);
        await shot(page, `mobile-${info.project.name}-p1-landscape`);
        await page.setViewportSize(vp);
        await expect(page.locator('[data-layout]')).toHaveAttribute('data-layout', 'phone');
      });
    }
  } finally {
    await deskCtx.close();
  }
});

test('P3 by touch: tap, long press, two-finger scroll and keys reach the agent as os.* ops', async ({ page, context }, info) => {
  test.skip(process.env.E2E_P3 !== '1', 'set E2E_P3=1 with AGENT_BIN and AGENT_DEV_STUB pointing at the wave-0b dev agent copy');
  test.skip(info.project.name === 'iphone-15', 'the phone path is covered by pixel-7; the iPhone layout is checked by the P1 case');
  await context.addInitScript(recordAgentOps);
  captureConsole(page, `assist ${info.project.name}`);
  let agent: AgentProcess | null = null;
  try {
    await signUp(page, `E2E P3 ${info.project.name}`);
    const { code } = await mintToken(page, 'p3_portable');
    agent = spawnAgent({ code, apiOrigin: API, autoConsent: 'control', stopAfterSecs: 180 });
    await agent.waitForLine(/desk\.hello\.ok|knock/i, 30_000);
    await acceptKnock(page);

    await test.step('secure, confirm the code and take control', async () => {
      await expect(page.getByTestId('sas-header')).toBeVisible({ timeout: 30_000 });
      const agentSas = await agent!.waitForSas(30_000);
      expect((await page.getByTestId('sas-header').innerText()).replace(/\D/g, '').slice(0, 6)).toBe(agentSas);
      await page.getByRole('button', { name: 'Confirm security code' }).click();
      const dialog = page.getByRole('dialog', { name: /confirm the security code/i });
      await dialog.getByLabel(/security code the user reads out/i).fill(agentSas);
      await dialog.getByRole('button', { name: 'Confirm code' }).click();
      await page.getByRole('button', { name: 'Control', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Control', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await probeRemoteVideo(page))?.width ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
      await shot(page, `mobile-${info.project.name}-p3-control`);
    });

    const opsOf = async (name: string, from: number) => (await agentOps(page)).slice(from).filter((o) => o.op === name);

    await test.step('a tap is os.pointer click button 0', async () => {
      const n = (await agentOps(page)).length;
      const b = await viewBox(page);
      await page.touchscreen.tap(b.x + b.width * 0.4, b.y + b.height * 0.4);
      await expect.poll(async () => (await opsOf('os.pointer', n)).some((o) => o.args['kind'] === 'click' && o.args['button'] === 0), { timeout: 5_000 }).toBe(true);
      await expect.poll(() => agentSaid(agent!, /ctl\.res ok op=os\.pointer/), { timeout: 15_000 }).toBe(true);
    });

    await test.step('a long press is os.pointer click button 2 (right click)', async () => {
      const n = (await agentOps(page)).length;
      const cdp = await context.newCDPSession(page);
      const b = await viewBox(page);
      await touch(cdp, 'touchStart', [{ x: b.x + b.width * 0.3, y: b.y + b.height * 0.3, id: 5 }]);
      await page.waitForTimeout(800);
      await touch(cdp, 'touchEnd', []);
      await expect.poll(async () => (await opsOf('os.pointer', n)).some((o) => o.args['kind'] === 'click' && o.args['button'] === 2), { timeout: 5_000 }).toBe(true);
    });

    await test.step('a two-finger drag up scrolls down (os.scroll)', async () => {
      const n = (await agentOps(page)).length;
      const cdp = await context.newCDPSession(page);
      const b = await viewBox(page);
      await twoFingers(cdp, b.x + b.width / 2, b.y + b.height * 0.7, 120, 120, -Math.min(160, b.height * 0.5), 10);
      await expect.poll(async () => (await opsOf('os.scroll', n)).reduce((s, o) => s + Number(o.args['dy'] ?? 0), 0), { timeout: 5_000 }).toBeGreaterThan(0);
      await expect.poll(() => agentSaid(agent!, /ctl\.res ok op=os\.scroll/), { timeout: 15_000 }).toBe(true);
    });

    await test.step('the keys bar sends os.key and typed text as os.text', async () => {
      const n = (await agentOps(page)).length;
      await page.getByRole('tab', { name: 'Keys' }).click();
      await page.getByRole('button', { name: 'Escape' }).click();
      await page.getByRole('button', { name: 'Ctrl' }).click();
      await page.getByRole('button', { name: 'Left arrow' }).click();
      await page.getByLabel('Type on the remote computer').focus();
      await page.keyboard.type('hi');
      await expect.poll(async () => (await opsOf('os.text', n)).map((o) => o.args['text']).join(''), { timeout: 5_000 }).toBe('hi');
      const keys = (await opsOf('os.key', n)).map((o) => `${o.args['kind']}:${o.args['code']}`);
      expect(keys).toEqual(expect.arrayContaining(['press:Escape', 'down:ControlLeft', 'press:ArrowLeft', 'up:ControlLeft']));
      await expect.poll(() => agentSaid(agent!, /ctl\.res ok op=os\.key/), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => agentSaid(agent!, /ctl\.res ok op=os\.text/), { timeout: 15_000 }).toBe(true);
      await shot(page, `mobile-${info.project.name}-p3-keys`);
    });

    await test.step('every op of the run was accepted by the agent', async () => {
      expect(agentSaid(agent!, /ctl\.res refused op=os\./)).toBe(false);
    });
  } finally {
    agent?.interrupt();
    await agent?.waitForExit(15_000).catch(() => undefined);
    agent?.kill();
  }
});
