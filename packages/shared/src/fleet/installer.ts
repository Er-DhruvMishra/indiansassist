/**
 * The branded Windows installer this api node serves (docs/specs/phase-d-contracts.md sections 12.1, 12.2, 13.4):
 * `AGENT_MSI_DIST_DIR/manifest.json` and the MSI files it names. Shaped like the Phase C agent manifest
 * (`agent/download.ts`) so the console and the api read both the same way; the MSI is per arch only (Windows), and
 * the org-specific part never lives in the MSI: it travels in the `IA_ENROLL` property or the MST transform built
 * from the region-signed `enroll.iaconfig` (section 12.3).
 */
import { z } from 'zod';
import { AGENT_VERSION_RE } from '../agent/download.js';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lower-case hex chars');
const version = z.string().regex(AGENT_VERSION_RE, 'expected MAJOR.MINOR.PATCH');

/** The arches an MSI is built for (section 12.2: one signed MSI per arch). */
export const INSTALLER_ARCHES = ['x64', 'arm64'] as const;
export type InstallerArch = (typeof INSTALLER_ARCHES)[number];

/** One downloadable installer (`GET /download/installer`). */
export const installerBuildSchema = z.strictObject({
  arch: z.enum(INSTALLER_ARCHES),
  version,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: hex64,
  /** False on a node serving an unsigned development build: the console says so rather than hiding it. */
  signed: z.boolean(),
  minOs: z.string().max(64),
});
export type InstallerBuild = z.infer<typeof installerBuildSchema>;

/** `GET /api/v1/download/installer` (org_admin): what this node can serve; `builds: []` = nothing configured. */
export const installerManifestSchema = z.strictObject({ v: z.literal(1), builds: z.array(installerBuildSchema).max(8) });
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

/** The dist file name of an installer, as `docs/release.md` publishes it: `IndiansAssist-Agent-0.4.0-windows-x64.msi`. */
export function installerFileName(arch: InstallerArch, v: string): string {
  return `IndiansAssist-Agent-${v}-windows-${arch}.msi`;
}

/** `GET /api/v1/download/installer/:arch` query: which enrollment token the download is audited against. */
export const installerDownloadQuerySchema = z.object({
  tokenId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lower-case uuid'),
});
