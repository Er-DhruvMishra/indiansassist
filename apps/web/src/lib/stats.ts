/**
 * Network path transparency (contracts sections 7.7 and 13.2): turns an `RTCStatsReport` into the
 * numbers the console shows and sends as `session.stats`. Pure; unit tested with plain objects.
 */
import type { SessionPath } from '@indiansassist/shared';

type Stat = Record<string, unknown> & { id: string; type: string };

export type NetStats = {
  path: SessionPath;
  rttMs: number | null;
  codec: string | null;
  bitrateKbps: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  packetsLost: number | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  protocol: string | null;
  relayProtocol: string | null;
  bytesReceived: number | null;
  ts: number;
};

export const EMPTY_STATS: NetStats = {
  path: 'unknown',
  rttMs: null,
  codec: null,
  bitrateKbps: null,
  fps: null,
  width: null,
  height: null,
  packetsLost: null,
  localCandidateType: null,
  remoteCandidateType: null,
  protocol: null,
  relayProtocol: null,
  bytesReceived: null,
  ts: 0,
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function toMap(report: RTCStatsReport | Iterable<Stat> | Map<string, Stat>): Map<string, Stat> {
  const out = new Map<string, Stat>();
  if (Array.isArray(report)) {
    for (const v of report as Stat[]) out.set(v.id, v);
    return out;
  }
  const r = report as { forEach?: (cb: (v: Stat) => void) => void };
  if (typeof r.forEach === 'function') {
    r.forEach((v: Stat) => out.set(v.id, v));
    return out;
  }
  for (const v of report as Iterable<Stat>) out.set(v.id, v);
  return out;
}

/** The selected (nominated, succeeded) candidate pair, preferring the transport's selectedCandidatePairId. */
export function selectedPair(stats: Map<string, Stat>): Stat | null {
  for (const s of stats.values()) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      const p = stats.get(s.selectedCandidatePairId);
      if (p) return p;
    }
  }
  let best: Stat | null = null;
  for (const s of stats.values()) {
    if (s.type !== 'candidate-pair') continue;
    if (s.selected === true) return s;
    if (s.nominated === true && s.state === 'succeeded') best = best ?? s;
  }
  return best;
}

/**
 * Computes the displayed stats. `prev` is the previous sample (for the bitrate delta).
 * Path: the nominated pair has a `relay` local or remote candidate => relay, else p2p; no pair => unknown.
 */
export function computeNetStats(
  report: RTCStatsReport | Iterable<Stat> | Map<string, Stat>,
  prev: Pick<NetStats, 'bytesReceived' | 'ts'> | null,
  now: number = Date.now(),
): NetStats {
  const stats = toMap(report);
  const out: NetStats = { ...EMPTY_STATS, ts: now };
  const pair = selectedPair(stats);
  if (pair) {
    const local = typeof pair.localCandidateId === 'string' ? stats.get(pair.localCandidateId) : undefined;
    const remote = typeof pair.remoteCandidateId === 'string' ? stats.get(pair.remoteCandidateId) : undefined;
    out.localCandidateType = str(local?.candidateType);
    out.remoteCandidateType = str(remote?.candidateType);
    out.protocol = str(local?.protocol);
    out.relayProtocol = str(local?.relayProtocol);
    out.path = out.localCandidateType === 'relay' || out.remoteCandidateType === 'relay' ? 'relay' : 'p2p';
    const rtt = num(pair.currentRoundTripTime);
    out.rttMs = rtt === null ? null : Math.round(rtt * 1000);
  }
  for (const s of stats.values()) {
    if (s.type !== 'inbound-rtp' || (s.kind ?? s.mediaType) !== 'video') continue;
    const codec = typeof s.codecId === 'string' ? stats.get(s.codecId) : undefined;
    out.codec = str(codec?.mimeType);
    out.fps = num(s.framesPerSecond);
    out.width = num(s.frameWidth);
    out.height = num(s.frameHeight);
    out.packetsLost = num(s.packetsLost);
    out.bytesReceived = num(s.bytesReceived);
    if (prev && prev.bytesReceived !== null && out.bytesReceived !== null && now > prev.ts) {
      const bits = (out.bytesReceived - prev.bytesReceived) * 8;
      out.bitrateKbps = bits >= 0 ? Math.round(bits / (now - prev.ts)) : null;
    }
    break;
  }
  return out;
}

/** Text alternative for the remote video (A6). */
export function describeRemote(s: Pick<NetStats, 'width' | 'height' | 'path'>, connected: boolean): string {
  if (!connected) return 'Remote screen, not connected';
  const size = s.width && s.height ? `, ${s.width} by ${s.height}` : '';
  const via = s.path === 'unknown' ? '' : `, connected via ${s.path === 'relay' ? 'relay' : 'peer to peer'}`;
  return `Remote screen${size}${via}`;
}
