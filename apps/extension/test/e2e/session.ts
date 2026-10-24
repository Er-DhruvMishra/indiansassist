/**
 * Shared setup of the extension e2e specs (docs/specs/phase-b-contracts.md section 13.2 E1): launches the Assist
 * (ordinary Chromium) and the Desk (persistent Chromium with the unpacked e2e build), signs the Assist up with a P2
 * seat, creates a p2_extension token, opens the fixture form on the Desk, joins through the real `/join` page with
 * **Open in extension** over externally_connectable (carrier A, asserted: no bridge postMessage, clipboard not
 * written), lets the Assist accept the knock and consents in the extension window. Every phase is a test step.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { e2eExtensionIdentity } from './extension-key';
import { E2E_DIST } from './global-setup';
import { BAR, FIXTURES, HEADLESS, MEDIA_ARGS, WEB, captureConsole, pageMatching, recordDataChannels, shot } from './helpers';

export const DESK_NAME = 'E2E Desk';
export const TECH_NAME = 'Asha Tech';
export const TYPED = 'typed by the desk';
const SENTINEL = 'ia-e2e-clipboard-sentinel';

export type ConsentChoice = { level: 'view' | 'tab_control' | 'in_page'; backstage?: boolean };

export type P2Session = {
  assist: Page;
  desk: BrowserContext;
  worker: Worker;
  extId: string;
  fixture: Page;
  /** The extension side panel, opened as a tab (sidepanel.html) so the test can drive it. */
  panel: Page;
  sessionId: string;
  fixtureTabId: number;
  /** Date.now() just before the Desk clicked Share: t = 0 of the bandwidth window (contract 13.4). */
  sharedAt: number;
  /** What the fixture tab's bar says while shared: "Shared with <technician> (<org>)". */
  sharedText: string;
  close: () => Promise<void>;
};

async function signUpWithP2Seat(assist: Page, org: string): Promise<void> {
  await assist.goto('/signup');
  await assist.getByLabel('Organisation name').fill(org);
  await assist.getByLabel('Your name').fill(TECH_NAME);
  await assist.getByLabel('Work email').fill(`asha+${Date.now()}@e2e.example.com`);
  await assist.getByLabel('Password').fill('correct horse battery staple');
  await assist.getByRole('button', { name: 'Create organisation' }).click();
  await expect(assist).toHaveURL(/\/app$/);
  await expect(assist.getByRole('banner').getByText('Signaling: Online')).toBeVisible();
  await assist.goto('/app/users');
  const row = assist.getByRole('row').filter({ hasText: TECH_NAME });
  await row.getByLabel(`Seat tier of ${TECH_NAME}`).selectOption('p2_extension');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(row.getByLabel(`Seat tier of ${TECH_NAME}`)).toHaveValue('p2_extension');
}

async function createToken(assist: Page, label: string): Promise<string> {
  await assist.goto('/app');
  const card = assist.locator('section').filter({ has: assist.getByRole('heading', { name: 'Quick create token' }) });
  await card.getByLabel('Package tier').selectOption('p2_extension');
  await card.getByLabel('Label (optional)').fill(label);
  await card.getByRole('button', { name: 'Create token' }).click();
  const link = assist.locator('#join-link');
  await expect(link).toHaveValue(/\/join#t=/);
  return link.inputValue();
}

/**
 * The Desk opens the join link and clicks Open in extension. Spies installed just before the click prove the code
 * went over `chrome.runtime.sendMessage(<id>, ia.join)` (carrier A) and not over the bridge `postMessage`.
 */
async function joinThroughJoinPage(desk: BrowserContext, joinUrl: string, extId: string): Promise<void> {
  await desk.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  const page = await desk.newPage();
  await page.goto(joinUrl);
  await expect(page).toHaveURL(`${WEB}/join`); // the bearer leaves the URL bar at once
  await expect(page.getByTestId('join-p2')).toBeVisible();
  const open = page.getByRole('button', { name: 'Open in extension' });
  await expect(open).toBeVisible();
  await page.evaluate((sentinel) => navigator.clipboard.writeText(sentinel), SENTINEL);
  await page.evaluate(() => {
    const w = window as unknown as {
      chrome?: { runtime?: { sendMessage?: (...a: unknown[]) => unknown } };
      __iaJoin: { external: string[]; bridge: number };
    };
    w.__iaJoin = { external: [], bridge: 0 };
    const rt = w.chrome?.runtime;
    const orig = rt?.sendMessage;
    if (rt && orig) {
      rt.sendMessage = (...a: unknown[]) => {
        if ((a[1] as { t?: string } | undefined)?.t === 'ia.join') w.__iaJoin.external.push(String(a[0]));
        return orig.apply(rt, a);
      };
    }
    const post = window.postMessage.bind(window);
    window.postMessage = ((msg: unknown, ...rest: unknown[]) => {
      if ((msg as { t?: string } | null)?.t === 'ia.join') w.__iaJoin.bridge += 1;
      return (post as (...x: unknown[]) => void)(msg, ...rest);
    }) as typeof window.postMessage;
  });
  await shot(page, 'desk-join-page');
  await open.click();
  await expect(page.getByText(/Continue in the extension: your technician is being asked to accept/)).toBeVisible();
  const carriers = await page.evaluate(() => (window as unknown as { __iaJoin: unknown }).__iaJoin);
  expect(carriers, 'join went over externally_connectable to the e2e id').toEqual({ external: [extId], bridge: 0 });
  expect(await page.evaluate(() => navigator.clipboard.readText()), 'clipboard not written').toBe(SENTINEL);
  await shot(page, 'desk-join-page-sent');
}

export async function startP2Session(o: { org: string; label: string; consent: ConsentChoice }): Promise<P2Session> {
  const profile = mkdtempSync(join(tmpdir(), 'ia-e2e-desk-'));
  let assistBrowser: Browser | null = null;
  let desk: BrowserContext | null = null;
  const close = async () => {
    await desk?.close().catch(() => undefined);
    await assistBrowser?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    assistBrowser = await chromium.launch({ channel: 'chromium', headless: HEADLESS, args: MEDIA_ARGS });
    const assistCtx = await assistBrowser.newContext({ baseURL: WEB, viewport: { width: 1600, height: 1100 } });
    await assistCtx.grantPermissions(['clipboard-read', 'clipboard-write', 'microphone'], { origin: WEB });
    await assistCtx.addInitScript(recordDataChannels);
    const assist = await assistCtx.newPage();
    captureConsole(assist, 'assist');

    desk = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: HEADLESS,
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${E2E_DIST}`, `--load-extension=${E2E_DIST}`, ...MEDIA_ARGS],
    });
    const deskCtx = desk;
    const worker = deskCtx.serviceWorkers()[0] ?? (await deskCtx.waitForEvent('serviceworker'));
    const extId = new URL(worker.url()).host;
    expect(extId, 'unpacked id derived from the e2e manifest key').toBe(e2eExtensionIdentity().extensionId);
    deskCtx.on('page', (p) => captureConsole(p, 'desk'));
    await deskCtx.grantPermissions(['microphone'], { origin: `chrome-extension://${extId}` }).catch(() => undefined);

    let joinUrl = '';
    await test.step('Assist signs up, takes a P2 seat and creates a p2_extension token', async () => {
      await signUpWithP2Seat(assist, o.org);
      joinUrl = await createToken(assist, o.label);
    });

    const fixture = deskCtx.pages()[0] ?? (await deskCtx.newPage());
    await test.step('Desk opens the fixture form and types into it', async () => {
      await fixture.goto(`${FIXTURES}/form.html`);
      await fixture.locator('#name').fill(TYPED);
      await expect(fixture).toHaveTitle('IA Fixture Form');
      // The remembered "Your name" of an earlier session (ia.lastDeskLabel) labels the knock.
      await worker.evaluate((name) => chrome.storage.local.set({ 'ia.lastDeskLabel': name }), DESK_NAME);
    });

    await test.step('Desk joins from the join page with Open in extension (carrier A, no clipboard write)', async () => {
      await joinThroughJoinPage(deskCtx, joinUrl, extId);
    });

    const panel = await deskCtx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    let sessionId = '';
    await test.step('Assist sees the knock and accepts', async () => {
      await expect(panel.getByText(/Waiting for Asha Tech|Your technician is being asked to accept/)).toBeVisible();
      const knock = assist.getByRole('article', { name: `Support request from ${DESK_NAME}` }).first();
      await expect(knock).toBeVisible();
      await expect(knock).toContainText(o.label);
      await knock.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
      sessionId = /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
      await expect(assist.getByText(/Waiting for consent/).first()).toBeVisible();
    });

    let fixtureTabId = 0;
    let sharedAt = 0;
    const sharedText = `Shared with ${TECH_NAME} (${o.org})`;
    await test.step(`Desk consents in the extension: this tab only, ${o.consent.level}`, async () => {
      const consent = await pageMatching(deskCtx, (u) => u.startsWith(`chrome-extension://${extId}/consent.html`));
      await expect(consent.getByRole('heading', { name: `${TECH_NAME} wants to see your browser` })).toBeVisible();
      const picker = consent.locator('#tab');
      const value = await picker.evaluate(
        (sel: HTMLSelectElement) => [...sel.options].find((x) => x.text.includes('IA Fixture Form'))?.value ?? '',
      );
      expect(value).not.toBe('');
      fixtureTabId = Number(value);
      await picker.selectOption(value);
      await consent.locator(`#level-${o.consent.level}`).check();
      if (o.consent.backstage) await consent.locator('#bg').check();
      await shot(consent, 'desk-consent');
      sharedAt = Date.now();
      await consent.getByRole('button', { name: 'Share', exact: true }).click();
      await expect(fixture).toHaveTitle(/^\(Shared\) IA Fixture Form$/);
      await expect(fixture.locator('ia-indicator')).toHaveCount(1);
      // The bar is in a closed shadow root; the e2e build mirrors it into data-ia-e2e-* host attributes (BAR).
      await expect(fixture.locator(BAR), 'bar names the technician and the organisation').toHaveAttribute('data-ia-e2e-bar', sharedText);
      await expect(fixture.locator(BAR)).toHaveAttribute('data-ia-e2e-text', /Pause this tab.*Stop sharing$/);
      await expect(assist.getByRole('tab', { name: /IA Fixture Form/ })).toBeVisible();
    });

    return { assist, desk: deskCtx, worker, extId, fixture, panel, sessionId, fixtureTabId, sharedAt, sharedText, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Opens the session's audit, filtered to it, and returns the entries table. */
export async function openAudit(s: Pick<P2Session, 'assist' | 'sessionId'>) {
  await s.assist.goto('/app/audit');
  await s.assist.locator('#f-session').fill(s.sessionId);
  await s.assist.getByRole('button', { name: 'Apply filters' }).click();
  return s.assist.getByRole('table', { name: 'Audit entries' });
}
