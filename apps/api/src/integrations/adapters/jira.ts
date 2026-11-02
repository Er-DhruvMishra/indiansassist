/**
 * Jira (docs/specs/phase-e-contracts.md sections 4.3, 4.6): cloud uses REST v3 with basic `email:apiToken` and an
 * Atlassian Document Format body; data_center uses REST v2 with a personal access token and a plain-text body whose
 * wiki markup characters are escaped. Jira sets no priority field.
 */
import { jiraCloudCredentialsSchema, jiraDataCenterCredentialsSchema } from '@indiansassist/shared';
import type { AdapterCtx, AdapterResult, TicketingAdapter } from '../adapter.js';
import { basicAuth, fail, failure, oneLine, originOf, pick, toAdf, toJiraWiki, upstream } from '../http.js';

type Ctx = AdapterCtx<'jira'>;

/** An issue key (`ABC-123`) or a numeric issue id. */
const ISSUE = /^(?:[A-Z][A-Z0-9_]{1,9}-\d{1,12}|\d{1,18})$/;

type Api = { base: string; auth: string; cloud: boolean };

function apiOf(c: Ctx): Api | null {
  const site = originOf(c.config.siteUrl);
  if (c.config.deployment === 'cloud') {
    const cr = jiraCloudCredentialsSchema.safeParse(c.credentials);
    return cr.success ? { base: `${site}/rest/api/3`, auth: basicAuth(cr.data.email, cr.data.apiToken), cloud: true } : null;
  }
  const dc = jiraDataCenterCredentialsSchema.safeParse(c.credentials);
  return dc.success ? { base: `${site}/rest/api/2`, auth: `Bearer ${dc.data.personalAccessToken}`, cloud: false } : null;
}

const MISMATCH = 'the credentials do not match the deployment (cloud needs email and API token, data_center a personal access token)';

export function createJiraAdapter(): TicketingAdapter<'jira'> {
  const body = (api: Api, text: string) => (api.cloud ? toAdf(text) : toJiraWiki(text));
  const browse = (c: Ctx, key: string) => `${originOf(c.config.siteUrl)}/browse/${key}`;

  return {
    type: 'jira',

    test: async (c) => {
      const api = apiOf(c);
      if (!api) return fail('misconfigured', { detail: MISMATCH });
      const r = await upstream(c, { method: 'GET', url: `${api.base}/myself`, headers: { Authorization: api.auth } });
      if (!r.ok) return { ok: false, failure: r.failure };
      return { ok: true, status: r.res.status, value: { account: pick(r.res.json, 'displayName') ?? pick(r.res.json, 'name') } };
    },

    create: async (c, t) => {
      const api = apiOf(c);
      if (!api) return fail('misconfigured', { detail: MISMATCH });
      const r = await upstream(c, {
        method: 'POST',
        url: `${api.base}/issue`,
        headers: { Authorization: api.auth },
        json: {
          fields: {
            project: { key: c.config.projectKey },
            issuetype: { name: c.config.issueType },
            summary: oneLine(t.title),
            description: body(api, t.body),
            labels: c.config.labels,
          },
        },
      });
      if (!r.ok) return { ok: false, failure: r.failure };
      const key = pick(r.res.json, 'key');
      if (!key || !ISSUE.test(key)) return { ok: false, failure: failure('upstream_error', { status: r.res.status, sent: true, detail: 'answer without an issue key' }) };
      return { ok: true, status: r.res.status, value: { externalId: key, externalUrl: browse(c, key) } };
    },

    append: async (c, externalId, t): Promise<AdapterResult<{ externalId: string; externalUrl: string | null }>> => {
      const api = apiOf(c);
      if (!api) return fail('misconfigured', { detail: MISMATCH });
      if (!ISSUE.test(externalId)) return fail('validation', { detail: 'not a Jira issue key' });
      const r = await upstream(c, {
        method: 'POST',
        url: `${api.base}/issue/${externalId}/comment`,
        headers: { Authorization: api.auth },
        json: { body: body(api, t.body) },
      });
      if (!r.ok) return { ok: false, failure: r.failure };
      return { ok: true, status: r.res.status, value: { externalId, externalUrl: browse(c, externalId) } };
    },
  };
}
