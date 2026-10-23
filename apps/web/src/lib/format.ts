/** Display formatting helpers. */
import { REGION_LABELS, type Region } from '@indiansassist/shared';

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function fmtTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleTimeString();
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "in 12 min", "3 min ago". */
export function fmtRelative(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const [name, size] = abs >= 3600000 ? ['h', 3600000] : abs >= 60000 ? ['min', 60000] : ['s', 1000];
  const v = Math.round(abs / (size as number));
  return diff >= 0 ? `in ${v} ${name}` : `${v} ${name} ago`;
}

export function regionLabel(r: Region | string): string {
  return (REGION_LABELS as Record<string, string>)[r] ?? r;
}

export function humanise(s: string): string {
  return s.replace(/_/g, ' ');
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '-';
}

export function fmtRoleName(role: string): string {
  return humanise(role).replace(/\b\w/g, (c) => c.toUpperCase());
}

export function fmtTier(tier: string): string {
  const names: Record<string, string> = {
    p1_browser: 'P1 Browser share',
    p2_extension: 'P2 Extension',
    p3_portable: 'P3 Portable',
    p4_installed: 'P4 Installed',
  };
  return names[tier] ?? tier;
}
