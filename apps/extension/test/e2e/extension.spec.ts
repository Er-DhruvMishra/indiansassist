/**
 * Package 2 extension e2e (docs/specs/phase-b-contracts.md section 13.2, the E1 / E3 / E4 / E11 core): the Desk is
 * a persistent Chromium context with the unpacked extension (dist-e2e), the Assist a separate Chromium. Assist
 * signs up, takes a P2 seat and creates a p2_extension token; the Desk pastes the join link into the extension's
 * side panel, consents to "This tab only / Tab control" on the fixture form; the console replayer renders the page
 * with the password, the [data-ia-sensitive] span and the typed input masked and the [data-ia-block] panel absent;
 * Assist opens a new tab through ia.control and the Desk gets it; a raw in_page frame above the consent is refused
 * by the extension (not_allowed); Stop sharing from the side panel ends the session; the audit chain holds
 * session.consent_granted, mirror.started, tab.action and mirror.stopped, and verifies.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { E2E_DIST } from './global-setup';
import {
  FIXTURES,
  HEADLESS,
  MEDIA_ARGS,
  WEB,
  captureConsole,
  pageMatching,
  rawControl,
  readMirror,
  recordDataChannels,
  shot,
  shots,
} from './helpers';

const DESK_NAME = 'E2E Desk';
const PASSWORD = 'hunter2-secret';
const SENSITIVE = 'SENSITIVE-4111-2222';
const TYPED = 'typed by the desk';
const MODS = { alt: false, ctrl: false, meta: false, shift: false };

test('Package 2: extension Desk mirrors a tab to the Assist console and takes tab control', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'ia-e2e-desk-'));
  let assistBrowser: Browser | null = null;
  let desk: BrowserContext | null = null;
  let joinUrl = '';
  let sessionId = '';
  let fixtureTabId = 0;

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
    expect(extId).toMatch(/^[a-p]{32}$/);
    deskCtx.on('page', (p) => captureConsole(p, 'desk'));

    await test.step('Assist signs up and takes a P2 seat', async () => {
      await assist.goto('/signup');
      await assist.getByLabel('Organisation name').fill('E2E Extension Clinic');
      await assist.getByLabel('Your name').fill('Asha Tech');
      await assist.getByLabel('Work email').fill(`asha+${Date.now()}@e2e.example.com`);
      await assist.getByLabel('Password').fill('correct horse battery staple');
      await assist.getByRole('button', { name: 'Create organisation' }).click();
      await expect(assist).toHaveURL(/\/app$/);
      await expect(assist.getByRole('banner').getByText('Signaling: Online')).toBeVisible();
      await assist.goto('/app/users');
      const row = assist.getByRole('row').filter({ hasText: 'Asha Tech' });
      await row.getByLabel('Seat tier of Asha Tech').selectOption('p2_extension');
      await row.getByRole('button', { name: 'Save' }).click();
      await expect(row.getByRole('button', { name: 'Save' })).toBeDisabled();
      await expect(row.getByLabel('Seat tier of Asha Tech')).toHaveValue('p2_extension');
    });

    await test.step('Assist creates a p2_extension token', async () => {
      await assist.goto('/app');
      const card = assist
        .locator('section')
        .filter({ has: assist.getByRole('heading', { name: 'Quick create token' }) });
      await card.getByLabel('Package tier').selectOption('p2_extension');
      await card.getByLabel('Label (optional)').fill('E2E P2 ticket');
      await card.getByRole('button', { name: 'Create token' }).click();
      const link = assist.locator('#join-link');
      await expect(link).toHaveValue(/\/join#t=/);
      joinUrl = await link.inputValue();
      await shot(assist, 'assist-p2-token');
    });

    const fixture = deskCtx.pages()[0] ?? (await deskCtx.newPage());
    await test.step('Desk opens the fixture form and types into it', async () => {
      await fixture.goto(`${FIXTURES}/form.html`);
      await fixture.locator('#name').fill(TYPED);
      await expect(fixture).toHaveTitle('IA Fixture Form');
    });

    let panel: Page | null = null;
    await test.step('Desk pastes the join link into the extension side panel', async () => {
      panel = await deskCtx.newPage();
      await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
      await panel.locator('#desk-name').fill(DESK_NAME);
      await panel.locator('#code').fill(joinUrl);
      await panel.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(panel.getByText(/Waiting for Asha Tech|Your technician is being asked to accept/)).toBeVisible();
      await shot(panel, 'desk-sidepanel-waiting');
    });

    await test.step('Assist sees the knock and accepts', async () => {
      const knock = assist.getByRole('article', { name: `Support request from ${DESK_NAME}` }).first();
      await expect(knock).toBeVisible();
      await expect(knock).toContainText('E2E P2 ticket');
      await knock.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(assist).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
      sessionId = /\/app\/sessions\/([0-9a-f-]{36})$/.exec(assist.url())![1]!;
      await expect(assist.getByText(/Waiting for consent/).first()).toBeVisible();
    });

    await test.step('Desk consents in the extension: this tab only, tab control', async () => {
      const consent = await pageMatching(deskCtx, (u) => u.startsWith(`chrome-extension://${extId}/consent.html`));
      await expect(consent.getByRole('heading', { name: 'Asha Tech wants to see your browser' })).toBeVisible();
      const picker = consent.locator('#tab');
      const value = await picker.evaluate(
        (sel: HTMLSelectElement) => [...sel.options].find((o) => o.text.includes('IA Fixture Form'))?.value ?? '',
      );
      expect(value).not.toBe('');
      fixtureTabId = Number(value);
      await picker.selectOption(value);
      await consent.locator('#level-tab_control').check();
      await shot(consent, 'desk-consent');
      await consent.getByRole('button', { name: 'Share', exact: true }).click();
      await expect(fixture).toHaveTitle(/^\(Shared\) IA Fixture Form$/);
      await expect(fixture.locator('ia-indicator')).toHaveCount(1);
      await shot(fixture, 'desk-fixture-shared');
    });

    await test.step('Assist replayer renders the page with the protected fields masked', async () => {
      await expect(assist.getByRole('tab', { name: /IA Fixture Form/ })).toBeVisible();
      await expect
        .poll(async () => (await readMirror(assist))?.text ?? '', { timeout: 30_000 })
        .toContain('Fixture visible text for the mirror');
      const doc = (await readMirror(assist))!;
      expect(doc.text).toContain('IA fixture: payroll settings');
      expect(doc.password).not.toBeNull();
      expect(doc.password).not.toContain('hunter2');
      expect(doc.password).toMatch(/^\*+$/);
      expect(doc.sensitive).not.toBeNull();
      expect(doc.sensitive).not.toContain('4111');
      expect(doc.sensitive).toMatch(/^[*\s-]+$/);
      expect(doc.name ?? '').not.toContain('typed');
      expect(doc.blocked).toBe(false);
      expect(doc.text).not.toContain(PASSWORD);
      expect(doc.text).not.toContain(SENSITIVE);
      await shot(assist, 'assist-mirror-live');
    });

    await test.step('Assist opens a new tab on the Desk through ia.control', async () => {
      const before = deskCtx.pages().length;
      await assist.locator('#ia-tab-url').fill(`${FIXTURES}/second.html`);
      await assist.getByRole('button', { name: 'Open in new tab' }).click();
      await expect(assist.getByTestId('op-notice')).toHaveText('Tab opened on the Desk.');
      await expect.poll(() => deskCtx.pages().some((p) => p.url() === `${FIXTURES}/second.html`)).toBe(true);
      expect(deskCtx.pages().length).toBeGreaterThan(before);
      await expect(assist.getByRole('tab', { name: /IA Fixture Second/ })).toBeVisible();
      await shot(assist, 'assist-new-tab');
    });

    await test.step('A control frame above the consented level is refused by the extension', async () => {
      const { transport, res } = await rawControl(assist, {
        t: 'ctl.req',
        id: 'e2e-above-consent-1',
        op: 'input.pointer',
        args: { tabId: fixtureTabId, kind: 'click', nodeId: null, vx: 0.5, vy: 0.5, modifiers: MODS },
        ts: Date.now(),
      });
      expect(transport, 'ia.control data channel open on the Assist').toBe('dc');
      expect(res).toMatchObject({ t: 'ctl.res', id: 'e2e-above-consent-1', ok: false, error: { code: 'not_allowed' } });
      await expect(fixture.locator('#toggle')).toHaveText('Off');
    });

    await test.step('Desk stops sharing from the side panel; both sides show the end', async () => {
      const p = panel!;
      await p.getByRole('button', { name: 'Stop sharing' }).click();
      await expect(p.getByRole('heading', { name: 'Session ended' })).toBeVisible();
      await expect(fixture.locator('ia-indicator')).toHaveCount(0);
      await expect(fixture).toHaveTitle('IA Fixture Form');
      await expect(assist.getByText(/^Session ended/).first()).toBeVisible();
      await shot(p, 'desk-sidepanel-receipt');
      await shot(assist, 'assist-ended');
    });

    await test.step('Audit holds the P2 entries and the chain verifies', async () => {
      await assist.goto('/app/audit');
      await assist.locator('#f-session').fill(sessionId);
      await assist.getByRole('button', { name: 'Apply filters' }).click();
      const table = assist.getByRole('table', { name: 'Audit entries' });
      for (const action of [
        'session.knock',
        'session.accepted',
        'session.consent_granted',
        'mirror.started',
        'tab.action',
        'mirror.stopped',
        'session.ended',
      ]) {
        await expect(table.getByRole('cell', { name: action, exact: true }).first(), action).toBeVisible();
      }
      // Diagnostics only: with a direct path the relay (a declared plaintext gap, 4.6) should not have been used.
      console.log(
        `mirror.relayed entries: ${await table.getByRole('cell', { name: 'mirror.relayed', exact: true }).count()}`,
      );
      await assist.getByRole('button', { name: 'Verify chain' }).click();
      const badge = assist.getByText(/^Verified /);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute('data-tone', 'green');
      await shot(assist, 'assist-audit-verified');
    });
  } finally {
    console.log(`screenshots:\n${shots.join('\n')}`);
    await desk?.close().catch(() => undefined);
    await assistBrowser?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
