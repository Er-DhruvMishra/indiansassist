/**
 * The public downloads list (`GET /api/v1/downloads`, the `/downloads` page): the generic builds this node already
 * serves through the Phase C token grant and the Phase D installer routes, offered without a login, plus the packaged
 * browser extension (`AGENT_DIST_DIR/extension/manifest.json`). A generic file carries no per-download code: the page
 * says what each one does without a code, and the token and enrollment checks stay where they were.
 */
import { z } from 'zod';
import { AGENT_VERSION_RE } from './download.js';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lower-case hex chars');
const version = z.string().regex(AGENT_VERSION_RE, 'expected MAJOR.MINOR.PATCH');

export const PUBLIC_DOWNLOAD_TIERS = ['p2_extension', 'p3_portable', 'p4_installed'] as const;
export type PublicDownloadTier = (typeof PUBLIC_DOWNLOAD_TIERS)[number];
export const PUBLIC_DOWNLOAD_PLATFORMS = ['windows', 'linux', 'macos', 'android', 'browser'] as const;
export type PublicDownloadPlatform = (typeof PUBLIC_DOWNLOAD_PLATFORMS)[number];
export const PUBLIC_DOWNLOAD_ARCHES = ['x64', 'arm64', 'universal'] as const;
export type PublicDownloadArch = (typeof PUBLIC_DOWNLOAD_ARCHES)[number];
export const PUBLIC_DOWNLOAD_FORMATS = ['zip', 'exe', 'tar.gz', 'app.zip', 'apk', 'msi', 'deb', 'rpm', 'pkg'] as const;
export type PublicDownloadFormat = (typeof PUBLIC_DOWNLOAD_FORMATS)[number];

/** One row of the public list; `signed` is about the very bytes of `filename` (false when in doubt). */
export const publicDownloadFileSchema = z.strictObject({
  tier: z.enum(PUBLIC_DOWNLOAD_TIERS),
  platform: z.enum(PUBLIC_DOWNLOAD_PLATFORMS),
  arch: z.enum(PUBLIC_DOWNLOAD_ARCHES),
  format: z.enum(PUBLIC_DOWNLOAD_FORMATS),
  version,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: hex64,
  signed: z.boolean(),
  minOs: z.string().max(64),
  filename: z.string().max(128),
  url: z.string().max(2048),
});
export type PublicDownloadFile = z.infer<typeof publicDownloadFileSchema>;

/** `GET /api/v1/downloads`: what this node serves; `files: []` = nothing published yet. */
export const publicDownloadsSchema = z.strictObject({ v: z.literal(1), files: z.array(publicDownloadFileSchema).max(64) });
export type PublicDownloads = z.infer<typeof publicDownloadsSchema>;

/** `AGENT_DIST_DIR/extension/manifest.json`: the packaged extension, written by `apps/extension/scripts/package-zip.mjs`. */
export const extensionDistManifestSchema = z.object({
  v: z.literal(1),
  builds: z
    .array(
      z.strictObject({
        version,
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        sha256: hex64,
        minOs: z.string().max(64),
        file: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'a bare file name')
          .optional(),
      }),
    )
    .max(8),
});
export type ExtensionDistManifest = z.infer<typeof extensionDistManifestSchema>;

/** The dist name of the packaged extension: `IndiansAssist-extension-0.2.0.zip`. */
export function extensionDistFileName(v: string): string {
  return `IndiansAssist-extension-${v}.zip`;
}

/** The generic Linux download: the same two programs as the per-download archive, under a name with no code in it. */
export function publicLinuxArchiveName(v: string): string {
  return `IndiansAssist-linux-x64-${v}.tar.gz`;
}
