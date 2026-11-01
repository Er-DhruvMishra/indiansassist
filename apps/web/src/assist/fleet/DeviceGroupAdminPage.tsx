/**
 * `DeviceGroupAdmin` (docs/specs/phase-d-contracts.md sections 7.1, 7.2, 13.4): group create / rename / delete with
 * the group's default policy (the `UnattendedPolicyEditor` in override mode), default tags and receipt address, the
 * organisation default policy, technician group assignment (`PUT /users/:id/device-groups`) and the fleet-scoping
 * switch with its explanation that unassigned technicians lose fleet access while it is on. Every save is audited by
 * the server. org_admin only.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { DeviceGroup, UnattendedPolicy, UnattendedPolicyPatch, UserWithSeat } from '@indiansassist/shared';
import { Alert, Button, Card, Field, Input, PageHeader, Spinner } from '../../components/ui';
import { Dialog } from '../../components/Dialog';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { usersApi } from '../../lib/endpoints';
import { deviceGroupsApi, fleetPolicyApi } from '../../lib/fleetApi';
import { fmtRoleName } from '../../lib/format';
import { refusalText, UNATTENDED_MODE_TEXT } from './fleetText';
import { allowedHoursSummary, effectivePolicy, overriddenKeys, POLICY_FIELD_LABELS } from './policyRules';
import { UnattendedPolicyEditor } from './UnattendedPolicyEditor';

export function DeviceGroupAdminPage() {
  usePageTitle('Device groups and policy');
  const groups = useAsync(() => deviceGroupsApi.list(), []);
  const orgPolicy = useAsync(() => fleetPolicyApi.getUnattended(), []);
  const fleet = useAsync(() => fleetPolicyApi.getFleet(), []);
  const users = useAsync(() => usersApi.list(), []);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The fleet console's group sidebar links straight to one group's policy editor (`?group=<id>`).
  const [params] = useSearchParams();
  const [openGroup, setOpenGroup] = useState<string | null>(params.get('group'));

  const say = (ok: string | null, e?: unknown) => {
    setNotice(ok);
    setError(e === undefined ? null : refusalText(e, 'That change was refused.'));
  };

  return (
    <>
      <PageHeader title="Device groups and policy">
        <Link to="/app/fleet" className="text-sm font-medium text-teal-800 underline dark:text-teal-300">
          Back to the fleet
        </Link>
      </PageHeader>

      {notice && (
        <div className="mb-3" aria-live="polite">
          <Alert tone="green">{notice}</Alert>
        </div>
      )}
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Card title="Fleet settings">
          {fleet.loading && <Spinner label="Loading the fleet settings" />}
          {fleet.data && (
            <div className="flex flex-col gap-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={fleet.data.fleetScopingEnabled}
                  onChange={(e) => {
                    const on = e.target.checked;
                    void fleetPolicyApi
                      .setFleet({ fleetScopingEnabled: on })
                      .then((r) => {
                        fleet.setData(r);
                        say(on ? 'Group scoping is on. A technician now sees only their assigned groups.' : 'Group scoping is off. Every technician sees the whole organisation.');
                      })
                      .catch((err: unknown) => say(null, err));
                  }}
                />
                <span>
                  Limit each technician to their assigned device groups
                  <span className="block text-xs text-slate-600 dark:text-slate-400">
                    While this is off, every technician&apos;s device scope is the whole organisation and the assignments below are ignored. Once it is on, a
                    technician with no groups assigned has <strong>no fleet access at all</strong>, and devices without a group are reachable only by senior
                    technicians and org admins.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={fleet.data.wakerMeshEnabled}
                  onChange={(e) => {
                    const on = e.target.checked;
                    void fleetPolicyApi
                      .setFleet({ wakerMeshEnabled: on })
                      .then((r) => {
                        fleet.setData(r);
                        say(on ? 'Devices may act as wakers for their own network.' : 'The waker mesh is off. Wake on LAN will report that no waker is available.');
                      })
                      .catch((err: unknown) => say(null, err));
                  }}
                />
                <span>
                  Let devices wake each other on their own network
                  <span className="block text-xs text-slate-600 dark:text-slate-400">
                    A device asked to wake a peer only ever sends one magic packet and learns only that one address. With this off, waking needs AMT.
                  </span>
                </span>
              </label>
            </div>
          )}
          {Boolean(fleet.error) && <Alert>{refusalText(fleet.error, 'The fleet settings could not be loaded.')}</Alert>}
        </Card>

        <Card title="Organisation default policy">
          {orgPolicy.loading && <Spinner label="Loading the organisation policy" />}
          {orgPolicy.data && (
            <UnattendedPolicyEditor
              title="Every device without a group, and the starting point for every group"
              mode="full"
              value={orgPolicy.data}
              onSaveFull={(p) =>
                void fleetPolicyApi
                  .setUnattended(p)
                  .then((r) => {
                    orgPolicy.setData(r);
                    say('The organisation default policy was saved and pushed to every enrolled device.');
                  })
                  .catch((e: unknown) => say(null, e))
              }
            />
          )}
          {Boolean(orgPolicy.error) && <Alert>{refusalText(orgPolicy.error, 'The organisation policy could not be loaded.')}</Alert>}
        </Card>

        <Card title="Groups">
          {groups.loading && <Spinner label="Loading groups" />}
          {Boolean(groups.error) && <Alert>{refusalText(groups.error, 'Groups could not be loaded.')}</Alert>}
          {groups.data && (
            <div className="flex flex-col gap-3">
              <NewGroupForm
                onCreated={() => {
                  groups.reload();
                  say('The group was created.');
                }}
                onError={(e) => say(null, e)}
              />
              {groups.data.items.length === 0 && <p className="text-sm">No groups yet. A device without a group follows the organisation default policy.</p>}
              <ul className="flex flex-col gap-3">
                {groups.data.items.map((g) => (
                  <li key={g.id}>
                    <GroupCard
                      g={g}
                      orgDefault={orgPolicy.data}
                      open={openGroup === g.id}
                      onToggle={() => setOpenGroup(openGroup === g.id ? null : g.id)}
                      onChanged={(m) => {
                        groups.reload();
                        say(m);
                      }}
                      onError={(e) => say(null, e)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card title="Which technician reaches which group">
          {users.loading && <Spinner label="Loading users" />}
          {users.data && groups.data && (
            <TechnicianAssignment
              users={users.data.items}
              groups={groups.data.items}
              scoping={fleet.data?.fleetScopingEnabled ?? false}
              onChanged={(m) => {
                users.reload();
                say(m);
              }}
              onError={(e) => say(null, e)}
            />
          )}
        </Card>
      </div>
    </>
  );
}

function NewGroupForm({ onCreated, onError }: { onCreated: () => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim().length < 1) return;
        setBusy(true);
        void deviceGroupsApi
          .create({ name: name.trim() })
          .then(() => {
            setName('');
            onCreated();
          })
          .catch(onError)
          .finally(() => setBusy(false));
      }}
    >
      <Field label="New group name">{(f) => <Input id={f.id} className="sm:w-64" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Button type="submit" disabled={busy || name.trim().length < 1}>
        Create the group
      </Button>
    </form>
  );
}

function GroupCard({
  g,
  orgDefault,
  open,
  onToggle,
  onChanged,
  onError,
}: {
  g: DeviceGroup;
  orgDefault: UnattendedPolicy | undefined;
  open: boolean;
  onToggle: () => void;
  onChanged: (message: string) => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState(g.name);
  const [tags, setTags] = useState(g.defaultTags.join(', '));
  const [email, setEmail] = useState(g.notifyEmail ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const merged = useMemo(() => (orgDefault ? effectivePolicy(null, g, orgDefault) : null), [orgDefault, g]);
  const overridden = useMemo(() => (orgDefault && merged ? overriddenKeys(orgDefault, merged) : []), [orgDefault, merged]);

  return (
    <section aria-label={`Group ${g.name}`} className="rounded border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{g.name}</h3>
        {merged && <span className="text-xs">{UNATTENDED_MODE_TEXT[merged.mode]}</span>}
        <span className="text-xs text-slate-600 dark:text-slate-400">
          {overridden.length === 0 ? 'Follows the organisation default' : `${overridden.length} field${overridden.length === 1 ? '' : 's'} overridden`}
        </span>
        <Button size="sm" variant="secondary" className="ml-auto" aria-expanded={open} onClick={onToggle}>
          {open ? 'Close' : 'Edit this group'}
        </Button>
      </div>
      {merged && (
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
          Allowed hours: {allowedHoursSummary(merged.allowedHours)}. {merged.recordingRequired ? 'Recording required.' : 'Recording not required.'}{' '}
          {overridden.length > 0 && `Overridden: ${overridden.map((k) => POLICY_FIELD_LABELS[k]).join(', ')}.`}
        </p>
      )}
      {open && (
        <div className="mt-3 flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name">{(f) => <Input id={f.id} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Default tags for new devices" hint="Comma separated.">
              {(f) => <Input id={f.id} aria-describedby={f.describedBy} value={tags} onChange={(e) => setTags(e.target.value)} />}
            </Field>
            <Field label="Receipt address" hint="Where unattended session and action receipts are mailed.">
              {(f) => <Input id={f.id} aria-describedby={f.describedBy} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                void deviceGroupsApi
                  .patch(g.id, {
                    name: name.trim(),
                    defaultTags: tags.split(',').map((t) => t.trim()).filter(Boolean),
                    notifyEmail: email.trim() === '' ? null : email.trim(),
                  })
                  .then(() => onChanged('The group was saved.'))
                  .catch(onError)
              }
            >
              Save the group
            </Button>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete the group
            </Button>
          </div>
          {orgDefault && merged && (
            <UnattendedPolicyEditor
              title={`Default policy for "${g.name}"`}
              mode="override"
              value={merged}
              inherited={orgDefault}
              override={g.defaultPolicy}
              inheritedLabel="the organisation default"
              onSavePatch={(patch: UnattendedPolicyPatch) =>
                void deviceGroupsApi
                  .patch(g.id, { defaultPolicy: patch })
                  .then(() => onChanged('The group policy was saved and pushed to its devices.'))
                  .catch(onError)
              }
            />
          )}
          <Dialog open={confirmDelete} title={`Delete the group "${g.name}"?`} onClose={() => setConfirmDelete(false)}>
            <p className="mb-4 text-sm">
              Its devices keep working and fall back to the organisation default policy. If group scoping is on, technicians assigned only to this group lose
              their fleet access.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                Keep the group
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void deviceGroupsApi
                    .remove(g.id)
                    .then(() => onChanged('The group was deleted; its devices fell back to the organisation default policy.'))
                    .catch(onError);
                }}
              >
                Delete the group
              </Button>
            </div>
          </Dialog>
        </div>
      )}
    </section>
  );
}

function TechnicianAssignment({
  users,
  groups,
  scoping,
  onChanged,
  onError,
}: {
  users: UserWithSeat[];
  groups: DeviceGroup[];
  scoping: boolean;
  onChanged: (message: string) => void;
  onError: (e: unknown) => void;
}) {
  const technicians = users.filter((u) => u.role === 'technician');
  return (
    <div className="flex flex-col gap-3">
      {!scoping && (
        <Alert tone="blue">
          Group scoping is off, so every technician reaches every device in the organisation and these assignments are not used yet. Turn it on above to apply
          them.
        </Alert>
      )}
      {technicians.length === 0 && <p className="text-sm">No technicians to assign. Senior technicians and org admins always reach the whole organisation.</p>}
      {technicians.map((u) => (
        <TechnicianRow key={u.id} u={u} groups={groups} onChanged={onChanged} onError={onError} />
      ))}
    </div>
  );
}

function TechnicianRow({
  u,
  groups,
  onChanged,
  onError,
}: {
  u: UserWithSeat;
  groups: DeviceGroup[];
  onChanged: (message: string) => void;
  onError: (e: unknown) => void;
}) {
  const current = u.deviceGroupIds ?? null;
  const [picked, setPicked] = useState<string[]>(current ?? []);
  const changed = JSON.stringify([...picked].sort()) !== JSON.stringify([...(current ?? [])].sort());
  return (
    <div className="flex flex-col gap-2 rounded border border-slate-200 p-2 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong>{u.name}</strong>
        <span className="text-xs text-slate-600 dark:text-slate-400">
          {u.email} ({fmtRoleName(u.role)})
        </span>
        {current === null && <span className="text-xs">No groups assigned: no fleet access while scoping is on.</span>}
      </div>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">{`Device groups for ${u.name}`}</legend>
        {groups.map((g) => (
          <label key={g.id} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={picked.includes(g.id)}
              aria-label={`${g.name} for ${u.name}`}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, g.id] : p.filter((x) => x !== g.id)))}
            />
            {g.name}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!changed}
          onClick={() =>
            void deviceGroupsApi
              .setUserGroups(u.id, picked.length === 0 ? null : picked)
              .then(() => onChanged(`The device groups of ${u.name} were saved.`))
              .catch(onError)
          }
        >
          Save
        </Button>
        {picked.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => setPicked([])}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
