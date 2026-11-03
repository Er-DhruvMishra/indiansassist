/**
 * /reset (docs/specs/phase-f-contracts.md sections 4.3, 4.4, stream mail). Without a token: the request form, which
 * always ends with the same sentence ("If an account exists for that address, we sent a link to it."), whatever the
 * address. With `#t=<token>` in the fragment: the page reads it, removes it from the address bar with
 * `history.replaceState`, and shows the new-password form. A successful reset mints no session: the person signs in
 * with the new password. Keyboard operable; every state change is announced (WCAG 2.1 AA, section 12).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LIMITS } from '@indiansassist/shared';
import { Alert, Button, Field, Input } from '../components/ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { api, errorMessage, isApiError } from '../lib/api';
import { useAuthOptions } from './LoginPage';
import { PublicLayout, TextLink } from './PublicLayout';

/** Reads `t` from the fragment (rule 4.3d); pure, so a double render reads the same value. */
export function readResetToken(): string | null {
  const token = new URLSearchParams(globalThis.location.hash.replace(/^#/, '')).get('t');
  return token && token.length > 0 ? token : null;
}

/** Removes the fragment from the address bar, so the token is not left in history or on screen. */
export function stripFragment(): void {
  if (globalThis.location.hash !== '')
    globalThis.history.replaceState(globalThis.history.state, '', globalThis.location.pathname + globalThis.location.search);
}

export const REQUEST_SENT_TEXT = 'If an account exists for that address, we sent a link to it.';

function RequestForm({ available, intro }: { available: boolean | null; intro?: string | null }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (sent) doneRef.current?.focus();
  }, [sent]);

  if (available === false)
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm">Password reset by email is not available on this server. Ask an administrator of your organisation to help you sign in.</p>
        <TextLink to="/login">Go to the sign-in page</TextLink>
      </div>
    );

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/password-reset/request', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <div className="flex flex-col gap-4">
        <p ref={doneRef} tabIndex={-1} role="status" className="text-sm font-medium outline-none">
          {REQUEST_SENT_TEXT}
        </p>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          The link works once, for {LIMITS.passwordResetTtlMin} minutes. If nothing arrives, check your spam folder or ask again in a few minutes.
        </p>
        <div className="flex flex-wrap gap-4">
          <TextLink to="/login">Go to the sign-in page</TextLink>
          <button
            type="button"
            className="text-sm font-medium text-teal-800 underline underline-offset-2 dark:text-teal-300"
            onClick={() => {
              setSent(false);
              setEmail('');
            }}
          >
            Use another address
          </button>
        </div>
      </div>
    );

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" aria-label="Ask for a reset link">
      {intro && <Alert tone="amber">{intro}</Alert>}
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-700 dark:text-slate-300">Enter the email address you sign in with. We will email you a link to choose a new password.</p>
      <Field label="Email">
        {(p) => <Input id={p.id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Button type="submit" size="lg" disabled={busy || available === null}>
        {busy ? 'Sending...' : 'Send reset link'}
      </Button>
      <TextLink to="/login">Back to sign in</TextLink>
    </form>
  );
}

type ConfirmState = { kind: 'form' } | { kind: 'done' } | { kind: 'invalid' } | { kind: 'sso'; beginUrl: string | null };

function ConfirmForm({ token, available }: { token: string; available: boolean | null }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ConfirmState>({ kind: 'form' });
  const doneRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.kind === 'done' || state.kind === 'sso') doneRef.current?.focus();
  }, [state.kind]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < LIMITS.passwordMin) return setError(`Use at least ${LIMITS.passwordMin} characters.`);
    if (password !== repeat) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      await api.post('/auth/password-reset/confirm', { token, newPassword: password });
      setState({ kind: 'done' });
    } catch (err) {
      if (isApiError(err, 'reset_invalid')) setState({ kind: 'invalid' });
      else if (isApiError(err, 'sso_required'))
        setState({ kind: 'sso', beginUrl: typeof err.details?.['beginUrl'] === 'string' ? err.details['beginUrl'] : null });
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === 'done')
    return (
      <div className="flex flex-col gap-4">
        <p ref={doneRef} tabIndex={-1} role="status" className="text-sm font-medium outline-none">
          Your password was changed, and every device that was signed in to your account was signed out.
        </p>
        <TextLink to="/login">Sign in with your new password</TextLink>
      </div>
    );
  if (state.kind === 'sso')
    return (
      <div className="flex flex-col gap-4">
        <p ref={doneRef} tabIndex={-1} role="status" className="text-sm font-medium outline-none">
          Your organisation signs in with single sign-on, so there is no password to reset.
        </p>
        {state.beginUrl ? (
          <a href={state.beginUrl} className="font-medium text-teal-800 underline underline-offset-2 dark:text-teal-300">
            Sign in with single sign-on
          </a>
        ) : (
          <TextLink to="/login">Go to the sign-in page</TextLink>
        )}
      </div>
    );
  if (state.kind === 'invalid')
    return <RequestForm available={available} intro="This reset link is invalid, expired or was already used. Ask for a new link below." />;

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" aria-label="Choose a new password">
      {error && <Alert>{error}</Alert>}
      <Field label="New password" hint={`At least ${LIMITS.passwordMin} characters.`}>
        {(p) => (
          <Input id={p.id} aria-describedby={p.describedBy} type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
      </Field>
      <Field label="Repeat the new password">
        {(p) => <Input id={p.id} type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />}
      </Field>
      <Button type="submit" size="lg" disabled={busy}>
        {busy ? 'Saving...' : 'Set new password'}
      </Button>
    </form>
  );
}

export function PasswordResetPage() {
  usePageTitle('Reset your password');
  const options = useAuthOptions();
  const [token] = useState(readResetToken);
  useEffect(() => stripFragment(), []);
  const available = options === null ? null : options.passwordReset;
  return (
    <PublicLayout title={token ? 'Choose a new password' : 'Reset your password'}>
      {token ? <ConfirmForm token={token} available={available} /> : <RequestForm available={available} />}
    </PublicLayout>
  );
}
