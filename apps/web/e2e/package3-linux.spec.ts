/**
 * `pnpm e2e:p3:linux` (docs/specs/phase-e-contracts.md sections 7.10, 15.7): a Windows Chromium Assist console
 * against the Linux portable agent built and run in WSL Ubuntu.
 *
 * Five sessions, each in its own org and token:
 *
 *  1. synthetic (the section 7.10 command: `--synthetic-capture --auto-consent control --no-self-delete`): knock and
 *     accept, `desk.hello` as `os: 'linux'` with the section 7.5 capabilities, the security code the console shows
 *     equals the one the agent printed, video advances, a click at `control` is accepted, chat, a file Assist ->
 *     agent landing in the run's temporary download folder with the right bytes, an `sh` playbook (read-only: it
 *     prints its parameter and its working directory) streaming pb.output and exiting 0, the stats widget, Stop from
 *     the agent, the self-delete decision logged (skipped: `--no-self-delete`), and the audit chain verifying;
 *  2. x11: the agent captures a harness-owned Xvfb (3840x1080 with two RandR monitors, `IA-E2E-LEFT` and
 *     `IA-E2E-RIGHT`) through MIT-SHM and injects through XTEST into it: the monitor picker lists both monitors,
 *     video advances, and a click on the remote screen moves the Xvfb pointer to the matching point (read back with
 *     xdotool on the harness display only);
 *  3. wayland: the agent sees a Wayland session (a WAYLAND_DISPLAY that names no compositor), shares no screen and
 *     says so; the console shows the no-screen state, and chat and a file still work;
 *  4. portal (Phase F section 9.6): the X11 dev binary with `.ia-portal` beside it, started under the headless portal
 *     stack (agent/scripts/portal-test.sh), hands over to the portal binary (its log and `/proc/<pid>/exe`) and joins:
 *     the console shows video of the stack's known colour, Control is greyed with E's text, chat and a file work;
 *  5. portal-nopw: the same pair with `IA_TEST_NO_PIPEWIRE=1` (dev builds only): the X11 binary stays and says that
 *     screen sharing on Wayland needs PipeWire; the console shows the no-screen state.
 *
 * Nothing is sent to or captured from the user's desktop: see linux-agent-harness.ts and agent/scripts/e2e-agent.sh.
 */
import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { captureConsole, probeRemoteVideo, recordPeerConnections, shot, shots } from './helpers';
import { LinuxAgent, type LinuxMode } from './linux-agent-harness';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5285'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || process.env.E2E_LINUX_PORT || '4115'}`;
const GW = process.env.E2E_LINUX_GW || '127.0.0.1';
const AGENT_API = `http://${GW}:${process.env.E2E_API_PORT || process.env.E2E_LINUX_PORT || '4115'}`;
const PLAYBOOK = 'Linux e2e: say where I am';
// Read-only: prints its parameter and its working directory, nothing else.
const PLAYBOOK_BODY = 'echo "who=$IA_PARAM_WHO"\necho "cwd=$(pwd)"\necho "uname=$(uname -s)"\n';

async function newSide(ctx: BrowserContext, side: string): Promise<Page> {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  await ctx.addInitScript(recordPeerConnections);
  const page = await ctx.newPage();
  captureConsole(page, side);
  return page;
}

const headers = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };

/** Sign up a p3_portable org, raise the seat, add the read-only sh playbook, mint a one_time p3 token. */
async function setupOrg(assist: Page, label: string): Promise<string> {
  await assist.goto('/signup');
  await assist.getByLabel('Organisation name').fill(`E2E Linux ${label}`);
  await assist.getByLabel('Your name').fill('Asha Tech');
  await assist.getByLabel('Work email').fill(`asha+linux-${label}-${Date.now()}@e2e.example.com`);
  await assist.getByLabel('Password').fill('correct horse battery staple');
  await assist.getByRole('button', { name: 'Create organisation' }).click();
  await expect(assist).toHaveURL(/\/app$/);
  const me = await (await assist.request.get(`${API}/api/v1/auth/me`)).json();
  const seat = await assist.request.patch(`${API}/api/v1/users/${me.user.id}/role`, {
    headers,
    data: { role: 'org_admin', tier: 'p3_portable' },
  });
  expect(seat.status(), 'seat raised to p3_portable').toBeLessThan(300);
  const pb = await assist.request.post(`${API}/api/v1/orgs/current/playbooks`, {
    headers,
    data: {
      name: PLAYBOOK,
      description: 'Read-only: prints its parameter and its working directory.',
      interpreter: 'sh',
      body: PLAYBOOK_BODY,
      requiresElevation: false,
      timeoutSec: 30,
      parameters: [{ name: 'who', label: 'Who', type: 'string', required: false, pattern: '[A-Za-z0-9 ]{1,40}', default: 'e2e' }],
    },
  });
  expect(pb.status(), `sh playbook created: ${await pb.text()}`).toBe(201);
  const res = await assist.request.post(`${API}/api/v1/tokens`, {
    headers,
    data: { tier: 'p3_portable', typ: 'one_time', label: `E2E Linux ${label}` },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  const code: string = body.token?.shortCode ?? body.compact;
  expect(code, 'token code').toBeTruthy();
  return code;
}

/** Spawn the agent, accept its knock and reach a secured live session; returns the session id. */
async function joinAndSecure(assist: Page, mode: LinuxMode, code: string): Promise<{ agent: LinuxAgent; sessionId: string }> {
  const agent = new LinuxAgent({ mode, code, apiOrigin: AGENT_API, stopAfterSecs: 180 });
  await agent.waitForLine(/desk\.hello\.ok|knock/i, 60_000);
  const knock = assist.getByRole('article', { name: /Support request/ }).first();
  await expect(knock).toBeVisible({ timeout: 30_000 });
  await knock.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
  const sessionId = /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
  await expect(assist.getByTestId('sas-header')).toBeVisible({ timeout: 45_000 });
  await expect(assist.getByText('Live', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  const agentSas = await agent.waitForSas(30_000);
  const header = await assist.getByTestId('sas-header').innerText();
  const consoleSas = (header.match(/(\d{3})\s?(\d{3})/) ?? []).slice(1).join('');
  expect(consoleSas, 'console and agent derive the same security code').toBe(agentSas);
  return { agent, sessionId };
}

async function confirmSasAndTakeControl(assist: Page): Promise<void> {
  await confirmSas(assist);
  await assist.getByRole('button', { name: 'Control', exact: true }).click();
}

async function confirmSas(assist: Page): Promise<void> {
  await assist.getByRole('button', { name: 'Confirm security code' }).click();
  const confirm = assist.getByRole('dialog', { name: /confirm the security code/i });
  await expect(confirm).toBeVisible();
  const header = await assist.getByTestId('sas-header').innerText();
  const digits = (header.match(/(\d{3})\s?(\d{3})/) ?? []).slice(1).join('');
  await confirm.getByLabel(/security code the user reads out/i).fill(digits);
  await confirm.getByRole('button', { name: 'Confirm code' }).click();
  await expect(confirm).toBeHidden();
}

async function sendFile(assist: Page, agent: LinuxAgent, name: string): Promise<void> {
  const bytes = randomBytes(1024).toString('hex');
  const sha = createHash('sha256').update(bytes).digest('hex');
  await assist.locator('#file-send').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(bytes) });
  const saved = await agent.waitForLine(/file saved (\S+)/i, 30_000);
  const path = saved[1]!.trim();
  expect(path.startsWith(`${agent.root}/downloads/IndiansAssist/`), `saved in the run's download folder: ${path}`).toBe(true);
  expect(agent.sha256Of(path)).toBe(sha);
}

async function chat(assist: Page, agent: LinuxAgent, text: string): Promise<void> {
  await assist.locator('#chat-input').fill(text);
  await assist.getByRole('button', { name: 'Send', exact: true }).click();
  await agent.waitForLine(new RegExp(`chat.*${text}|chat message`, 'i'), 15_000);
  await expect(assist.getByRole('log', { name: 'Chat messages' })).toContainText(text);
}

async function stopFromAgent(assist: Page, agent: LinuxAgent): Promise<void> {
  agent.interrupt();
  await expect(assist.getByText(/^Session ended/).first()).toBeVisible({ timeout: 30_000 });
  await agent.waitForLine(/exit decision: no file change.*no-self-delete/i, 20_000); // --no-self-delete: no file change
}

test.describe.configure({ mode: 'serial' });

test('Linux agent (synthetic capture): the section 7.10 session end to end', async ({ browser }) => {
  const ctx = await browser.newContext();
  const assist = await newSide(ctx, 'assist');
  let agent: LinuxAgent | null = null;
  try {
    const code = await setupOrg(assist, 'synthetic');
    let sessionId = '';
    await test.step('the Linux agent knocks as os linux; the Assist accepts; the security codes match', async () => {
      ({ agent, sessionId } = await joinAndSecure(assist, 'synthetic', code));
      await agent.waitForLine(/linux capabilities.*features.*"playbooks"/i, 5_000);
      await shot(assist, 'linux-synthetic-secured');
    });
    const a = agent as unknown as LinuxAgent;
    await test.step('video advances', async () => {
      await expect.poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      const t0 = (await probeRemoteVideo(assist))!.time;
      await expect.poll(async () => (await probeRemoteVideo(assist))?.time ?? 0).toBeGreaterThan(t0 + 0.3);
    });
    await test.step('a click at control is accepted', async () => {
      await confirmSasAndTakeControl(assist);
      const screen = assist.locator('canvas[role="img"]').first();
      const box = (await screen.boundingBox())!;
      await assist.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await a.waitForLine(/ctl\.res ok|op=os\.pointer/i, 15_000);
    });
    await test.step('chat Assist -> Desk', async () => chat(assist, a, 'Hello Linux'));
    await test.step('a file lands in the temporary download folder with the right bytes', async () =>
      sendFile(assist, a, 'e2e-linux-note.txt'));
    await test.step('the read-only sh playbook streams pb.output and exits 0', async () => {
      const panel = assist.getByRole('region', { name: /playbook/i }).first();
      const item = panel.locator('li', { hasText: PLAYBOOK });
      await expect(item).toBeVisible({ timeout: 20_000 });
      await item.getByRole('button', { name: 'Run...' }).click();
      await panel.getByRole('button', { name: `Run ${PLAYBOOK}` }).click();
      await expect(panel.getByText(/exit 0|succeeded|done/i).first()).toBeVisible({ timeout: 60_000 });
      await expect(panel.getByText(/who=e2e/).first()).toBeVisible();
      await expect(panel.getByText(/uname=Linux/).first()).toBeVisible();
      // The run directory is the agent's private runtime dir inside the run's temporary root.
      await expect(panel.getByText(new RegExp(`cwd=${a.root}/runtime/indiansassist/run`)).first()).toBeVisible();
      await shot(assist, 'linux-synthetic-playbook');
    });
    await test.step('the stats widget shows fps and bitrate', async () => {
      const stats = assist.getByRole('region', { name: /agent stats|statistics/i }).first();
      await expect(stats.getByText(/fps/i).first()).toBeVisible({ timeout: 20_000 });
      await expect(stats.getByText(/kbps|mbps|bitrate/i).first()).toBeVisible();
    });
    await test.step('Stop from the agent ends the session; the self-delete decision is logged', async () => stopFromAgent(assist, a));
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
    (agent as LinuxAgent | null)?.kill();
    await ctx.close();
  }
});

test('Linux agent (X11 on a harness Xvfb): two monitors, MIT-SHM capture, XTEST input', async ({ browser }) => {
  const ctx = await browser.newContext();
  const assist = await newSide(ctx, 'assist');
  let agent: LinuxAgent | null = null;
  try {
    const code = await setupOrg(assist, 'x11');
    await test.step('the agent joins from the X11 session and advertises two monitors', async () => {
      ({ agent } = await joinAndSecure(assist, 'x11', code));
      expect((agent as unknown as LinuxAgent).display).toMatch(/^:\d+$/);
      expect((agent as unknown as LinuxAgent).display).not.toBe(':0');
      await (agent as unknown as LinuxAgent).waitForLine(/linux capabilities.*monitors=2.*"multi_monitor"/i, 5_000);
    });
    const a = agent as unknown as LinuxAgent;
    await test.step('the monitor picker lists both RandR monitors', async () => {
      const picker = assist.getByRole('group', { name: /monitor/i }).first();
      await expect(picker).toBeVisible();
      await expect(picker.getByText(/IA-E2E-LEFT/).first()).toBeVisible();
      await expect(picker.getByText(/IA-E2E-RIGHT/).first()).toBeVisible();
    });
    await test.step('video of the Xvfb monitor advances', async () => {
      await expect.poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      await shot(assist, 'linux-x11-video');
    });
    await test.step('a click on the remote screen moves the Xvfb pointer to the matching point', async () => {
      await confirmSasAndTakeControl(assist);
      const screen = assist.locator('canvas[role="img"]').first();
      const box = (await screen.boundingBox())!;
      await assist.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
      await a.waitForLine(/ctl\.res ok|op=os\.pointer/i, 15_000);
      // Monitor 1 is IA-E2E-LEFT at 0,0 1920x1080: (0.25, 0.75) is near (480, 810). The console letterboxes the
      // video inside the canvas, so allow a generous margin; the point must land on the left monitor.
      await expect
        .poll(() => a.pointerOnXvfb(), { timeout: 10_000 })
        .toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
      const p = a.pointerOnXvfb()!;
      expect(p.x, `pointer ${JSON.stringify(p)}`).toBeLessThan(1920);
      expect(Math.abs(p.y - 810), `pointer ${JSON.stringify(p)}`).toBeLessThan(200);
    });
    await test.step('Stop from the agent ends the session', async () => stopFromAgent(assist, a));
  } finally {
    (agent as LinuxAgent | null)?.kill();
    await ctx.close();
  }
});

test('Linux agent (Wayland session): no screen, honest no-screen state; chat and files work', async ({ browser }) => {
  const ctx = await browser.newContext();
  const assist = await newSide(ctx, 'assist');
  let agent: LinuxAgent | null = null;
  try {
    const code = await setupOrg(assist, 'wayland');
    await test.step('the agent joins from a Wayland session with the files / chat / playbooks set', async () => {
      ({ agent } = await joinAndSecure(assist, 'wayland', code));
      await (agent as unknown as LinuxAgent).waitForLine(/linux capabilities.*mode=Wayland/i, 5_000);
    });
    const a = agent as unknown as LinuxAgent;
    await test.step('the console shows the no-screen state in place of the video', async () => {
      await expect(assist.getByRole('heading', { name: 'The Desk cannot share its screen: Wayland session' })).toBeVisible({
        timeout: 20_000,
      });
      await shot(assist, 'linux-wayland-no-screen');
    });
    await test.step('chat still works', async () => chat(assist, a, 'Hello Wayland'));
    await test.step('a file still arrives', async () => sendFile(assist, a, 'e2e-wayland-note.txt'));
    await test.step('Stop from the agent ends the session', async () => stopFromAgent(assist, a));
  } finally {
    (agent as LinuxAgent | null)?.kill();
    await ctx.close();
  }
});

/** The mean colour of a patch of the remote video (drawn to a canvas in the page). */
async function videoColour(page: Page): Promise<[number, number, number] | null> {
  return page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].find(
      (x) => x.srcObject instanceof MediaStream && x.getAttribute('aria-hidden') === 'true',
    );
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0);
    const d = ctx.getImageData(Math.floor(c.width * 0.3), Math.floor(c.height * 0.3), 16, 16).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]!;
      g += d[i + 1]!;
      b += d[i + 2]!;
    }
    const n = d.length / 4;
    return [r / n, g / n, b / n] as [number, number, number];
  });
}

/** agent/scripts/portal-test.sh's solid background (`IA_PORTAL_TEST_COLOUR`, default 3366cc). */
const PORTAL_COLOUR: [number, number, number] = [0x33, 0x66, 0xcc];

test('Linux agent (Wayland with the portal companion): hand-over, view-only video, chat and files', async ({ browser }) => {
  const ctx = await browser.newContext();
  const assist = await newSide(ctx, 'assist');
  let agent: LinuxAgent | null = null;
  try {
    const code = await setupOrg(assist, 'portal');
    await test.step('the X11 binary hands over to .ia-portal, which joins with the portal capabilities', async () => {
      ({ agent } = await joinAndSecure(assist, 'portal', code));
      const a = agent as unknown as LinuxAgent;
      await a.waitForLine(/handing over to the Wayland screen-sharing part: \S+\/\.ia-portal$/, 5_000);
      const m = await a.waitForLine(/handed over from (\S+\/IndiansAssist): running (\S+) \(pid (\d+)\)/, 5_000);
      expect(m[2]).toMatch(/\/\.ia-portal$/);
      expect(a.exeOfPid(Number(m[3])), 'the process image is the portal binary').toMatch(/\/\.ia-portal$/);
      await a.waitForLine(/linux capabilities.*mode=Portal.*"screen".*"recorder"/i, 5_000);
      expect(a.lines.some((l) => /needs PipeWire/.test(l))).toBe(false);
    });
    const a = agent as unknown as LinuxAgent;
    await test.step('the portal session starts without a dialog and the console shows video of the known colour', async () => {
      await a.waitForLine(/portal: first frame/, 45_000);
      await expect.poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect
        .poll(
          async () => {
            const c = await videoColour(assist);
            return c ? Math.max(...c.map((v, i) => Math.abs(v - PORTAL_COLOUR[i]!))) : 999;
          },
          { timeout: 30_000 },
        )
        .toBeLessThan(28);
      await shot(assist, 'linux-portal-video');
    });
    await test.step('Control stays off and the console says why: the portal build advertises no input', async () => {
      // Section 9.4 (close-out): "This Desk cannot take remote control" is visible and is the greyed Control
      // button's accessible description; even with the security code confirmed the console stays in View.
      await confirmSas(assist);
      const control = assist.getByRole('button', { name: 'Control', exact: true });
      await expect(assist.getByTestId('control-unavailable')).toHaveText('This Desk cannot take remote control');
      await expect(assist.getByTestId('control-unavailable')).toBeVisible();
      await expect(control).toBeDisabled();
      await expect(control).toHaveAccessibleDescription('This Desk cannot take remote control');
      await expect(control).toHaveAttribute('aria-pressed', 'false');
      await expect(assist.getByRole('button', { name: 'View', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await shot(assist, 'linux-portal-control-unavailable');
      await expect(assist.getByTestId('no-screen-state')).toHaveCount(0);
      expect(a.lines.some((l) => /op=os\.pointer/.test(l))).toBe(false);
    });
    await test.step('chat still works', async () => chat(assist, a, 'Hello portal'));
    await test.step('a file still arrives', async () => sendFile(assist, a, 'e2e-portal-note.txt'));
    await test.step('Stop from the agent ends the session', async () => stopFromAgent(assist, a));
  } finally {
    (agent as LinuxAgent | null)?.kill();
    await ctx.close();
  }
});

test('Linux agent (Wayland, PipeWire missing): the X11 binary stays with the honest message', async ({ browser }) => {
  const ctx = await browser.newContext();
  const assist = await newSide(ctx, 'assist');
  let agent: LinuxAgent | null = null;
  try {
    const code = await setupOrg(assist, 'nopw');
    await test.step('no hand-over: the PipeWire line, the Wayland set', async () => {
      ({ agent } = await joinAndSecure(assist, 'portal-nopw', code));
      const a = agent as unknown as LinuxAgent;
      await a.waitForLine(/Screen sharing on Wayland needs PipeWire, which was not found\./, 5_000);
      await a.waitForLine(/linux capabilities.*mode=Wayland/i, 5_000);
      expect(a.lines.some((l) => /handing over|handed over from/.test(l))).toBe(false);
    });
    const a = agent as unknown as LinuxAgent;
    await test.step('the console shows the no-screen state', async () => {
      await expect(assist.getByRole('heading', { name: 'The Desk cannot share its screen: Wayland session' })).toBeVisible({
        timeout: 20_000,
      });
      await shot(assist, 'linux-portal-nopw-no-screen');
    });
    await test.step('chat still works', async () => chat(assist, a, 'Hello no PipeWire'));
    await test.step('Stop from the agent ends the session', async () => stopFromAgent(assist, a));
  } finally {
    console.log(`screenshots:\n${shots.join('\n')}`);
    (agent as LinuxAgent | null)?.kill();
    await ctx.close();
  }
});
