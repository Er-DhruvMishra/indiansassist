// Phase F smoke flow "mail" (docs/specs/phase-f-contracts.md sections 4, 15.3), run by scripts/smoke-f.mjs against a
// running api that sends through this process's fake SMTP server (scripts/smoke/fake-smtp.mjs: 127.0.0.1 only, never
// relays). Start the api with
//
//   MAIL_DRIVER=smtp SMTP_URL=smtp://127.0.0.1:<E2E_SMTP_PORT> SMTP_REQUIRE_TLS=0
//
// (E2E_SMTP_PORT defaults to 2526, the mail stream's port in section 1.5). The flow: invite -> mail -> accept;
// resend -> the old link dies, the new one is mailed; reset -> mail -> confirm -> sign in with the new password (the
// old one refused, no session minted by the reset); an unknown address answered identically and mailed nothing.
// Every address is synthetic (`@e2e.example.com`).

import { ApiClient } from './http.mjs';
import { check, eq } from './runner.mjs';
import { findLink, startFakeSmtp } from './fake-smtp.mjs';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new smoke passphrase';
const INVITE_SUBJECT = 'Your invitation to IndiansAssist';
const RESET_SUBJECT = 'Reset your IndiansAssist password';

/** @param {import('./runner.mjs').Runner} run */
export async function flowSteps(run, ctx) {
  const { cfg } = ctx;
  const port = Number(process.env.E2E_SMTP_PORT || 2526);
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const client = () => new ApiClient(cfg.apiUrl, { origin: cfg.webOrigin, fetchImpl: ctx.fetchImpl });
  const s = {};
  let fake = null;

  try {
    await run.step('mail: fake SMTP listening on 127.0.0.1 only', async () => {
      fake = await startFakeSmtp({ port });
      eq(fake.host, '127.0.0.1', 'bind address');
      return fake.url;
    });

    await run.step('mail: GET /auth/options says reset and invite mail are on', async () => {
      const r = await ctx.api.request('GET', '/api/v1/auth/options');
      eq(r.status, 200, 'options');
      check(
        r.json?.passwordReset === true && r.json?.inviteMail === true,
        `options ${JSON.stringify(r.json)}: start the api with MAIL_DRIVER=smtp SMTP_URL=${fake.url} SMTP_REQUIRE_TLS=0`,
      );
    });

    await run.step('mail: an org_admin signs up', async () => {
      s.admin = client();
      s.adminEmail = `mail-admin-${tag}@e2e.example.com`;
      const r = await s.admin.request('POST', '/api/v1/auth/signup', {
        orgName: `Mail Smoke ${tag}`,
        name: 'Mail Admin',
        email: s.adminEmail,
        password: PASSWORD,
      });
      eq(r.status, 201, 'signup');
    });

    await run.step('mail: invite -> the mail arrives with the link -> accept', async () => {
      s.inviteeEmail = `mail-invitee-${tag}@e2e.example.com`;
      const r = await s.admin.request('POST', '/api/v1/users/invite', { email: s.inviteeEmail, name: 'Mail Invitee', role: 'technician' });
      eq(r.status, 201, 'invite');
      eq(r.json.mailed, true, 'mailed');
      check(typeof r.json.user.inviteMailedAt === 'string', 'inviteMailedAt set');
      const m = await fake.waitFor((x) => x.to.includes(s.inviteeEmail) && x.subject === INVITE_SUBJECT, cfg.timeoutMs * 2);
      check(!/text\/html/i.test(m.raw), 'plain text only');
      const link = findLink(m.text, '/invite#i=');
      eq(link, r.json.inviteUrl, 'the mailed link is the reply link');
      const invitee = client();
      const acc = await invitee.request('POST', '/api/v1/auth/accept-invite', { invite: new URL(link).hash.slice(3), name: 'Mail Invitee', password: PASSWORD });
      eq(acc.status, 200, 'accept-invite');
      return `${fake.messages.length} mail(s) recorded`;
    });

    await run.step('mail: resend rotates the secret; the old link stops working', async () => {
      const email = `mail-resend-${tag}@e2e.example.com`;
      const r = await s.admin.request('POST', '/api/v1/users/invite', { email, name: 'Mail Resend', role: 'technician', sendEmail: false });
      eq(r.status, 201, 'invite without mail');
      eq(r.json.mailed, false, 'not mailed');
      const res = await s.admin.request('POST', `/api/v1/users/${r.json.user.id}/invite/resend`, {});
      eq(res.status, 200, 'resend');
      eq(res.json.mailed, true, 'resend mailed');
      check(res.json.inviteUrl !== r.json.inviteUrl, 'a new link');
      const m = await fake.waitFor((x) => x.to.includes(email), cfg.timeoutMs * 2);
      eq(findLink(m.text, '/invite#i='), res.json.inviteUrl, 'the mailed link is the new one');
      const stale = await client().request('POST', '/api/v1/auth/accept-invite', { invite: new URL(r.json.inviteUrl).hash.slice(3), name: 'X', password: PASSWORD });
      eq(stale.status, 401, 'old link refused');
    });

    await run.step('mail: reset requests answer 202 {} for a known and an unknown address alike', async () => {
      const known = await client().request('POST', '/api/v1/auth/password-reset/request', { email: s.inviteeEmail });
      const unknown = await client().request('POST', '/api/v1/auth/password-reset/request', { email: `nobody-${tag}@e2e.example.com` });
      eq(known.status, 202, 'known');
      eq(unknown.status, 202, 'unknown');
      eq(known.text, unknown.text, 'same body');
      eq(known.text, '{}', 'empty object');
    });

    await run.step('mail: reset mail -> confirm -> sign in with the new password', async () => {
      const m = await fake.waitFor((x) => x.to.includes(s.inviteeEmail) && x.subject === RESET_SUBJECT, cfg.timeoutMs * 2);
      const link = findLink(m.text, '/reset#t=');
      check(link !== null, 'a /reset#t= link in the mail');
      const token = new URL(link).hash.slice(3);
      check(/^[A-Za-z0-9_-]{43}$/.test(token), 'a 43-character token');
      const c = client();
      const r = await c.request('POST', '/api/v1/auth/password-reset/confirm', { token, newPassword: NEW_PASSWORD });
      eq(r.status, 204, 'confirm');
      check(c.cookie === null, 'no session minted by the reset');
      const again = await client().request('POST', '/api/v1/auth/password-reset/confirm', { token, newPassword: 'yet another passphrase' });
      eq(again.status, 400, 'single use');
      eq(again.json?.error?.code, 'reset_invalid', 'reset_invalid');
      const old = await client().request('POST', '/api/v1/auth/login', { email: s.inviteeEmail, password: PASSWORD });
      eq(old.status, 401, 'old password refused');
      const fresh = await client().request('POST', '/api/v1/auth/login', { email: s.inviteeEmail, password: NEW_PASSWORD });
      eq(fresh.status, 200, 'new password accepted');
    });

    await run.step('mail: the unknown address was mailed nothing', async () => {
      await new Promise((r) => setTimeout(r, 300));
      eq(fake.to(`nobody-${tag}@e2e.example.com`).length, 0, 'mails to the unknown address');
    });
  } finally {
    await fake?.close();
  }
}
