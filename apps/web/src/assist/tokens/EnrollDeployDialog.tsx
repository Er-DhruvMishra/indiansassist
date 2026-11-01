/**
 * "Install and enroll" for one enrollment token (Phase D section 13.4 tokens-page row, 12.1 channels): the group
 * selector, the signed `enroll.iaconfig` download from `GET /devices/enroll-config` (org_admin), and the GPO /
 * Intune copy-paste snippets of that same signed config. The value is a secret, so it is copied, not shown, until
 * the technician asks to see it.
 */
import { useState } from 'react';
import type { Token } from '@indiansassist/shared';
import { CopyButton } from '../../components/CopyButton';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Field, Select, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { saveText } from '../../lib/agentApi';
import { errorMessage } from '../../lib/api';
import { deviceGroupsApi } from '../../lib/fleetApi';
import { ENROLL_SECRET_TEXT, enrollConfigApi, enrollmentUsage, gpoSnippet, iaEnrollValue, intuneSnippet, MSI_FILE_NAME } from './enroll';

export function EnrollDeployDialog({
  token,
  orgName,
  open,
  onClose,
}: {
  token: Token | null;
  orgName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [groupId, setGroupId] = useState('');
  const [config, setConfig] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useAsync(async () => (open ? (await deviceGroupsApi.list()).items : []), [open]);

  const close = () => {
    setConfig(null);
    setRevealed(false);
    setError(null);
    onClose();
  };

  const issue = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await enrollConfigApi.get(token.id, groupId || undefined);
      setConfig(r.iaconfig);
    } catch (e) {
      setConfig(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const usage = token ? enrollmentUsage(token) : null;
  const iaEnroll = config ? iaEnrollValue(config) : null;
  const gpo = iaEnroll ? gpoSnippet(iaEnroll, orgName) : null;
  const intune = iaEnroll ? intuneSnippet(iaEnroll) : null;

  return (
    <Dialog open={open && token !== null} title="Install and enroll devices with this token" onClose={close} wide>
      {token && usage && (
        <div className="flex flex-col gap-4">
          <Alert tone="amber">{ENROLL_SECRET_TEXT}</Alert>
          <p data-testid="enroll-usage" className="text-sm">
            This token has enrolled <strong>{usage.enrolled}</strong> of <strong>{usage.max}</strong> devices;{' '}
            {usage.full ? 'it can enroll no more.' : `${usage.remaining} left.`} One config serves the whole rollout
            wave; issue a new token when it runs out.
          </p>
          <Field label="Device group" hint="The group is fixed inside the signed config and cannot be changed later.">
            {(p) => (
              <Select
                id={p.id}
                aria-describedby={p.describedBy}
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value);
                  setConfig(null);
                  setRevealed(false);
                }}
              >
                <option value="">No group (the organisation default policy applies)</option>
                {(groups.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {groups.loading && <Spinner label="Loading device groups" />}
          {Boolean(groups.error) && <Alert tone="amber">Device groups could not be loaded; you can still enroll without a group.</Alert>}
          {error && <Alert>{error}</Alert>}
          <div>
            <Button onClick={() => void issue()} disabled={busy}>
              {config ? 'Issue a fresh config' : 'Get the signed enrollment config'}
            </Button>
          </div>
          {config && iaEnroll && gpo && intune && (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                Step 1: take the signed base installer <span className="font-mono text-xs">{MSI_FILE_NAME}</span> from your
                release share. This server does not serve the MSI itself. Step 2: hand it the config below, as a transform
                (GPO) or as the <span className="font-mono text-xs">IA_ENROLL</span> property (Intune, msiexec).
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" onClick={() => saveText(config, 'enroll.iaconfig')}>
                  Download enroll.iaconfig
                </Button>
                <CopyButton variant="secondary" text={iaEnroll} label="Copy the IA_ENROLL value" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton variant="secondary" text={gpo} label="Copy the GPO snippet" />
                <CopyButton variant="secondary" text={intune} label="Copy the Intune snippet" />
                <Button variant="ghost" onClick={() => setRevealed((v) => !v)}>
                  {revealed ? 'Hide the secret value' : 'Show the secret value'}
                </Button>
              </div>
              {revealed && (
                <div className="flex flex-col gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">Group Policy (MSI + MST)</h3>
                    <pre data-testid="gpo-snippet" className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">
                      {gpo}
                    </pre>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">Intune</h3>
                    <pre data-testid="intune-snippet" className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">
                      {intune}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
