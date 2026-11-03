/**
 * /app/settings/integrations (docs/specs/phase-e-contracts.md sections 4.2, 4.7, 13.4, stream tickets): one card per
 * ticketing type with its configuration form, write-only credentials (shown only as set / not set with a fingerprint),
 * Test, the enable switch and Delete. The webhook card shows its signing secret exactly once, after create or rotate,
 * with a verification snippet. Auditors see the same cards read-only. States are words, results are announced in a
 * live region (section 11).
 */
import { useId, useState, type FormEvent } from 'react';
import { INTEGRATION_TYPES, INTEGRATION_VERIFICATION, ZOHO_DATA_CENTERS, type Integration, type IntegrationType } from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { CopyButton } from '../../components/CopyButton';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { errorMessage, isApiError } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { CAUSE_WORDS, integrationsApi, TYPE_LABELS, type IntegrationTestReply } from './api';

type FieldDef = {
  key: string;
  label: string;
  kind?: 'text' | 'email' | 'url' | 'select';
  options?: { value: string; label: string }[];
  hint?: string;
  optional?: boolean;
  /** Jira only: shown for one deployment. */
  when?: (v: Record<string, string>) => boolean;
};

const PRIORITY_NONE = { value: '', label: 'Not set' };

const CONFIG_FIELDS: Record<IntegrationType, FieldDef[]> = {
  zoho_desk: [
    { key: 'dataCenter', label: 'Data centre', kind: 'select', options: ZOHO_DATA_CENTERS.map((d) => ({ value: d.id, label: `${d.id} (${d.deskHost})` })) },
    { key: 'orgId', label: 'Zoho organisation id', hint: 'Digits only.' },
    { key: 'departmentId', label: 'Department id', hint: 'Digits only.' },
    { key: 'defaultContactEmail', label: 'Default contact email', kind: 'email' },
    {
      key: 'priority',
      label: 'Default priority',
      kind: 'select',
      optional: true,
      options: [PRIORITY_NONE, ...['Low', 'Medium', 'High', 'Urgent'].map((p) => ({ value: p, label: p }))],
    },
  ],
  servicenow: [
    { key: 'instanceUrl', label: 'Instance URL', kind: 'url', hint: 'The origin only, for example https://acme.service-now.com' },
    { key: 'callerId', label: 'Caller sys_id', optional: true, hint: '32 hex characters, optional.' },
    { key: 'assignmentGroup', label: 'Assignment group sys_id', optional: true, hint: '32 hex characters, optional.' },
    { key: 'urgency', label: 'Default urgency', kind: 'select', optional: true, options: [PRIORITY_NONE, { value: '1', label: '1 (high)' }, { value: '2', label: '2 (medium)' }, { value: '3', label: '3 (low)' }] },
  ],
  jira: [
    { key: 'siteUrl', label: 'Site URL', kind: 'url', hint: 'The origin only, for example https://acme.atlassian.net' },
    { key: 'deployment', label: 'Deployment', kind: 'select', options: [{ value: 'cloud', label: 'Cloud' }, { value: 'data_center', label: 'Data Center' }] },
    { key: 'projectKey', label: 'Project key', hint: 'For example OPS.' },
    { key: 'issueType', label: 'Issue type', optional: true, hint: 'Default Task.' },
    { key: 'labels', label: 'Labels', optional: true, hint: 'Comma separated, no spaces inside a label, at most 10.' },
  ],
  freshdesk: [
    { key: 'domain', label: 'Freshdesk subdomain', hint: 'The <subdomain>.freshdesk.com part.' },
    { key: 'defaultRequesterEmail', label: 'Default requester email', kind: 'email' },
    { key: 'priority', label: 'Default priority', kind: 'select', options: [{ value: '1', label: 'Low' }, { value: '2', label: 'Medium' }, { value: '3', label: 'High' }, { value: '4', label: 'Urgent' }] },
    { key: 'groupId', label: 'Group id', optional: true, hint: 'Optional, digits only.' },
  ],
  webhook: [
    {
      key: 'url',
      label: 'Webhook URL',
      kind: 'url',
      hint: 'The full URL is stored sealed, because it may carry a secret in its path or query; only its origin is shown again. Enter it again to change any setting.',
    },
  ],
};

const CREDENTIAL_FIELDS: Record<IntegrationType, FieldDef[]> = {
  zoho_desk: [
    { key: 'clientId', label: 'Client id' },
    { key: 'clientSecret', label: 'Client secret' },
    { key: 'refreshToken', label: 'Refresh token' },
  ],
  servicenow: [
    { key: 'username', label: 'User name' },
    { key: 'password', label: 'Password' },
  ],
  jira: [
    { key: 'email', label: 'Account email', when: (v) => v['deployment'] !== 'data_center' },
    { key: 'apiToken', label: 'API token', when: (v) => v['deployment'] !== 'data_center' },
    { key: 'personalAccessToken', label: 'Personal access token', when: (v) => v['deployment'] === 'data_center' },
  ],
  freshdesk: [{ key: 'apiKey', label: 'API key' }],
  webhook: [],
};

function initialValues(type: IntegrationType, i: Integration | undefined): Record<string, string> {
  const c = (i?.config ?? {}) as Record<string, unknown>;
  const s = (k: string, d = '') => (c[k] === null || c[k] === undefined ? d : String(c[k]));
  switch (type) {
    case 'zoho_desk':
      return { dataCenter: s('dataCenter', ZOHO_DATA_CENTERS[0]?.id ?? ''), orgId: s('orgId'), departmentId: s('departmentId'), defaultContactEmail: s('defaultContactEmail'), priority: s('priority') };
    case 'servicenow':
      return { instanceUrl: s('instanceUrl'), callerId: s('callerId'), assignmentGroup: s('assignmentGroup'), urgency: s('urgency') };
    case 'jira':
      return { siteUrl: s('siteUrl'), deployment: s('deployment', 'cloud'), projectKey: s('projectKey'), issueType: s('issueType', 'Task'), labels: Array.isArray(c['labels']) ? (c['labels'] as string[]).join(', ') : '' };
    case 'freshdesk':
      return { domain: s('domain'), defaultRequesterEmail: s('defaultRequesterEmail'), priority: s('priority', '2'), groupId: s('groupId') };
    case 'webhook':
      return { url: '' };
  }
}

const orNull = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null);

/** The written config of a type from the form strings (the server validates it again). */
export function configOf(type: IntegrationType, v: Record<string, string>): Record<string, unknown> {
  switch (type) {
    case 'zoho_desk':
      return { dataCenter: v['dataCenter'] ?? '', orgId: v['orgId']?.trim() ?? '', departmentId: v['departmentId']?.trim() ?? '', defaultContactEmail: v['defaultContactEmail']?.trim() ?? '', priority: orNull(v['priority']) };
    case 'servicenow':
      return { instanceUrl: v['instanceUrl']?.trim() ?? '', callerId: orNull(v['callerId']), assignmentGroup: orNull(v['assignmentGroup']), urgency: v['urgency'] ? Number(v['urgency']) : null };
    case 'jira':
      return {
        siteUrl: v['siteUrl']?.trim() ?? '',
        deployment: v['deployment'] === 'data_center' ? 'data_center' : 'cloud',
        projectKey: v['projectKey']?.trim() ?? '',
        issueType: orNull(v['issueType']) ?? 'Task',
        labels: (v['labels'] ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      };
    case 'freshdesk':
      return { domain: v['domain']?.trim() ?? '', defaultRequesterEmail: v['defaultRequesterEmail']?.trim() ?? '', priority: Number(v['priority'] ?? '2'), groupId: orNull(v['groupId']) === null ? null : Number(v['groupId']) };
    case 'webhook':
      return { url: v['url']?.trim() ?? '' };
  }
}

/** The receiver-side check a webhook owner pastes (section 4.5). */
export const WEBHOOK_VERIFY_SNIPPET = `// Node.js: verify an IndiansAssist webhook delivery
const crypto = require('node:crypto');
function verify(secret, signatureHeader, timestamp, rawBody) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // refuse stale deliveries
  const key = Buffer.from(secret, 'base64url'); // the 32 decoded bytes, not the string
  const mac = crypto.createHmac('sha256', key).update(timestamp + '.').update(rawBody).digest('hex');
  return signatureHeader.split(',').map((s) => s.trim()).some((v) =>
    v.startsWith('v1=') && v.length === 67 && crypto.timingSafeEqual(Buffer.from(v.slice(3)), Buffer.from(mac)));
}
// De-duplicate on the X-IA-Push-Id header: a retry carries the same id.`;

function SecretOnce({ secret }: { secret: string }) {
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
      <p className="text-sm font-medium">Signing secret, shown only now. Store it in the receiver before closing this page.</p>
      <code className="break-all rounded bg-white px-2 py-1 font-mono text-sm dark:bg-slate-950" data-testid="webhook-secret">
        {secret}
      </code>
      <CopyButton text={secret} label="Copy secret" size="sm" variant="secondary" />
      <details>
        <summary className="cursor-pointer text-sm font-medium">How the receiver verifies a delivery</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-white p-2 text-xs dark:bg-slate-950">{WEBHOOK_VERIFY_SNIPPET}</pre>
      </details>
    </div>
  );
}

function StatusLine({ integration }: { integration: Integration | undefined }) {
  if (!integration) return <Badge>Not configured</Badge>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone={integration.enabled ? 'green' : 'neutral'}>{integration.enabled ? 'Enabled' : 'Disabled'}</Badge>
      <Badge tone="amber">Leaves the region when used</Badge>
    </span>
  );
}

/** Whose documentation each vendor type was checked against (Phase F section 3.3 V5). */
const VENDOR_NAMES: Record<Exclude<IntegrationType, 'webhook'>, string> = {
  zoho_desk: 'Zoho',
  servicenow: 'ServiceNow',
  jira: 'Atlassian',
  freshdesk: 'Freshdesk',
};

/**
 * Phase F section 3.3 V5: a type whose request format is not fully verified against the vendor's documentation stays
 * usable, and its card says so and lists the unconfirmed items. `Test` remains the operational gate.
 */
export function UnverifiedNote({ type }: { type: IntegrationType }) {
  if (type === 'webhook') return null;
  const v = INTEGRATION_VERIFICATION[type];
  if (v.verified) return null;
  const n = v.unconfirmed.length;
  return (
    <div role="note" className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <p>
        This request format has not been fully verified against {VENDOR_NAMES[type]}&apos;s documentation ({n} {n === 1 ? 'item' : 'items'}). Use Test before relying on it.
      </p>
      {n > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {v.unconfirmed.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IntegrationCard({ type, integration, canAdmin, onChanged }: { type: IntegrationType; integration: Integration | undefined; canAdmin: boolean; onChanged: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(type, integration));
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<boolean>(integration?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'green' | 'red' | 'blue'; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const enabledId = useId();
  const label = TYPE_LABELS[type];
  const zohoUnavailable = type === 'zoho_desk' && ZOHO_DATA_CENTERS.length === 0;
  const credFields = CREDENTIAL_FIELDS[type].filter((f) => !f.when || f.when(values));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const filled = credFields.filter((f) => (creds[f.key] ?? '') !== '');
      const credentials = type !== 'webhook' && filled.length > 0 ? Object.fromEntries(credFields.map((f) => [f.key, creds[f.key] ?? ''])) : undefined;
      const res = await integrationsApi.save(type, { enabled, config: configOf(type, values), ...(credentials ? { credentials } : {}) });
      if (res.secret) setSecret(res.secret);
      setCreds({});
      setMessage({ tone: 'green', text: `${label} saved.` });
      onChanged();
    } catch (err) {
      const cause = isApiError(err, 'egress_refused') ? ` (${String(err.details?.['cause'] ?? 'refused')})` : '';
      setMessage({ tone: 'red', text: `${label} was not saved: ${errorMessage(err)}${cause}` });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r: IntegrationTestReply = await integrationsApi.test(type);
      setMessage(
        r.ok
          ? { tone: 'green', text: `Test passed${r.account ? ` (account: ${r.account})` : ''}.` }
          : { tone: 'red', text: `Test failed: ${r.cause ? CAUSE_WORDS[r.cause] : 'unknown'}${r.detail ? ` (${r.detail})` : ''}.` },
      );
      onChanged();
    } catch (err) {
      setMessage({ tone: 'red', text: `Test failed: ${errorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await integrationsApi.remove(type);
      setConfirmDelete(false);
      setSecret(null);
      setValues(initialValues(type, undefined));
      setMessage({ tone: 'blue', text: `${label} deleted.` });
      onChanged();
    } catch (err) {
      setMessage({ tone: 'red', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await integrationsApi.rotateWebhookSecret();
      setSecret(r.secret);
      setMessage({ tone: 'green', text: 'New secret issued. The previous secret keeps signing as a second signature for 24 hours.' });
      onChanged();
    } catch (err) {
      setMessage({ tone: 'red', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const disabled = !canAdmin || busy;
  return (
    <Card title={label} actions={<StatusLine integration={integration} />}>
      {integration && (
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {type === 'webhook' && (
            <>
              <dt className="font-medium">Origin</dt>
              <dd>
                {String((integration.config as { origin?: string }).origin ?? '')}
                {(integration.config as { pathSet?: boolean }).pathSet ? ' (path and query sealed)' : ''}
              </dd>
            </>
          )}
          <dt className="font-medium">{type === 'webhook' ? 'Signing secret' : 'Credentials'}</dt>
          <dd>
            {integration.credentials.set
              ? `Set${integration.credentials.fingerprint ? `, fingerprint ${integration.credentials.fingerprint}` : ''}${integration.credentials.setAt ? `, ${fmtDateTime(integration.credentials.setAt)}` : ''}`
              : 'Not set'}
          </dd>
          <dt className="font-medium">Last test</dt>
          <dd>
            {integration.lastTest
              ? `${integration.lastTest.ok ? 'Passed' : `Failed (${integration.lastTest.cause ? CAUSE_WORDS[integration.lastTest.cause] : 'unknown'})`}, ${fmtDateTime(integration.lastTest.at)}`
              : 'Never tested'}
          </dd>
          <dt className="font-medium">Updated</dt>
          <dd>
            {fmtDateTime(integration.updatedAt)}
            {integration.updatedBy ? ` by ${integration.updatedBy.name}` : ''}
          </dd>
        </dl>
      )}
      <UnverifiedNote type={type} />
      {zohoUnavailable && (
        <Alert tone="amber">Zoho Desk cannot be configured on this server yet: no Zoho data centre has been verified for it.</Alert>
      )}
      {canAdmin && !zohoUnavailable && (
        <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)} aria-label={`${label} settings`}>
          {CONFIG_FIELDS[type]
            .filter((f) => !f.when || f.when(values))
            .map((f) => (
              <Field key={f.key} label={f.optional ? `${f.label} (optional)` : f.label} hint={f.hint}>
                {({ id, describedBy }) =>
                  f.kind === 'select' ? (
                    <Select id={id} aria-describedby={describedBy} value={values[f.key] ?? ''} disabled={disabled} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      type={f.kind === 'email' ? 'email' : f.kind === 'url' ? 'url' : 'text'}
                      required={!f.optional}
                      value={values[f.key] ?? ''}
                      disabled={disabled}
                      placeholder={type === 'webhook' && integration ? `${String((integration.config as { origin?: string }).origin ?? '')}/...` : undefined}
                      onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    />
                  )
                }
              </Field>
            ))}
          {credFields.length > 0 && (
            <fieldset className="flex flex-col gap-3 rounded-md border border-slate-300 p-3 dark:border-slate-700">
              <legend className="px-1 text-sm font-medium">Credentials (write-only)</legend>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {integration?.credentials.set ? 'Saved credentials are never shown. Leave these blank to keep them.' : 'Stored sealed; never shown again after saving.'}
              </p>
              {credFields.map((f) => (
                <Field key={f.key} label={f.label}>
                  {({ id }) => (
                    <Input id={id} type="password" autoComplete="new-password" value={creds[f.key] ?? ''} disabled={disabled} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} />
                  )}
                </Field>
              ))}
            </fieldset>
          )}
          <div className="flex items-center gap-2">
            <input id={enabledId} type="checkbox" className="h-4 w-4" checked={enabled} disabled={disabled} onChange={(e) => setEnabled(e.target.checked)} />
            <label htmlFor={enabledId} className="text-sm">
              Enabled (technicians may push tickets to {label})
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={disabled}>
              Save {label}
            </Button>
            {integration && (
              <Button variant="secondary" disabled={disabled} onClick={() => void test()}>
                Test {label}
              </Button>
            )}
            {integration && type === 'webhook' && (
              <Button variant="secondary" disabled={disabled} onClick={() => void rotate()}>
                Rotate secret
              </Button>
            )}
            {integration && !confirmDelete && (
              <Button variant="ghost" disabled={disabled} onClick={() => setConfirmDelete(true)}>
                Delete {label}
              </Button>
            )}
          </div>
          {confirmDelete && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-300 p-2 text-sm dark:border-red-800">
              <span>Delete {label}? Pushes still pending or retrying will fail.</span>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>
                Confirm delete
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
            </div>
          )}
        </form>
      )}
      <div aria-live="polite" className="mt-2">
        {message && <p className={message.tone === 'red' ? 'text-sm font-medium text-red-700 dark:text-red-400' : 'text-sm'}>{message.text}</p>}
      </div>
      {secret && <SecretOnce secret={secret} />}
    </Card>
  );
}

export function IntegrationsPage() {
  usePageTitle('Integrations');
  const { me } = useAuth();
  const canAdmin = can(me?.user.role, 'integrations.admin');
  const list = useAsync(() => integrationsApi.list(), []);
  const byType = new Map((list.data?.items ?? []).map((i) => [i.type, i]));
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Integrations" />
      <p className="text-sm text-slate-700 dark:text-slate-300">
        Push session notes and AI summaries into your ticketing system. Each enabled integration sends the ticket text a technician pushes outside
        this region; it is listed on the data residency report.
      </p>
      {list.loading && !list.data && <Spinner label="Loading integrations" />}
      {list.error !== null && <Alert>{errorMessage(list.error)}</Alert>}
      {list.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          {INTEGRATION_TYPES.map((type) => (
            <IntegrationCard key={type} type={type} integration={byType.get(type)} canAdmin={canAdmin} onChanged={list.reload} />
          ))}
        </div>
      )}
    </div>
  );
}
