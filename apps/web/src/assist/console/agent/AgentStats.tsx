/**
 * Section 4.4 / 13.4 `AgentStats`: the agent's encoder, hardware encoding, capture vs sent fps, bitrate of the Assist
 * and recorder legs, rung, a **Low bandwidth mode** badge in floor mode, the capture path, monitors streaming,
 * `encodeMs` and the glass-to-glass estimate against its `< 150 ms` target.
 */
import type { AgentStats as AgentStatsT } from '@indiansassist/shared';
import { Badge } from '../../../components/ui';
import { CAPTURE_PATH_LABEL } from './agentStatsFold';

export const GLASS_TARGET_MS = 150;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </>
  );
}

const f = (n: number | null | undefined, unit = '', d = 0) => (n === null || n === undefined ? '-' : `${n.toFixed(d)}${unit}`);

export function AgentStats({ stats, glassMs }: { stats: AgentStatsT | null; glassMs: number | null }) {
  if (!stats) return <p className="text-xs text-slate-600 dark:text-slate-400">Waiting for the agent&apos;s statistics.</p>;
  const streaming = stats.monitors.filter((m) => m.fps > 0).length;
  return (
    <section aria-label="Agent statistics" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Desk agent</h3>
        {stats.floorMode && <Badge tone="amber">Low bandwidth mode</Badge>}
        {stats.capturePath === 'gdi' && <Badge tone="amber">Compatibility capture (slower)</Badge>}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="Encoder" value={`${stats.encoder.toUpperCase()} ${stats.hwEncoder ? '(hardware)' : '(software)'}`} />
        <Row label="Capture path" value={CAPTURE_PATH_LABEL[stats.capturePath]} />
        <Row label="Rung" value={stats.rung ?? '-'} />
        <Row label="Capture / sent fps" value={`${f(stats.captureFps)} / ${f(stats.sentFps)}`} />
        <Row label="Target bitrate" value={f(stats.targetKbps, ' kbps')} />
        <Row label="Sent (all legs)" value={f(stats.sentKbps, ' kbps')} />
        <Row label="Recorder leg" value={stats.recorderKbps === null ? 'none' : f(stats.recorderKbps, ' kbps')} />
        <Row label="Monitors streaming" value={String(streaming)} />
        <Row label="Encode" value={f(stats.encodeMs, ' ms', 1)} />
        <Row label="Glass to glass" value={glassMs === null ? '-' : `${Math.round(glassMs)} ms (target < ${GLASS_TARGET_MS} ms)`} />
        <Row label="Desk CPU" value={f(stats.cpuPercent, ' %')} />
      </dl>
      {glassMs !== null && glassMs >= GLASS_TARGET_MS && <p className="text-xs text-amber-700 dark:text-amber-300">Latency is above the {GLASS_TARGET_MS} ms target.</p>}
    </section>
  );
}
