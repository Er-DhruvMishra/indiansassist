/** /app/account (contracts section 6.5): change own password. */
import { useState, type FormEvent } from 'react';
import { LIMITS } from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Card, Field, Input, PageHeader } from '../components/ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage, isApiError } from '../lib/api';
import { authApi } from '../lib/endpoints';
import { fmtRoleName, fmtTier, regionLabel } from '../lib/format';

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
      </div>
    </>
  );
}
