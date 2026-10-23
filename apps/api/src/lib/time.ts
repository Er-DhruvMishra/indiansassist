/** Time helpers: ISO strings with milliseconds (REST / WS convention) and unix seconds (signed token). */
export function iso(d: Date): string {
  return new Date(d).toISOString();
}

export function isoOrNull(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

export function unixSeconds(d: Date | number = Date.now()): number {
  return Math.floor((typeof d === 'number' ? d : d.getTime()) / 1000);
}

/** `yyyymmdd` in UTC (export filename). */
export function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
