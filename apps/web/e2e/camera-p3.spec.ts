/**
 * Phase F phone camera in a P3 session (docs/specs/phase-f-contracts.md sections 6, 15.5): the wave-0b dev agent
 * (`--synthetic-capture --no-self-delete`, read-only: no playbook, no file) is the Desk; the Assist opens **Phone
 * camera**, sends the link to the Desk's chat (the agent logs the chat message), a phone context (`devices['Pixel 7']`,
 * Chromium's fake camera) opens the link, consents, and the Assist sees the camera live beside the agent's screen,
 * records a snapshot by hash and stops the camera; the agent's own session keeps running; the chain holds the camera
 * entries.
 *
 *   E2E_P3=1 AGENT_BIN=<repo>/data/agent-bin/IndiansAssist.exe AGENT_DEV_STUB=<same> E2E_API_PORT=4150 E2E_WEB_PORT=5310 \
 *     E2E_DATA_DIR=./data/e2e-camera pnpm --filter @indiansassist/web exec playwright test camera-p3
 */
import { devices, expect, test, type Page } from '@playwright/test';
import { spawnAgent, type AgentProcess } from './agent-harness';
import { captureConsole, probeRemoteVideo, shot } from './helpers';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;

test('Phone camera in a P3 session with the native agent', async ({ browser }) => {
  test.setTimeout(420_000);
  const assistCtx = await browser.newContext({ acceptDownloads: true });
  await assistCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'] });
  await phoneCtx.grantPermissions(['camera'], { origin: WEB });
  const assist = await assistCtx.newPage();
  captureConsole(assist, 'assist');
  const phone: Page = await phoneCtx.newPage();
  captureConsole(phone, 'phone');
  const panel = assist
    .getByRole('heading', { name: 'Phone camera', exact: true })
    .locator('xpath=ancestor::section[1]');
  let agent: AgentProcess | null = null;
  let sessionId = '';
  let url = '';

  try {
    await test.step('a live P3 session with the dev agent', async () => {
      await assist.goto('/signup');
      await assist.getByLabel('Organisation name').fill('Camera Portable');
      await assist.getByLabel('Your name').fill('Meera Tech');
      await assist.getByLabel('Work email').fill(`meera+${Date.now()}@e2e.example.com`);
      await assist.getByLabel('Password').fill('correct horse battery staple');
      await assist.getByRole('button', { name: 'Create organisation' }).click();
      await expect(assist).toHaveURL(/\/app$/);
      await expect(assist.getByRole('banner').getByText('Signaling: Online')).toBeVisible();
      const headers = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };
      const me = await (await assist.request.get(`${API}/api/v1/auth/me`)).json();
      const seat = await assist.request.patch(`${API}/api/v1/users/${me.user.id}/role`, {
        headers,
        data: { role: 'org_admin', tier: 'p3_portable' },
      });
      expect(seat.status()).toBeLessThan(300);
      const res = await assist.request.post(`${API}/api/v1/tokens`, {
        headers,
        data: { tier: 'p3_portable', typ: 'one_time', label: 'Camera P3' },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      agent = spawnAgent({
        code: body.token?.shortCode ?? body.compact,
        apiOrigin: API,
        autoConsent: 'view',
        stopAfterSecs: 300,
      });
      await agent.waitForLine(/desk\.hello\.ok|knock/i, 60_000);
      const knock = assist.getByRole('article', { name: /Support request/ }).first();
      await expect(knock).toBeVisible({ timeout: 30_000 });
      await knock.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
      sessionId = /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
      await expect(assist.getByText('Live', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 60_000 })
        .toBeGreaterThan(0);
    });

    await test.step('Phone camera: the link goes to the agent through ia.chat', async () => {
      await panel.getByRole('button', { name: 'Phone camera' }).click();
      await expect(panel.getByRole('img', { name: 'QR code of the phone camera link' })).toBeVisible();
      url = ((await panel.getByText(/^Link /).textContent()) ?? '').replace(/^Link\s+/, '').trim();
      expect(url).toMatch(/\/c\/[0-9A-HJKMNP-TV-Z]{12}$/);
      await panel.getByRole('button', { name: "Send to the Desk's chat" }).click();
      await expect(assist.getByRole('log', { name: 'Chat messages' })).toContainText(url);
      await agent!.waitForLine(/chat/i, 30_000);
      await shot(assist, 'camera-p3-link');
    });

    await test.step('the phone consents; the Assist sees the camera beside the agent screen', async () => {
      await phone.goto(url);
      await phone.getByRole('button', { name: 'Start camera' }).click();
      const video = panel.getByLabel("Phone camera, live video from the person's phone");
      await expect(video).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 60_000 })
        .toBeGreaterThan(0);
      await expect(phone.locator('span.font-mono')).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
      await expect(panel.locator('span.font-mono').filter({ hasText: /^\d{3} \d{3}$/ })).toHaveText(
        (await phone.locator('span.font-mono').textContent()) ?? 'x',
      );
      // the agent's own video keeps running beside the camera
      const t0 = (await probeRemoteVideo(assist))!.time;
      await expect.poll(async () => (await probeRemoteVideo(assist))?.time ?? 0).toBeGreaterThan(t0 + 0.3);
      await shot(assist, 'camera-p3-live');
    });

    await test.step('snapshot by hash, then the Assist stops the camera', async () => {
      const download = assist.waitForEvent('download');
      await panel.getByRole('button', { name: 'Snapshot' }).click();
      expect((await download).suggestedFilename()).toMatch(/^camera-[0-9a-f]{8}-\d{8}-\d{6}\.png$/);
      await expect(panel.getByText(/noted in the audit log/)).toBeVisible();
      await panel.getByRole('button', { name: 'Stop camera' }).click();
      await expect(phone.getByText(/The technician stopped the camera/)).toBeVisible();
      await expect(panel.getByText('Ended: you stopped the camera').first()).toBeVisible();
      await expect(assist.getByText('Live', { exact: true }).first()).toBeVisible();
    });

    await test.step('the chain holds the camera entries', async () => {
      const res = await assist.request.get(`${API}/api/v1/sessions/${sessionId}/audit`);
      const body = (await res.json()) as { items: { action: string; data: Record<string, unknown> }[] };
      const actions = body.items.map((e) => e.action);
      for (const a of ['camera.link_created', 'camera.started', 'camera.snapshot', 'camera.ended'])
        expect(actions).toContain(a);
      expect(body.items.find((e) => e.action === 'camera.ended')!.data.by).toBe('assist');
    });
  } finally {
    (agent as AgentProcess | null)?.kill();
    await phoneCtx.close();
    await assistCtx.close();
  }
});
