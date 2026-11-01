/**
 * Section 4.4: the console folds `agent.stats` into `session.stats` and estimates glass-to-glass latency
 * `glassMs = rttMs / 2 + encodeMs + jitterBufferDelay / jitterBufferEmittedCount x 1000 + totalDecodeTime / framesDecoded x 1000`
 * from the video `inbound-rtp`. Pure; unit tested with plain objects.
 */
import type { AgentStats } from '@indiansassist/shared';
import type { NetStats } from '../../../lib/stats';

type Stat = Record<string, unknown> & { type: string };

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function each(report: unknown, fn: (s: Stat) => void): void {
  const r = report as { forEach?: (cb: (v: Stat) => void) => void };
  if (Array.isArray(report)) (report as Stat[]).forEach(fn);
  else if (typeof r?.forEach === 'function') r.forEach(fn);
}

/** Glass-to-glass estimate in ms, or null while a term is unknown. */
export function glassFromReport(report: unknown, rttMs: number | null, encodeMs: number | null): number | null {
  let jitter: number | null = null;
  let decode: number | null = null;
  each(report, (s) => {
    if (s.type !== 'inbound-rtp' || (s['kind'] ?? s['mediaType']) !== 'video' || jitter !== null) return;
    const jbd = n(s['jitterBufferDelay']);
    const jbe = n(s['jitterBufferEmittedCount']);
    const tdt = n(s['totalDecodeTime']);
    const fd = n(s['framesDecoded']);
    if (jbd !== null && jbe) jitter = (jbd / jbe) * 1000;
    if (tdt !== null && fd) decode = (tdt / fd) * 1000;
  });
  if (rttMs === null || encodeMs === null || jitter === null || decode === null) return null;
  return Math.round(rttMs / 2 + encodeMs + (jitter as number) + (decode as number));
}

/** The optional `session.stats` fields of a P3 session (section 4.4, `sessionStatsSchema` additions). */
export function foldedStats(stats: AgentStats | null, glassMs: number | null): Record<string, unknown> {
  if (!stats) return glassMs === null ? {} : { glassMs };
  return {
    encoder: stats.encoder,
    hwEncoder: stats.hwEncoder,
    floorMode: stats.floorMode,
    targetKbps: stats.targetKbps,
    captureFps: stats.captureFps,
    capturePath: stats.capturePath,
    monitorsStreaming: stats.monitors.filter((m) => m.fps > 0).length,
    encodeMs: stats.encodeMs,
    glassMs,
  };
}

/** The `session.stats` frame of a P3 console. */
export function sessionStatsFrame(sessionId: string, net: NetStats, stats: AgentStats | null, glassMs: number | null): Record<string, unknown> & { t: string } {
  const int = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    t: 'session.stats',
    sessionId,
    path: net.path,
    rttMs: net.rttMs,
    codec: net.codec,
    bitrateKbps: net.bitrateKbps,
    fps: net.fps,
    width: int(net.width),
    height: int(net.height),
    packetsLost: int(net.packetsLost),
    ts: Date.now(),
    ...foldedStats(stats, glassMs),
  };
}

/** Labels of the network panel's agent block (section 13.4 AgentStats). */
export const CAPTURE_PATH_LABEL: Record<AgentStats['capturePath'], string> = {
  dda: 'Desktop Duplication',
  gdi: 'GDI (compatibility)',
  projection: 'Screen projection',
  // Phase E section 7.2 / 7.4: the Linux X11 paths and the Wayland no-screen path.
  xshm: 'X11 shared memory',
  xgetimage: 'X11 (compatibility)',
  none: 'No screen shared',
};
