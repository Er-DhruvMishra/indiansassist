/** /app/users (contracts section 6.6): invite, role and seat tier change, enable / disable (org_admin). */
import { useState, type FormEvent } from 'react';
import { PACKAGE_TIERS, USER_ROLES, roleHasSeat, type PackageTier, type UserRole, type UserWithSeat } from '@indiansassist/shared';
import { useAuth } from '../auth/AuthContext';
import { can } from '../auth/permissions';
import { CopyButton } from '../components/CopyButton';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Spinner } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { usePageTitle } from '../hooks/usePageTitle';
import { errorMessage } from '../lib/api';
import { usersApi } from '../lib/endpoints';
import { fmtDateTime, fmtRoleName, fmtTier } from '../lib/format';

function InviteForm({ onInvited }: { onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('technician');
  const [tier, setTier] = useState<PackageTier>('p1_browser');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await usersApi.invite({ email: email.trim(), name: name.trim(), role, ...(roleHasSeat(role) ? { tier } : {}) });
      setUrl(r.inviteUrl);
      setEmail('');
      setName('');
      onInvited();
    } catch (err) {
      setError(errorMessage(err));
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
        <div className="sm:col-span-2"><Button type="submit">Create invitation</Button></div>
      </form>
      {url && (
        <div className="mt-3 flex flex-col gap-2" aria-live="polite">
          <Alert tone="green">Invitation created. No email is sent in this version; share the link securely. It is shown only once.</Alert>
          <code className="break-all rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{url}</code>
          <CopyButton text={url} label="Copy invitation link" />
        </div>
      )}
    </Card>
  );
}

function UserRow({ u, manage, onChanged }: { u: UserWithSeat; manage: boolean; onChanged: (e?: string) => void }) {
  const [role, setRole] = useState<UserRole>(u.role);
  const [tier, setTier] = useState<PackageTier>(u.seat?.tier ?? 'p1_browser');
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
      <td className="py-2 pr-3"><Badge tone={u.status === 'active' ? 'green' : u.status === 'invited' ? 'amber' : 'red'}>{u.status}</Badge></td>
      <td className="py-2 pr-3 text-xs">{fmtDateTime(u.lastLoginAt)}</td>
      {manage && (
        <td className="py-2">
          <div className="flex flex-wrap gap-1">
            <Button size="sm" onClick={() => void save()} disabled={role === u.role && tier === (u.seat?.tier ?? 'p1_browser')}>Save</Button>
            <Button size="sm" variant={u.status === 'disabled' ? 'secondary' : 'danger'} onClick={() => void toggle()}>
              {u.status === 'disabled' ? 'Enable' : 'Disable'}
            </Button>
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
  const users = useAsync(() => usersApi.list(), []);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Users" />
      {manage && <div className="mb-4"><InviteForm onInvited={users.reload} /></div>}
      {error && <Alert>{error}</Alert>}
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
                  <UserRow key={u.id} u={u} manage={manage} onChanged={(e) => { setError(e ?? null); if (!e) users.reload(); }} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
