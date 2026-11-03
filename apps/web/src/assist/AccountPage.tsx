/**
 * /app/account (contracts section 6.5): change own password.
 * Phase F section 7.7: install the console (Android Chrome's prompt behind an Install button; iOS guidance).
 */
import { useState, type FormEvent } from 'react';
import { LIMITS } from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Card, Field, Input, PageHeader } from '../components/ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage, isApiError } from '../lib/api';
import { authApi } from '../lib/endpoints';
import { fmtRoleName, fmtTier, regionLabel } from '../lib/format';
import { isIos, isStandalone, useInstallPrompt } from './touch/pwa';

export function AccountPage() {
  usePageTitle('Account');
  const { me } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < LIMITS.passwordMin) return setMsg({ ok: false, text: `Use at least ${LIMITS.passwordMin} characters.` });
    try {
      await authApi.changePassword(current, next);
      setCurrent('');
      setNext('');
      setMsg({ ok: true, text: 'Password changed. Your other sessions were signed out.' });
    } catch (err) {
      setMsg({ ok: false, text: isApiError(err, 'reauth_required') ? 'Your current password is incorrect.' : errorMessage(err) });
    }
  };
  return (
    <>
      <PageHeader title="Account" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Profile">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-medium">Name</dt><dd>{me?.user.name}</dd>
            <dt className="font-medium">Email</dt><dd>{me?.user.email}</dd>
            <dt className="font-medium">Role</dt><dd>{me ? fmtRoleName(me.user.role) : ''}</dd>
            <dt className="font-medium">Seat</dt><dd>{me?.seat ? fmtTier(me.seat.tier) : 'none'}</dd>
            <dt className="font-medium">Organisation</dt><dd>{me?.org.name}</dd>
            <dt className="font-medium">Region</dt><dd>{me ? regionLabel(me.org.dataRegion) : ''}</dd>
          </dl>
        </Card>
        <Card title="Change password">
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            {msg && <Alert tone={msg.ok ? 'green' : 'red'}>{msg.text}</Alert>}
            <Field label="Current password">{(p) => <Input id={p.id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />}</Field>
            <Field label="New password" hint={`At least ${LIMITS.passwordMin} characters.`}>
              {(p) => <Input id={p.id} aria-describedby={p.describedBy} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />}
            </Field>
            <Button type="submit">Change password</Button>
          </form>
        </Card>
        <InstallCard />
      </div>
    </>
  );
}

/** Phase F section 7.7: the Install button (Android Chrome's `beforeinstallprompt`) or the iOS guidance. */
function InstallCard() {
  const prompt = useInstallPrompt();
  const [result, setResult] = useState<string | null>(null);
  const standalone = isStandalone();
  return (
    <Card title="Install the console">
      <div className="flex flex-col gap-3 text-sm">
        {standalone || prompt.installed ? (
          <p role="status">The console is installed on this device. Open it from your home screen or app list.</p>
        ) : prompt.available ? (
          <>
            <p>Install the console to open it like an app, full screen, from your home screen.</p>
            <Button
              onClick={() =>
                void prompt.install().then((r) => setResult(r === 'accepted' ? 'Installing the console.' : r === 'dismissed' ? 'Not installed.' : 'Your browser did not offer an install.'))
              }
            >
              Install
            </Button>
          </>
        ) : isIos() ? (
          <p>On iPhone or iPad: in Safari, tap Share, then Add to Home Screen. The installed console keeps its own sign-in, so you sign in once there.</p>
        ) : (
          <p>Your browser has not offered an install yet. In Chrome or Edge, use the menu&apos;s Install app (or Add to Home screen on Android).</p>
        )}
        {result && (
          <p role="status" aria-live="polite">
            {result}
          </p>
        )}
      </div>
    </Card>
  );
}
