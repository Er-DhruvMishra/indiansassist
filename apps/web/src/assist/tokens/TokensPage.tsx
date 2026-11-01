/**
 * /app/tokens: create dialog, status filter, list with copy link / copy short code / QR / revoke. Phase D
 * section 13.4: an enrollment token also shows `devicesEnrolled / maxDevices` with a warning as it fills or
 * nears expiry, and an org_admin can take the signed enrollment config and the deployment snippets from it.
 */
import { useState } from 'react';
import { TOKEN_STATUSES, type Token, type TokenStatus } from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { CopyButton } from '../../components/CopyButton';
import { Dialog } from '../../components/Dialog';
import { QrCode } from '../../components/QrCode';
import { Alert, Badge, Button, Card, PageHeader, Select, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { errorMessage } from '../../lib/api';
import { tokensApi } from '../../lib/endpoints';
import { iaconfigApi, saveText } from '../../lib/agentApi';
import { fmtDateTime, fmtRelative, fmtTier, humanise, shortId } from '../../lib/format';
import { useAssistSignal } from '../signal/AssistSignalProvider';
import { CreateTokenDialog } from './CreateTokenDialog';
import { EnrollDeployDialog } from './EnrollDeployDialog';
import { enrollmentUsage, nearExpiry } from './enroll';

const STATUS_TONE: Record<TokenStatus, 'green' | 'neutral' | 'red' | 'amber'> = {
  active: 'green',
  used: 'neutral',
  revoked: 'red',
  expired: 'amber',
};

export function TokenStatusBadge({ status }: { status: TokenStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}

export function TokensPage() {
  usePageTitle('Tokens');
  const { me } = useAuth();
  const signal = useAssistSignal();
  const [status, setStatus] = useState<TokenStatus | ''>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [qrFor, setQrFor] = useState<Token | null>(null);
  const [revokeFor, setRevokeFor] = useState<Token | null>(null);
  const [deployFor, setDeployFor] = useState<Token | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [extra, setExtra] = useState<Token[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useAsync(
    async () => {
      const page = await tokensApi.list(status ? { status } : {});
      setExtra([]);
      setCursor(page.nextCursor);
      return page.items;
    },
    [status],
  );
  const canCreate = can(me?.user.role, 'tokens.create');
  /** `GET /devices/enroll-config` is org_admin only (section 7.2); the server refuses anyone else anyway. */
  const canDeploy = can(me?.user.role, 'fleet.admin');
  const tokens = [...(list.data ?? []), ...extra];

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const page = await tokensApi.list({ ...(status ? { status } : {}), cursor });
      setExtra((x) => [...x, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  /** Phase C 2.4: the signed sidecar for an MSP / self-host rollout (org_admin and the token creator). */
  const downloadIaconfig = async (t: Token) => {
    setActionError(null);
    try {
      const r = await iaconfigApi.issue(t.id);
      saveText(r.iaconfig, 'IndiansAssist.iaconfig');
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const doRevoke = async (t: Token) => {
    setActionError(null);
    try {
      const updated = await tokensApi.revoke(t.id);
      list.setData((list.data ?? []).map((x) => (x.id === updated.id ? updated : x)));
      setExtra((x) => x.map((y) => (y.id === updated.id ? updated : y)));
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setRevokeFor(null);
    }
  };

  return (
    <>
      <PageHeader title="Support tokens">
        <label htmlFor="token-status" className="text-sm font-medium">
          Status
        </label>
        <Select id="token-status" className="w-36" value={status} onChange={(e) => setStatus(e.target.value as TokenStatus | '')}>
          <option value="">All</option>
          {TOKEN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        {canCreate && <Button onClick={() => setCreateOpen(true)}>Create token</Button>}
      </PageHeader>
      {actionError && <Alert>{actionError}</Alert>}
      <Card>
        {list.loading && <Spinner label="Loading tokens" />}
        {Boolean(list.error) && <Alert>{errorMessage(list.error)}</Alert>}
        {!list.loading && tokens.length === 0 && !list.error && (
          <p className="text-sm text-slate-600 dark:text-slate-400">No tokens yet. Create one and send the link to the person you are helping.</p>
        )}
        {tokens.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Support tokens</caption>
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-700 dark:text-slate-400">
                <tr>
                  <th scope="col" className="py-2 pr-3">Label / id</th>
                  <th scope="col" className="py-2 pr-3">Status</th>
                  <th scope="col" className="py-2 pr-3">Short code</th>
                  <th scope="col" className="py-2 pr-3">Type</th>
                  <th scope="col" className="py-2 pr-3">Expires</th>
                  <th scope="col" className="py-2 pr-3">Created by</th>
                  <th scope="col" className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => {
                  const p = signal?.presence[t.id];
                  const enroll = t.typ === 'enrollment' ? enrollmentUsage(t) : null;
                  const expiring = t.status === 'active' && nearExpiry(t.expiresAt);
                  return (
                    <tr key={t.id} className="border-b border-slate-100 align-top dark:border-slate-800">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{t.label ?? 'Untitled'}</div>
                        <div className="font-mono text-xs text-slate-600 dark:text-slate-400">{shortId(t.id)}</div>
                        {p?.waiting && <Badge tone="amber">{p.held ? 'Desk waiting (held)' : 'Desk connected'}</Badge>}
                      </td>
                      <td className="py-2 pr-3">
                        <TokenStatusBadge status={t.status} />
                      </td>
                      <td className="py-2 pr-3">
                        <span className="font-mono">{t.shortCodeDisplay}</span>
                        <div className="text-xs text-slate-600 dark:text-slate-400">valid on {t.joinHost}</div>
                      </td>
                      <td className="py-2 pr-3">
                        {humanise(t.typ)}
                        <div className="text-xs text-slate-600 dark:text-slate-400">{fmtTier(t.tier)}</div>
                        {enroll && (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span data-testid="devices-enrolled" className="text-xs">
                              {enroll.enrolled} / {enroll.max} devices enrolled
                            </span>
                            {enroll.full && <Badge tone="red">Device limit reached</Badge>}
                            {enroll.nearLimit && <Badge tone="amber">{enroll.remaining} left</Badge>}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3" title={fmtDateTime(t.expiresAt)}>
                        {fmtRelative(t.expiresAt)}
                        {expiring && (
                          <div className="mt-1">
                            <Badge tone="amber">Expires soon</Badge>
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3">{t.createdBy.name}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1">
                          <CopyButton size="sm" variant="secondary" text={t.joinUrl} label="Copy link" />
                          <CopyButton size="sm" variant="secondary" text={t.shortCode} label="Copy short code" />
                          <Button size="sm" variant="ghost" onClick={() => setQrFor(t)} aria-label={`Show QR code for ${t.label ?? shortId(t.id)}`}>
                            QR
                          </Button>
                          {t.tier === 'p3_portable' && t.status === 'active' && (can(me?.user.role, 'tokens.iaconfig') || t.createdBy.id === me?.user.id) && (
                            <Button size="sm" variant="ghost" onClick={() => void downloadIaconfig(t)}>
                              Download .iaconfig for this token
                            </Button>
                          )}
                          {t.typ === 'enrollment' && t.status === 'active' && canDeploy && (
                            <Button size="sm" variant="ghost" onClick={() => setDeployFor(t)}>
                              Install and enroll
                            </Button>
                          )}
                          {t.status === 'active' && canCreate && (
                            <Button size="sm" variant="danger" onClick={() => setRevokeFor(t)}>
                              Revoke
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <Button variant="secondary" className="mt-3" onClick={() => void loadMore()}>
            Load more
          </Button>
        )}
      </Card>
      <CreateTokenDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        seatTier={me?.seat?.tier ?? null}
        onCreated={(r) => list.setData([r.token, ...(list.data ?? [])])}
      />
      <EnrollDeployDialog
        token={deployFor}
        orgName={me?.org.branding.displayName ?? me?.org.name ?? 'your organisation'}
        open={deployFor !== null}
        onClose={() => setDeployFor(null)}
      />
      <Dialog open={qrFor !== null} title="Join link QR code" onClose={() => setQrFor(null)}>
        {qrFor && (
          <div className="flex flex-col items-center gap-3">
            <QrCode text={qrFor.joinUrl} label={`QR code of the join link for ${qrFor.label ?? shortId(qrFor.id)}`} size={240} />
            <p className="font-mono text-lg">{qrFor.shortCodeDisplay}</p>
          </div>
        )}
      </Dialog>
      <Dialog open={revokeFor !== null} title="Revoke this token?" onClose={() => setRevokeFor(null)}>
        <p className="mb-4 text-sm">The link and short code stop working immediately. Any live session on this token ends.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRevokeFor(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => revokeFor && void doRevoke(revokeFor)}>
            Revoke token
          </Button>
        </div>
      </Dialog>
    </>
  );
}
