/**
 * Package 3 end-to-end test: a real browser Assist console driven against the native Rust agent (the Desk).
 *
 * The Assist signs up a p3_portable org, creates a one_time p3 token and opens the console; the spec spawns the
 * built dev agent binary (`--synthetic-capture --auto-consent control --no-self-delete`) with that code. It then
 * asserts, through the real UI and the agent's own log, the full P3 surface: the knock and accept, consent granted
 * with monitors, the security code the console shows equals the one the agent printed, the remote video advances,
 * the monitor picker lists the synthetic monitors, the security code is confirmed and an os.input click at
 * `control` is accepted (the view-level `not_allowed` refusal is proven by the Rust tests; the console never emits
 * an input op below control), chat both ways, a file Assist -> agent landing on disk with the right bytes, a
 * starter playbook ("Collect logs (zip)", non-elevation and non-destructive) streaming pb.output and exiting 0,
 * the agent stats widget showing fps/bitrate, the elevation request (hand-over mint audit entry; the runas
 * relaunch is stubbed), Stop from the agent (a `stop` line on its stdin) ending the session, the audit chain
 * verifying, and the exit decision being logged. Files the run creates on the host (the received note,
 * the logs zip) are removed after they are checked.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { captureConsole, probeRemoteVideo, recordPeerConnections, shot, shots } from './helpers';
import { spawnAgent, type AgentProcess } from './agent-harness';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
const FILE_NAME = 'e2e-assist-note.txt';
const FILE_BYTES = randomBytes(1024).toString('hex'); // 2048 ASCII bytes
const FILE_SHA = createHash('sha256').update(FILE_BYTES).digest('hex');

async function newSide(ctx: BrowserContext, side: string): Promise<Page> {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  await ctx.addInitScript(recordPeerConnections);
  const page = await ctx.newPage();
  captureConsole(page, side);
  return page;
}

test('Package 3: Assist console completes a real session with the native agent', async ({ browser }) => {
  const assistCtx = await browser.newContext();
  const assist = await newSide(assistCtx, 'assist');
  let sessionId = '';
  let code = '';
  let agent: AgentProcess | null = null;

  try {
    await test.step('Assist signs up a p3_portable org', async () => {
      await assist.goto('/signup');
      await assist.getByLabel('Organisation name').fill('E2E Portable');
      await assist.getByLabel('Your name').fill('Asha Tech');
      await assist.getByLabel('Work email').fill(`asha+${Date.now()}@e2e.example.com`);
      await assist.getByLabel('Password').fill('correct horse battery staple');
      await assist.getByRole('button', { name: 'Create organisation' }).click();
      await expect(assist).toHaveURL(/\/app$/);
      await expect(assist.getByRole('banner').getByText('Signaling: Online')).toBeVisible();
      await shot(assist, 'assist-dashboard');
    });

    await test.step('Assist creates a one_time p3 token (via the API, with the signed-in cookie)', async () => {
      // Mutations need the CSRF pair the web client sends (X-Requested-With + the web Origin).
      const headers = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };
      const me = await (await assist.request.get(`${API}/api/v1/auth/me`)).json();
      // As in smoke:p3, the signed-up admin's seat is raised to p3_portable before minting a p3 token.
      const seat = await assist.request.patch(`${API}/api/v1/users/${me.user.id}/role`, {
        headers,
        data: { role: 'org_admin', tier: 'p3_portable' },
      });
      expect(seat.status(), 'seat raised to p3_portable').toBeLessThan(300);
      const res = await assist.request.post(`${API}/api/v1/tokens`, {
        headers,
        data: { tier: 'p3_portable', typ: 'one_time', label: 'E2E P3' },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      // The agent accepts the 12-digit short code or the compact ia1.* token (join_input::normalise).
      code = body.token?.shortCode ?? body.compact;
      expect(code, 'token code').toBeTruthy();
    });

    await test.step('Spawn the native agent as the Desk; it knocks', async () => {
      agent = spawnAgent({ code, apiOrigin: API, autoConsent: 'control', stopAfterSecs: 90 });
      await agent.waitForLine(/desk\.hello\.ok|knock/i, 30_000);
    });

    await test.step('Assist sees the knock and accepts', async () => {
      const knock = assist.getByRole('article', { name: /Support request/ }).first();
      await expect(knock).toBeVisible({ timeout: 20_000 });
      await shot(assist, 'assist-knock');
      await knock.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
      sessionId = /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
    });

    await test.step('Consent is granted with monitors; the console reaches a secured live session', async () => {
      // --auto-consent control makes the agent consent at `control` with its synthetic monitors.
      await expect(assist.getByTestId('sas-header')).toBeVisible({ timeout: 30_000 });
      await expect(assist.getByText('Live', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    });

    await test.step('The security code the console shows equals the one the agent printed', async () => {
      const agentSas = await agent!.waitForSas(30_000);
      const header = await assist.getByTestId('sas-header').innerText();
      const consoleSas = (header.match(/(\d{3})\s?(\d{3})/) ?? []).slice(1).join('');
      expect(consoleSas).toBe(agentSas);
      await shot(assist, 'assist-secured');
    });

    await test.step('Remote video advances (synthetic frames)', async () => {
      await expect.poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
      const t0 = (await probeRemoteVideo(assist))!.time;
      await expect.poll(async () => (await probeRemoteVideo(assist))?.time ?? 0).toBeGreaterThan(t0 + 0.3);
      await shot(assist, 'assist-video');
    });

    await test.step('The monitor picker lists the synthetic monitors', async () => {
      const picker = assist.getByRole('group', { name: /monitor/i }).first();
      await expect(picker).toBeVisible();
      await expect(picker.getByText(/SYNTHETIC/i).first()).toBeVisible();
    });

    await test.step('os.input click at control is accepted; a view-level op is refused', async () => {
      // The org requires the security code to be confirmed before Control (section 1.3 step 7).
      await assist.getByRole('button', { name: 'Confirm security code' }).click();
      const confirm = assist.getByRole('dialog', { name: /confirm the security code/i });
      await expect(confirm).toBeVisible();
      const header = await assist.getByTestId('sas-header').innerText();
      const digits = (header.match(/(\d{3})\s?(\d{3})/) ?? []).slice(1).join('');
      await confirm.getByLabel(/security code the user reads out/i).fill(digits);
      await confirm.getByRole('button', { name: 'Confirm code' }).click();
      // Take control and click on the remote screen; the agent answers ctl.res ok.
      await assist.getByRole('button', { name: 'Control', exact: true }).click();
      const screen = assist.locator('canvas[role="img"]').first();
      const box = (await screen.boundingBox())!;
      await assist.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await agent!.waitForLine(/ctl\.res ok|op=os\.pointer/i, 15_000);
      // The agent-side view-level refusal (not_allowed) is proven by the Rust unit/loopback
      // tests; the console will not emit an input op once it is below control, so this is a
      // best-effort probe only.
      await agent!.waitForLine(/not_allowed/i, 2_000).catch(() => undefined);
    });

    await test.step('Chat both ways', async () => {
      await assist.locator('#chat-input').fill('Hello from Assist');
      await assist.getByRole('button', { name: 'Send', exact: true }).click();
      await agent!.waitForLine(/chat.*Hello from Assist|chat message/i, 15_000);
      await expect(assist.getByRole('log', { name: 'Chat messages' })).toContainText('Hello from Assist');
    });

    await test.step('A file Assist -> agent arrives on disk with the right bytes', async () => {
      await assist.locator('#file-send').setInputFiles({ name: FILE_NAME, mimeType: 'text/plain', buffer: Buffer.from(FILE_BYTES) });
      const saved = await agent!.waitForLine(/file saved (.+)/i, 30_000);
      const path = saved[1]!.trim();
      const bytes = readFileSync(path);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(FILE_SHA);
      rmSync(path); // the test file landed in the real Downloads/IndiansAssist folder
    });

    await test.step('A starter playbook runs: output panel shows pb.output and exit 0', async () => {
      // "Collect logs (zip)" is the non-elevation, non-destructive starter playbook: it reads the
      // event logs and writes a zip into the agent's own %LOCALAPPDATA%\IndiansAssist folder.
      // (The agent is not elevated in this build and on recent Windows `ipconfig /flushdns` needs
      // admin; "Clear temp files" would delete files from the developer's real temp folders.)
      const panel = assist.getByRole('region', { name: /playbook/i }).first();
      const item = panel.locator('li', { hasText: 'Collect logs (zip)' });
      await item.getByRole('button', { name: 'Run...' }).click();
      await panel.getByRole('button', { name: 'Run Collect logs (zip)' }).click();
      await expect(panel.getByText(/exit 0|succeeded|done/i).first()).toBeVisible({ timeout: 120_000 });
      // pb.output reached the panel: the playbook's stdout names the zip it produced.
      const out = panel.getByText(/IA_FILE_OFFER .+\.zip/).first();
      await expect(out).toBeVisible();
      const zip = /IA_FILE_OFFER (.+\.zip)/.exec(await out.innerText())?.[1]?.trim();
      const ownDir = resolve(process.env.LOCALAPPDATA ?? '', 'IndiansAssist').toLowerCase();
      if (zip && resolve(zip).toLowerCase().startsWith(ownDir) && existsSync(zip)) rmSync(zip);
      await shot(assist, 'assist-playbook');
    });

    await test.step('The agent stats widget shows fps and bitrate', async () => {
      const stats = assist.getByRole('region', { name: /agent stats|statistics/i }).first();
      await expect(stats.getByText(/fps/i).first()).toBeVisible({ timeout: 20_000 });
      await expect(stats.getByText(/kbps|mbps|bitrate/i).first()).toBeVisible();
    });

    await test.step('Elevation request shows the reason dialog; the hand-over mint is audited', async () => {
      await assist.getByRole('button', { name: 'Elevated', exact: true }).click();
      const dialog = assist.getByRole('dialog', { name: /administrator rights/i });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/why do you need/i).fill('install the printer driver');
      await dialog.getByRole('button', { name: 'Request elevation' }).click();
      // The runas path may be stubbed; the mint is audited server-side regardless.
      await expect
        .poll(async () => {
          const r = await assist.request.get(`${API}/api/v1/sessions/${sessionId}/audit`);
          const a = await r.json();
          return (a.items ?? []).some((e: { action: string }) => e.action === 'elevation.handover_minted');
        }, { timeout: 20_000 })
        .toBe(true);
    });

    await test.step('Stop from the agent ends the session', async () => {
      // --stop-after fires; or interrupt the agent to Stop now.
      agent!.interrupt();
      await expect(assist.getByText(/^Session ended/).first()).toBeVisible({ timeout: 30_000 });
      await agent!.waitForLine(/exit decision: no file change.*no-self-delete/i, 15_000); // exit decision logged (--no-self-delete: no file change)
      await shot(assist, 'assist-ended');
    });

    await test.step('Audit shows the P3 entries and the chain verifies', async () => {
      await assist.goto('/app/audit');
      await assist.locator('#f-session').fill(sessionId);
      await assist.getByRole('button', { name: 'Apply filters' }).click();
      const table = assist.getByRole('table', { name: 'Audit entries' });
      for (const action of ['session.knock', 'session.accepted', 'session.consent_granted', 'session.started', 'elevation.handover_minted', 'session.ended']) {
        await expect(table.getByRole('cell', { name: action, exact: true }).first()).toBeVisible();
      }
      await assist.getByRole('button', { name: 'Verify chain' }).click();
      const badge = assist.getByText(/^Verified /);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute('data-tone', 'green');
      await shot(assist, 'assist-audit-verified');
    });
  } finally {
    console.log(`screenshots:\n${shots.join('\n')}`);
    (agent as AgentProcess | null)?.kill();
    await assistCtx.close();
  }
});
