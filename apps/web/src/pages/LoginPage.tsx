/**
 * /login (contracts section 1.1 T3; Phase E section 13.4): email first. Continue asks `POST /auth/sso/discover`;
 * `sso_required` shows a single "Continue with <displayName>" link and a small "Administrator sign-in with password"
 * link; `sso_available` shows both; `password` shows today's form. `?sso_error=` is shown in plain words. The region
 * picker is unchanged (VITE_REGION_ORIGINS with more than one distinct origin; remembered in localStorage['ia.region']).
 */
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { REGION_LABELS, STORAGE_KEYS, isRegion, type Region, type SsoDiscovery } from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Field, Input, Select } from '../components/ui';
import { REGION_ORIGINS } from '../config';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage, isApiError } from '../lib/api';
import { authApi } from '../lib/endpoints';
import { allowedOrigins, navigateTo } from '../lib/region';
import { readStore, writeStore } from '../lib/storage';
import { SsoContinueLink } from '../assist/sso/SsoContinueLink';
import { beginHref, ssoApi, ssoErrorText } from '../assist/sso/ssoApi';
import { PublicLayout, TextLink } from './PublicLayout';

type Step = 'email' | 'credentials';

function withReturnTo(beginUrl: string, from: string): string {
  if (!from.startsWith('/app') || from === '/app') return beginUrl;
  return `${beginUrl}${beginUrl.includes('?') ? '&' : '?'}return_to=${encodeURIComponent(from)}`;
}

export function LoginPage() {
  usePageTitle('Sign in');
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const from = (location.state as { from?: string } | null)?.from ?? '/app';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>('email');
  const [discovery, setDiscovery] = useState<SsoDiscovery | null>(null);
  const [adminPassword, setAdminPassword] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const ssoError = ssoErrorText(params.get('sso_error'));

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

  const ssoHref = discovery?.beginUrl ? beginHref(withReturnTo(discovery.beginUrl, from)) : null;
  const mode = ssoHref ? discovery!.mode : 'password';
  const passwordVisible = step === 'credentials' && (mode !== 'sso_required' || adminPassword);

  const onContinue = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setDiscovery(await ssoApi.discover(email.trim()));
    } catch {
      // Discovery is a convenience: when it cannot answer, the password form is still offered.
      setDiscovery({ mode: 'password' });
    } finally {
      setBusy(false);
      setStep('credentials');
      setAdminPassword(false);
      setTimeout(() => passwordRef.current?.focus(), 0);
    }
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
      if (isApiError(err, 'sso_required')) {
        const url = typeof err.details?.['beginUrl'] === 'string' ? err.details['beginUrl'] : null;
        setDiscovery({ mode: 'sso_required', displayName: discovery?.displayName ?? 'your identity provider', ...(url ? { beginUrl: url } : {}) });
        setAdminPassword(false);
        setError('Your organisation signs in with single sign-on. Use the button below.');
      } else
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
      <div className="flex flex-col gap-4">
        {ssoError && <Alert>{ssoError}</Alert>}
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
        <form onSubmit={(e) => void (step === 'email' ? onContinue(e) : passwordVisible ? onSubmit(e) : e.preventDefault())} className="flex flex-col gap-4">
          <Field label="Email">
            {(p) => (
              <Input
                id={p.id}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (step !== 'email') {
                    setStep('email');
                    setDiscovery(null);
                  }
                }}
                autoComplete="email"
                required
              />
            )}
          </Field>
          {step === 'email' && (
            <Button type="submit" size="lg" disabled={busy}>
              {busy ? 'Checking...' : 'Continue'}
            </Button>
          )}
          {step === 'credentials' && ssoHref && (
            <div className="flex flex-col gap-2" role="group" aria-label="Single sign-on">
              {mode === 'sso_required' && (
                <p className="text-sm text-slate-700 dark:text-slate-300">Your organisation signs in with {discovery?.displayName ?? 'single sign-on'}.</p>
              )}
              <SsoContinueLink href={ssoHref} label={`Continue with ${discovery?.displayName ?? 'single sign-on'}`} />
            </div>
          )}
          {step === 'credentials' && mode === 'sso_required' && !adminPassword && (
            <button
              type="button"
              className="self-start text-sm font-medium text-teal-800 underline underline-offset-2 dark:text-teal-300"
              onClick={() => {
                setAdminPassword(true);
                setTimeout(() => passwordRef.current?.focus(), 0);
              }}
            >
              Administrator sign-in with password
            </button>
          )}
          {passwordVisible && (
            <>
              {mode === 'sso_available' && <p className="text-center text-sm text-slate-600 dark:text-slate-400">or sign in with your password</p>}
              <Field label="Password">
                {(p) => (
                  <Input
                    id={p.id}
                    ref={passwordRef}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                )}
              </Field>
              <Button type="submit" size="lg" variant={mode === 'password' ? 'primary' : 'secondary'} disabled={busy}>
                {busy ? 'Signing in...' : 'Sign in'}
              </Button>
            </>
          )}
        </form>
      </div>
    </PublicLayout>
  );
}
