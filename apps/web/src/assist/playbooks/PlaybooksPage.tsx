/**
 * /app/playbooks (org_admin, docs/specs/phase-c-contracts.md section 13.4): the org playbook catalogue (list,
 * create / edit, enable / disable, delete) and the Package 3 policy toggle "Require security-code confirmation
 * before control" (`requireSasConfirm`, section 1.3 step 7). The dashboard copy recommends server recording for P3.
 */
import { useState } from 'react';
import type { Playbook } from '@indiansassist/shared';
import { Dialog } from '../../components/Dialog';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { agentPolicyApi, playbooksApi } from '../../lib/agentApi';
import { errorMessage, isApiError } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { PlaybookEditor, draftOf, emptyDraft } from './PlaybookEditor';

export function AgentPolicyCard() {
  const policy = useAsync(() => agentPolicyApi.get(), []);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (on: boolean) => {
    setError(null);
    try {
      policy.setData(await agentPolicyApi.set(on));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Card title="Package 3 security">
      {policy.loading && <Spinner label="Loading policy" />}
      {policy.data && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={policy.data.requireSasConfirm} onChange={(e) => void toggle(e.target.checked)} />
          Require security-code confirmation before control
        </label>
      )}
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
        When on, a technician must type the 6-digit code the user reads out before controlling a computer. When off, the step can be skipped (the skip is
        recorded). Server recording is recommended for organisations that use Package 3.
      </p>
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}

function saveError(e: unknown): string {
  if (isApiError(e, 'playbook_name_taken')) return 'Another playbook already has this name.';
  if (isApiError(e, 'validation_failed')) {
    const lint = (e.details?.['lint'] as { errors?: string[] } | undefined)?.errors;
    return lint && lint.length > 0 ? lint.join(' ') : errorMessage(e);
  }
  return errorMessage(e);
}

export function PlaybooksPage() {
  usePageTitle('Playbooks');
  const list = useAsync(() => playbooksApi.list(), []);
  const [editing, setEditing] = useState<Playbook | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Playbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const replace = (p: Playbook) => list.setData({ items: [p, ...items.filter((x) => x.id !== p.id)], nextCursor: list.data?.nextCursor ?? null });

  const toggle = async (p: Playbook) => {
    setError(null);
    try {
      replace(await playbooksApi.update(p.id, { enabled: !p.enabled }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async (p: Playbook) => {
    setError(null);
    try {
      await playbooksApi.remove(p.id);
      list.setData({ items: items.filter((x) => x.id !== p.id), nextCursor: list.data?.nextCursor ?? null });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <PageHeader title="Playbooks">
        <Button onClick={() => setEditing('new')}>New playbook</Button>
      </PageHeader>
      <div className="flex flex-col gap-4">
        <AgentPolicyCard />
        {error && <Alert>{error}</Alert>}
        <Card title="Approved scripts">
          {list.loading && <Spinner label="Loading playbooks" />}
          {Boolean(list.error) && <Alert>{errorMessage(list.error)}</Alert>}
          {!list.loading && items.length === 0 && !list.error && <p className="text-sm">No playbooks yet.</p>}
          <ul className="flex flex-col gap-2">
            {items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 rounded border border-slate-200 p-2 text-sm dark:border-slate-700">
                <span className="font-medium">{p.name}</span>
                <Badge>{p.interpreter}</Badge>
                {p.requiresElevation && <Badge tone="red">admin</Badge>}
                <Badge tone={p.enabled ? 'green' : 'neutral'}>{p.enabled ? 'enabled' : 'disabled'}</Badge>
                <span className="font-mono text-xs" title="sha256 of the body">
                  {p.bodyHash.slice(0, 12)}
                </span>
                <span className="text-xs text-slate-600 dark:text-slate-400">updated {fmtDateTime(p.updatedAt)}</span>
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void toggle(p)}>
                    {p.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleting(p)}>
                    Delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Dialog open={editing !== null} wide title={editing === 'new' ? 'New playbook' : 'Edit playbook'} onClose={() => setEditing(null)}>
        {editing !== null && (
          <PlaybookEditor
            initial={editing === 'new' ? emptyDraft() : draftOf(editing)}
            onCancel={() => setEditing(null)}
            onSave={async (d) => {
              try {
                replace(editing === 'new' ? await playbooksApi.create(d) : await playbooksApi.update(editing.id, d));
                setEditing(null);
                return null;
              } catch (e) {
                return saveError(e);
              }
            }}
          />
        )}
      </Dialog>
      <Dialog open={deleting !== null} title="Delete this playbook?" onClose={() => setDeleting(null)}>
        <p className="mb-4 text-sm">Prefer Disable: past runs stay in the audit log either way. Deleting removes it from the catalogue.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
            Delete playbook
          </Button>
        </div>
      </Dialog>
    </>
  );
}
