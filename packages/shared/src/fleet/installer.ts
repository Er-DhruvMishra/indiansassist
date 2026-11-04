/**
 * The branded Windows installer this api node serves (docs/specs/phase-d-contracts.md sections 12.1, 12.2, 13.4):
 * `AGENT_MSI_DIST_DIR/manifest.json` and the MSI files it names. Shaped like the Phase C agent manifest
 * (`agent/download.ts`) so the console and the api read both the same way; the MSI is per arch only (Windows), and
 * the org-specific part never lives in the MSI: it travels in the `IA_ENROLL` property or the MST transform built
 * from the region-signed `enroll.iaconfig` (section 12.3).
 */
import { z } from 'zod';
import { AGENT_VERSION_RE } from '../agent/download.js';
import { INSTALLER_FORMATS, INSTALLER_PLATFORMS, type InstallerFormat, type InstallerPlatform } from '../enums.js';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lower-case hex chars');
const version = z.string().regex(AGENT_VERSION_RE, 'expected MAJOR.MINOR.PATCH');

/** The arches an installer is built for (section 12.2: one signed MSI per arch; Phase F: the macOS PKG per arch). */
export const INSTALLER_ARCHES = ['x64', 'arm64'] as const;
export type InstallerArch = (typeof INSTALLER_ARCHES)[number];

/**
 * One downloadable installer (`GET /download/installer`). `platform` and `format` (Phase F sections 8.11, 17.8) are
 * optional; absent = `windows` / `msi` (`installerPlatformOf`, `installerFormatOf`). `signed` is optional (Phase F
 * linux-p4 L3); absent = not signed, so the console warns rather than vouches. The format names the platform: an
 * `msi` is Windows, a `deb` or `rpm` Linux, a `pkg` macOS; the api serves no row whose two disagree.
 */
export const installerBuildSchema = z.strictObject({
  platform: z.enum(INSTALLER_PLATFORMS).optional(),
  format: z.enum(INSTALLER_FORMATS).optional(),
  arch: z.enum(INSTALLER_ARCHES),
  version,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: hex64,
  /** False (or absent) on a node serving an unsigned build: the console says so rather than hiding it. */
  signed: z.boolean().optional(),
  minOs: z.string().max(64),
});
export type InstallerBuild = z.infer<typeof installerBuildSchema>;

/** `GET /api/v1/download/installer` (org_admin): what this node can serve; `builds: []` = nothing configured. */
export const installerManifestSchema = z.strictObject({ v: z.literal(1), builds: z.array(installerBuildSchema).max(16) });
export type InstallerManifest = z.infer<typeof installerManifestSchema>;

/** `AGENT_MSI_DIST_DIR/manifest.json`: the wire builds plus an optional bare `file` name (default `installerFileName`). */
export const installerDistManifestSchema = z.object({
  v: z.literal(1),
  builds: z
    .array(
      installerBuildSchema.extend({
        file: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'a bare file name')
          .optional(),
      }),
    )
    .max(8),
});
export type InstallerDistManifest = z.infer<typeof installerDistManifestSchema>;

/**
 * The dist file name of an installer, as `docs/release.md` publishes it: `IndiansAssist-Agent-0.4.0-windows-x64.msi`;
 * Phase F section 8.9 `IndiansAssist-Agent-0.5.0-linux-x64.deb` / `.rpm`; section 17.3 `...-macos-arm64.pkg`.
 */
export function installerFileName(arch: InstallerArch, v: string, format: InstallerFormat = 'msi'): string {
  return `IndiansAssist-Agent-${v}-${installerPlatformForFormat(format)}-${arch}.${format}`;
}

/** The platform a package format installs on: `msi` Windows, `deb` / `rpm` Linux, `pkg` macOS. */
export function installerPlatformForFormat(format: InstallerFormat): InstallerPlatform {
  return format === 'msi' ? 'windows' : format === 'pkg' ? 'macos' : 'linux';
}

/** A build's platform, absent = `windows`. */
export function installerPlatformOf(b: Pick<InstallerBuild, 'platform'>): InstallerPlatform {
  return b.platform ?? 'windows';
}

/** A build's format, absent = `msi`. */
export function installerFormatOf(b: Pick<InstallerBuild, 'format'>): InstallerFormat {
  return b.format ?? 'msi';
}

/**
 * `GET /api/v1/download/installer/:arch` query: which enrollment token the download is audited against, and
 * (Phase F section 8.11) the package format, absent = `msi`.
 */
export const installerDownloadQuerySchema = z.object({
  tokenId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lower-case uuid'),
  format: z.enum(INSTALLER_FORMATS).optional(),
});
