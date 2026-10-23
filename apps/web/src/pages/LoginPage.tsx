/**
 * /login (contracts section 1.1 T3): email + password, plus a region picker when VITE_REGION_ORIGINS has
 * more than one distinct origin; the choice is remembered in localStorage['ia.region'].
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { REGION_LABELS, STORAGE_KEYS, isRegion, type Region } from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Field, Input, Select } from '../components/ui';
import { REGION_ORIGINS } from '../config';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage, isApiError } from '../lib/api';
import { authApi } from '../lib/endpoints';
import { allowedOrigins, navigateTo } from '../lib/region';
import { readStore, writeStore } from '../lib/storage';
import { PublicLayout, TextLink } from './PublicLayout';

export function LoginPage() {
  usePageTitle('Sign in');
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/app';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showPicker = allowedOrigins().length > 1;
  const currentRegion = useMemo<Region | ''>(() => {
    const stored = readStore('local', STORAGE_KEYS.region);
    if (isRegion(stored) && REGION_ORIGINS[stored] === globalThis.location.origin) return stored;
    const here = (Object.entries(REGION_ORIGINS) as [Region, string][]).find(([, o]) => o === globalThis.location.origin);
    return here ? here[0] : '';
  }, []);

  const onRegion = (r: Region) => {
    writeStore('local', STORAGE_KEYS.region, r);
    const origin = REGION_ORIGINS[r];
    if (origin && origin !== globalThis.location.origin) navigateTo(`${origin}/login`);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await authApi.login(email.trim(), password);
      setMe(r);
      navigate(from.startsWith('/app') ? from : '/app', { replace: true });
    } catch (err) {
      setError(
        isApiError(err, 'invalid_credentials')
          ? 'Email or password is incorrect. If your organisation is hosted in another region, choose that region first.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicLayout
      title="Sign in to the Assist console"
      footer={
        <>
          New here? <TextLink to="/signup">Create an organisation</TextLink>
        </>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        {showPicker && (
          <Field label="Region" hint="Sign in on the region site where your organisation was created.">
            {(p) => (
              <Select id={p.id} aria-describedby={p.describedBy} value={currentRegion} onChange={(e) => onRegion(e.target.value as Region)}>
                <option value="" disabled>
                  Choose a region
                </option>
                {(Object.keys(REGION_ORIGINS) as Region[]).map((r) => (
                  <option key={r} value={r}>
                    {REGION_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Email">
          {(p) => <Input id={p.id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />}
        </Field>
        <Field label="Password">
          {(p) => (
            <Input id={p.id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          )}
        </Field>
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
    </PublicLayout>
  );
}
