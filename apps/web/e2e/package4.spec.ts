/**
 * Package 4 end-to-end test: the fleet console's keyboard-only accessibility flows
 * (docs/specs/phase-d-contracts.md section 13.5 "Accessibility", section 13.4 for the pages).
 *
 * The Assist signs up a p4_installed org, then — over REST with the signed-in cookie — creates a device group with
 * an `allow` policy, an enrollment token and a region-signed `enroll.iaconfig`, and enrols two devices with their own
 * identity and sealing keys (as the installed service does, section 3.2), so the fleet has real rows. Everything
 * after that is done with the keyboard only (Tab / Shift+Tab / Enter / Space / typing; no click, no
 * `selectOption`, no `fill`): reaching `/app/fleet` through the skip link and the main nav, the whole device table
 * and its filters, sorting, opening a device page, and saving a policy override in `UnattendedPolicyEditor`.
 *
 * Asserted throughout: the tab order is the DOM order, every control in `main` is reachable by Tab and carries an
 * accessible name, every focused control paints a visible focus ring, each status (connection, tamper, unattended
 * mode, the saved-policy confirmation) is conveyed in words that survive the colour being flattened away, and the
 * confirmation lands in a polite live region.
 */
import { randomBytes } from 'node:crypto';
import { base64urlDecode, devicePublicKeyOf, deviceSigInput, kexPublicKeyOf, kidOf, signDeviceInput } from '@indiansassist/shared';
import { expect, test, type Page } from '@playwright/test';
import { assertKeyboardReachable, assertTextNotColour, focused, tab, tabUntil } from './a11y';
import { captureConsole, shot } from './helpers';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
const HEADERS = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };
const DEVICES = ['E2E-KBD-ONE', 'E2E-KBD-TWO'];

/** One simulated installed service: the keys never leave "the device", exactly as in `smoke:p4`. */
function newDevice(name: string) {
  const seed = new Uint8Array(randomBytes(32));
  const kexSecret = new Uint8Array(randomBytes(32));
  const publicKey = devicePublicKeyOf(seed);
  return {
    name,
    seed,
    publicKey,
    kex: kexPublicKeyOf(kexSecret),
    keyId: kidOf(base64urlDecode(publicKey)),
    hw: randomBytes(32).toString('hex'),
  };
}

/**
 * Walks backwards with Shift+Tab to the first tab stop of the page, the skip link. Chromium keeps the sequential
 * focus starting point where the last step left it, so getting back to the top is itself a keyboard journey - and it
 * proves the order is walkable in reverse, not only forwards.
 */
async function homeByKeyboard(page: Page): Promise<void> {
  const seen: string[] = [];
  for (let i = 0; i < 150; i += 1) {
    await page.keyboard.press('Shift+Tab');
    const s = await focused(page);
    seen.push(`${s.role}:${s.name.slice(0, 20)}`);
    if (s.name.includes('Skip to content')) {
      expect(s.ring, 'the skip link shows a focus ring when focused').toBe(true);
      return;
    }
  }
  throw new Error(`Shift+Tab never reached the skip link; saw: ${seen.join(' | ')}`);
}

/** Moves focus to the top of `main` with the keyboard alone: back to the skip link, then Enter to follow it. */
async function skipToMain(page: Page): Promise<void> {
  await homeByKeyboard(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
}

test('Package 4: the fleet console is fully operable from the keyboard', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  captureConsole(page, 'fleet');
  const main = page.locator('main');
  let groupId = '';
  const enrolled: string[] = [];

  try {
    await test.step('Assist signs up a p4_installed org', async () => {
      await page.goto('/signup');
      await page.getByLabel('Organisation name').fill('E2E Fleet');
      await page.getByLabel('Your name').fill('Asha Tech');
      await page.getByLabel('Work email').fill(`asha+${Date.now()}@e2e.example.com`);
      await page.getByLabel('Password').fill('correct horse battery staple');
      await page.getByRole('button', { name: 'Create organisation' }).click();
      await expect(page).toHaveURL(/\/app$/);
      const me = await (await page.request.get(`${API}/api/v1/auth/me`)).json();
      const seat = await page.request.patch(`${API}/api/v1/users/${me.user.id}/role`, {
        headers: HEADERS,
        data: { role: 'org_admin', tier: 'p4_installed' },
      });
      expect(seat.status(), 'seat raised to p4_installed').toBeLessThan(300);
    });

    await test.step('Two devices enrol over REST, each minting its own keys (section 3.2)', async () => {
      const group = await page.request.post(`${API}/api/v1/orgs/current/device-groups`, {
        headers: HEADERS,
        data: { name: 'Keyboard test fleet', defaultPolicy: { mode: 'allow', recordingRequired: false, requireLocalApprovalWhenPresent: true } },
      });
      expect(group.status(), await group.text()).toBe(201);
      groupId = (await group.json()).id;
      const token = await page.request.post(`${API}/api/v1/tokens`, {
        headers: HEADERS,
        data: { tier: 'p4_installed', typ: 'enrollment', maxDevices: DEVICES.length, label: 'E2E P4 keyboard' },
      });
      expect(token.status(), await token.text()).toBe(201);
      const tokenId = (await token.json()).token.id;
      const cfgRes = await page.request.get(`${API}/api/v1/devices/enroll-config?tokenId=${tokenId}&groupId=${groupId}`, { headers: HEADERS });
      expect(cfgRes.status(), await cfgRes.text()).toBe(200);
      const enrollConfig = (await cfgRes.json()).iaconfig;
      for (const name of DEVICES) {
        const d = newDevice(name);
        const res = await page.request.post(`${API}/api/v1/devices/enroll`, {
          headers: HEADERS,
          data: {
            enrollConfig,
            devicePublicKey: d.publicKey,
            deviceKexPublicKey: d.kex,
            deviceKeyProof: signDeviceInput(deviceSigInput.enroll({ tokenId, devicePublicKey: d.publicKey, deviceKexPublicKey: d.kex }), d.seed),
            machine: {
              name: d.name,
              platform: 'windows',
              osVersion: '10.0.26100',
              arch: 'x64',
              serviceVersion: '0.4.0',
              hwFingerprint: d.hw,
              wakeMac: null,
              amt: null,
              capabilities: {
                monitors: 1,
                elevation: 'admin',
                features: ['screen', 'input', 'chat', 'service_input'],
                encoders: ['vp8'],
                hwEncoder: false,
                interpreters: ['powershell'],
                serviceVersion: '0.4.0',
              },
              interactive: { state: 'locked', idleSec: null, at: Date.now() },
            },
          },
        });
        expect(res.status(), await res.text()).toBe(201);
        enrolled.push((await res.json()).deviceId);
      }
      expect(enrolled).toHaveLength(DEVICES.length);
    });

    await test.step('The fleet list is reached by keyboard: skip link, then the main nav', async () => {
      await page.goto('/app');
      await expect(page.getByRole('banner')).toBeVisible();
      const first = await tab(page);
      expect(first.name, 'the first tab stop is the skip link').toContain('Skip to content');
      await tabUntil(page, (s) => s.role === 'link' && s.name === 'Fleet');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/app\/fleet$/);
      await expect(page.getByRole('heading', { name: 'Fleet', level: 1 })).toBeVisible();
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.getByRole('row')).toHaveCount(DEVICES.length + 1); // the header row and one per device
      await shot(page, 'p4-fleet-list');
    });

    await test.step('Every control of the fleet list is reachable, labelled and shows a focus ring, in DOM order', async () => {
      await skipToMain(page);
      const stops = await assertKeyboardReachable(page, main, 'fleet list');
      // The table's own keyboard surface: a caption, sortable column headers as buttons, a checkbox per row.
      expect(stops.some((s) => s.role === 'button' && s.name === 'Device'), 'the Device column header is a button').toBe(true);
      expect(stops.filter((s) => s.role === 'checkbox' && s.name.startsWith('Select ')).length, 'one labelled select box per row').toBe(DEVICES.length);
      for (const name of DEVICES) expect(stops.some((s) => s.role === 'link' && s.name === name), `${name} is a tab stop`).toBe(true);
      await expect(page.locator('table caption')).toHaveText('Devices in the fleet');
    });

    await test.step('The device table conveys status in words, not colour alone', async () => {
      const table = page.getByRole('table');
      await assertTextNotColour(page, table, ['Offline', 'No tamper', 'Unattended allowed', 'Cold power on: not available']);
      // Sorting state is announced, not drawn: aria-sort moves with the keyboard.
      await skipToMain(page);
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Device');
      await page.keyboard.press('Enter');
      await expect(page.locator('th[aria-sort="descending"]')).toContainText('Device');
      await page.keyboard.press('Enter');
      await expect(page.locator('th[aria-sort="ascending"]')).toContainText('Device');
    });

    await test.step('The filters are typed, not clicked: the list narrows to one device and back', async () => {
      await skipToMain(page);
      await tabUntil(page, (s) => s.name === 'Search name or tag');
      await page.keyboard.type(DEVICES[1]!);
      await expect(page.getByRole('row')).toHaveCount(2);
      await expect(page.getByRole('link', { name: DEVICES[1]! })).toBeVisible();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await expect(page.getByRole('row')).toHaveCount(DEVICES.length + 1);
    });

    await test.step('A device page opens with Enter on its name and is fully keyboard-operable', async () => {
      await skipToMain(page);
      await tabUntil(page, (s) => s.role === 'link' && s.name === DEVICES[0]);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/app\/fleet\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { name: DEVICES[0]!, level: 1 })).toBeVisible();
      await assertTextNotColour(page, main, ['Offline', 'No tamper', 'Unattended allowed', 'Signed in, screen locked']);
      await shot(page, 'p4-device-detail');
      await skipToMain(page);
      await assertKeyboardReachable(page, main, 'device page');
    });

    await test.step('The policy override is saved from the keyboard and confirmed in a polite live region', async () => {
      const editor = page.getByRole('region', { name: 'Policy override for this device' });
      await expect(editor).toBeVisible();
      await expect(page.getByTestId('device-override')).toContainText('Set on this device: nothing');
      await skipToMain(page);
      await tabUntil(page, (s) => s.role === 'checkbox' && s.name.startsWith('Require recording'));
      const before = await focused(page);
      expect(before.ring, 'the checkbox shows a focus ring').toBe(true);
      await page.keyboard.press('Space');
      await expect(editor.getByRole('checkbox', { name: 'Require recording' })).toBeChecked();
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Save policy');
      await page.keyboard.press('Enter');
      const live = page.locator('[aria-live="polite"]').filter({ hasText: 'The policy override was saved.' });
      await expect(live, 'the confirmation is in a polite live region').toBeVisible();
      await expect(page.getByTestId('device-override')).toContainText('Set on this device: Require recording.');
      await shot(page, 'p4-policy-override-saved');
      // The saved state is readable without colour too.
      await assertTextNotColour(page, main, ['The policy override was saved.', 'Require recording']);
    });

    await test.step('Shift+Tab walks back out and the "All devices" link returns to the list', async () => {
      await skipToMain(page);
      await tabUntil(page, (s) => s.role === 'link' && s.name === 'All devices');
      await page.keyboard.press('Shift+Tab');
      const back = await focused(page);
      expect(back.name, 'Shift+Tab lands on the previous control, not nowhere').not.toBe('');
      await tabUntil(page, (s) => s.role === 'link' && s.name === 'All devices');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/app\/fleet$/);
      await expect(page.getByRole('table')).toBeVisible();
      // The group sidebar is a labelled nav and its buttons say which group is current.
      const nav = page.getByRole('navigation', { name: 'Device groups' });
      await expect(nav.getByRole('button', { name: 'Every device' })).toHaveAttribute('aria-current', 'true');
    });
  } finally {
    await ctx.close();
  }
});
