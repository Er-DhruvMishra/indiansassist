/**
 * Mirror status (Phase B 10.1, 10.3): transport (direct / relayed, not end-to-end encrypted), mirror bitrate of
 * the `ia.mirror` channel (10 s average, kbps), the whole session's rate, the ICE path and RTT, and signaling
 * latency. Video fields (codec, fps, resolution) do not exist in a P2 session.
 */
import { Badge } from '../../../components/ui';
import type { NetStats } from '../../../lib/stats';
import { PathBadge } from '../../SessionsPage';

const v = (n: number | null, unit = '') => (n === null ? '-' : `${Math.round(n)}${unit}`);

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </>
  );
}

export function transportText(t: 'dc' | 'relay' | 'none'): string {
  if (t === 'dc') return 'direct';
  if (t === 'relay') return 'relayed, not end-to-end encrypted';
  return 'not connected';
}

export function MirrorStatus({
  transport,
  mirrorKbps,
  sessionKbps,
  tabs,
  net,
  signalLatency,
  stale,
  relayAllowed,
}: {
  transport: 'dc' | 'relay' | 'none';
  mirrorKbps: number;
  sessionKbps: number | null;
  tabs: number;
  net: NetStats;
  signalLatency: number | null;
  stale: boolean;
  relayAllowed: boolean;
}) {
  return (
    <section aria-label="Mirror network">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Network</h2>
        <div className="flex gap-1">
          {stale && <Badge tone="amber">Reconnecting</Badge>}
          <Badge tone={transport === 'dc' ? 'green' : transport === 'relay' ? 'amber' : 'neutral'}>{transportText(transport)}</Badge>
        </div>
      </div>
      {transport === 'relay' && <p className="mb-2 text-xs text-amber-800 dark:text-amber-300">Relayed through the server (degraded, not end-to-end encrypted).</p>}
      {transport !== 'dc' && !relayAllowed && <p className="mb-2 text-xs">This organisation does not allow server relay; waiting for a direct connection.</p>}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="Mirror" value={`${mirrorKbps.toFixed(1)} kbps`} />
        <Row label="Session" value={v(sessionKbps, ' kbps')} />
        <Row label="Shared tabs" value={String(tabs)} />
        <dt className="text-slate-600 dark:text-slate-400">Path</dt>
        <dd>
          <PathBadge path={net.path} />
        </dd>
        <Row label="RTT" value={v(net.rttMs, ' ms')} />
        <Row label="Signaling" value={v(signalLatency, ' ms')} />
      </dl>
    </section>
  );
}
