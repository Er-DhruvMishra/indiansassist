/**
 * `/app/fleet` (docs/specs/phase-d-contracts.md section 13.4): the fleet console. A filterable, sortable device table
 * (name, group, tags, online, who is at the device, last seen, OS and versions, tamper badge with text, cold power
 * on, unattended mode), a group sidebar with each group's policy editor, and bulk group / tag actions for an
 * org_admin. Every status carries text as well as colour (section 13.5).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { DEVICE_STATUSES, type Device, type DeviceGroup, type UnattendedPolicy } from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { fmtDateTime, shortId } from '../../lib/format';
import { devicesApi, deviceGroupsApi, fleetPolicyApi } from '../../lib/fleetApi';
import { coldPowerOnText, onlineBadge, presenceShort, refusalText, tamperBadge, UNATTENDED_MODE_TEXT, unattendedModeTone } from './fleetText';
import { effectivePolicy } from './policyRules';

type SortKey = 'name' | 'group' | 'online' | 'lastSeenAt' | 'tamperState';

export function FleetPage() {
  usePageTitle('Fleet');
  const { me } = useAuth();
  const role = me?.user.role;
  const admin = can(role, 'fleet.admin');
  const [filters, setFilters] = useState<{ q: string; group: string; tag: string; status: string; online: string }>({
    q: '',
    group: '',
    tag: '',
    status: '',
    online: '',
  });
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useAsync(() => deviceGroupsApi.list(), []);
  const orgPolicy = useAsync(() => fleetPolicyApi.getUnattended(), []);
  const devices = useAsync(
    () =>
      devicesApi.list({
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.group ? { group: filters.group } : {}),
        ...(filters.tag ? { tag: filters.tag } : {}),
        ...(filters.status ? { status: filters.status as Device['status'] } : {}),
        ...(filters.online ? { online: filters.online === 'true' } : {}),
        limit: 200,
      }),
    [filters.q, filters.group, filters.tag, filters.status, filters.online],
  );

  const groupById = useMemo(() => new Map((groups.data?.items ?? []).map((g) => [g.id, g])), [groups.data]);
  const items = useMemo(() => {
    const list = [...(devices.data?.items ?? [])];
    const key = sort.key;
    list.sort((a, b) => {
      const va = sortValue(a, key, groupById);
      const vb = sortValue(b, key, groupById);
      return va < vb ? -sort.dir : va > vb ? sort.dir : a.name.localeCompare(b.name);
    });
    return list;
  }, [devices.data, sort, groupById]);

  // `Device` (section 13.1a) carries no `unattendedPolicy`, so the list can only show what a device inherits from its
  // group and the org default; a per-device override is visible on the device's own page (`GET /devices/:id.policy`).
  const inheritedMode = (d: Device): UnattendedPolicy | null =>
    orgPolicy.data ? effectivePolicy(null, d.groupId ? (groupById.get(d.groupId) ?? null) : null, orgPolicy.data) : null;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulk = async (patch: { groupId?: string | null; tags?: string[] }) => {
    setError(null);
    setNotice(null);
    const ids = [...selected];
    let done = 0;
    for (const id of ids) {
      try {
        await devicesApi.patch(id, patch);
        done += 1;
      } catch (e) {
        setError(refusalText(e, `Device ${shortId(id)} could not be changed.`));
        break;
      }
    }
    setNotice(`${done} of ${ids.length} device${ids.length === 1 ? '' : 's'} changed.`);
    setSelected(new Set());
    devices.reload();
  };

  return (
    <>
      <PageHeader title="Fleet">
        {admin && (
          <Link to="/app/fleet/groups" className="text-sm font-medium text-teal-800 underline dark:text-teal-300">
            Groups and policy
          </Link>
        )}
      </PageHeader>

      <div className="grid gap-4 xl:grid-cols-[18rem_1fr]">
        <div className="flex flex-col gap-4">
          <Card title="Groups">
            {groups.loading && <Spinner label="Loading groups" />}
            {Boolean(groups.error) && <Alert>{refusalText(groups.error, 'Groups could not be loaded.')}</Alert>}
            {groups.data && (
              <nav aria-label="Device groups">
                <ul className="flex flex-col gap-1 text-sm">
                  <li>
                    <GroupButton active={filters.group === ''} label="Every device" onClick={() => setFilters((f) => ({ ...f, group: '' }))} />
                  </li>
                  {groups.data.items.map((g) => (
                    <li key={g.id} className="flex items-center gap-1">
                      <GroupButton active={filters.group === g.id} label={g.name} onClick={() => setFilters((f) => ({ ...f, group: g.id }))} />
                      {admin && (
                        <Link
                          to={`/app/fleet/groups?group=${g.id}`}
                          aria-label={`Edit the policy of ${g.name}`}
                          className="shrink-0 text-xs font-medium text-teal-800 underline dark:text-teal-300"
                        >
                          Policy
                        </Link>
                      )}
                    </li>
                  ))}
                  <li>
                    <GroupButton active={filters.group === 'none'} label="No group (org default policy)" onClick={() => setFilters((f) => ({ ...f, group: 'none' }))} />
                  </li>
                </ul>
              </nav>
            )}
            {admin && (
              <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
                &quot;Policy&quot; opens that group&apos;s unattended policy editor. Creating and deleting groups, technician group assignment and the
                fleet-scoping switch are on the{' '}
                <Link to="/app/fleet/groups" className="underline">
                  groups and policy
                </Link>{' '}
                page.
              </p>
            )}
          </Card>
          {orgPolicy.data && (
            <Card title="Organisation default policy">
              <p className="text-sm">{UNATTENDED_MODE_TEXT[orgPolicy.data.mode]}</p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                {orgPolicy.data.recordingRequired ? 'Recording is required.' : 'Recording is not required.'} It applies to any device without a group.
              </p>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Filters">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Search name or tag">
                {(f) => <Input id={f.id} value={filters.q} onChange={(e) => setFilters((x) => ({ ...x, q: e.target.value }))} />}
              </Field>
              <Field label="Tag">{(f) => <Input id={f.id} value={filters.tag} onChange={(e) => setFilters((x) => ({ ...x, tag: e.target.value }))} />}</Field>
              <Field label="Status">
                {(f) => (
                  <Select id={f.id} value={filters.status} onChange={(e) => setFilters((x) => ({ ...x, status: e.target.value }))}>
                    <option value="">Any status</option>
                    {DEVICE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Connection">
                {(f) => (
                  <Select id={f.id} value={filters.online} onChange={(e) => setFilters((x) => ({ ...x, online: e.target.value }))}>
                    <option value="">Online and offline</option>
                    <option value="true">Online only</option>
                    <option value="false">Offline only</option>
                  </Select>
                )}
              </Field>
            </div>
          </Card>

          {notice && <Alert tone="blue">{notice}</Alert>}
          {error && <Alert>{error}</Alert>}

          {admin && selected.size > 0 && (
            <Card title={`${selected.size} device${selected.size === 1 ? '' : 's'} selected`}>
              <BulkActions groups={groups.data?.items ?? []} onApply={(p) => void bulk(p)} onClear={() => setSelected(new Set())} />
            </Card>
          )}

          <Card>
            {devices.loading && <Spinner label="Loading devices" />}
            {Boolean(devices.error) && <Alert>{refusalText(devices.error, 'The device list could not be loaded.')}</Alert>}
            {devices.data && items.length === 0 && (
              <p className="text-sm">
                No devices match. Devices appear here once the installed agent enrols with an enrollment token.
              </p>
            )}
            {items.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Devices in the fleet</caption>
                  <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-700 dark:text-slate-400">
                    <tr>
                      {admin && (
                        <th scope="col" className="py-2 pr-2">
                          <span className="sr-only">Select</span>
                        </th>
                      )}
                      <SortHeader label="Device" k="name" sort={sort} onSort={setSort} />
                      <SortHeader label="Group" k="group" sort={sort} onSort={setSort} />
                      <SortHeader label="Connection" k="online" sort={sort} onSort={setSort} />
                      <th scope="col" className="py-2 pr-3">At the device</th>
                      <SortHeader label="Last seen" k="lastSeenAt" sort={sort} onSort={setSort} />
                      <th scope="col" className="py-2 pr-3">Windows / versions</th>
                      <SortHeader label="Tamper" k="tamperState" sort={sort} onSort={setSort} />
                      <th scope="col" className="py-2 pr-3">Unattended (inherited)</th>
                      <th scope="col" className="py-2 pr-3">Cold power on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((d) => (
                      <DeviceRow
                        key={d.id}
                        d={d}
                        group={d.groupId ? (groupById.get(d.groupId) ?? null) : null}
                        policy={inheritedMode(d)}
                        selectable={admin}
                        checked={selected.has(d.id)}
                        onToggle={() => toggle(d.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {items.length > 0 && (
              <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
                The unattended column is what each device inherits from its group and the organisation default. A device with its own override shows its
                effective policy on its own page.
              </p>
            )}
            {devices.data?.nextCursor && (
              <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
                Only the first {items.length} devices are shown. Narrow the filters to see the rest.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function GroupButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      className={`block w-full rounded px-2 py-1 text-left ${active ? 'bg-teal-700 text-white' : 'hover:bg-slate-200 dark:hover:bg-slate-800'}`}
    >
      {label}
    </button>
  );
}

function SortHeader({ label, k, sort, onSort }: { label: string; k: SortKey; sort: { key: SortKey; dir: 1 | -1 }; onSort: (s: { key: SortKey; dir: 1 | -1 }) => void }) {
  const active = sort.key === k;
  return (
    <th scope="col" className="py-2 pr-3" aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="font-semibold uppercase underline-offset-2 hover:underline" onClick={() => onSort({ key: k, dir: active && sort.dir === 1 ? -1 : 1 })}>
        {label}
      </button>
    </th>
  );
}

export function DeviceRow({
  d,
  group,
  policy,
  selectable,
  checked,
  onToggle,
}: {
  d: Device;
  group: DeviceGroup | null;
  policy: UnattendedPolicy | null;
  selectable: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const on = onlineBadge(d);
  const tamper = tamperBadge(d.tamperState);
  return (
    <tr className="border-b border-slate-100 align-top dark:border-slate-800">
      {selectable && (
        <td className="py-2 pr-2">
          <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Select ${d.name}`} />
        </td>
      )}
      <td className="py-2 pr-3">
        <Link to={`/app/fleet/${d.id}`} className="font-medium text-teal-800 underline dark:text-teal-300">
          {d.name}
        </Link>
        <div className="flex flex-wrap gap-1 pt-1">
          {d.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
        {d.status !== 'enrolled' && <div className="text-xs">{d.status}</div>}
      </td>
      <td className="py-2 pr-3">{group?.name ?? 'No group'}</td>
      <td className="py-2 pr-3">
        <Badge tone={on.tone}>{on.text}</Badge>
      </td>
      <td className="py-2 pr-3 text-xs">{presenceShort(d.interactive)}</td>
      <td className="py-2 pr-3 text-xs">{fmtDateTime(d.lastSeenAt)}</td>
      <td className="py-2 pr-3 text-xs">
        <div>{d.osVersion ?? '-'}</div>
        <div>
          service {d.serviceVersion ?? '-'} / worker {d.agentVersion ?? '-'}
        </div>
      </td>
      <td className="py-2 pr-3">
        <Badge tone={tamper.tone}>{tamper.text}</Badge>
      </td>
      <td className="py-2 pr-3">{policy ? <Badge tone={unattendedModeTone(policy.mode)}>{UNATTENDED_MODE_TEXT[policy.mode]}</Badge> : <span className="text-xs">-</span>}</td>
      <td className="py-2 pr-3 text-xs">{coldPowerOnText(d.amt)}</td>
    </tr>
  );
}

function BulkActions({ groups, onApply, onClear }: { groups: DeviceGroup[]; onApply: (p: { groupId?: string | null; tags?: string[] }) => void; onClear: () => void }) {
  const [groupId, setGroupId] = useState('');
  const [tags, setTags] = useState('');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-slate-600 dark:text-slate-400">
        A group change moves the devices onto that group&apos;s default policy at once. Each change is audited as `device.updated`.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Move to group">
          {(f) => (
            <Select id={f.id} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Leave the group unchanged</option>
              <option value="none">No group (org default policy)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Replace tags with" hint="Comma separated; leave empty to keep the current tags.">
          {(f) => <Input id={f.id} aria-describedby={f.describedBy} value={tags} onChange={(e) => setTags(e.target.value)} />}
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={groupId === '' && tags.trim() === ''}
          onClick={() =>
            onApply({
              ...(groupId === '' ? {} : { groupId: groupId === 'none' ? null : groupId }),
              ...(tags.trim() === '' ? {} : { tags: tags.split(',').map((t) => t.trim()).filter(Boolean) }),
            })
          }
        >
          Apply to the selected devices
        </Button>
        <Button variant="secondary" onClick={onClear}>
          Clear the selection
        </Button>
      </div>
    </div>
  );
}

function sortValue(d: Device, k: SortKey, groups: Map<string, DeviceGroup>): string | number {
  if (k === 'name') return d.name.toLowerCase();
  if (k === 'group') return (d.groupId ? groups.get(d.groupId)?.name : '') ?? '';
  if (k === 'online') return d.online ? 0 : 1;
  if (k === 'tamperState') return d.tamperState === 'alerted' ? 0 : d.tamperState === 'suspected' ? 1 : 2;
  return d.lastSeenAt ? -new Date(d.lastSeenAt).getTime() : 0;
}
