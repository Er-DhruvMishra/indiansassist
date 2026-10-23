/**
 * Host deny list and URL helpers of a P2 session (docs/specs/phase-b-contracts.md sections 4.1, 4.5, 8.2, 12.3).
 * Entry syntax: an exact hostname (`example.com`) or a wildcard host (`*.example.com`, which matches every subdomain
 * AND the apex). Matching is on the hostname only (case-insensitive, IDNA-ASCII, port ignored); the scheme check is
 * the separate `isMirrorableUrl`.
 */
import { LIMITS } from '../enums.js';

/** Built-in entries (section 8.2); additions by pull request only. Orgs may not remove them in Phase B. */
export const BUILTIN_DENY_LIST = [
  // Identity providers
  'accounts.google.com', // Google sign-in
  'login.microsoftonline.com', // Microsoft Entra ID sign-in
  'login.live.com', // Microsoft personal account sign-in
  'appleid.apple.com', // Apple ID
  'id.atlassian.com', // Atlassian identity
  // Indian net banking and UPI
  '*.onlinesbi.sbi', // State Bank of India
  'netbanking.hdfcbank.com', // HDFC Bank net banking
  '*.icicibank.com', // ICICI Bank
  '*.axisbank.co.in', // Axis Bank
  '*.kotak.com', // Kotak Mahindra Bank
  '*.pnbibanking.in', // Punjab National Bank
  '*.bankofbaroda.in', // Bank of Baroda
  '*.paytm.com', // Paytm
  '*.phonepe.com', // PhonePe
  '*.npci.org.in', // NPCI (UPI)
  // Password managers
  'vault.bitwarden.com', // Bitwarden web vault
  '*.1password.com', // 1Password
  '*.lastpass.com', // LastPass
  'passwords.google.com', // Google Password Manager
  '*.dashlane.com', // Dashlane
] as const;

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Lower-case IDNA-ASCII hostname of `host`, or null when it is not a plain hostname (no port, path, userinfo). */
function asciiHost(host: string): string | null {
  if (host === '' || /[\s/\\?#@:[\]%]/.test(host)) return null;
  let out: string;
  try {
    out = new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
  if (out.length === 0 || out.length > LIMITS.policyHostPatternMax) return null;
  if (IPV4_RE.test(out)) return out; // IPv4 literal (the e2e deny-list test uses 127.0.0.1)
  if (out.split('.').some((l) => !LABEL_RE.test(l))) return null;
  return out;
}

/**
 * Normalises a deny-list entry: lower-case, IDNA-ASCII, an optional `*.` prefix only (no other wildcard), no port,
 * no path, at most 253 characters. Returns null for anything else.
 */
export function normaliseHostPattern(pattern: string): string | null {
  if (typeof pattern !== 'string') return null;
  const p = pattern.trim().replace(/\.$/, '');
  const wildcard = p.startsWith('*.');
  const rest = wildcard ? p.slice(2) : p;
  if (rest.includes('*')) return null;
  const host = asciiHost(rest);
  if (!host) return null;
  if (wildcard && (!host.includes('.') || IPV4_RE.test(host))) return null; // `*.com` is too broad
  const out = wildcard ? `*.${host}` : host;
  return out.length <= LIMITS.policyHostPatternMax ? out : null;
}

/**
 * True when `host` is a wire `host` value (conventions table): a hostname that `normaliseHostPattern` returns
 * unchanged and without a `*.` prefix.
 */
export function isWireHost(host: unknown): host is string {
  return typeof host === 'string' && !host.startsWith('*.') && normaliseHostPattern(host) === host;
}

/** Lower-case IDNA-ASCII hostname of a URL, or null when it does not parse or has no host. */
export function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h === '' ? null : h.replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** `http:` / `https:` only (section 4.1); every other scheme is `unsupported`. */
export function isMirrorableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

/** As matchesDenyList for a bare hostname. */
export function hostMatchesDenyList(host: string, list: readonly string[]): boolean {
  const h = asciiHost(host.trim().replace(/\.$/, ''));
  if (!h) return false;
  for (const raw of list) {
    const e = normaliseHostPattern(raw);
    if (!e) continue;
    if (e.startsWith('*.')) {
      const apex = e.slice(2);
      if (h === apex || h.endsWith(`.${apex}`)) return true;
    } else if (h === e) return true;
  }
  return false;
}

/** True when the URL's host matches an entry of `list` (entries are normalised; invalid entries never match). */
export function matchesDenyList(url: string, list: readonly string[]): boolean {
  const host = hostOf(url);
  return host !== null && hostMatchesDenyList(host, list);
}

/** Chrome match patterns for `excludeMatches` (section 8.2): `*.example.com` also yields the apex pattern. */
export function denyListToMatchPatterns(list: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const e = normaliseHostPattern(raw);
    if (!e) continue;
    out.add(`*://${e}/*`);
    if (e.startsWith('*.')) out.add(`*://${e.slice(2)}/*`);
  }
  return [...out];
}

/** The built-in list plus the given lists (org, managed `extraDenyList`), normalised and de-duplicated. */
export function effectiveDenyList(...lists: readonly (readonly string[] | undefined)[]): string[] {
  const out = new Set<string>(BUILTIN_DENY_LIST);
  for (const l of lists)
    for (const raw of l ?? []) {
      const e = normaliseHostPattern(raw);
      if (e) out.add(e);
    }
  return [...out];
}

/**
 * Origin + path only (section 4.5): no query, no fragment, no credentials. Opaque URLs (`about:blank`) keep their
 * scheme and path. Null when the URL does not parse.
 */
export function stripUrlForMirror(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.host === '' && !url.slice(u.protocol.length).startsWith('//')) return `${u.protocol}${u.pathname}`;
  return `${u.protocol}//${u.host}${u.pathname}`;
}
