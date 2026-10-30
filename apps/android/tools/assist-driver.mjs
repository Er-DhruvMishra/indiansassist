// The Assist half of the live Android e2e (`pnpm android:e2e`, tools/android-e2e.mjs): REST and a plain `/signal`
// ws (scripts/smoke helpers, imported, not copied) for setup and assertions, and the real technician console in
// Playwright Chromium (apps/web's Playwright install) for everything that needs WebRTC: the Android host offers a
// real peer connection with the `ia.sec` handshake on a data channel, which Node cannot answer.
//
// Exports `AssistDriver`; it has no side effects on import.

import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { ApiClient } from '../../../scripts/smoke/http.mjs';
import { SignalClient } from '../../../scripts/smoke/ws-client.mjs';
import { loadShared } from '../../../scripts/smoke/shared.mjs';
import { verifySessionAudit } from '../../../scripts/smoke/audit.mjs';

const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));

/** Technician and org names used for the run; the consent screen must show both. */
export const TECH_NAME = 'Asha Tech';

export class AssistDriver {
  /**
   * @param {{ apiUrl: string, webOrigin: string, headless?: boolean, log?: (s: string) => void, artifacts?: string }} o
   */
  constructor(o) {
    this.apiUrl = o.apiUrl.replace(/\/+$/, '');
    this.webOrigin = o.webOrigin.replace(/\/+$/, '');
    this.headless = o.headless !== false;
    this.log = o.log ?? ((s) => console.log(s));
    this.artifacts = o.artifacts ?? null;
    this.api = new ApiClient(this.apiUrl, { origin: this.webOrigin });
    this.sockets = [];
    this.browser = null;
    this.page = null;
    this.state = {};
  }

  // ---------- REST + ws ----------

  /** Well-known, signup on the p3_portable plan (the api runs with SIGNUP_PLAN_TIER=p3_portable), seat raised to p3. */
  async signup() {
    this.shared = await loadShared();
    const wk = await this.api.expect('GET', '/.well-known/indiansassist.json');
    this.signalUrl = wk.signal;
    const h = await this.api.expect('GET', '/api/v1/health');
    const region = h.servedRegions?.length > 0 ? h.servedRegions[0] : h.region;
    const s = randomBytes(3).toString('hex');
    const orgName = `Android E2E ${s}`;
    const body = { orgName, region, name: TECH_NAME, email: `android-e2e-${s}@example.com`, password: `E2e-${randomBytes(12).toString('base64url')}` };
    const r = await this.api.expect('POST', '/api/v1/auth/signup', body, [201]);
    if (!['p3_portable', 'p4_installed'].includes(r.org.planTier)) throw new Error(`org.planTier ${r.org.planTier}: start the api with SIGNUP_PLAN_TIER=p3_portable`);
    await this.api.expect('PATCH', `/api/v1/users/${r.user.id}/role`, { role: 'org_admin', tier: 'p3_portable' });
    Object.assign(this.state, { user: r.user, org: r.org, region, orgDisplay: r.org.displayName ?? r.org.name ?? orgName });
    return this.state;
  }

  /** A one_time p3_portable token (compact form, joined through the deep link `indiansassist://join?t=`). */
  async mintToken() {
    const r = await this.api.expect('POST', '/api/v1/tokens', { tier: 'p3_portable', typ: 'one_time', label: 'android-e2e' }, [201]);
    this.state.token = r.token;
    this.state.compact = r.compact;
    return r;
  }

  /** A second, observing Assist socket (plain ws): sees `assist.knock` / `knock.closed` for the org. */
  async openObserver(timeoutMs = 10_000) {
    const ws = new SignalClient('observer', this.signalUrl, { Origin: this.webOrigin, Cookie: this.api.cookie });
    this.sockets.push(ws);
    await ws.open(timeoutMs);
    ws.send({ t: 'assist.hello' });
    await ws.reply('assist.hello.ok', timeoutMs);
    this.observer = ws;
    return ws;
  }

  async session(id) {
    return this.api.expect('GET', `/api/v1/sessions/${id}`);
  }

  /** `GET /sessions/:id/audit` verified client-side with the shared hashing (scripts/smoke/audit.mjs). */
  async verifyAudit(sessionId, requiredActions, expectedTail) {
    const a = await this.api.expect('GET', `/api/v1/sessions/${sessionId}/audit`);
    const v = verifySessionAudit(this.shared, a.items, { orgId: this.state.org.id, sessionId, region: this.state.region, requiredActions, expectedTail });
    return { items: a.items, integrity: a.integrity, verify: v };
  }

  // ---------- the console in Playwright ----------

  async openConsole() {
    const { chromium } = webRequire('@playwright/test');
    this.browser = await chromium.launch({
      channel: 'chromium',
      headless: this.headless,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // The emulator cannot resolve mDNS host candidates; real IPs let its slirp NAT reach this Chromium.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    });
    const context = await this.browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const [name, ...rest] = this.api.cookie.split('=');
    await context.addCookies([{ name, value: rest.join('='), domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => this.log(`[console pageerror] ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') this.log(`[console error] ${m.text()}`);
    });
    this.page = page;
    await page.goto(`${this.webOrigin}/app/sessions`);
    await page.getByRole('banner').getByText('Signaling: Online').waitFor({ timeout: 30_000 });
  }

  /** Accepts the knock from the Android Desk in the console's knock toast; resolves with the session id. */
  async acceptKnock(timeoutMs = 120_000) {
    const card = this.page.getByRole('article', { name: /Support request from/ }).first();
    await card.waitFor({ timeout: timeoutMs });
    const text = await card.innerText();
    await card.getByRole('button', { name: 'Accept', exact: true }).click();
    await this.page.waitForURL(/\/app\/sessions\/[0-9a-f-]{36}/, { timeout: 15_000 });
    const id = /\/app\/sessions\/([0-9a-f-]{36})/.exec(this.page.url())[1];
    this.state.sessionId = id;
    return { sessionId: id, cardText: text };
  }

  /** Waits until the remote <video> has decoded frames; returns its size. */
  async waitVideo(timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < end) {
      last = await this.page.evaluate(() => {
        const v = [...document.querySelectorAll('video')].find((x) => x.srcObject instanceof MediaStream && x.videoWidth > 0);
        return v ? { width: v.videoWidth, height: v.videoHeight, time: v.currentTime } : null;
      });
      if (last && last.width > 0) return last;
      await sleep(500);
    }
    throw new Error('the console never decoded a video frame from the Android Desk');
  }

  /** The security code in the console header (`Security code 123 456`), as six digits. */
  async consoleSas(timeoutMs = 60_000) {
    const el = this.page.getByTestId('sas-header');
    await el.waitFor({ timeout: timeoutMs });
    const t = await el.innerText();
    const m = /(\d{3})\s?(\d{3})/.exec(t);
    if (!m) throw new Error(`console security code text '${t}'`);
    return m[1] + m[2];
  }

  /** Types the code read from the phone into the console's SasConfirmDialog (constant-time compare in the console). */
  async confirmSas(code) {
    const p = this.page;
    await p.getByRole('group', { name: 'Input mode' }).getByRole('button', { name: 'Confirm security code' }).click();
    const dialog = p.getByRole('dialog', { name: 'Confirm the security code' });
    await dialog.getByLabel('Security code the user reads out').fill(code);
    await dialog.getByRole('button', { name: 'Confirm code' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
    await p.getByText('Code not confirmed').waitFor({ state: 'hidden', timeout: 10_000 });
  }

  async enableControl() {
    const btn = this.page.getByRole('group', { name: 'Input mode' }).getByRole('button', { name: 'Control', exact: true });
    await btn.click();
    await this.page.waitForFunction(() => {
      const b = [...document.querySelectorAll('[role=group][aria-label="Input mode"] button')].find((x) => x.textContent?.trim() === 'Control');
      return b?.getAttribute('aria-pressed') === 'true';
    }, null, { timeout: 10_000 });
  }

  /** A real mouse click on the console's input overlay at (nx, ny): `os.pointer` down + up on `ia.control`. */
  async tap(nx, ny) {
    const overlay = this.page.locator('[role=application]').first();
    await overlay.waitFor({ timeout: 10_000 });
    const box = await overlay.boundingBox();
    if (!box) throw new Error('input overlay has no box');
    await this.page.mouse.click(box.x + box.width * nx, box.y + box.height * ny);
  }

  async sendChat(text) {
    const chat = this.page.getByRole('region', { name: 'Chat' });
    await chat.getByPlaceholder('Type a message').fill(text);
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
  }

  async waitChat(text, timeoutMs = 60_000) {
    await this.page.getByRole('log', { name: 'Chat messages' }).getByText(text, { exact: true }).waitFor({ timeout: timeoutMs });
  }

  /** Sends `bytes` as `name` through the console's file panel; resolves when the console shows the transfer done. */
  async sendFile(name, bytes) {
    await this.page.setInputFiles('#file-send', { name, mimeType: 'text/plain', buffer: bytes });
    return createHash('sha256').update(bytes).digest('hex');
  }

  async waitFileDone(name, timeoutMs = 120_000) {
    const row = this.page.getByRole('region', { name: 'Files' }).getByRole('listitem').filter({ hasText: name });
    await row.getByText('done', { exact: true }).waitFor({ timeout: timeoutMs });
    return row.innerText();
  }

  async waitEnded(timeoutMs = 30_000) {
    await this.page.getByText(/^Session ended/).first().waitFor({ timeout: timeoutMs });
    return this.page.getByText(/^Session ended/).first().innerText();
  }

  async screenshot(file) {
    if (this.page) await this.page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  }

  async close() {
    for (const s of this.sockets) s.close();
    if (this.browser) await this.browser.close().catch(() => undefined);
    this.browser = null;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
