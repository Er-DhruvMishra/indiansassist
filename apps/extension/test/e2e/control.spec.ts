/**
 * Package 2 privacy and control e2e (contract 13.2 E3 reveal, E4 tab groups, E7 backstage, E8 pause): after the
 * join-page handshake and consent "This tab only / Tab control" without background tabs (session.ts):
 * - the Assist asks to **Reveal this tab**; the Desk allows it in the side panel; the typed input appears in the
 *   replayer while the password keeps the fixed mask; **Hide again** restores the masks;
 * - the Desk pauses the tab in the side panel: the console shows "Paused by the user", a raw `tabs.reload` answers
 *   `tab_paused`; Resume brings the mirror back;
 * - the Assist groups the tab and renames / recolours the group (checked with chrome.tabGroups on the Desk);
 * - backstage is refused until the Desk ticks "Allow the technician to open background tabs" in the side panel; a
 *   background tab then opens with `active: false` and the Desk's active tabs and focused window do not change;
 *   the Assist closes it;
 * - the audit holds each pair and the chain verifies.
 * Not covered here (reason): the toast and the "(+1 background tab)" bar text live in the indicator's closed
 * shadow root, which Playwright cannot read; the side panel chip is asserted instead.
 */
import { MASK_FIXED } from '@indiansassist/shared';
import { expect, test } from '@playwright/test';
import { FIXTURES, rawControl, readMirror, shot, shots } from './helpers';
import { TYPED, openAudit, startP2Session, type P2Session } from './session';

const REASON = 'Check the employee name the user typed';

test('Package 2: reveal, pause, tab groups and backstage', async () => {
  let s: P2Session | null = null;
  try {
    s = await startP2Session({ org: 'E2E Control Clinic', label: 'E2E control ticket', consent: { level: 'tab_control' } });
    const { assist, panel, worker, fixtureTabId } = s;
    const notice = assist.getByTestId('op-notice');
    await expect.poll(async () => (await readMirror(assist))?.text ?? '', { timeout: 30_000 }).toContain('Fixture visible text');

    await test.step('Assist asks to reveal the tab; the Desk allows it; Hide again restores the masks', async () => {
      expect((await readMirror(assist))?.name ?? '').not.toContain('typed');
      await assist.getByRole('region', { name: 'Masking' }).getByRole('button', { name: 'Reveal this tab' }).click();
      const dialog = assist.getByRole('dialog', { name: 'Ask to reveal this tab' });
      await dialog.getByLabel('Reason').fill(REASON);
      await dialog.getByRole('button', { name: 'Ask the user' }).click();
      const card = panel.getByRole('alertdialog', { name: 'Request from your technician' });
      await expect(card).toContainText(REASON);
      await shot(panel, 'desk-panel-reveal-prompt');
      await card.getByRole('button', { name: 'Show for 60 s' }).click();
      await expect.poll(async () => (await readMirror(assist))?.name ?? '', { timeout: 15_000 }).toBe(TYPED);
      const doc = (await readMirror(assist))!;
      expect(doc.password, 'a secret is never revealed').toBe(MASK_FIXED);
      expect(doc.text).not.toContain('hunter2');
      await expect(assist.getByTestId('mask-summary')).toContainText('1 revealed');
      await shot(assist, 'assist-revealed');
      const row = panel.getByRole('listitem').filter({ hasText: 'IA Fixture Form' });
      await expect(row.getByText('REVEALED', { exact: true })).toBeVisible();
      await row.getByRole('button', { name: 'Hide again' }).click();
      await expect.poll(async () => (await readMirror(assist))?.name ?? '', { timeout: 15_000 }).not.toContain('typed');
      await expect(row.getByText('REVEALED', { exact: true })).toHaveCount(0);
    });

    await test.step('Desk pauses the tab in the side panel, then resumes it', async () => {
      const row = panel.getByRole('listitem').filter({ hasText: 'IA Fixture Form' });
      await row.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(row).toContainText('Paused: not shared');
      await expect(assist.getByText('Paused by the user').first()).toBeVisible();
      await expect(assist.getByRole('tab', { name: /IA Fixture Form/ })).toContainText('paused');
      const { res } = await rawControl(assist, {
        t: 'ctl.req',
        id: 'e2e-reload-paused-1',
        op: 'tabs.reload',
        args: { tabId: fixtureTabId },
        ts: Date.now(),
      });
      expect(res).toMatchObject({ ok: false, error: { code: 'tab_paused' } });
      await shot(assist, 'assist-paused');
      await row.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(assist.getByText('Paused by the user')).toHaveCount(0);
      await expect.poll(async () => (await readMirror(assist))?.text ?? '', { timeout: 15_000 }).toContain('Fixture visible text');
    });

    await test.step('Assist groups the tab, then renames and recolours the group', async () => {
      const groups = () =>
        worker.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => ({ title: g.title, color: g.color })));
      const tabs = assist.getByRole('region', { name: 'Tab control' });
      await tabs.getByLabel('Group title').fill('E2E Group');
      await tabs.getByLabel('Group colour').selectOption('green');
      await tabs.getByRole('button', { name: 'Group this tab' }).click();
      await expect(notice).toHaveText('Group created.');
      await expect.poll(groups).toEqual([{ title: 'E2E Group', color: 'green' }]);
      await tabs.getByRole('button', { name: 'List groups' }).click();
      const item = tabs.getByRole('listitem').filter({ hasText: 'E2E Group' });
      await expect(item).toContainText('green, 1 tabs');
      await tabs.getByLabel('Group title').fill('E2E Renamed');
      await tabs.getByLabel('Group colour').selectOption('purple');
      await item.getByRole('button', { name: 'Rename / recolour' }).click();
      // The panel reloads the list right after the update ("Groups loaded." replaces "Group updated."), so the
      // Desk's real tab group is the assertion.
      await expect.poll(groups).toEqual([{ title: 'E2E Renamed', color: 'purple' }]);
      await expect(tabs.getByRole('listitem').filter({ hasText: 'E2E Renamed' })).toContainText('purple');
      await shot(assist, 'assist-tab-group');
    });

    await test.step('Backstage: refused without the Desk consent, then opens a background tab without focus change', async () => {
      const bs = assist.getByRole('region', { name: 'Background tabs' });
      await expect(bs.getByTestId('backstage-blocked')).toHaveText('The user has not allowed background tabs.');
      const refused = await rawControl(assist, {
        t: 'ctl.req',
        id: 'e2e-backstage-refused-1',
        op: 'backstage.enter',
        args: { url: `${FIXTURES}/second.html` },
        ts: Date.now(),
      });
      expect(refused.res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
      await panel.getByLabel('Allow the technician to open background tabs').check();
      await expect(bs.getByTestId('backstage-blocked')).toHaveCount(0);
      const focus = () =>
        worker.evaluate(async () => ({
          active: (await chrome.tabs.query({ active: true })).map((t) => t.id).sort(),
          window: (await chrome.windows.getLastFocused()).id,
        }));
      const before = await focus();
      await bs.getByLabel('Address').fill(`${FIXTURES}/second.html`);
      await bs.getByRole('button', { name: 'Open background tab' }).click();
      await expect(notice).toHaveText('Background tab opened. The user was told.');
      const opened = () =>
        worker.evaluate(
          async (url) => (await chrome.tabs.query({ url })).map((t) => ({ id: t.id, active: t.active })),
          `${FIXTURES}/second.html`,
        );
      await expect.poll(async () => (await opened()).length).toBe(1);
      expect((await opened())[0]!.active, 'backstage tab is never active').toBe(false);
      expect(await focus(), "the Desk's active tabs and focused window did not change").toEqual(before);
      await expect(panel.getByText('1 background tab(s)')).toBeVisible();
      await expect(bs.getByRole('listitem').filter({ hasText: 'IA Fixture Second' })).toBeVisible();
      await shot(assist, 'assist-backstage');
      await bs.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(notice).toHaveText('Background tab closed.');
      await expect.poll(async () => (await opened()).length).toBe(0);
      expect(await focus()).toEqual(before);
    });

    await test.step('Stop sharing; the audit holds the reveal, pause, group and backstage entries', async () => {
      await panel.getByRole('button', { name: 'Stop sharing' }).click();
      await expect(panel.getByRole('heading', { name: 'Session ended' })).toBeVisible();
      const table = await openAudit(s!);
      for (const action of [
        'mask.requested',
        'mask.override',
        'mask.restored',
        'mirror.stopped',
        'mirror.started',
        'tab.action',
        'consent.backstage_changed',
        'backstage.enter',
        'backstage.exit',
        'session.ended',
      ])
        await expect(table.getByRole('cell', { name: action, exact: true }).first(), action).toBeVisible();
      await assist.getByRole('button', { name: 'Verify chain' }).click();
      await expect(assist.getByText(/^Verified /)).toHaveAttribute('data-tone', 'green');
    });
  } finally {
    console.log(`screenshots:\n${shots.join('\n')}`);
    await s?.close();
  }
});
