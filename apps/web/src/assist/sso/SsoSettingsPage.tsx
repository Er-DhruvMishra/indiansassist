/**
 * /app/settings/sso (docs/specs/phase-e-contracts.md section 13.4, stream sso): protocol choice; OIDC or SAML fields
 * with the SP values to copy and the SP-key action; the client secret as a write-only field showing its SecretStatus;
 * JIT and role mapping; session lifetime; domains with the TXT record and a Verify button; the break-glass picker;
 * Test sign-in; and the SSO-required switch, disabled with the missing list until ready. Auditors read it; only
 * org_admins change it. States are in words, and results are announced in live regions (section 11).
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import {
  JIT_ROLES,
  PACKAGE_TIERS,
  SAML_NAMEID_FORMATS,
  type JitRole,
  type PackageTier,
  type SamlNameIdFormat,
  type SecretStatus,
  type SsoConfig,
  type SsoDomain,
  type SsoProtocol,
  type SsoSettings,
  type UserWithSeat,
} from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { CopyButton } from '../../components/CopyButton';
import { Dialog } from '../../components/Dialog';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { errorMessage, isApiError } from '../../lib/api';
import { usersApi } from '../../lib/endpoints';
import { fmtDateTime, fmtRoleName, fmtTier } from '../../lib/format';
import { navigateWithOriginReferrer } from './SsoContinueLink';
import { beginHref, ssoApi, ssoErrorText } from './ssoApi';

// ---------- the form model ----------

type Model = {
  protocol: SsoProtocol;
  enabled: boolean;
  displayName: string;
  sessionMaxAgeHours: string;
  issuer: string;
  clientId: string;
  tokenEndpointAuth: 'client_secret_basic' | 'client_secret_post' | 'none';
  scopes: string;
  emailClaim: string;
  nameClaim: string;
  groupsClaim: string;
  requiredClaims: string;
  idpEntityId: string;
  ssoUrl: string;
  idpCertificates: string;
  nameIdFormat: SamlNameIdFormat;
  emailAttribute: string;
  nameAttribute: string;
  groupsAttribute: string;
  signAuthnRequests: boolean;
  wantResponseSigned: boolean;
  clockSkewSec: string;
  jitEnabled: boolean;
  defaultRole: JitRole;
  defaultSeatTier: PackageTier;
  groupRoles: string;
};

export function modelFrom(cfg: SsoConfig | null): Model {
  const o = cfg?.oidc;
  const s = cfg?.saml;
  return {
    protocol: cfg?.protocol ?? 'oidc',
    enabled: cfg?.enabled ?? false,
    displayName: cfg?.displayName ?? '',
    sessionMaxAgeHours: String(cfg?.sessionMaxAgeHours ?? 12),
    issuer: o?.issuer ?? '',
    clientId: o?.clientId ?? '',
    tokenEndpointAuth: o?.tokenEndpointAuth ?? 'client_secret_basic',
    scopes: (o?.scopes ?? ['openid', 'email', 'profile']).join(' '),
    emailClaim: o?.emailClaim ?? 'email',
    nameClaim: o?.nameClaim ?? 'name',
    groupsClaim: o?.groupsClaim ?? '',
    requiredClaims: (o?.requiredClaims ?? []).map((c) => `${c.name}=${c.values.join(',')}`).join('\n'),
    idpEntityId: s?.idpEntityId ?? '',
    ssoUrl: s?.ssoUrl ?? '',
    idpCertificates: (s?.idpCertificates ?? []).join('\n'),
    nameIdFormat: s?.nameIdFormat ?? 'email',
    emailAttribute: s?.emailAttribute ?? '',
    nameAttribute: s?.nameAttribute ?? '',
    groupsAttribute: s?.groupsAttribute ?? '',
    signAuthnRequests: s?.signAuthnRequests ?? false,
    wantResponseSigned: s?.wantResponseSigned ?? false,
    clockSkewSec: String(s?.clockSkewSec ?? 120),
    jitEnabled: cfg?.jit.enabled ?? false,
    defaultRole: cfg?.jit.defaultRole ?? 'technician',
    defaultSeatTier: cfg?.jit.defaultSeatTier ?? 'p1_browser',
    groupRoles: (cfg?.jit.groupRoles ?? []).map((g) => `${g.group}=${g.role}`).join('\n'),
  };
}

const lines = (v: string) =>
  v
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** The model as an `SsoConfig` (the server validates it again); throws a plain-words Error on a malformed line. */
export function configFrom(m: Model): SsoConfig {
  const nullable = (v: string) => (v.trim() === '' ? null : v.trim());
  const requiredClaims = lines(m.requiredClaims).map((l) => {
    const i = l.indexOf('=');
    if (i <= 0) throw new Error(`Required claim "${l}" must look like name=value1,value2`);
    return { name: l.slice(0, i).trim(), values: l.slice(i + 1).split(',').map((v) => v.trim()).filter(Boolean) };
  });
  const groupRoles = lines(m.groupRoles).map((l) => {
    const i = l.lastIndexOf('=');
    const role = l.slice(i + 1).trim() as JitRole;
    if (i <= 0 || !(JIT_ROLES as readonly string[]).includes(role)) throw new Error(`Group mapping "${l}" must look like group=role (one of ${JIT_ROLES.join(', ')})`);
    return { group: l.slice(0, i).trim(), role };
  });
  const certs = m.idpCertificates
    .split(/(?=-----BEGIN CERTIFICATE-----)/)
    .map((c) => c.trim())
    .filter(Boolean);
  return {
    v: 1,
    protocol: m.protocol,
    enabled: m.enabled,
    displayName: m.displayName.trim(),
    sessionMaxAgeHours: Number(m.sessionMaxAgeHours),
    oidc:
      m.protocol === 'oidc'
        ? {
            issuer: m.issuer.trim(),
            clientId: m.clientId.trim(),
            tokenEndpointAuth: m.tokenEndpointAuth,
            scopes: m.scopes.split(/\s+/).filter(Boolean),
            emailClaim: m.emailClaim.trim(),
            nameClaim: m.nameClaim.trim(),
            groupsClaim: nullable(m.groupsClaim),
            requiredClaims,
          }
        : null,
    saml:
      m.protocol === 'saml'
        ? {
            idpEntityId: m.idpEntityId.trim(),
            ssoUrl: m.ssoUrl.trim(),
            idpCertificates: certs,
            nameIdFormat: m.nameIdFormat,
            emailAttribute: nullable(m.emailAttribute),
            nameAttribute: nullable(m.nameAttribute),
            groupsAttribute: nullable(m.groupsAttribute),
            signAuthnRequests: m.signAuthnRequests,
            wantResponseSigned: m.wantResponseSigned,
            clockSkewSec: Number(m.clockSkewSec),
          }
        : null,
    jit: { enabled: m.jitEnabled, defaultRole: m.defaultRole, defaultSeatTier: m.defaultSeatTier, groupRoles },
  };
}

// ---------- words ----------

export const MISSING_TEXT: Record<string, string> = {
  sso_enabled: 'Single sign-on is configured and turned on',
  verified_domain: 'At least one domain is verified',
  break_glass: 'At least one break-glass administrator is chosen',
  break_glass_password: 'Every break-glass administrator is an active org admin with a password',
  recent_test: 'You completed a successful test sign-in as yourself in the last 24 hours',
};

const DOMAIN_STATUS_TEXT: Record<SsoDomain['status'], string> = { pending: 'Pending', verified: 'Verified', lapsed: 'Lapsed' };
const DOMAIN_TONE: Record<SsoDomain['status'], 'amber' | 'green' | 'red'> = { pending: 'amber', verified: 'green', lapsed: 'red' };

function secretText(s: SecretStatus): string {
  if (!s.set) return 'Not set';
  return `Set${s.setAt ? ` on ${fmtDateTime(s.setAt)}` : ''}${s.fingerprint ? `, fingerprint ${s.fingerprint}` : ''}`;
}

function errorText(err: unknown): string {
  if (isApiError(err, 'sso_discovery_failed')) return `The OpenID discovery document could not be fetched or checked (${String(err.details?.['cause'] ?? 'unknown')}).`;
  if (isApiError(err, 'egress_refused')) return `This server is not allowed to reach that address (${String(err.details?.['cause'] ?? 'refused')}).`;
  if (isApiError(err, 'sso_cert_invalid')) return 'An IdP certificate is not an unexpired RSA certificate of at least 2048 bits.';
  if (isApiError(err, 'tier_not_licensed')) return 'The default seat tier is above your plan.';
  if (isApiError(err, 'sso_required_on')) return 'Single sign-on is required for this organisation. Turn that off first.';
  if (isApiError(err, 'domain_invalid')) return 'That is not a valid domain name.';
  if (isApiError(err, 'domain_not_allowed')) return 'A public mail domain cannot be claimed.';
  if (isApiError(err, 'domain_exists')) return 'This domain is already listed.';
  if (isApiError(err, 'domain_limit')) return 'The domain limit is reached.';
  if (isApiError(err, 'domain_taken')) return 'Another organisation in this region has verified this domain.';
  if (isApiError(err, 'last_break_glass')) return 'Single sign-on is required, so keep at least one break-glass administrator.';
  if (isApiError(err, 'break_glass_invalid_user')) return 'Break-glass administrators must be active org admins with a password (at most two).';
  return errorMessage(err);
}

function Copyable({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <Field label={label}>
      {(p) => (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          {multiline ? (
            <textarea id={p.id} readOnly rows={4} value={value} className="min-h-10 w-full rounded-md border border-slate-400 bg-slate-50 px-3 py-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-950" />
          ) : (
            <Input id={p.id} readOnly value={value} className="font-mono text-xs" />
          )}
          <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} variant="secondary" size="sm" />
        </div>
      )}
    </Field>
  );
}

function Check({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1 h-4 w-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-xs text-slate-600 dark:text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

function TextArea({ id, value, onChange, rows = 3, describedBy, placeholder }: { id: string; value: string; onChange: (v: string) => void; rows?: number; describedBy?: string; placeholder?: string }) {
  return (
    <textarea
      id={id}
      aria-describedby={describedBy}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-10 w-full rounded-md border border-slate-400 bg-white px-3 py-2 font-mono text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
    />
  );
}

// ---------- sections ----------

function ConfigCard({ settings, admin, onSaved }: { settings: SsoSettings; admin: boolean; onSaved: (s: SsoSettings) => void }) {
  const [m, setM] = useState<Model>(() => modelFrom(settings.config));
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Model>(k: K, v: Model[K]) => setM((x) => ({ ...x, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus('');
    let cfg: SsoConfig;
    try {
      cfg = configFrom(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    try {
      const secretArg = m.protocol !== 'oidc' ? undefined : clearSecret ? null : secret ? secret : undefined;
      const s = await ssoApi.save(cfg, secretArg);
      setSecret('');
      setClearSecret(false);
      setStatus('Saved.');
      onSaved(s);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Identity provider">
      <form onSubmit={(e) => void save(e)}>
        <fieldset disabled={!admin || busy} className="flex flex-col gap-4">
          <legend className="sr-only">Identity provider settings</legend>
          {error && <Alert>{error}</Alert>}
          <div role="radiogroup" aria-label="Protocol" className="flex flex-wrap gap-4">
            {(['oidc', 'saml'] as const).map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm">
                <input type="radio" name="sso-protocol" value={p} checked={m.protocol === p} onChange={() => set('protocol', p)} />
                {p === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'}
              </label>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Button label" hint='Shown as "Continue with <label>".'>
              {(p) => <Input id={p.id} aria-describedby={p.describedBy} required maxLength={60} value={m.displayName} onChange={(e) => set('displayName', e.target.value)} />}
            </Field>
            <Field label="Session lifetime (hours)" hint="1 to 168. A user disabled at the IdP keeps a session until it ends.">
              {(p) => (
                <Input id={p.id} aria-describedby={p.describedBy} type="number" min={1} max={168} required value={m.sessionMaxAgeHours} onChange={(e) => set('sessionMaxAgeHours', e.target.value)} />
              )}
            </Field>
          </div>
          <Check label="Single sign-on is turned on" checked={m.enabled} onChange={(v) => set('enabled', v)} />

          {m.protocol === 'oidc' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Issuer URL">{(p) => <Input id={p.id} type="url" required value={m.issuer} onChange={(e) => set('issuer', e.target.value)} />}</Field>
              <Field label="Client ID">{(p) => <Input id={p.id} required value={m.clientId} onChange={(e) => set('clientId', e.target.value)} />}</Field>
              <Field label="Client authentication">
                {(p) => (
                  <Select id={p.id} value={m.tokenEndpointAuth} onChange={(e) => set('tokenEndpointAuth', e.target.value as Model['tokenEndpointAuth'])}>
                    <option value="client_secret_basic">Client secret (HTTP Basic)</option>
                    <option value="client_secret_post">Client secret (form post)</option>
                    <option value="none">None (public client, PKCE only)</option>
                  </Select>
                )}
              </Field>
              <Field label="Client secret" hint={`Write-only. ${secretText(settings.secrets.clientSecret)}.`}>
                {(p) => (
                  <Input
                    id={p.id}
                    aria-describedby={p.describedBy}
                    type="password"
                    autoComplete="off"
                    value={secret}
                    placeholder={settings.secrets.clientSecret.set ? 'Leave empty to keep the stored secret' : ''}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                )}
              </Field>
              {settings.secrets.clientSecret.set && <Check label="Clear the stored client secret" checked={clearSecret} onChange={setClearSecret} />}
              <Field label="Scopes" hint="Space separated; must include openid.">
                {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={m.scopes} onChange={(e) => set('scopes', e.target.value)} />}
              </Field>
              <Field label="Email claim">{(p) => <Input id={p.id} value={m.emailClaim} onChange={(e) => set('emailClaim', e.target.value)} />}</Field>
              <Field label="Name claim">{(p) => <Input id={p.id} value={m.nameClaim} onChange={(e) => set('nameClaim', e.target.value)} />}</Field>
              <Field label="Groups claim (optional)">{(p) => <Input id={p.id} value={m.groupsClaim} onChange={(e) => set('groupsClaim', e.target.value)} />}</Field>
              <Field label="Required claims" hint="One per line, name=value1,value2 (for example hd=example.com). Google needs at least one.">
                {(p) => <TextArea id={p.id} describedBy={p.describedBy} value={m.requiredClaims} onChange={(v) => set('requiredClaims', v)} />}
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="IdP entity ID">{(p) => <Input id={p.id} required value={m.idpEntityId} onChange={(e) => set('idpEntityId', e.target.value)} />}</Field>
              <Field label="IdP sign-on URL" hint="The HTTP-Redirect SingleSignOnService.">
                {(p) => <Input id={p.id} aria-describedby={p.describedBy} type="url" required value={m.ssoUrl} onChange={(e) => set('ssoUrl', e.target.value)} />}
              </Field>
              <div className="sm:col-span-2">
                <Field label="IdP signing certificates" hint="PEM, RSA of at least 2048 bits; paste a second one during an IdP key rotation.">
                  {(p) => <TextArea id={p.id} describedBy={p.describedBy} rows={5} value={m.idpCertificates} onChange={(v) => set('idpCertificates', v)} />}
                </Field>
              </div>
              <Field label="NameID format">
                {(p) => (
                  <Select id={p.id} value={m.nameIdFormat} onChange={(e) => set('nameIdFormat', e.target.value as SamlNameIdFormat)}>
                    {SAML_NAMEID_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Email attribute" hint="Empty: the NameID is the email (needs the email format).">
                {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={m.emailAttribute} onChange={(e) => set('emailAttribute', e.target.value)} />}
              </Field>
              <Field label="Name attribute (optional)">{(p) => <Input id={p.id} value={m.nameAttribute} onChange={(e) => set('nameAttribute', e.target.value)} />}</Field>
              <Field label="Groups attribute (optional)">{(p) => <Input id={p.id} value={m.groupsAttribute} onChange={(e) => set('groupsAttribute', e.target.value)} />}</Field>
              <Field label="Clock skew (seconds)">
                {(p) => <Input id={p.id} type="number" min={0} max={300} value={m.clockSkewSec} onChange={(e) => set('clockSkewSec', e.target.value)} />}
              </Field>
              <div className="flex flex-col gap-2">
                <Check label="Sign AuthnRequests (needs an SP key)" checked={m.signAuthnRequests} onChange={(v) => set('signAuthnRequests', v)} />
                <Check label="Also require a signed Response" hint="The assertion signature is always required." checked={m.wantResponseSigned} onChange={(v) => set('wantResponseSigned', v)} />
              </div>
            </div>
          )}

          <fieldset className="flex flex-col gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-800">
            <legend className="px-1 text-sm font-semibold">Just-in-time accounts</legend>
            <Check
              label="Create an account on first sign-in"
              hint="Only for addresses on a verified domain. An org admin is never created this way."
              checked={m.jitEnabled}
              onChange={(v) => set('jitEnabled', v)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Default role">
                {(p) => (
                  <Select id={p.id} value={m.defaultRole} onChange={(e) => set('defaultRole', e.target.value as JitRole)}>
                    {JIT_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {fmtRoleName(r)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Default seat tier">
                {(p) => (
                  <Select id={p.id} value={m.defaultSeatTier} onChange={(e) => set('defaultSeatTier', e.target.value as PackageTier)}>
                    {PACKAGE_TIERS.map((t) => (
                      <option key={t} value={t}>
                        {fmtTier(t)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="sm:col-span-2">
                <Field label="Group to role mapping" hint={`One per line, group=role; the first group the user has wins. Roles: ${JIT_ROLES.join(', ')}.`}>
                  {(p) => <TextArea id={p.id} describedBy={p.describedBy} value={m.groupRoles} onChange={(v) => set('groupRoles', v)} />}
                </Field>
              </div>
            </div>
          </fieldset>
          {admin && (
            <div className="flex items-center gap-3">
              <Button type="submit">{busy ? 'Saving...' : 'Save identity provider'}</Button>
              <span aria-live="polite" className="text-sm">
                {status}
              </span>
            </div>
          )}
        </fieldset>
      </form>
    </Card>
  );
}

function SpCard({ settings, admin, onChange }: { settings: SsoSettings; admin: boolean; onChange: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rotate = async () => {
    setConfirm(false);
    setError(null);
    try {
      await ssoApi.rotateSpKey();
      setStatus('A new SP key and certificate were generated. Import the metadata at your IdP again.');
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const isSaml = settings.config?.protocol === 'saml';
  return (
    <Card title="Values for your identity provider">
      <div className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        {isSaml ? (
          <>
            <Copyable label="SP entity ID" value={settings.sp.entityId} />
            <Copyable label="ACS URL" value={settings.sp.acsUrl} />
            <Copyable label="Metadata URL" value={settings.sp.metadataUrl} />
            {settings.sp.certPem && <Copyable label="SP certificate" value={settings.sp.certPem} multiline />}
            <p className="text-sm">SP key: {secretText(settings.secrets.spKey)}.</p>
            {admin && (
              <div>
                <Button variant="secondary" onClick={() => setConfirm(true)}>
                  {settings.secrets.spKey.set ? 'Rotate the SP key' : 'Generate an SP key'}
                </Button>
              </div>
            )}
          </>
        ) : (
          <Copyable label="Redirect URI" value={settings.sp.oidcRedirectUri} />
        )}
        <p aria-live="polite" className="text-sm">
          {status}
        </p>
      </div>
      <Dialog open={confirm} title="Generate a new SP key?" onClose={() => setConfirm(false)}>
        <p className="mb-4 text-sm">The new certificate replaces the old one. Your IdP must import the SP metadata again, or signed and encrypted messages stop working.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
          <Button onClick={() => void rotate()}>Generate</Button>
        </div>
      </Dialog>
    </Card>
  );
}

function DomainsCard({ settings, admin, onChange }: { settings: SsoSettings; admin: boolean; onChange: () => void }) {
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const d = await ssoApi.addDomain(domain.trim());
      setDomain('');
      setStatus(`${d.domain} added. Publish its TXT record, then choose Verify.`);
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const verify = async (d: SsoDomain) => {
    setError(null);
    setStatus(`Checking ${d.domain}...`);
    try {
      await ssoApi.verifyDomain(d.id);
      setStatus(`${d.domain} is verified.`);
      onChange();
    } catch (err) {
      if (isApiError(err, 'domain_unverified')) {
        const found = Array.isArray(err.details?.['found']) ? (err.details['found'] as string[]) : [];
        setStatus(`${d.domain} is not verified yet: the TXT record was not found.${found.length ? ` Found: ${found.join('; ')}` : ''}`);
      } else {
        setStatus('');
        setError(errorText(err));
      }
    }
  };
  const remove = async (d: SsoDomain) => {
    setError(null);
    try {
      await ssoApi.removeDomain(d.id);
      setStatus(`${d.domain} removed.`);
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Card title="Verified domains">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-700 dark:text-slate-300">
          A verified domain routes sign-ins to your IdP and lets single sign-on match existing users and create new ones. Prove each domain with a DNS TXT record.
        </p>
        {error && <Alert>{error}</Alert>}
        <p aria-live="polite" role="status" className="text-sm">
          {status}
        </p>
        {settings.domains.length === 0 ? (
          <p className="text-sm">No domains yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {settings.domains.map((d) => (
              <li key={d.id} className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.domain}</span>
                  <Badge tone={DOMAIN_TONE[d.status]}>{DOMAIN_STATUS_TEXT[d.status]}</Badge>
                  {d.verifiedAt && <span className="text-xs text-slate-600 dark:text-slate-400">verified {fmtDateTime(d.verifiedAt)}</span>}
                </div>
                {d.status !== 'verified' && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Copyable label={`TXT name for ${d.domain}`} value={d.txtName} />
                    <Copyable label={`TXT value for ${d.domain}`} value={d.txtValue} />
                  </div>
                )}
                {admin && (
                  <div className="mt-2 flex gap-2">
                    {d.status !== 'verified' && (
                      <Button size="sm" onClick={() => void verify(d)} aria-label={`Verify ${d.domain}`}>
                        Verify
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void remove(d)} aria-label={`Remove ${d.domain}`}>
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <form onSubmit={(e) => void add(e)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Domain to add">{(p) => <Input id={p.id} required value={domain} placeholder="example.com" onChange={(e) => setDomain(e.target.value)} />}</Field>
            </div>
            <Button type="submit">Add domain</Button>
          </form>
        )}
      </div>
    </Card>
  );
}

function TestCard({ settings, admin }: { settings: SsoSettings; admin: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      const r = await ssoApi.test();
      const href = beginHref(r.beginUrl);
      if (!href) throw new Error('The server returned an unexpected sign-in address.');
      navigateWithOriginReferrer(href);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const lt = settings.lastTest;
  return (
    <Card title="Test sign-in">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-700 dark:text-slate-300">
          Sign in at your IdP as yourself. Nothing is created and no session is started; the result is recorded here. Requiring single sign-on needs a successful test as yourself in the last 24 hours.
        </p>
        {error && <Alert>{error}</Alert>}
        <p className="text-sm">
          Last test:{' '}
          {lt
            ? `${fmtDateTime(lt.at)}, ${lt.ok ? 'succeeded' : `failed (${ssoErrorText(lt.cause) ?? 'unknown cause'})`}${lt.ok ? (lt.matchedSelf ? ', matched your account' : ', did not match your account') : ''}`
            : 'none yet'}
        </p>
        {admin && (
          <div>
            <Button variant="secondary" disabled={!settings.config} onClick={() => void run()}>
              Test sign-in
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function BreakGlassCard({ settings, admin, onChange }: { settings: SsoSettings; admin: boolean; onChange: () => void }) {
  const users = useAsync(async () => (admin ? (await usersApi.list()).items : ([] as UserWithSeat[])), [admin]);
  const [picked, setPicked] = useState<string[]>(settings.breakGlassUserIds);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => setPicked(settings.breakGlassUserIds), [settings.breakGlassUserIds]);
  const admins = (users.data ?? []).filter((u) => u.role === 'org_admin' && u.status === 'active');
  const save = async () => {
    setError(null);
    try {
      await ssoApi.setBreakGlass(picked);
      setStatus('Break-glass administrators saved.');
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Card title="Break-glass administrators">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-700 dark:text-slate-300">
          At most two org admins who may still sign in with a password while single sign-on is required. Their sessions last one hour and every other admin is told by email.
        </p>
        {error && <Alert>{error}</Alert>}
        {!admin ? (
          <p className="text-sm">{settings.breakGlassUserIds.length} chosen.</p>
        ) : users.loading ? (
          <Spinner label="Loading admins" />
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Break-glass administrators</legend>
            {admins.map((u) => (
              <Check
                key={u.id}
                label={`${u.name} (${u.email})`}
                checked={picked.includes(u.id)}
                disabled={!picked.includes(u.id) && picked.length >= 2}
                onChange={(v) => setPicked((p) => (v ? [...p, u.id] : p.filter((x) => x !== u.id)))}
              />
            ))}
          </fieldset>
        )}
        {admin && (
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={() => void save()}>
              Save break-glass administrators
            </Button>
            <span aria-live="polite" className="text-sm">
              {status}
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

function RequiredCard({ settings, admin, onChange }: { settings: SsoSettings; admin: boolean; onChange: (s: SsoSettings) => void }) {
  const [missing, setMissing] = useState<string[] | null>(null);
  const [warning, setWarning] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const key = useMemo(() => JSON.stringify([settings.required, settings.domains, settings.breakGlassUserIds, settings.lastTest, settings.config?.enabled]), [settings]);
  useEffect(() => {
    if (!admin || settings.required) {
      setMissing([]);
      return;
    }
    let live = true;
    ssoApi
      .setRequired(true, true)
      .then((r) => {
        if (!live) return;
        setMissing([]);
        setWarning(r.warnings.usersOutsideVerifiedDomains);
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (isApiError(err, 'sso_not_ready')) setMissing(Array.isArray(err.details?.['missing']) ? (err.details['missing'] as string[]) : []);
        else setError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [key, admin]);
  const apply = async (required: boolean) => {
    setConfirm(false);
    setError(null);
    try {
      const r = await ssoApi.setRequired(required);
      setStatus(required ? 'Single sign-on is now required. Password sessions of other users were signed out.' : 'Single sign-on is no longer required.');
      onChange(r);
    } catch (err) {
      if (isApiError(err, 'sso_not_ready')) setMissing(Array.isArray(err.details?.['missing']) ? (err.details['missing'] as string[]) : []);
      setError(errorText(err));
    }
  };
  const ready = missing !== null && missing.length === 0;
  return (
    <Card title="Require single sign-on">
      <div className="flex flex-col gap-3">
        {error && <Alert>{error}</Alert>}
        <label className="flex items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            role="switch"
            aria-checked={settings.required}
            className="h-5 w-5"
            checked={settings.required}
            disabled={!admin || (!settings.required && !ready)}
            onChange={(e) => (e.target.checked ? setConfirm(true) : void apply(false))}
          />
          Single sign-on is required: {settings.required ? 'yes' : 'no'}
        </label>
        {!settings.required && missing && missing.length > 0 && (
          <div>
            <p className="text-sm font-medium">Before it can be required:</p>
            <ul className="ml-5 list-disc text-sm">
              {missing.map((k) => (
                <li key={k}>{MISSING_TEXT[k] ?? k}</li>
              ))}
            </ul>
          </div>
        )}
        <p aria-live="polite" className="text-sm">
          {status}
        </p>
      </div>
      <Dialog open={confirm} title="Require single sign-on?" onClose={() => setConfirm(false)}>
        <div className="flex flex-col gap-3 text-sm">
          <p>Password sign-in stops for everyone except the break-glass administrators, and current password sessions are signed out.</p>
          {warning !== null && (
            <p>
              {warning === 1 ? '1 active user has' : `${warning} active users have`} an email outside your verified domains and no linked sign-in, and could not sign in.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void apply(true)}>
              Require single sign-on
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

export function SsoSettingsPage() {
  usePageTitle('Single sign-on');
  const { me } = useAuth();
  const admin = can(me?.user.role, 'sso.admin');
  const [params] = useSearchParams();
  const test = params.get('test');
  const st = useAsync(() => ssoApi.settings(), []);
  const settings = st.data;
  const refresh = () => st.reload();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Single sign-on">
        {settings && (
          <>
            <Badge tone={settings.config?.enabled ? 'green' : 'neutral'}>{settings.config?.enabled ? 'Turned on' : 'Turned off'}</Badge>
            <Badge tone={settings.required ? 'blue' : 'neutral'}>{settings.required ? 'Required' : 'Not required'}</Badge>
          </>
        )}
      </PageHeader>
      <div role="status" aria-live="polite">
        {test && (test === 'ok' ? <Alert tone="green">Test sign-in succeeded.</Alert> : <Alert tone="amber">Test sign-in failed: {ssoErrorText(test)}</Alert>)}
      </div>
      {st.loading && !settings && <Spinner label="Loading single sign-on settings" />}
      {Boolean(st.error) && <Alert>{errorMessage(st.error)}</Alert>}
      {settings && (
        <>
          <ConfigCard settings={settings} admin={admin} onSaved={(s) => st.setData(s)} />
          <SpCard settings={settings} admin={admin} onChange={refresh} />
          <DomainsCard settings={settings} admin={admin} onChange={refresh} />
          <TestCard settings={settings} admin={admin} />
          <BreakGlassCard settings={settings} admin={admin} onChange={refresh} />
          <RequiredCard settings={settings} admin={admin} onChange={(s) => st.setData(s)} />
        </>
      )}
    </div>
  );
}
