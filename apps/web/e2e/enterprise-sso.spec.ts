/**
 * Phase E stream sso, keyboard-only accessibility spec (docs/specs/phase-e-contracts.md sections 3, 11, 13.4, 15.2).
 *
 * An org_admin signs up, then does everything from the keyboard (Tab / Shift+Tab / arrows / Enter / Space / typing):
 * reaches SSO from the main nav, configures a SAML IdP, adds and verifies a domain, runs a test sign-in, picks a
 * break-glass administrator and turns SSO required on. A new user then signs in through the email-first login page
 * (just-in-time account), and a cross-site link's /sso/continue interstitial is completed. Asserted: every control in
 * `main` is reachable, labelled and shows a focus ring; states are words that survive the colour being removed;
 * results land in live regions; the whole SAML round trip runs in a real browser (per-flow SameSite=None binding
 * cookie, a cross-site POST to the ACS).
 *
 * In-process fakes in this test process, on 127.0.0.1 only: a SAML IdP (signs with xml-crypto, shows a form whose
 * submit button is pressed with Enter) and a DNS server answering the domain TXT proof. The api it talks to needs
 * EGRESS_ALLOW_LOOPBACK=1 and SSO_DEV_DNS_SERVERS=127.0.0.1:<SMOKE_SSO_DNS_PORT, default 5391> in the runner's
 * environment (Playwright passes it to the api it starts); every address is synthetic.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { assertKeyboardReachable, assertTextNotColour, focused, tab, tabUntil } from './a11y';
import { captureConsole, shot } from './helpers';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
const HEADERS = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };
const DNS_PORT = Number(process.env.SMOKE_SSO_DNS_PORT || 5391);
const PASSWORD = 'correct horse battery staple';

type Idp = { entityId: string; certPem: string; privateKeyPem: string };
type SsoLib = {
  startFakeDns(port: number): Promise<{ records: Map<string, string[]>; close(): Promise<void> }>;
  makeSamlIdp(): Promise<Idp>;
  samlResponseFor(idp: Idp, o: { acsUrl: string; audience: string; inResponseTo: string; nameId: string }): string;
};

const here = dirname(fileURLToPath(import.meta.url));
const loadLib = async () => (await import(pathToFileURL(resolve(here, '../../../scripts/smoke/flow-e-sso.mjs')).href)) as SsoLib;

/** The fake IdP's sign-on page: reads the AuthnRequest and offers a signed Response for `user` in a POST form. */
async function startIdp(lib: SsoLib, idp: Idp, sp: { acsUrl: () => string; entityId: () => string }, user: { email: string }): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://idp.local');
    const saml = u.searchParams.get('SAMLRequest');
    if (u.pathname !== '/sso' || !saml) {
      res.writeHead(404).end();
      return;
    }
    const xml = inflateRawSync(Buffer.from(saml, 'base64')).toString('utf8');
    const requestId = /ID="([^"]+)"/.exec(xml)?.[1] ?? '';
    const response = lib.samlResponseFor(idp, { acsUrl: sp.acsUrl(), audience: sp.entityId(), inResponseTo: requestId, nameId: user.email });
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html lang="en"><title>Fake IdP</title><main><h1>Fake IdP</h1><p>Signed in as ${esc(user.email)}</p>` +
        `<form method="post" action="${esc(sp.acsUrl())}"><input type="hidden" name="SAMLResponse" value="${esc(response)}">` +
        `<input type="hidden" name="RelayState" value="${esc(u.searchParams.get('RelayState') ?? '')}">` +
        `<button type="submit" autofocus>Send the response</button></form></main></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** On the fake IdP page: the submit button has focus; Enter sends the Response to the ACS. */
async function submitAtIdp(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Fake IdP' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send the response' })).toBeFocused();
  await page.keyboard.press('Enter');
}

async function typeInto(page: Page, nameStarts: string, text: string): Promise<void> {
  await tabUntil(page, (s) => s.name.startsWith(nameStarts) && ['textbox', 'combobox'].includes(s.role));
  await page.keyboard.insertText(text);
}

test('Phase E sso: SSO settings, test sign-in, SSO required and SAML logins are operable from the keyboard', async ({ browser }) => {
  test.setTimeout(240_000);
  const lib = await loadLib();
  const dns = await lib.startFakeDns(DNS_PORT);
  const idpKeys = await lib.makeSamlIdp();
  const tag = Date.now().toString(36);
  const domain = `sso-e2e-${tag}.example.test`;
  const adminEmail = `admin@${domain}`;
  const sp = { acs: '', entity: '' };
  const user = { email: adminEmail };
  const idp = await startIdp(lib, idpKeys, { acsUrl: () => sp.acs, entityId: () => sp.entity }, user);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  captureConsole(page, 'assist');
  let slug = '';

  try {
    await test.step('an org_admin signs up (synthetic address on the org domain)', async () => {
      await page.goto('/signup');
      await page.getByLabel('Organisation name').fill(`E2E SSO ${tag}`);
      await page.getByLabel('Your name').fill('Asha Admin');
      await page.getByLabel('Work email').fill(adminEmail);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByLabel('Password').press('Enter');
      await expect(page).toHaveURL(/\/app$/);
      const me = await (await page.request.get(`${API}/api/v1/auth/me`)).json();
      slug = me.org.slug as string;
      const st = await (await page.request.get(`${API}/api/v1/orgs/current/sso`)).json();
      sp.acs = st.sp.acsUrl;
      sp.entity = st.sp.entityId;
    });

    await test.step('SSO is reached by keyboard from the main nav; every control is reachable, named and ringed', async () => {
      await page.keyboard.press('Tab');
      expect((await focused(page)).name).toContain('Skip to content');
      await tabUntil(page, (s) => s.role === 'link' && s.name === 'SSO');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Single sign-on', level: 1 })).toBeVisible();
      await expect(page.getByRole('switch')).toBeVisible();
      const main = page.getByRole('main');
      await page.locator('main').focus();
      await assertKeyboardReachable(page, main, 'sso settings page');
      await assertTextNotColour(page, main, ['Turned off', 'Not required', 'Before it can be required']);
    });

    await test.step('a SAML IdP is configured from the keyboard and the save is announced', async () => {
      await page.locator('main').focus();
      await tabUntil(page, (s) => s.role === 'radio');
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('radio', { name: 'SAML 2.0' })).toBeChecked();
      await typeInto(page, 'Button label', 'E2E SAML');
      await tabUntil(page, (s) => s.role === 'checkbox' && s.name.startsWith('Single sign-on is turned on'));
      await page.keyboard.press('Space');
      await typeInto(page, 'IdP entity ID', idpKeys.entityId);
      await typeInto(page, 'IdP sign-on URL', `${idp.url}/sso`);
      await typeInto(page, 'IdP signing certificates', idpKeys.certPem);
      await tabUntil(page, (s) => s.role === 'checkbox' && s.name.startsWith('Create an account on first sign-in'));
      await page.keyboard.press('Space');
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Save identity provider');
      expect((await focused(page)).ring).toBe(true);
      await page.keyboard.press('Enter');
      await expect(page.getByText('Saved.')).toBeVisible();
      await expect(page.getByText('Turned on', { exact: true })).toBeVisible();
      await expect(page.getByLabel('ACS URL')).toHaveValue(sp.acs);
      await shot(page, 'sso-configured');
    });

    await test.step('a domain is added and verified from the keyboard (TXT proof through the fake DNS)', async () => {
      await page.locator('main').focus();
      await typeInto(page, 'Domain to add', domain);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('status').filter({ hasText: 'Publish its TXT record' })).toBeVisible();
      const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Verified domains' }) });
      await assertTextNotColour(page, card, ['Pending']);
      const txtName = await page.getByLabel(`TXT name for ${domain}`).inputValue();
      const txtValue = await page.getByLabel(`TXT value for ${domain}`).inputValue();
      dns.records.set(txtName, [txtValue]);
      await page.locator('main').focus();
      await tabUntil(page, (s) => s.role === 'button' && s.name === `Verify ${domain}`);
      await page.keyboard.press('Enter');
      await expect(card.getByRole('status')).toHaveText(`${domain} is verified.`);
      await assertTextNotColour(page, card, ['Verified']);
    });

    await test.step('a test sign-in as the admin runs the SAML round trip and is announced', async () => {
      await page.locator('main').focus();
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Test sign-in');
      await page.keyboard.press('Enter');
      await submitAtIdp(page);
      await expect(page).toHaveURL(/\/app\/settings\/sso\?test=ok$/);
      await expect(page.getByText('Test sign-in succeeded.')).toBeVisible();
      await expect(page.getByText(/succeeded, matched your account/)).toBeVisible();
    });

    await test.step('a break-glass admin is chosen and SSO required is turned on from the keyboard', async () => {
      await page.locator('main').focus();
      await tabUntil(page, (s) => s.role === 'checkbox' && s.name.startsWith('Asha Admin'));
      await page.keyboard.press('Space');
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Save break-glass administrators');
      await page.keyboard.press('Enter');
      await expect(page.getByText('Break-glass administrators saved.')).toBeVisible();
      await expect(page.getByRole('switch')).toBeEnabled();
      await page.locator('main').focus();
      await tabUntil(page, (s) => s.role === 'switch');
      await page.keyboard.press('Space');
      const dialog = page.getByRole('dialog', { name: 'Require single sign-on?' });
      await expect(dialog).toBeVisible();
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Require single sign-on');
      await page.keyboard.press('Enter');
      await expect(page.getByText(/Single sign-on is now required/)).toBeVisible();
      await expect(page.getByText('Required', { exact: true })).toBeVisible();
      await shot(page, 'sso-required');
    });

    await test.step('a new user signs in from the email-first login page and gets a JIT account', async () => {
      const c2 = await browser.newContext();
      const p2 = await c2.newPage();
      captureConsole(p2, 'jit');
      try {
        user.email = `newtech@${domain}`;
        await p2.goto('/login');
        await tab(p2);
        await tabUntil(p2, (s) => s.name === 'Email');
        await p2.keyboard.type(user.email);
        await p2.keyboard.press('Enter');
        const link = p2.getByRole('link', { name: 'Continue with E2E SAML' });
        await expect(link).toBeVisible();
        await expect(p2.getByRole('button', { name: 'Administrator sign-in with password' })).toBeVisible();
        await expect(p2.getByLabel('Password')).toHaveCount(0);
        await tabUntil(p2, (s) => s.role === 'link' && s.name === 'Continue with E2E SAML');
        await p2.keyboard.press('Enter');
        await submitAtIdp(p2);
        await expect(p2).toHaveURL(/\/app$/);
        const me = await (await p2.request.get(`${API}/api/v1/auth/me`)).json();
        expect(me.user.email).toBe(user.email);
        expect(me.user.role).toBe('technician');
      } finally {
        await c2.close();
      }
    });

    await test.step('a cross-site link lands on /sso/continue, which names the org and the IdP before continuing', async () => {
      const c3 = await browser.newContext();
      const p3 = await c3.newPage();
      try {
        const r = await p3.request.get(`${API}/api/v1/auth/sso/${slug}/begin?login_hint=${encodeURIComponent(user.email)}`, {
          headers: { 'Sec-Fetch-Site': 'cross-site' },
          maxRedirects: 0,
        });
        expect(r.status()).toBe(303);
        await p3.goto(r.headers()['location']!);
        await expect(p3.getByText(`E2E SSO ${tag}`)).toBeVisible();
        await expect(p3.getByText('E2E SAML', { exact: true })).toBeVisible();
        await tabUntil(p3, (s) => s.role === 'link' && s.name === 'Continue to E2E SAML');
        await p3.keyboard.press('Enter');
        await submitAtIdp(p3);
        await expect(p3).toHaveURL(/\/app$/);
      } finally {
        await c3.close();
      }
    });

    await test.step('password login of a non-break-glass user is refused, and ?sso_error= reads in plain words', async () => {
      const c4 = await browser.newContext();
      const p4 = await c4.newPage();
      try {
        const res = await p4.request.post(`${API}/api/v1/auth/login`, { headers: HEADERS, data: { email: user.email, password: 'whatever it is' } });
        expect(res.status()).toBe(401);
        await p4.goto('/login?sso_error=domain_not_verified');
        await expect(p4.getByRole('alert')).toHaveText(/Your email domain is not verified for this organisation/);
      } finally {
        await c4.close();
      }
    });
  } finally {
    await ctx.close();
    await new Promise<void>((r) => idp.server.close(() => r()));
    await dns.close();
  }
});
