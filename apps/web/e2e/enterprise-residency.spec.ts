/**
 * Phase E residency end-to-end (docs/specs/phase-e-contracts.md sections 6.4, 11 "Accessibility", 15.5), with the
 * Phase F print rule (docs/specs/phase-f-contracts.md section 3.2): the signed data residency page of the heaviest
 * report the contract names (10 data flows, a 200-character storage detail, SSO with 5 verified domains, the AI
 * acknowledgement, the erasure block in its `cooling_off` state, a 100-character org name) prints on ONE A4 page with
 * at least 15 mm of free height, measured, and the printed page carries the full public key; the "Verify a report"
 * panel verifies the org's real signed report from the keyboard alone.
 *
 * The report is seeded by intercepting the page's `GET /orgs/current/residency` and filling the real signed report up
 * to ten flows of the kinds an org configures (an AI provider with its acknowledgement, ticketing systems, webhooks,
 * an IdP, a vault, a mail relay), plus the other heavy fields above: the routes that configure those flows belong to
 * other streams, and the e2e api's environment is fixed by playwright.config.ts. The page renders the report as
 * given; the verification step uses the real, unmodified signed JSON from `signed.json`.
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
type Store = { kind: string; region: string; detail: string };

const AT = '2026-10-30T08:15:00.000Z';
/** Section 3.2a: the report the print must hold. */
const FLOW_TOTAL = 10;
const ORG_NAME = 'E2E Residency Org with a deliberately long registered name that fills the header line of the printed';
const LONG_DETAIL =
  'fs storage on the regional volume /srv/indiansassist/region-in-mum/objects, encrypted at rest with the volume key, replicated within the region only, prefix in-mum/org/recordings, lifecycle by policy.';
const SSO_DOMAINS = ['acme-e2e.example', 'support.acme-e2e.example', 'it.acme-e2e.example', 'eu.acme-e2e.example', 'acme-e2e-holdings.example'];
/** The section 5.7 note, the longest erasure text. */
const ERASURE_NOTE =
  "Erasure destroys this organisation's personal data and the audit pepper after two administrators approve it and a 7-day cooling-off period (an organisation with a single administrator: a mailed confirmation and a 14-day cooling-off period). Technician display names and typed reasons stay in the audit chain.";
/** Section 3.2b: A4 portrait less the 12 mm margins is 186 x 273 mm; the report may use at most 273 - 15 mm. */
const PX_PER_MM = 96 / 25.4;
const PRINTABLE_MM = 273;
const MAX_REPORT_MM = PRINTABLE_MM - 15;

const ticketing = (name: string, host: string, enabled = true, leavesRegion = 'unknown'): Flow => ({
  kind: 'ticketing',
  name,
  host,
  leavesInfrastructure: true,
  leavesRegion,
  dataSent: 'session summary or note, with a link to the session',
  enabled,
  since: enabled ? AT : null,
  enabledBy: enabled ? 'Asha Admin' : null,
  acknowledgement: null,
});

const ORG_FLOWS: Flow[] = [
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
  ticketing('Jira Cloud', 'acme-e2e.atlassian.example'),
  ticketing('ServiceNow', 'acme-e2e.service-now.example'),
  ticketing('Freshdesk', 'acme-e2e.freshdesk.com', false),
  ticketing('Zoho Desk (in data centre)', 'desk.zoho.in', true, 'no'),
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
  {
    kind: 'vault',
    name: 'HashiCorp Vault',
    host: 'vault.acme-e2e.example',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: 'credential look-ups for playbooks; no session data',
    enabled: true,
    since: AT,
    enabledBy: 'Asha Admin',
    acknowledgement: null,
  },
  {
    kind: 'mail',
    name: 'SMTP relay',
    host: 'smtp.acme-e2e.example',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: 'invite, password reset and notice mails: the address, name and link',
    enabled: true,
    since: AT,
    enabledBy: 'Asha Admin',
    acknowledgement: null,
  },
  {
    kind: 'webhook',
    name: 'Webhook (second receiver)',
    host: 'hooks-dr.acme-e2e.example',
    leavesInfrastructure: true,
    leavesRegion: 'unknown',
    dataSent: 'signed JSON: session summary or note, with a link',
    enabled: false,
    since: null,
    enabledBy: null,
    acknowledgement: null,
  },
];

/** Counts the page objects of a PDF (`/Type /Page`, not `/Type /Pages`). */
function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

test('Phase E/F residency: the heaviest report prints on one A4 page with 15 mm free and the full public key; a report verifies from the keyboard', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  captureConsole(page, 'residency');
  let signedText = '';
  let pub = '';
  let flowCount = 0;
  const flowsCard = page.locator('section', { has: page.getByRole('heading', { name: 'Data that leaves the region' }) });

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

    await test.step('the real signed report is fetched; the screen route is seeded with the section 3.2a report', async () => {
      const signed = await page.request.get(`${API}/api/v1/orgs/current/residency/signed.json`, { headers: HEADERS });
      expect(signed.status(), await signed.text()).toBe(200);
      expect(signed.headers()['content-disposition']).toMatch(/^attachment; filename="residency-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.json"$/);
      signedText = await signed.text();
      const real = JSON.parse(signedText) as Record<string, unknown> & {
        dataFlows: Flow[];
        statement: string;
        signature: { pub: string };
        org: Record<string, unknown>;
        dataCategories: { category: string; stores: Store[] }[];
      };
      pub = real.signature.pub;
      expect(pub).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Exactly ten flows: the e2e api's own (operator) flows, filled up with org flows.
      expect(real.dataFlows.length).toBeLessThan(FLOW_TOTAL);
      const flows = [...ORG_FLOWS.slice(0, FLOW_TOTAL - real.dataFlows.length), ...real.dataFlows];
      flowCount = flows.length;
      expect(flowCount).toBe(FLOW_TOTAL);
      // One storage detail of 200 characters, on the first object store (else added to the first category).
      expect(LONG_DETAIL.length).toBe(200);
      expect(ORG_NAME.length).toBe(100);
      let longSet = false;
      const dataCategories = real.dataCategories.map((c) => ({
        ...c,
        stores: c.stores.map((st) => {
          if (longSet || st.kind !== 'object_store') return st;
          longSet = true;
          return { ...st, detail: LONG_DETAIL };
        }),
      }));
      if (!longSet) dataCategories[0]!.stores = [{ kind: 'object_store', region: 'in-mum', detail: LONG_DETAIL }, ...dataCategories[0]!.stores];
      const seeded = {
        ...real,
        org: { ...real.org, name: ORG_NAME },
        dataFlows: flows,
        dataCategories,
        subprocessors: [...new Set(flows.filter((f) => f.enabled && f.leavesInfrastructure).map((f) => f.name))],
        sso: { protocol: 'oidc', enabled: true, required: true, verifiedDomains: SSO_DOMAINS },
        erasure: { available: true, state: 'cooling_off', scheduledFor: '2026-11-09T08:15:00.000Z', note: ERASURE_NOTE },
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

    await test.step('the residency page shows all ten flows and every heavy field, in words', async () => {
      await page.goto('/app/residency');
      await expect(flowsCard.getByRole('row')).toHaveCount(1 + flowCount);
      await expect(flowsCard.getByText('Leaves the region', { exact: true })).toBeVisible();
      await expect(flowsCard.getByText('Configured, disabled', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Where your data lives' })).toBeVisible();
      await expect(page.getByText(pub)).toBeVisible();
      await expect(page.getByText(LONG_DETAIL, { exact: false })).toBeVisible();
      await expect(page.getByText(ORG_NAME, { exact: false })).toBeVisible();
      await expect(page.getByText(SSO_DOMAINS.join(', '), { exact: false })).toBeVisible();
      await expect(page.getByTestId('residency-erasure')).toBeVisible();
      await shot(page, 'residency-screen');
    });

    await test.step('print: at least 15 mm free on one A4 page, measured, with the full public key (section 3.2)', async () => {
      await page.emulateMedia({ media: 'print' });
      // The printable box of A4 portrait with 12 mm margins: 186 x 273 mm (703 x 1032 CSS px).
      await page.setViewportSize({ width: Math.round(186 * PX_PER_MM), height: Math.round(PRINTABLE_MM * PX_PER_MM) });
      const key = page.getByText(pub, { exact: true });
      await expect(key).toBeVisible();
      expect((await key.textContent())?.trim()).toBe(pub);
      // The key wraps rather than being clipped: its box lies inside the printable width.
      const fits = await key.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= document.documentElement.clientWidth + 1);
      expect(fits, 'the public key is not clipped in the print layout').toBe(true);
      for (const name of ['Print', 'Download signed JSON', 'Verify a report']) await expect(page.getByRole('button', { name })).toBeHidden();
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
      // Rule 3.2c: no field is dropped from the print (the flows print as two columns of blocks, so they are counted
      // as elements rather than table rows), and states stay in words.
      const printedFlows = flowsCard.locator('tbody tr');
      await expect(printedFlows).toHaveCount(flowCount);
      for (let i = 0; i < flowCount; i += 1) await expect(printedFlows.nth(i)).toBeVisible();
      await expect(flowsCard.getByText('Leaves the region', { exact: true })).toBeVisible();
      await expect(flowsCard.getByText('Data sent:', { exact: false }).first()).toBeVisible();
      await expect(page.getByText(LONG_DETAIL, { exact: false })).toBeVisible();
      await expect(page.getByText(ORG_NAME, { exact: false })).toBeVisible();
      await expect(page.getByText(SSO_DOMAINS.join(', '), { exact: false })).toBeVisible();
      await expect(page.getByText('Acknowledged (outside the region) by Asha Admin', { exact: false })).toBeVisible();
      // Rule 3.2b2: the erasure block keeps its fixed print budget.
      const erasure = await page.getByTestId('residency-erasure').boundingBox();
      expect(erasure, 'the erasure block is laid out').not.toBeNull();
      expect(erasure!.height / PX_PER_MM, 'the erasure block stays within its 12 mm budget').toBeLessThanOrEqual(12.05);
      // Rule 3.2b: the report's height, measured, is at most 273 - 15 mm.
      const box = await page.locator('.residency-report').boundingBox();
      expect(box, 'the report is laid out').not.toBeNull();
      const usedMm = box!.height / PX_PER_MM;
      const freeMm = PRINTABLE_MM - usedMm;
      // For the record: each block's printed height, so a regression points at its block.
      const blocks = await page.locator('.residency-report').evaluate((el, pxPerMm) => {
        const out: Record<string, number> = {};
        for (const b of Array.from(el.querySelectorAll(':scope > *, :scope > div > *'))) {
          const h = (b as HTMLElement).getBoundingClientRect().height;
          if (h === 0) continue;
          const name = b.querySelector('h1, h2')?.textContent?.trim() || b.className.split(' ')[0] || b.tagName;
          out[name] = Math.round((h / pxPerMm) * 10) / 10;
        }
        return out;
      }, PX_PER_MM);
      writeFileSync(
        join(ARTIFACTS, 'residency-print-measure.json'),
        JSON.stringify({ usedMm: Number(usedMm.toFixed(1)), freeMm: Number(freeMm.toFixed(1)), flows: flowCount, blocks }, null, 2),
      );
      await shot(page, 'residency-print-layout');
      expect(usedMm, `the print uses ${usedMm.toFixed(1)} mm of ${PRINTABLE_MM} mm, leaving ${freeMm.toFixed(1)} mm free (15 mm required)`).toBeLessThanOrEqual(
        MAX_REPORT_MM,
      );
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: false });
      writeFileSync(join(ARTIFACTS, 'residency-print.pdf'), pdf);
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // Every page is A4 portrait: Chromium writes a MediaBox of about 595 x 842 points.
      const boxes = [...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(boxes.length).toBeGreaterThan(0);
      for (const [w, h] of boxes) expect(Math.abs(w! - 595) < 1.5 && Math.abs(h! - 842) < 1.5, `A4 portrait MediaBox, got ${w} x ${h}`).toBe(true);
      expect(pdfPageCount(pdf), `the report prints on one A4 page (${usedMm.toFixed(1)} mm used)`).toBe(1);
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
