/**
 * The branded installers served by this node (docs/specs/phase-d-contracts.md sections 12.1, 12.2, 13.4; Phase F
 * sections 8.11 and 17.3): `AGENT_MSI_DIST_DIR/manifest.json` and the files it names, read at boot and on SIGHUP
 * exactly as the Phase C `AgentDist` reads the agent builds. A node without the directory serves `builds: []`, so the
 * console simply does not offer the download; there is no development stand-in, because an unsigned installer is not
 * something to hand out by accident (`docs/release.md` publishes the signed MSI here).
 *
 * Phase F (linux-p4 L3): the same directory also holds one sub-directory per non-Windows platform, each with the
 * manifest its own build writes, so no new configuration key is needed: `linux/manifest.json` is the folder
 * `pnpm linux:pkg` writes (`packaging/linux/out/dist/`: the deb, the rpm and their rows), `macos/manifest.json` the
 * PKG's. Each row's file is resolved inside the directory of the manifest that names it. A row whose `format`
 * belongs to another platform than its `platform` says is skipped (an `msi` is Windows, `deb` / `rpm` Linux, `pkg`
 * macOS).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  installerDistManifestSchema,
  installerFileName,
  installerFormatOf,
  installerPlatformForFormat,
  installerPlatformOf,
  type InstallerArch,
  type InstallerBuild,
  type InstallerFormat,
  type InstallerPlatform,
} from '@indiansassist/shared';
import type { Config } from '../config.js';

export type ServedInstaller = InstallerBuild & { path: string; file: string };

/** The manifests read, relative to `AGENT_MSI_DIST_DIR`: the MSI one at the root, then one per other platform. */
export const INSTALLER_MANIFEST_DIRS = ['', 'linux', 'macos'] as const;

/** The wire manifest caps the list (`installerManifestSchema`). */
const MAX_BUILDS = 16;

export class InstallerDist {
  private builds: ServedInstaller[] = [];
  /** Why the manifest is empty or partial (logged once per load). */
  lastError: string | null = null;

  constructor(private readonly config: Pick<Config, 'fleet'>) {}

  /** (Re)reads every manifest; never throws (a bad manifest serves nothing of its own). */
  load(): void {
    const root = this.config.fleet.msiDistDir;
    this.lastError = null;
    const out: ServedInstaller[] = [];
    const errors: string[] = [];
    let found = 0;
    for (const sub of INSTALLER_MANIFEST_DIRS) {
      const distDir = sub ? join(root, sub) : root;
      const manifestPath = join(distDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      found++;
      try {
        const m = installerDistManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
        for (const b of m.builds) {
          const format = installerFormatOf(b);
          if (installerPlatformOf(b) !== installerPlatformForFormat(format)) continue;
          const file = b.file ?? installerFileName(b.arch, b.version, format);
          const path = resolve(distDir, file);
          // A manifest never reaches outside its own directory, and never names a file that is not there.
          if (dirname(path) !== resolve(distDir) || !existsSync(path)) continue;
          // One row per (platform, arch, format): the first manifest that names it wins.
          if (out.some((o) => o.arch === b.arch && installerFormatOf(o) === format)) continue;
          const { file: _f, ...build } = b;
          void _f;
          out.push({ ...build, size: statSync(path).size, path, file });
        }
      } catch (err) {
        errors.push(`${sub || '.'}/manifest.json is invalid: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    this.builds = out.slice(0, MAX_BUILDS);
    if (found === 0) this.lastError = 'no manifest.json in AGENT_MSI_DIST_DIR';
    else if (errors.length > 0) this.lastError = errors.join('; ');
  }

  /** The wire manifest (`GET /download/installer`): every platform's rows. */
  manifest(): { v: 1; builds: InstallerBuild[] } {
    return { v: 1, builds: this.builds.map(({ path: _p, file: _f, ...b }) => (void _p, void _f, b)) };
  }

  /** The build for `arch` in `format` (absent = the MSI); the platform follows from the format. */
  find(arch: InstallerArch, format: InstallerFormat = 'msi', platform: InstallerPlatform = installerPlatformForFormat(format)): ServedInstaller | null {
    return this.builds.find((b) => b.arch === arch && installerFormatOf(b) === format && installerPlatformOf(b) === platform) ?? null;
  }

  /** Every served installer (the public list). The array object changes on each load, which is how a cache can tell. */
  served(): readonly ServedInstaller[] {
    return this.builds;
  }

  /** Whether this node can serve any installer at all (the console offers the download only then). */
  get available(): boolean {
    return this.builds.length > 0;
  }
}
