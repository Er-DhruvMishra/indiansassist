/**
 * /signup (contracts section 12): org name, region (default India, immutable residency note), name,
 * email, password. A 421 follows the allow-listed origin (R3 / R5).
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { DEFAULT_REGION, LIMITS, REGIONS, REGION_LABELS, isRegion, type Region } from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Field, Input, Select } from '../components/ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage, isApiError } from '../lib/api';
import { authApi } from '../lib/endpoints';
import { navigateTo, regionDecision } from '../lib/region';
import { PublicLayout, TextLink } from './PublicLayout';

function initialRegion(): Region {
  const q = new URLSearchParams(globalThis.location?.search ?? '').get('region');
  return isRegion(q) ? q : DEFAULT_REGION;
}

export function SignupPage() {
  usePageTitle('Create your organisation');
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const [orgName, setOrgName] = useState('');
  const [region, setRegion] = useState<Region>(initialRegion);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (orgName.trim().length < 2) errs.orgName = 'Enter your organisation name.';
    if (name.trim() === '') errs.name = 'Enter your name.';
    if (!/^\S+@\S+\.\S+$/.test(email)) errs.email = 'Enter a valid email address.';
    if (password.length < LIMITS.passwordMin) errs.password = `Use at least ${LIMITS.passwordMin} characters.`;
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authApi.signup({ orgName: orgName.trim(), region, name: name.trim(), email: email.trim(), password });
      setMe({ user: r.user, org: r.org, seat: r.seat });
      navigate('/app', { replace: true });
    } catch (err) {
      if (isApiError(err, 'region_mismatch')) {
        const d = regionDecision(err.details, `/signup?region=${region}`);
        if (d.kind === 'redirect') return navigateTo(d.url);
        setError(d.manualOrigin ? `${d.message} (${d.manualOrigin})` : d.message);
      } else if (isApiError(err, 'email_taken')) {
        setFieldErrors({ email: 'An account with this email already exists.' });
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicLayout
      title="Create your organisation"
      footer={
        <>
          Already have an account? <TextLink to="/login">Sign in</TextLink>
        </>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Organisation name" error={fieldErrors.orgName}>
          {(p) => (
            <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} value={orgName} onChange={(e) => setOrgName(e.target.value)} autoComplete="organization" required />
          )}
        </Field>
        <Field
          label="Data region"
          hint="Your data never leaves this region and this cannot be changed later. All session metadata, recordings and audit entries are stored and served there."
        >
          {(p) => (
            <Select id={p.id} aria-describedby={p.describedBy} value={region} onChange={(e) => setRegion(e.target.value as Region)}>
              {REGIONS.map((r) => (
                <option key={r} value={r}>
                  {REGION_LABELS[r]}
                  {r === DEFAULT_REGION ? ' (default)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Your name" error={fieldErrors.name}>
          {(p) => <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />}
        </Field>
        <Field label="Work email" error={fieldErrors.email}>
          {(p) => (
            <Input id={p.id} type="email" aria-describedby={p.describedBy} aria-invalid={p.invalid} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          )}
        </Field>
        <Field label="Password" hint={`At least ${LIMITS.passwordMin} characters.`} error={fieldErrors.password}>
          {(p) => (
            <Input id={p.id} type="password" aria-describedby={p.describedBy} aria-invalid={p.invalid} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          )}
        </Field>
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? 'Creating...' : 'Create organisation'}
        </Button>
      </form>
    </PublicLayout>
  );
}
