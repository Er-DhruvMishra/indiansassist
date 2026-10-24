/**
 * Package 2 extension e2e (docs/specs/phase-b-contracts.md section 13.2, the E1 / E3 / E4 / E11 core): the Desk is
 * a persistent Chromium context with the unpacked extension (dist-e2e), the Assist a separate Chromium. Assist
 * signs up, takes a P2 seat and creates a p2_extension token; the Desk opens the join link and clicks **Open in
 * extension** (externally_connectable, clipboard untouched; session.ts), consents to "This tab only / Tab control"
 * on the fixture form; the console replayer renders the page with the password (fixed 8-char mask), the
 * [data-ia-sensitive] span and the typed input masked and the [data-ia-block] panel absent; Assist opens a new tab
 * through ia.control and the Desk gets it; a raw in_page frame above the consent is refused by the extension
 * (not_allowed); Stop sharing from the side panel ends the session; the audit chain holds session.consent_granted,
 * mirror.started, tab.action and mirror.stopped, and verifies.
 */
import { MASK_FIXED } from '@indiansassist/shared';
import { expect, test } from '@playwright/test';
import { FIXTURES, rawControl, readMirror, shot, shots } from './helpers';
import { openAudit, startP2Session, type P2Session } from './session';

const PASSWORD = 'hunter2-secret';
const SENSITIVE = 'SENSITIVE-4111-2222';
const MODS = { alt: false, ctrl: false, meta: false, shift: false };

test('Package 2: extension Desk mirrors a tab to the Assist console and takes tab control', async () => {
  let s: P2Session | null = null;
  try {
    s = await startP2Session({ org: 'E2E Extension Clinic', label: 'E2E P2 ticket', consent: { level: 'tab_control' } });
    const { assist, desk: deskCtx, fixture, panel, fixtureTabId } = s;
    await shot(fixture, 'desk-fixture-shared');

    await test.step('Assist replayer renders the page with the protected fields masked', async () => {
      await expect(assist.getByRole('tab', { name: /IA Fixture Form/ })).toBeVisible();
      await expect
        .poll(async () => (await readMirror(assist))?.text ?? '', { timeout: 30_000 })
        .toContain('Fixture visible text for the mirror');
      const doc = (await readMirror(assist))!;
      expect(doc.text).toContain('IA fixture: payroll settings');
      expect(doc.password).not.toBeNull();
      expect(doc.password).not.toContain('hunter2');
      expect(doc.password, 'secrets get the fixed-length mask').toBe(MASK_FIXED);
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
      const p = panel;
      await p.getByRole('button', { name: 'Stop sharing' }).click();
      await expect(p.getByRole('heading', { name: 'Session ended' })).toBeVisible();
      await expect(fixture.locator('ia-indicator')).toHaveCount(0);
      await expect(fixture).toHaveTitle('IA Fixture Form');
      await expect(assist.getByText(/^Session ended/).first()).toBeVisible();
      await shot(p, 'desk-sidepanel-receipt');
      await shot(assist, 'assist-ended');
    });

    await test.step('Audit holds the P2 entries and the chain verifies', async () => {
      const table = await openAudit(s!);
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
    await s?.close();
  }
});
