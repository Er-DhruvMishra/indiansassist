/**
 * `pnpm e2e:p4:linux` (docs/specs/phase-f-contracts.md section 8.12 "End to end"): a Windows Chromium Assist console
 * against the dev Linux service (`ia-service --console`, as the current user) and its desktop worker in WSL Ubuntu,
 * run by `agent/scripts/service-e2e.sh` with the fake logind on a private bus reporting a session on the harness Xvfb
 * :97. The service enrolls through the real Rust `--enroll` path, with the enroll.iaconfig the console's "Install and
 * enroll" dialog downloads (minted by `GET /api/v1/devices/enroll-config`), never by a JS shortcut.
 *
 *  1. synthetic capture: enrollment; the device page (Linux, "Signed-in X11 session"); the dialog's Linux tab; an
 *     attended session (local consent, granted by the dev `--auto-consent` the harness passes to the worker) with the
 *     security code, a click at control, chat, a file and a read-only `sh` playbook in the session (as the user);
 *     an unattended `auto_grant` session; a read-only `sh` playbook as a device action (run by the service,
 *     `ranAs: 'admin'`); a clean stop (exit 0);
 *  2. X11 on :97: an attended and an unattended session sharing the harness display, a click read back with xdotool
 *     on :97; the locked state shown on the device page (rule 8.4e); the Wayland case (no screen, chat and a file
 *     still work, rule 8.4d); nobody signed in (`409 prelogin_unsupported`, rule 8.4f) while device actions still
 *     run; the audit chain verifying; a clean stop.
 *
 * Isolation (S1-S3): read-only playbooks only, `--no-self-delete` always, the harness Xvfb :97 only (never :0), the
 * private bus only, temporary XDG roots; the harness tears down what it started in a `finally`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { captureConsole, probeRemoteVideo, recordPeerConnections, shot, shots } from './helpers';
import { WSL_DISTRO, wsl, wslPath } from './linux-agent-harness';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5330'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4160'}`;
const DATA = resolve(repoRoot, process.env.E2E_DATA_DIR || './data/e2e-linux-p4');
const SCRIPT = wslPath(resolve(repoRoot, 'agent/scripts/service-e2e.sh'));
const FORWARD = process.env.IA_E2E_API_FORWARD || '';
const XVFB = '97';
const headers = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };
const PLAYBOOK = 'Linux P4 e2e: say where I am';
// Read-only: prints its parameter, who runs it and where, nothing else.
const PLAYBOOK_BODY = 'echo "who=$IA_PARAM_WHO"\necho "uid=$(id -u)"\necho "uname=$(uname -s)"\n';
const PRELOGIN = 'Nobody is signed in to this Linux computer. IndiansAssist can connect only to a signed-in desktop session.';

/** The dev Linux service in WSL (service-e2e.sh run), with line-oriented access to its log and its stdin commands. */
class LinuxService {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  root: string | null = null;
  exit: number | null = null;
  private readonly waiters: { re: RegExp; resolve: (m: RegExpMatchArray) => void }[] = [];

  constructor(opts: { synthetic: boolean; enrollFile: string }) {
    if (!FORWARD) throw new Error('run e2e:p4:linux through run-p4-linux.mjs (it sets IA_E2E_API_FORWARD)');
    const args = [
      'run',
      '--enroll',
      wslPath(opts.enrollFile),
      '--worker-arg',
      '--no-self-delete',
      '--worker-arg',
      '--auto-consent',
      '--worker-arg',
      'control',
      ...(opts.synthetic ? ['--worker-arg', '--synthetic-capture'] : []),
    ];
    this.proc = spawn('wsl.exe', ['-d', WSL_DISTRO, '--', 'bash', SCRIPT, ...args], {
      env: {
        ...process.env,
        IA_E2E_API_FORWARD: FORWARD,
        IA_E2E_XVFB_DISPLAY: XVFB,
        // WSLENV carries just these variables into WSL (nothing else of the Windows environment).
        WSLENV: ['IA_E2E_API_FORWARD/u', 'IA_E2E_XVFB_DISPLAY/u', process.env.WSLENV].filter(Boolean).join(':'),
      },
    }) as ChildProcessWithoutNullStreams;
    const onChunk = (buf: Buffer) => {
      for (const raw of buf.toString('utf8').split(/\r?\n/)) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
        if (!line) continue;
        this.lines.push(line);
        console.log(`[linux-service] ${line}`);
        const root = /^E2E_ROOT=(\/tmp\/ia-service-e2e\.[A-Za-z0-9]+)$/.exec(line);
        if (root) this.root = root[1]!;
        const exit = /^E2E_SERVICE_EXIT=(\d+)$/.exec(line);
        if (exit) this.exit = Number(exit[1]);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const m = line.match(this.waiters[i]!.re);
          if (m) this.waiters.splice(i, 1)[0]!.resolve(m);
        }
      }
    };
    this.proc.stdout.on('data', onChunk);
    this.proc.stderr.on('data', onChunk);
  }

  /** The first line matching `re` from `from` on (an index into `lines`), or the next one to arrive. */
  waitForLine(re: RegExp, timeoutMs = 30_000, from = 0): Promise<RegExpMatchArray> {
    for (const line of this.lines.slice(from)) {
      const m = line.match(re);
      if (m) return Promise.resolve(m);
    }
    return new Promise((resolveP, reject) => {
      const w = {
        re,
        resolve: (m: RegExpMatchArray) => {
          clearTimeout(timer);
          resolveP(m);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`the linux service log did not match ${re} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  mark(): number {
    return this.lines.length;
  }

  /** A command to the fake logind (examples/logind_fake.rs: type, locked, nobody, present, ...). */
  logind(cmd: string): void {
    this.proc.stdin.write(`logind ${cmd}\n`);
  }

  /** systemd's stop: SIGTERM to the service, which must exit 0. */
  async stop(): Promise<number> {
    this.proc.stdin.write('stop\n');
    const m = await this.waitForLine(/^E2E_SERVICE_EXIT=(\d+)$/, 30_000);
    return Number(m[1]);
  }

  /** sha256 of a file the worker wrote; only under this run's temporary root. */
  sha256Of(path: string): string {
    if (!this.root || !path.startsWith(`${this.root}/`)) throw new Error(`refusing to read ${path} outside ${this.root}`);
    return wsl(['sha256sum', path]).stdout.trim().split(/\s+/)[0] ?? '';
  }

  /** The pointer on the harness Xvfb, read by xdotool as an independent observer (never :0). */
  pointer(): { x: number; y: number } | null {
    const r = wsl(['env', '-u', 'WAYLAND_DISPLAY', `DISPLAY=:${XVFB}`, 'xdotool', 'getmouselocation']);
    const m = /x:(\d+)\s+y:(\d+)/.exec(r.stdout);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  }

  /** Stop what this run started: the wsl.exe child (and its tree), then the script's own pids and root in WSL. */
  kill(): void {
    if (this.proc.exitCode === null && this.proc.pid !== undefined) spawnSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F']);
    if (this.root) wsl(['bash', SCRIPT, 'cleanup', this.root]);
  }
}

async function newAssist(ctx: BrowserContext): Promise<Page> {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  await ctx.addInitScript(recordPeerConnections);
  const page = await ctx.newPage();
  captureConsole(page, 'assist');
  return page;
}

type Org = { tokenId: string; playbookId: string; groupName: string };

/** A p4_installed org: the admin seat, an `allow` group without local approval, the read-only sh playbook, a token. */
async function setupOrg(assist: Page, label: string): Promise<Org> {
  await assist.goto('/signup');
  await assist.getByLabel('Organisation name').fill(`E2E Linux P4 ${label}`);
  await assist.getByLabel('Your name').fill('Asha Tech');
  await assist.getByLabel('Work email').fill(`asha+linux-p4-${label}-${Date.now()}@e2e.example.com`);
  await assist.getByLabel('Password').fill('correct horse battery staple');
  await assist.getByRole('button', { name: 'Create organisation' }).click();
  await expect(assist).toHaveURL(/\/app$/);
  const me = await (await assist.request.get(`${API}/api/v1/auth/me`)).json();
  const seat = await assist.request.patch(`${API}/api/v1/users/${me.user.id}/role`, { headers, data: { role: 'org_admin', tier: 'p4_installed' } });
  expect(seat.status(), 'seat raised to p4_installed').toBeLessThan(300);
  const pb = await assist.request.post(`${API}/api/v1/orgs/current/playbooks`, {
    headers,
    data: {
      name: PLAYBOOK,
      description: 'Read-only: prints its parameter, its uid and the kernel name.',
      interpreter: 'sh',
      body: PLAYBOOK_BODY,
      requiresElevation: false,
      timeoutSec: 30,
      parameters: [{ name: 'who', label: 'Who', type: 'string', required: false, pattern: '[A-Za-z0-9 ]{1,40}', default: 'e2e' }],
    },
  });
  expect(pb.status(), `sh playbook created: ${await pb.text()}`).toBe(201);
  const group = await assist.request.post(`${API}/api/v1/orgs/current/device-groups`, {
    headers,
    data: { name: `Linux ${label}`, defaultPolicy: { mode: 'allow', recordingRequired: false, requireLocalApprovalWhenPresent: false } },
  });
  expect(group.status(), await group.text()).toBe(201);
  const token = await assist.request.post(`${API}/api/v1/tokens`, {
    headers,
    data: { tier: 'p4_installed', typ: 'enrollment', maxDevices: 2, label: `Linux rollout ${label}` },
  });
  expect(token.status(), await token.text()).toBe(201);
  return { tokenId: (await token.json()).token.id as string, playbookId: (await pb.json()).id as string, groupName: `Linux ${label}` };
}

/**
 * The console's "Install and enroll" dialog: choose the group, take the signed config, look at the Linux tab, and
 * download enroll.iaconfig there, which is the file the service enrolls with.
 */
async function downloadEnrollConfig(assist: Page, label: string, groupName: string): Promise<string> {
  await assist.goto('/app/tokens');
  const row = assist.getByRole('row', { name: new RegExp(`Linux rollout ${label}`) });
  await row.getByRole('button', { name: 'Install and enroll' }).click();
  const dialog = assist.getByRole('dialog', { name: 'Install and enroll devices with this token' });
  await expect(dialog).toBeVisible();
  const select = dialog.getByLabel('Device group');
  await expect(select.getByRole('option', { name: groupName })).toHaveCount(1);
  await select.selectOption({ label: groupName });
  await dialog.getByRole('button', { name: 'Get the signed enrollment config' }).click();
  await dialog.getByRole('tab', { name: 'Linux' }).click();
  const panel = dialog.getByRole('tabpanel');
  await expect(panel.getByTestId('linux-commands')).toContainText('sudo install -D -m 0600 enroll.iaconfig /etc/indiansassist/enroll.iaconfig');
  await expect(panel.getByTestId('ansible-snippet')).toContainText('indiansassist_agent_enroll_config');
  const served = await panel.getByTestId('linux-downloads').count();
  if (served > 0) {
    await expect(panel.getByRole('link', { name: /Download the \.deb package/ })).toBeVisible();
    await expect(panel.getByRole('link', { name: /Download the \.rpm package/ })).toBeVisible();
  } else {
    await expect(panel.getByTestId('linux-release-share')).toBeVisible();
  }
  await shot(assist, `linux-p4-enroll-tab-${label}`);
  mkdirSync(DATA, { recursive: true });
  const file = resolve(DATA, `enroll-${label}.iaconfig`);
  const [download] = await Promise.all([assist.waitForEvent('download'), panel.getByRole('button', { name: 'Download enroll.iaconfig' }).click()]);
  await download.saveAs(file);
  await dialog.getByRole('button', { name: 'Done' }).click();
  return file;
}

type DeviceRow = { id: string; platform: string; online: boolean; osVersion: string | null; interactive: { state: string; display?: string | null } | null };

async function device(assist: Page): Promise<DeviceRow | null> {
  const list = await (await assist.request.get(`${API}/api/v1/devices`)).json();
  return ((list.items ?? []) as DeviceRow[]).find((d) => d.platform === 'linux') ?? null;
}

/** Waits until the enrolled Linux device is online and reports `state` (and `display`, when given). */
async function deviceIn(assist: Page, state: string, display?: string | null): Promise<DeviceRow> {
  let last: DeviceRow | null = null;
  await expect
    .poll(
      async () => {
        last = await device(assist);
        return Boolean(last && last.online && last.interactive?.state === state && (display === undefined || (last.interactive?.display ?? null) === display));
      },
      { timeout: 60_000, message: `device online in ${state}/${display}` },
    )
    .toBe(true);
  return last!;
}

/** Opens a session from the device page's Connect panel; returns the session id. */
async function connect(assist: Page, deviceId: string, unattended: boolean, reason = 'e2e: check the printer queue'): Promise<string> {
  await assist.goto(`/app/fleet/${deviceId}`);
  const panel = assist.getByRole('region', { name: 'Connect' });
  await panel.getByRole('radio', { name: unattended ? /^Unattended/ : /^Attended/ }).check();
  if (unattended) await panel.getByLabel('Reason (required)').fill(reason);
  await panel.getByRole('button', { name: 'Start a session' }).click();
  await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  return /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
}

async function secured(assist: Page, svc: LinuxService, from: number): Promise<void> {
  await expect(assist.getByTestId('sas-header')).toBeVisible({ timeout: 60_000 });
  await expect(assist.getByText('Live', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  const m = await svc.waitForLine(/(?:security code|SAS)\s+(\d{3})\s?(\d{3})/i, 30_000, from);
  const header = await assist.getByTestId('sas-header').innerText();
  const consoleSas = (header.match(/(\d{3})\s?(\d{3})/) ?? []).slice(1).join('');
  expect(consoleSas, 'the console and the worker derive the same security code').toBe(`${m[1]}${m[2]}`);
}

async function takeControl(assist: Page): Promise<void> {
  const confirmBtn = assist.getByRole('button', { name: 'Confirm security code' });
  const control0 = assist.getByRole('button', { name: 'Control', exact: true });
  // Either the security code still needs confirming, or control is already ready: wait for one of the two.
  try {
    await expect
      .poll(async () => (await confirmBtn.isVisible().catch(() => false)) || (await control0.isEnabled().catch(() => false)), { timeout: 30_000 })
      .toBe(true);
  } catch (e) {
    await shot(assist, 'linux-p4-take-control-failed');
    console.log(`input mode: ${await assist.getByRole('group', { name: 'Input mode' }).innerText().catch(() => '?')}`);
    console.log(`main: ${(await assist.locator('main').innerText().catch(() => '?')).slice(0, 1500)}`);
    throw e;
  }
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click();
    const confirm = assist.getByRole('dialog', { name: /confirm the security code/i });
    await expect(confirm).toBeVisible();
    const header = await assist.getByTestId('sas-header').innerText();
    const digits = (header.match(/(\d{3})\s?(\d{3})/) ?? []).slice(1).join('');
    await confirm.getByLabel(/security code the user reads out/i).fill(digits);
    await confirm.getByRole('button', { name: 'Confirm code' }).click();
  }
  const control = assist.getByRole('button', { name: 'Control', exact: true });
  await expect(control).toBeEnabled({ timeout: 20_000 });
  if ((await control.getAttribute('aria-pressed')) !== 'true') await control.click();
}

async function videoAdvances(assist: Page): Promise<void> {
  await expect.poll(async () => (await probeRemoteVideo(assist))?.width ?? 0, { timeout: 45_000 }).toBeGreaterThan(0);
  const t0 = (await probeRemoteVideo(assist))!.time;
  await expect.poll(async () => (await probeRemoteVideo(assist))?.time ?? 0, { timeout: 20_000 }).toBeGreaterThan(t0 + 0.3);
}

async function chat(assist: Page, svc: LinuxService, text: string): Promise<void> {
  const from = svc.mark();
  await assist.locator('#chat-input').fill(text);
  await assist.getByRole('button', { name: 'Send', exact: true }).click();
  await svc.waitForLine(new RegExp(`chat.*${text}|chat message`, 'i'), 20_000, from);
  await expect(assist.getByRole('log', { name: 'Chat messages' })).toContainText(text);
}

async function sendFile(assist: Page, svc: LinuxService, name: string): Promise<void> {
  const from = svc.mark();
  const bytes = randomBytes(1024).toString('hex');
  const sha = createHash('sha256').update(bytes).digest('hex');
  await assist.locator('#file-send').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(bytes) });
  const saved = await svc.waitForLine(/file saved (\S+)/i, 30_000, from);
  const path = saved[1]!.trim();
  // The worker runs as the user with HOME in the run's temporary root (`--home`), never the real home.
  expect(path.startsWith(`${svc.root}/home/`), `saved under the run's temporary home: ${path}`).toBe(true);
  expect(svc.sha256Of(path)).toBe(sha);
}

async function sessionPlaybook(assist: Page): Promise<void> {
  const panel = assist.getByRole('region', { name: /playbook/i }).first();
  const item = panel.locator('li', { hasText: PLAYBOOK });
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.getByRole('button', { name: 'Run...' }).click();
  await panel.getByRole('button', { name: `Run ${PLAYBOOK}` }).click();
  await expect(panel.getByText(/exit 0|succeeded|done/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(/who=e2e/).first()).toBeVisible();
  await expect(panel.getByText(/uname=Linux/).first()).toBeVisible();
}

async function endSession(assist: Page, sessionId: string): Promise<void> {
  const r = await assist.request.post(`${API}/api/v1/sessions/${sessionId}/end`, { headers, data: {} });
  expect(r.status(), await r.text()).toBe(200);
  await expect(assist.getByText(/^Session ended/).first()).toBeVisible({ timeout: 30_000 });
}

/** A read-only sh playbook as a device action: run by the service (rule 9.7: the output stays on the device). */
async function deviceAction(assist: Page, deviceId: string, playbookId: string): Promise<void> {
  const path = `${API}/api/v1/devices/${deviceId}/actions`;
  const q = await assist.request.post(path, { headers, data: { kind: 'playbook_run', payload: { playbookId, args: {}, requiresElevation: false } } });
  expect(q.status(), await q.text()).toBe(202);
  const actionId = (await q.json()).actionId as string;
  let row: { state: string; result: { exit?: number; ranAs?: string } | null } | undefined;
  await expect
    .poll(
      async () => {
        row = ((await (await assist.request.get(path)).json()).items as { id: string; state: string; result: never }[]).find((a) => a.id === actionId);
        return row?.state ?? 'none';
      },
      { timeout: 60_000 },
    )
    .toMatch(/^(done|failed)$/);
  expect(row!.state, JSON.stringify(row)).toBe('done');
  expect(row!.result?.exit).toBe(0);
  expect(row!.result?.ranAs).toBe('admin');
}

test.describe.configure({ mode: 'serial' });

test('Linux P4 (synthetic): enrollment through --enroll, attended and unattended sessions, playbooks, a clean stop', async ({ browser }) => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const assist = await newAssist(ctx);
  let svc: LinuxService | null = null;
  try {
    const org = await setupOrg(assist, 'synthetic');
    const enrollFile = await test.step('the dialog Linux tab and the enroll.iaconfig download', () => downloadEnrollConfig(assist, 'synthetic', org.groupName));
    const s = new LinuxService({ synthetic: true, enrollFile });
    svc = s;
    let deviceId = '';
    await test.step('the dev service enrolls through the Rust --enroll path and reports the X11 session', async () => {
      await s.waitForLine(/^E2E_READY$/, 90_000);
      await s.waitForLine(/enrolled; the enrollment material has been shredded/, 5_000);
      const d = await deviceIn(assist, 'active', 'x11');
      deviceId = d.id;
      expect(d.osVersion ?? '').not.toBe('');
      await assist.goto(`/app/fleet/${deviceId}`);
      await expect(assist.getByText(/^Linux x64 /).first()).toBeVisible();
      await expect(assist.getByText('Signed-in X11 session')).toBeVisible();
      await shot(assist, 'linux-p4-device-x11');
    });
    await test.step('an attended session: consent, the security code, control, chat, a file, a session playbook', async () => {
      const from = s.mark();
      const sessionId = await connect(assist, deviceId, false);
      await secured(assist, s, from);
      await s.waitForLine(/linux worker capabilities.*"playbooks"/i, 10_000, from);
      await videoAdvances(assist);
      await takeControl(assist);
      const screen = assist.locator('canvas[role="img"]').first();
      const box = (await screen.boundingBox())!;
      const before = s.mark();
      await assist.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await s.waitForLine(/ctl\.res ok|op=os\.pointer/i, 15_000, before);
      await chat(assist, s, 'Hello Linux service');
      await sendFile(assist, s, 'e2e-linux-p4-note.txt');
      await sessionPlaybook(assist);
      await shot(assist, 'linux-p4-attended');
      await endSession(assist, sessionId);
    });
    await test.step('an unattended auto_grant session', async () => {
      const from = s.mark();
      const sessionId = await connect(assist, deviceId, true);
      await s.waitForLine(/AutoGrant|auto_grant/i, 30_000, from);
      await secured(assist, s, from);
      await videoAdvances(assist);
      await shot(assist, 'linux-p4-unattended');
      await endSession(assist, sessionId);
    });
    await test.step('a read-only sh playbook as a device action, run by the service', async () => deviceAction(assist, deviceId, org.playbookId));
    await test.step("systemd's stop: SIGTERM ends the service with status 0", async () => {
      expect(await s.stop()).toBe(0);
    });
  } finally {
    svc?.kill();
    await ctx.close();
  }
});

test('Linux P4 (X11 on :97): clicks read back, locked, Wayland, nobody, the audit chain', async ({ browser }) => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const assist = await newAssist(ctx);
  let svc: LinuxService | null = null;
  try {
    const org = await setupOrg(assist, 'x11');
    const enrollFile = await downloadEnrollConfig(assist, 'x11', org.groupName);
    const s = new LinuxService({ synthetic: false, enrollFile });
    svc = s;
    await s.waitForLine(/^E2E_READY$/, 90_000);
    const deviceId = (await deviceIn(assist, 'active', 'x11')).id;

    await test.step('an attended X11 session shares the harness display', async () => {
      const from = s.mark();
      const sessionId = await connect(assist, deviceId, false);
      await secured(assist, s, from);
      await videoAdvances(assist);
      await endSession(assist, sessionId);
    });
    await test.step('an unattended X11 session: a click moves the Xvfb :97 pointer to the matching point', async () => {
      const from = s.mark();
      const sessionId = await connect(assist, deviceId, true);
      await secured(assist, s, from);
      await videoAdvances(assist);
      await takeControl(assist);
      const screen = assist.locator('canvas[role="img"]').first();
      const box = (await screen.boundingBox())!;
      await assist.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
      // :97 is one 1920x1080 screen: (0.25, 0.75) is near (480, 810); the console letterboxes, so allow a margin.
      await expect.poll(() => s.pointer()?.y ?? -1, { timeout: 15_000 }).toBeGreaterThan(600);
      const p = s.pointer()!;
      expect(Math.abs(p.x - 480), `pointer ${JSON.stringify(p)}`).toBeLessThan(250);
      expect(Math.abs(p.y - 810), `pointer ${JSON.stringify(p)}`).toBeLessThan(200);
      await shot(assist, 'linux-p4-x11-click');
      await endSession(assist, sessionId);
    });
    await test.step('a locked session: the device page says the screen is locked (rule 8.4e)', async () => {
      s.logind('locked true');
      await deviceIn(assist, 'locked', 'x11');
      await assist.goto(`/app/fleet/${deviceId}`);
      await expect(assist.getByTestId('screen-locked')).toHaveText("The Desk's screen is locked");
      s.logind('locked false');
      await deviceIn(assist, 'active', 'x11');
    });
    await test.step('a Wayland session: no screen, chat and a file still work (rule 8.4d)', async () => {
      s.logind('type wayland');
      await deviceIn(assist, 'active', 'wayland');
      await assist.goto(`/app/fleet/${deviceId}`);
      await expect(assist.getByText('Wayland session: chat and files only')).toBeVisible();
      const from = s.mark();
      const sessionId = await connect(assist, deviceId, true);
      await expect(assist.getByRole('heading', { name: 'The Desk cannot share its screen: Wayland session' })).toBeVisible({ timeout: 60_000 });
      await s.waitForLine(/linux worker capabilities.*wayland: true|linux worker capabilities.*wayland=true/i, 20_000, from);
      await chat(assist, s, 'Hello Wayland');
      await sendFile(assist, s, 'e2e-linux-p4-wayland.txt');
      await shot(assist, 'linux-p4-wayland');
      await endSession(assist, sessionId);
    });
    await test.step('nobody signed in: 409 prelogin_unsupported, device actions still run (rule 8.4f)', async () => {
      s.logind('nobody');
      await deviceIn(assist, 'none');
      const r = await assist.request.post(`${API}/api/v1/devices/${deviceId}/sessions`, { headers, data: { unattended: true, reason: 'e2e: nobody' } });
      expect(r.status()).toBe(409);
      expect((await r.json()).error).toMatchObject({ code: 'prelogin_unsupported', message: PRELOGIN });
      await assist.goto(`/app/fleet/${deviceId}`);
      await expect(assist.getByText('Nobody signed in: device actions only')).toBeVisible();
      const panel = assist.getByRole('region', { name: 'Connect' });
      await panel.getByLabel('Reason (required)').fill('e2e: nobody');
      await panel.getByRole('button', { name: 'Start a session' }).click();
      await expect(panel.getByText(PRELOGIN)).toBeVisible();
      await shot(assist, 'linux-p4-nobody');
      await deviceAction(assist, deviceId, org.playbookId);
    });
    await test.step('the audit chain verifies', async () => {
      await assist.goto('/app/audit');
      const table = assist.getByRole('table', { name: 'Audit entries' });
      for (const action of ['device.enrolled', 'session.unattended_started', 'session.ended']) {
        await expect(table.getByRole('cell', { name: action, exact: true }).first()).toBeVisible();
      }
      await assist.getByRole('button', { name: 'Verify chain' }).click();
      const badge = assist.getByText(/^Verified /);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute('data-tone', 'green');
    });
    await test.step("systemd's stop: SIGTERM ends the service with status 0", async () => {
      expect(await s.stop()).toBe(0);
    });
  } finally {
    console.log(`screenshots:\n${shots.join('\n')}`);
    svc?.kill();
    await ctx.close();
  }
});
