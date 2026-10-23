/** /invite#i=<secret> (contracts sections 3.6, 6.5): accept an invite with name and password. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS } from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Field, Input } from '../components/ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage, isApiError } from '../lib/api';
import { authApi } from '../lib/endpoints';
import { PublicLayout } from './PublicLayout';

/** Reads `i` from the fragment, falling back to the query, then strips it from the URL. */
export function takeInviteSecret(): string | null {
  const hash = new URLSearchParams(globalThis.location.hash.replace(/^#/, '')).get('i');
  const query = new URLSearchParams(globalThis.location.search).get('i');
  const secret = hash || query || null;
  if (secret) globalThis.history.replaceState(null, '', '/invite');
  return secret;
}

export function InvitePage() {
  usePageTitle('Accept invitation');
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const secret = useRef<string | null>(null);
  const [hasSecret, setHasSecret] = useState(true);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (secret.current === null) secret.current = takeInviteSecret();
    setHasSecret(secret.current !== null);
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!secret.current) return;
    if (password.length < LIMITS.passwordMin) return setError(`Use at least ${LIMITS.passwordMin} characters.`);
    setBusy(true);
    setError(null);
    try {
      setMe(await authApi.acceptInvite({ invite: secret.current, name: name.trim(), password }));
      navigate('/app', { replace: true });
    } catch (err) {
      setError(isApiError(err, 'invite_invalid') ? 'This invitation is invalid, expired or was already used.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicLayout title="Accept your invitation">
      {!hasSecret ? (
        <Alert>This page needs the invitation link your administrator sent you.</Alert>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
          {error && <Alert>{error}</Alert>}
          <Field label="Your name">
            {(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />}
          </Field>
          <Field label="Choose a password" hint={`At least ${LIMITS.passwordMin} characters.`}>
            {(p) => (
              <Input id={p.id} aria-describedby={p.describedBy} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
            )}
          </Field>
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? 'Joining...' : 'Join organisation'}
          </Button>
        </form>
      )}
    </PublicLayout>
  );
}
