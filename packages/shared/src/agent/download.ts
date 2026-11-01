/**
 * Phase C section 2: the agent download flow. `manifest.json` builds, the `prepare` request / reply, the served
 * filename grammar that carries the region and a per-download desk code (section 2.3), and the signed `.iaconfig`
 * sidecar (section 2.4). Mirrored by `ia_core::download` (Rust).
 */
import { z } from 'zod';
import { canonicalJson } from '../canonical.js';
import { utf8Encode } from '../encoding.js';
import { AGENT_ARCHES, AGENT_PLATFORMS, LIMITS, type AgentArch, type AgentPlatform } from '../enums.js';
import { isRegion, REGIONS, type Region } from '../regions.js';
import { generateShortCode, isValidShortCode } from '../token/short-code.js';
import { signBytes, verifyBytes, type PublicKeyLike } from '../crypto.js';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lower-case hex chars');
/** `MAJOR.MINOR.PATCH` with an optional `-pre` suffix. */
export const AGENT_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const version = z.string().regex(AGENT_VERSION_RE, 'expected MAJOR.MINOR.PATCH');

/** One downloadable build (`GET /download/manifest`, section 2.2). */
export const agentBuildSchema = z.strictObject({
  platform: z.enum(AGENT_PLATFORMS),
  arch: z.enum(AGENT_ARCHES),
  version,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: hex64,
  signed: z.boolean(),
  minOs: z.string().max(64),
});
export type AgentBuild = z.infer<typeof agentBuildSchema>;

export const downloadManifestSchema = z.strictObject({ v: z.literal(1), builds: z.array(agentBuildSchema).max(32) });
export type DownloadManifest = z.infer<typeof downloadManifestSchema>;

/** `AGENT_DIST_DIR/manifest.json`: the wire builds plus an optional `file` (default: `agentDistFileName`). */
export const agentDistManifestSchema = z.object({
  v: z.literal(1),
  builds: z
    .array(
      agentBuildSchema.extend({
        file: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'a bare file name')
          .optional(),
      }),
    )
    .max(32),
});
export type AgentDistManifest = z.infer<typeof agentDistManifestSchema>;

/**
 * The dist file name of a build: `IndiansAssist-windows-x64-0.3.0.exe`, `IndiansAssist-android-universal-0.3.0.apk`,
 * and (Phase E section 7.6) the raw Linux ELF `IndiansAssist-linux-x64-0.3.0`, which has no extension.
 */
export function agentDistFileName(platform: AgentPlatform, arch: AgentArch, v: string): string {
  if (platform === 'linux') return `IndiansAssist-linux-${arch}-${v}`;
  return `IndiansAssist-${platform}-${arch}-${v}.${platform === 'android' ? 'apk' : 'exe'}`;
}

/** Which arch values a platform serves (Windows: x64 / arm64; Android: one universal APK; Linux: x64 only, E W81). */
export function archAllowed(platform: AgentPlatform, arch: AgentArch): boolean {
  if (platform === 'android') return arch === 'universal';
  if (platform === 'linux') return arch === 'x64';
  return arch === 'x64' || arch === 'arm64';
}

export const downloadPrepareSchema = z
  .strictObject({
    code: z.string().min(1).max(4096),
    platform: z.enum(AGENT_PLATFORMS),
    arch: z.enum(AGENT_ARCHES),
  })
  .refine((b) => archAllowed(b.platform, b.arch), { message: 'arch does not exist for this platform', path: ['arch'] });
export type DownloadPrepare = z.infer<typeof downloadPrepareSchema>;

export const downloadPrepareReplySchema = z.strictObject({
  url: z.string().max(2048),
  expiresAt: z.string(),
  filename: z.string().max(255),
  deskCode: z.string().regex(/^\d{12}$/),
  version,
  sha256: hex64,
  signed: z.boolean(),
});
export type DownloadPrepareReply = z.infer<typeof downloadPrepareReplySchema>;

/** Section 2.3 filename grammar (case-insensitive; a browser's ` (1)` duplicate suffix is tolerated). */
export const AGENT_FILENAME_RE =
  /^IndiansAssist-(?<region>[a-z]{2}-[a-z]{3,5})-(?<a>\d{4})-(?<b>\d{4})-(?<c>\d{4})(?: \(\d+\))?\.exe$/i;

/** The served Windows filename for a region and a desk code: `IndiansAssist-in-mum-4821-9365-7715.exe`. */
export function agentFileName(region: Region, deskCode: string): string {
  if (!/^\d{12}$/.test(deskCode)) throw new Error('desk code must be 12 digits');
  return `IndiansAssist-${region}-${deskCode.slice(0, 4)}-${deskCode.slice(4, 8)}-${deskCode.slice(8, 12)}.exe`;
}

/** Parses a served filename; null unless the region is known and the 12 digits are a Luhn-valid code. */
export function parseAgentFileName(name: string): { region: Region; deskCode: string } | null {
  const m = AGENT_FILENAME_RE.exec(name);
  if (!m?.groups) return null;
  const region = m.groups['region']!.toLowerCase();
  const deskCode = `${m.groups['a']}${m.groups['b']}${m.groups['c']}`;
  if (!isRegion(region) || !isValidShortCode(deskCode)) return null;
  return { region, deskCode };
}

/**
 * Phase E section 7.6: the inner binary of the Linux `.tar.gz` is `IndiansAssist-<region>-<dddd>-<dddd>-<dddd>`
 * with no extension. Case-sensitive and without a duplicate suffix: a browser's ` (1)` lands on the archive name,
 * never on the name inside it. Mirrored by `ia_core::download` (linux stream).
 */
export const AGENT_LINUX_FILENAME_RE = /^IndiansAssist-(?<region>[a-z]{2}-[a-z]{3,5})-(?<a>\d{4})-(?<b>\d{4})-(?<c>\d{4})$/;

/** The inner Linux binary name for a region and a desk code: `IndiansAssist-in-mum-4821-9365-7715`. */
export function agentLinuxFileName(region: Region, deskCode: string): string {
  if (!/^\d{12}$/.test(deskCode)) throw new Error('desk code must be 12 digits');
  return `IndiansAssist-${region}-${deskCode.slice(0, 4)}-${deskCode.slice(4, 8)}-${deskCode.slice(8, 12)}`;
}

/** Parses an inner Linux binary name; null unless the region is known and the 12 digits are a Luhn-valid code. */
export function parseAgentLinuxFileName(name: string): { region: Region; deskCode: string } | null {
  const m = AGENT_LINUX_FILENAME_RE.exec(name);
  if (!m?.groups) return null;
  const region = m.groups['region']!;
  const deskCode = `${m.groups['a']}${m.groups['b']}${m.groups['c']}`;
  if (!isRegion(region) || !isValidShortCode(deskCode)) return null;
  return { region, deskCode };
}

/** Mints a desk code (12 digits, Luhn-valid), never equal to `avoid` (the token's own short code). */
export function makeDeskCode(avoid?: string | null, random?: (n: number) => Uint8Array): string {
  for (;;) {
    const c = random ? generateShortCode(random) : generateShortCode();
    if (c !== avoid) return c;
  }
}

// ---------- signed sidecar (section 2.4) ----------

const originRe = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** The `.iaconfig` sidecar, strict (unknown keys are an error). */
export const iaconfigSchema = z.strictObject({
  v: z.literal(1),
  apiOrigin: z.string().max(200).regex(originRe, 'an http(s) origin without a path'),
  region: z.enum(REGIONS),
  code: z.string().min(1).max(4096).optional(),
  deskLabel: z.string().max(80).optional(),
  kid: z.string().regex(/^[0-9a-f]{16}$/),
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'base64url Ed25519 signature'),
});
export type Iaconfig = z.infer<typeof iaconfigSchema>;
export type IaconfigFields = Omit<Iaconfig, 'sig'>;

/** The signed bytes: `utf8(canonicalJson(sidecar minus sig))`. */
export function iaconfigSigningInput(cfg: IaconfigFields | Iaconfig): Uint8Array {
  const { sig: _sig, ...rest } = cfg as Iaconfig;
  void _sig;
  return utf8Encode(canonicalJson(rest));
}

/** Signs a sidecar with the region's token-signing seed and serialises it (sorted keys, UTF-8, <= 16 KiB). */
export async function signIaconfig(fields: IaconfigFields, seedHex: string): Promise<string> {
  const sig = await signBytes(iaconfigSigningInput(fields), seedHex);
  const text = canonicalJson({ ...fields, sig });
  if (utf8Encode(text).length > LIMITS.iaconfigMaxBytes) throw new Error('iaconfig exceeds 16 KiB');
  return text;
}

/** Parses and verifies a sidecar against a key set; null when malformed, oversize or not signed by a known key. */
export async function verifyIaconfig(text: string, keys: readonly PublicKeyLike[]): Promise<Iaconfig | null> {
  if (utf8Encode(text).length > LIMITS.iaconfigMaxBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = iaconfigSchema.safeParse(raw);
  if (!r.success) return null;
  return (await verifyBytes(iaconfigSigningInput(r.data), r.data.sig, r.data.kid, keys)) ? r.data : null;
}

/** `POST /tokens/:id/iaconfig` body (optional label) and reply. */
export const iaconfigRequestSchema = z.strictObject({ deskLabel: z.string().max(80).optional() });
export const iaconfigReplySchema = z.strictObject({ iaconfig: z.string() });
