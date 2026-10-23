/** Network path transparency widget (contracts sections 7.7 and 13.2). */
import type { NetStats } from '../../lib/stats';
import { Badge } from '../../components/ui';
import { IS_DEV } from '../../config';
import { PathBadge } from '../SessionsPage';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </>
  );
}

const v = (n: number | null, unit = '') => (n === null ? '-' : `${Math.round(n)}${unit}`);

export function NetworkPanel({
  net,
  signalLatency,
  relayOnly,
  onRelayOnly,
}: {
  net: NetStats;
  signalLatency: number | null;
  relayOnly: boolean;
  onRelayOnly: (on: boolean) => void;
}) {
  return (
    <section aria-label="Network path">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">Network</h2>
        <PathBadge path={net.path} />
      </div>
      <p className="mb-2 text-xs text-slate-600 dark:text-slate-400">
        {net.path === 'relay'
          ? 'Media is relayed through your organisation\'s TURN server because a direct path failed.'
          : net.path === 'p2p'
            ? 'Media flows directly between the two computers.'
            : 'Waiting for a selected candidate pair.'}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="Candidates" value={net.localCandidateType ? `${net.localCandidateType} / ${net.remoteCandidateType ?? '-'}` : '-'} />
        <Row label="Transport" value={net.protocol ? `${net.protocol}${net.relayProtocol ? ` via ${net.relayProtocol}` : ''}` : '-'} />
        <Row label="RTT" value={v(net.rttMs, ' ms')} />
        <Row label="Codec" value={net.codec ?? '-'} />
        <Row label="Bitrate" value={v(net.bitrateKbps, ' kbps')} />
        <Row label="Resolution" value={net.width && net.height ? `${net.width}x${net.height}` : '-'} />
        <Row label="FPS" value={net.fps === null ? '-' : net.fps.toFixed(0)} />
        <Row label="Packets lost" value={v(net.packetsLost)} />
        <Row label="Signaling" value={v(signalLatency, ' ms')} />
      </dl>
      {IS_DEV && (
        <label className="mt-2 flex items-center gap-2 text-xs">
          <input type="checkbox" checked={relayOnly} onChange={(e) => onRelayOnly(e.target.checked)} />
          <span>
            Force relay <Badge>dev</Badge>
          </span>
        </label>
      )}
    </section>
  );
}
