/**
 * Phase E residency end-to-end (docs/specs/phase-e-contracts.md sections 6.4, 11 "Accessibility", 15.5): the signed
 * data residency page of an org with six data flows prints on ONE A4 page, and the printed page carries the full
 * public key; the "Verify a report" panel verifies the org's real signed report from the keyboard alone.
 *
 * The flows are seeded by intercepting the page's `GET /orgs/current/residency` and adding six flows of the kinds an
 * org configures (an AI provider with its acknowledgement, three ticketing systems, a webhook, an IdP) to the real
 * signed report: the routes that configure those flows belong to the sso, tickets and ai streams, and the e2e api's
 * environment is fixed by playwright.config.ts. The page renders the report as given; the verification step uses the
 * real, unmodified signed JSON from `signed.json`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { focused, tabUntil } from './a11y';
import { ARTIFACTS, captureConsole, shot } from './helpers';

const WEB = `http://localhost:${process.env.E2E_WEB_PORT || '5173'}`;
const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
const HEADERS = { Origin: WEB, 'X-Requested-With': 'IndiansAssist' };

type Flow = Record<string, unknown> & { name: string; enabled: boolean; leavesInfrastructure: boolean };

const AT = '2026-10-30T08:15:00.000Z';
const SIX_FLOWS: Flow[] = [
  {
    kind: 'ai_provider',
    name: 'Anthropic (Claude)',
    host: 'api.anthropic.com',
    leavesInfrastructure: true,
    leavesRegion: 'yes',
    dataSent: 'redacted session events; after a notice in chat, redacted chat and playbook output',
    enabled: true,
    since: AT,
    enabledBy: 'Asha Admin',
    acknowledgement: { scope: 'outside_region', by: 'Asha Admin', at: AT },
  },
  {
    kind: 'ticketing',
    name: 'Jira Cloud',
    host: 'acme-e2e.atlassian.example',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: 'session summary or note, with a link to the session',
    enabled: true,
    since: AT,
    enabledBy: 'Asha Admin',
    acknowledgement: null,
  },
  {
    kind: 'ticketing',
    name: 'ServiceNow',
    host: 'acme-e2e.service-now.example',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: 'session summary or note, with a link to the session',
    enabled: true,
    since: AT,
    enabledBy: 'Asha Admin',
    acknowledgement: null,
  },
  {
    kind: 'ticketing',
    name: 'Freshdesk',
    host: 'acme-e2e.freshdesk.com',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: 'session summary or note, with a link to the session',
    enabled: false,
    since: null,
    enabledBy: null,
    acknowledgement: null,
  },
  {
    kind: 'webhook',
    name: 'Webhook',
    host: 'hooks.acme-e2e.example',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: 'signed JSON: session summary or note, with a link',
    enabled: true,
    since: AT,
    enabledBy: 'Asha Admin',
    acknowledgement: null,
  },
  {
    kind: 'sso_idp',
    name: 'Okta (OIDC)',
    host: 'acme-e2e.okta.example',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: "sign-in requests; the IdP returns the user's email and name",
    enabled: true,
    since: AT,
    enabledBy: 'Asha Admin',
    acknowledgement: null,
  },
];

/** Counts the page objects of a PDF (`/Type /Page`, not `/Type /Pages`). */
function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

test('Phase E residency: six flows print on one A4 page with the full public key; a report verifies from the keyboard', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  captureConsole(page, 'residency');
  let signedText = '';
  let pub = '';
  let flowCount = 0;

  try {
    await test.step('an org_admin signs up (synthetic e2e address)', async () => {
      await page.goto('/signup');
      await page.getByLabel('Organisation name').fill('E2E Residency Org');
      await page.getByLabel('Your name').fill('Asha Admin');
      await page.getByLabel('Work email').fill(`residency+${Date.now()}@e2e.example.com`);
      await page.getByLabel('Password').fill('correct horse battery staple');
      await page.getByRole('button', { name: 'Create organisation' }).click();
      await expect(page).toHaveURL(/\/app$/);
    });

    await test.step('the real signed report is fetched; the screen route is seeded with six flows', async () => {
      const signed = await page.request.get(`${API}/api/v1/orgs/current/residency/signed.json`, { headers: HEADERS });
      expect(signed.status(), await signed.text()).toBe(200);
      expect(signed.headers()['content-disposition']).toMatch(/^attachment; filename="residency-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.json"$/);
      signedText = await signed.text();
      const real = JSON.parse(signedText) as Record<string, unknown> & { dataFlows: Flow[]; statement: string; signature: { pub: string } };
      pub = real.signature.pub;
      expect(pub).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const flows = [...SIX_FLOWS, ...real.dataFlows];
      flowCount = flows.length;
      const seeded = {
        ...real,
        dataFlows: flows,
        subprocessors: [...new Set(flows.filter((f) => f.enabled && f.leavesInfrastructure).map((f) => f.name))],
        sso: { protocol: 'oidc', enabled: true, required: true, verifiedDomains: ['acme-e2e.example'] },
        statement:
          `${real.statement} Redacted session summaries are processed by Anthropic (Claude), outside India (Mumbai), acknowledged by Asha Admin on 2026-10-30.` +
          ' Tickets and notes are sent to Jira Cloud (acme-e2e.atlassian.example), whose location is not known to this report.' +
          ' Tickets and notes are sent to ServiceNow (acme-e2e.service-now.example), whose location is not known to this report.' +
          ' Signed ticket notifications are sent to the webhook Webhook (hooks.acme-e2e.example), whose location is not known to this report.' +
          ' Sign-in requests are sent to the identity provider Okta (OIDC) (acme-e2e.okta.example), whose location is not known to this report.',
      };
      await page.route(
        (url) => url.pathname === '/api/v1/orgs/current/residency',
        (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(seeded) }),
      );
    });

    await test.step('the residency page shows all six flows, in words', async () => {
      await page.goto('/app/residency');
      const flowsCard = page.locator('section', { has: page.getByRole('heading', { name: 'Data that leaves the region' }) });
      // A header row plus the six org flows (and any operator flow the e2e api has of its own).
      expect(flowCount).toBeGreaterThanOrEqual(SIX_FLOWS.length);
      await expect(flowsCard.getByRole('row')).toHaveCount(1 + flowCount);
      await expect(flowsCard.getByText('Leaves the region', { exact: true })).toBeVisible();
      await expect(flowsCard.getByText('Configured, disabled', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Where your data lives' })).toBeVisible();
      await expect(page.getByText(pub)).toBeVisible();
      await shot(page, 'residency-screen');
    });

    await test.step('print: one A4 page, and the printed layout carries the full public key', async () => {
      await page.emulateMedia({ media: 'print' });
      const key = page.getByText(pub, { exact: true });
      await expect(key).toBeVisible();
      expect((await key.textContent())?.trim()).toBe(pub);
      // The key wraps rather than being clipped: its box lies inside the printable width.
      const fits = await key.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= document.documentElement.clientWidth + 1);
      expect(fits, 'the public key is not clipped in the print layout').toBe(true);
      for (const name of ['Print', 'Download signed JSON', 'Verify a report']) await expect(page.getByRole('button', { name })).toBeHidden();
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
      // The printable area of A4 portrait with 12 mm margins is 186 x 273 mm (703 x 1032 CSS px); measured for the record.
      await page.setViewportSize({ width: 703, height: 1032 });
      const printHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await shot(page, 'residency-print-layout');
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: false });
      writeFileSync(join(ARTIFACTS, 'residency-print.pdf'), pdf);
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // Every page is A4 portrait: Chromium writes a MediaBox of about 595 x 842 points.
      const boxes = [...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(boxes.length).toBeGreaterThan(0);
      for (const [w, h] of boxes) expect(Math.abs(w! - 595) < 1.5 && Math.abs(h! - 842) < 1.5, `A4 portrait MediaBox, got ${w} x ${h}`).toBe(true);
      expect(pdfPageCount(pdf), `the report prints on one A4 page (print layout ${printHeight} px tall at 703 px wide)`).toBe(1);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.emulateMedia({ media: 'screen' });
    });

    await test.step('keyboard only: open "Verify a report", paste the real signed JSON, verify', async () => {
      await page.locator('main').focus();
      await tabUntil(page, (s) => s.name === 'Verify a report');
      expect((await focused(page)).ring, 'the focused button shows a focus ring').toBe(true);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Verify a report' })).toHaveAttribute('aria-expanded', 'true');
      await tabUntil(page, (s) => s.name === 'Signed report JSON');
      await page.keyboard.insertText(signedText);
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Verify');
      await page.keyboard.press('Enter');
      await expect(page.getByText(/^Verified: the report for E2E Residency Org/)).toBeVisible();
      // A changed copy is refused in words: back to the text box with Shift+Tab, select all, replace.
      for (let i = 0; i < 20 && (await focused(page)).name !== 'Signed report JSON'; i += 1) await page.keyboard.press('Shift+Tab');
      expect((await focused(page)).name).toBe('Signed report JSON');
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(signedText.replace('"auditEntries": "append-only, never deleted"', '"auditEntries": "deleted weekly"'));
      await tabUntil(page, (s) => s.role === 'button' && s.name === 'Verify');
      await page.keyboard.press('Enter');
      await expect(page.getByText('Not verified: its content or signature was changed after signing.')).toBeVisible();
      await shot(page, 'residency-verified');
    });
  } finally {
    await ctx.close();
  }
});
