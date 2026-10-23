/** Regions and topology constants (contracts section 1). */

export const REGIONS = ['in-mum', 'eu-fra', 'us-east'] as const;
export type Region = (typeof REGIONS)[number];

export const DEFAULT_REGION: Region = 'in-mum';

export const REGION_LABELS: Record<Region, string> = {
  'in-mum': 'India (Mumbai)',
  'eu-fra': 'EU (Frankfurt)',
  'us-east': 'US East',
};

export function isRegion(x: unknown): x is Region {
  return typeof x === 'string' && (REGIONS as readonly string[]).includes(x);
}

/**
 * Parses a comma list of regions (env `SERVED_REGIONS`). Empty or unset means "all regions" and yields [].
 * Throws on an unknown region code.
 */
export function parseRegionList(value: string | undefined | null): Region[] {
  if (!value || value.trim() === '') return [];
  const out: Region[] = [];
  for (const raw of value.split(',')) {
    const code = raw.trim();
    if (code === '') continue;
    if (!isRegion(code)) throw new Error(`unknown region: ${code}`);
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/** True when `region` is served by a node declaring `served` (empty list = all regions, rule R2). */
export function isRegionServed(region: Region, served: readonly Region[]): boolean {
  return served.length === 0 || served.includes(region);
}

/**
 * Parses a `region=origin` comma list (env `REGION_ORIGINS`, `VITE_REGION_ORIGINS`).
 * Unknown regions and malformed pairs throw. Trailing slashes are removed from origins.
 */
export function parseRegionOrigins(value: string | undefined | null): Partial<Record<Region, string>> {
  const out: Partial<Record<Region, string>> = {};
  if (!value || value.trim() === '') return out;
  for (const raw of value.split(',')) {
    const pair = raw.trim();
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`malformed region origin pair: ${pair}`);
    const code = pair.slice(0, eq).trim();
    const origin = pair.slice(eq + 1).trim();
    if (!isRegion(code)) throw new Error(`unknown region: ${code}`);
    if (origin === '') throw new Error(`empty origin for region ${code}`);
    out[code] = origin.replace(/\/+$/, '');
  }
  return out;
}
