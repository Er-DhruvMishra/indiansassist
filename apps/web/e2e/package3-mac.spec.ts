/**
 * `pnpm e2e:p3:mac` (docs/specs/phase-f-contracts.md section 17.6): a Chromium Assist console against the macOS
 * portable dev agent on the same Mac, with `--synthetic-capture --auto-consent control --no-self-delete` (A1):
 *
 * knock and accept, `desk.hello` as `os: 'mac'` with the section 17.2 capabilities, the security code the console
 * shows equals the one the agent printed, video advances, a click at `control` is accepted, chat, a file Assist ->
 * agent landing in the run's temporary download folder with the right bytes, a read-only `zsh` playbook streaming
 * pb.output and exiting 0, the stats widget, Stop from the agent, the self-delete decision logged (skipped:
 * `--no-self-delete`), and the audit chain verifying.
 *
 * Nothing is captured from or injected into the user's desktop and TCC is never touched: see mac-agent-harness.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { captureConsole, probeRemoteVideo, recordPeerConnections, shot, shots } from './helpers';
import { MAC_PLAYBOOKS, MacAgent } from './mac-agent-harness';

const PORT = process.env.E2E_API_PORT || '4170';
const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5340'}`;
const API = `http://localhost:${PORT}`;
const AGENT_API = `http://127.0.0.1:${PORT}`;
const PLAYBOOK = MAC_PLAYBOOKS[0]!;

async function newSide(ctx: BrowserContext, side: string): Promise<Page> {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  await ctx.addInitScript(recordPeerConnections);
  const page = await ctx.newPage();
  captureConsole(page, side);
  return page;
}

const headers = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };

/** Sign up a p3_portable org, raise the seat, add the read-only zsh playbook, mint a one_time p3 token. */
async function setupOrg(assist: Page, label: string): Promise<string> {
  await assist.goto('/signup');
  await assist.getByLabel('Organisation name').fill(`E2E Mac ${label}`);
  await assist.getByLabel('Your name').fill('Asha Tech');
  await assist.getByLabel('Work email').fill(`asha+mac-${label}-${Date.now()}@e2e.example.com`);
  await assist.getByLabel('Password').fill('correct horse battery staple');
  await assist.getByRole('button', { name: 'Create organisation' }).click();
  await expect(assist).toHaveURL(/\/app$/);
  const me = await (await assist.request.get(`${API}/api/v1/auth/me`)).json();
  const seat = await assist.request.patch(`${API}/api/v1/users/${me.user.id}/role`, {
    headers,
    data: { role: 'org_admin', tier: 'p3_portable' },
  });
  expect(seat.status(), 'seat raised to p3_portable').toBeLessThan(300);
  const pb = await assist.request.post(`${API}/api/v1/orgs/current/playbooks`, { headers, data: PLAYBOOK });
  expect(pb.status(), `zsh playbook created: ${await pb.text()}`).toBe(201);
  const res = await assist.request.post(`${API}/api/v1/tokens`, {
    headers,
    data: { tier: 'p3_portable', typ: 'one_time', label: `E2E Mac ${label}` },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  const code: string = body.token?.shortCode ?? body.compact;
  expect(code, 'token code').toBeTruthy();
  return code;
}

test('macOS agent (synthetic capture): the section 17.6 session end to end', async ({ browser }) => {
  const ctx = await browser.newContext();
  const assist = await newSide(ctx, 'assist');
  let agent: MacAgent | null = null;
  try {
    const code = await setupOrg(assist, 'synthetic');
    let sessionId = '';
    await test.step('the macOS agent knocks as os mac; the Assist accepts; the security codes match', async () => {
      agent = new MacAgent({ code, apiOrigin: AGENT_API, stopAfterSecs: 180 });
      await agent.waitForLine(/desk\.hello\.ok|knock/i, 60_000);
      await agent.waitForLine(/macos capabilities.*"screen".*"input".*"playbooks"/i, 5_000);
      const knock = assist.getByRole('article', { name: /Support request/ }).first();
      await expect(knock).toBeVisible({ timeout: 30_000 });
      await knock.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
      sessionId = /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
      await expect(assist.getByTestId('sas-header')).toBeVisible({ timeout: 45_000 });
      await expect(assist.getByText('Live', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
      const agentSas = await agent.waitForSas(30_000);
      const header = await assist.getByTestId('sas-header').innerText();
      const consoleSas = (header.match(/(\d{3})\s?(\d{3})/) ?? []).slice(1).join('');
      expect(consoleSas, 'console and agent derive the same security code').toBe(agentSas);
      await shot(assist, 'mac-synthetic-secured');
    });
    const a = agent as unknown as MacAgent;
    await test.step('video advances', async () => {
      await expect.poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      const t0 = (await probeRemoteVideo(assist))!.time;
      await expect.poll(async () => (await probeRemoteVideo(assist))?.time ?? 0).toBeGreaterThan(t0 + 0.3);
    });
    await test.step('a click at control is accepted', async () => {
      await assist.getByRole('button', { name: 'Confirm security code' }).click();
      const confirm = assist.getByRole('dialog', { name: /confirm the security code/i });
      await expect(confirm).toBeVisible();
      const header = await assist.getByTestId('sas-header').innerText();
      const digits = (header.match(/(\d{3})\s?(\d{3})/) ?? []).slice(1).join('');
      await confirm.getByLabel(/security code the user reads out/i).fill(digits);
      await confirm.getByRole('button', { name: 'Confirm code' }).click();
      await assist.getByRole('button', { name: 'Control', exact: true }).click();
      const screen = assist.locator('canvas[role="img"]').first();
      const box = (await screen.boundingBox())!;
      await assist.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await a.waitForLine(/ctl\.res ok|op=os\.pointer/i, 15_000);
    });
    await test.step('chat Assist -> Desk', async () => {
      await assist.locator('#chat-input').fill('Hello Mac');
      await assist.getByRole('button', { name: 'Send', exact: true }).click();
      await a.waitForLine(/chat.*Hello Mac|chat message/i, 15_000);
      await expect(assist.getByRole('log', { name: 'Chat messages' })).toContainText('Hello Mac');
    });
    await test.step('a file lands in the temporary download folder with the right bytes', async () => {
      const bytes = randomBytes(1024).toString('hex');
      const sha = createHash('sha256').update(bytes).digest('hex');
      await assist.locator('#file-send').setInputFiles({ name: 'e2e-mac-note.txt', mimeType: 'text/plain', buffer: Buffer.from(bytes) });
      const saved = await a.waitForLine(/file saved (\S+)/i, 30_000);
      const path = saved[1]!.trim();
      expect(path.startsWith(`${a.downloads}/`), `saved in the run's download folder: ${path}`).toBe(true);
      expect(a.sha256Of(path)).toBe(sha);
    });
    await test.step('the read-only zsh playbook streams pb.output and exits 0', async () => {
      const panel = assist.getByRole('region', { name: /playbook/i }).first();
      const item = panel.locator('li', { hasText: PLAYBOOK.name });
      await expect(item).toBeVisible({ timeout: 20_000 });
      await item.getByRole('button', { name: 'Run...' }).click();
      await panel.getByRole('button', { name: `Run ${PLAYBOOK.name}` }).click();
      await expect(panel.getByText(/exit 0|succeeded|done/i).first()).toBeVisible({ timeout: 60_000 });
      await expect(panel.getByText(/who=e2e/).first()).toBeVisible();
      await expect(panel.getByText(/uname=Darwin/).first()).toBeVisible();
      await expect(panel.getByText(/shell=zsh/).first()).toBeVisible();
      // The run directory is the agent's private run dir inside this run's temporary root.
      await expect(panel.getByText(new RegExp(`cwd=${a.runDir}`)).first()).toBeVisible();
      await shot(assist, 'mac-synthetic-playbook');
    });
    await test.step('the stats widget shows fps and bitrate', async () => {
      const stats = assist.getByRole('region', { name: /agent stats|statistics/i }).first();
      await expect(stats.getByText(/fps/i).first()).toBeVisible({ timeout: 20_000 });
      await expect(stats.getByText(/kbps|mbps|bitrate/i).first()).toBeVisible();
    });
    await test.step('Stop from the agent ends the session; the self-delete decision is logged', async () => {
      a.interrupt();
      await expect(assist.getByText(/^Session ended/).first()).toBeVisible({ timeout: 30_000 });
      // Phase F 3.4: the exit decision (with --no-self-delete, action Nothing); the older wording is accepted too.
      await a.waitForLine(/exit decision|self-delete.*(skip|decision|keep)/i, 20_000);
    });
    await test.step('the audit chain verifies', async () => {
      await assist.goto('/app/audit');
      await assist.locator('#f-session').fill(sessionId);
      await assist.getByRole('button', { name: 'Apply filters' }).click();
      const table = assist.getByRole('table', { name: 'Audit entries' });
      for (const action of ['session.knock', 'session.accepted', 'session.consent_granted', 'session.started', 'session.ended']) {
        await expect(table.getByRole('cell', { name: action, exact: true }).first()).toBeVisible();
      }
      await assist.getByRole('button', { name: 'Verify chain' }).click();
      const badge = assist.getByText(/^Verified /);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute('data-tone', 'green');
    });
  } finally {
    console.log(`screenshots:\n${shots.join('\n')}`);
    (agent as MacAgent | null)?.kill();
    await ctx.close();
  }
});
