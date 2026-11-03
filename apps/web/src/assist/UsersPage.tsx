/**
 * /app/users (contracts section 6.6): invite, role and seat tier change, enable / disable (org_admin). Phase F section
 * 4.2 (stream mail): when the server can send mail (`GET /auth/options`), the invitation is emailed (a checkbox, on by
 * default) and the reply says whether it was; an invited user shows "Invitation emailed <date>" and a "Resend
 * invitation" button, which makes a new link (the old one stops working). The link is still shown once for copying.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  inviteResendReplySchema,
  inviteResponseSchema,
  PACKAGE_TIERS,
  USER_ROLES,
  roleHasSeat,
  type InviteResendReply,
  type PackageTier,
  type UserRole,
  type UserWithSeat,
} from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { can } from '../auth/permissions';
import { CopyButton } from '../components/CopyButton';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Spinner } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { usePageTitle } from '../hooks/usePageTitle';
import { api, errorMessage } from '../lib/api';
import { usersApi } from '../lib/endpoints';
import { fmtDateTime, fmtRoleName, fmtTier } from '../lib/format';
import { useAuthOptions } from '../pages/LoginPage';

/** What an invite or a resend produced, shown once (the link is not retrievable later). */
type LinkResult = { url: string; email: string; mailed: boolean; mailTried: boolean; resent: boolean };

function linkMessage(r: LinkResult): { tone: 'green' | 'amber'; text: string } {
  const what = r.resent ? 'A new invitation link was made; the earlier link no longer works.' : 'Invitation created.';
  if (r.mailed) return { tone: 'green', text: `${what} It was emailed to ${r.email}. You can also share the link below; it is shown only once.` };
  if (r.mailTried)
    return { tone: 'amber', text: `${what} The email to ${r.email} could not be sent. Share the link below securely; it is shown only once.` };
  return { tone: 'green', text: `${what} No email was sent. Share the link below securely; it is shown only once.` };
}

function LinkPanel({ result }: { result: LinkResult }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [result]);
  const m = linkMessage(result);
  return (
    <div ref={ref} tabIndex={-1} className="mt-3 flex flex-col gap-2 outline-none" aria-live="polite">
      <Alert tone={m.tone}>{m.text}</Alert>
      <code className="break-all rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{result.url}</code>
      <CopyButton text={result.url} label="Copy invitation link" />
    </div>
  );
}

function InviteForm({ onInvited, inviteMail }: { onInvited: () => void; inviteMail: boolean }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('technician');
  const [tier, setTier] = useState<PackageTier>('p1_browser');
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const to = email.trim();
    const mailTried = inviteMail && sendEmail;
    try {
      const r = await api.post<{ inviteUrl: string; mailed?: boolean }>(
        '/users/invite',
        { email: to, name: name.trim(), role, ...(roleHasSeat(role) ? { tier } : {}), ...(inviteMail ? { sendEmail } : {}) },
        { schema: inviteResponseSchema },
      );
      setResult({ url: r.inviteUrl, email: to, mailed: r.mailed === true, mailTried, resent: false });
      setEmail('');
      setName('');
      onInvited();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Invite a user">
      <form onSubmit={(e) => void submit(e)} className="grid gap-3 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <Field label="Email">{(p) => <Input id={p.id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Name">{(p) => <Input id={p.id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Role">
          {(p) => (
            <Select id={p.id} value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
              {USER_ROLES.map((r) => <option key={r} value={r}>{fmtRoleName(r)}</option>)}
            </Select>
          )}
        </Field>
        {roleHasSeat(role) && (
          <Field label="Seat tier">
            {(p) => (
              <Select id={p.id} value={tier} onChange={(e) => setTier(e.target.value as PackageTier)}>
                {PACKAGE_TIERS.map((t) => <option key={t} value={t}>{fmtTier(t)}</option>)}
              </Select>
            )}
          </Field>
        )}
        {inviteMail && (
          <label className="flex min-h-10 items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="h-4 w-4" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
            Email the invitation to this address
          </label>
        )}
        <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? 'Creating...' : 'Create invitation'}</Button></div>
      </form>
      {result && <LinkPanel result={result} />}
    </Card>
  );
}

function UserRow({
  u,
  manage,
  inviteMail,
  onChanged,
  onResent,
}: {
  u: UserWithSeat;
  manage: boolean;
  inviteMail: boolean;
  onChanged: (e?: string) => void;
  onResent: (r: LinkResult) => void;
}) {
  const [role, setRole] = useState<UserRole>(u.role);
  const [tier, setTier] = useState<PackageTier>(u.seat?.tier ?? 'p1_browser');
  const [resending, setResending] = useState(false);
  const save = async () => {
    try {
      await usersApi.changeRole(u.id, role, roleHasSeat(role) ? tier : undefined);
      onChanged();
    } catch (e) {
      onChanged(errorMessage(e));
    }
  };
  const toggle = async () => {
    try {
      await usersApi.changeStatus(u.id, u.status === 'disabled' ? 'active' : 'disabled');
      onChanged();
    } catch (e) {
      onChanged(errorMessage(e));
    }
  };
  const resend = async () => {
    setResending(true);
    try {
      const r = await api.post<InviteResendReply>(`/users/${encodeURIComponent(u.id)}/invite/resend`, {}, { schema: inviteResendReplySchema });
      onResent({ url: r.inviteUrl, email: u.email, mailed: r.mailed, mailTried: inviteMail, resent: true });
      onChanged();
    } catch (e) {
      onChanged(errorMessage(e));
    } finally {
      setResending(false);
    }
  };
  return (
    <tr className="border-b border-slate-100 align-top dark:border-slate-800">
      <td className="py-2 pr-3"><div className="font-medium">{u.name}</div><div className="text-xs">{u.email}</div></td>
      <td className="py-2 pr-3">
        {manage ? (
          <Select aria-label={`Role of ${u.name}`} value={role} onChange={(e) => setRole(e.target.value as UserRole)} className="w-44">
            {USER_ROLES.map((r) => <option key={r} value={r}>{fmtRoleName(r)}</option>)}
          </Select>
        ) : fmtRoleName(u.role)}
      </td>
      <td className="py-2 pr-3">
        {manage && roleHasSeat(role) ? (
          <Select aria-label={`Seat tier of ${u.name}`} value={tier} onChange={(e) => setTier(e.target.value as PackageTier)} className="w-44">
            {PACKAGE_TIERS.map((t) => <option key={t} value={t}>{fmtTier(t)}</option>)}
          </Select>
        ) : u.seat ? fmtTier(u.seat.tier) : '-'}
      </td>
      <td className="py-2 pr-3">
        <Badge tone={u.status === 'active' ? 'green' : u.status === 'invited' ? 'amber' : 'red'}>{u.status}</Badge>
        {u.status === 'invited' && u.inviteMailedAt && (
          <div className="mt-1 text-xs text-slate-700 dark:text-slate-300">Invitation emailed {fmtDateTime(u.inviteMailedAt)}</div>
        )}
      </td>
      <td className="py-2 pr-3 text-xs">{fmtDateTime(u.lastLoginAt)}</td>
      {manage && (
        <td className="py-2">
          <div className="flex flex-wrap gap-1">
            <Button size="sm" onClick={() => void save()} disabled={role === u.role && tier === (u.seat?.tier ?? 'p1_browser')}>Save</Button>
            <Button size="sm" variant={u.status === 'disabled' ? 'secondary' : 'danger'} onClick={() => void toggle()}>
              {u.status === 'disabled' ? 'Enable' : 'Disable'}
            </Button>
            {u.status === 'invited' && (
              <Button size="sm" variant="secondary" aria-label={`Resend invitation to ${u.name}`} onClick={() => void resend()} disabled={resending}>
                {resending ? 'Resending...' : 'Resend invitation'}
              </Button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

export function UsersPage() {
  usePageTitle('Users');
  const { me } = useAuth();
  const manage = can(me?.user.role, 'users.manage');
  const options = useAuthOptions();
  const inviteMail = can(me?.user.role, 'users.invite_mail') && (options?.inviteMail ?? false);
  const users = useAsync(() => usersApi.list(), []);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState<LinkResult | null>(null);
  return (
    <>
      <PageHeader title="Users" />
      {manage && <div className="mb-4"><InviteForm onInvited={users.reload} inviteMail={inviteMail} /></div>}
      {error && <Alert>{error}</Alert>}
      {resent && (
        <div className="mb-4">
          <Card title="Invitation sent again">
            <LinkPanel result={resent} />
          </Card>
        </div>
      )}
      <Card>
        {users.loading && <Spinner label="Loading users" />}
        {Boolean(users.error) && <Alert>{errorMessage(users.error)}</Alert>}
        {users.data && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Users</caption>
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-700 dark:text-slate-400">
                <tr>
                  <th scope="col" className="py-2 pr-3">User</th>
                  <th scope="col" className="py-2 pr-3">Role</th>
                  <th scope="col" className="py-2 pr-3">Seat tier</th>
                  <th scope="col" className="py-2 pr-3">Status</th>
                  <th scope="col" className="py-2 pr-3">Last login</th>
                  {manage && <th scope="col" className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((u) => (
                  <UserRow
                    key={u.id}
                    u={u}
                    manage={manage}
                    inviteMail={inviteMail}
                    onChanged={(e) => { setError(e ?? null); if (!e) users.reload(); }}
                    onResent={(r) => { setError(null); setResent(r); }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
