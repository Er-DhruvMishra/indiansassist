/**
 * The branded Windows installers served by this node (docs/specs/phase-d-contracts.md sections 12.1, 12.2, 13.4):
 * `AGENT_MSI_DIST_DIR/manifest.json` and the MSI files it names, read at boot and on SIGHUP exactly as the Phase C
 * `AgentDist` reads the agent builds. A node without the directory serves `builds: []`, so the console simply does
 * not offer the download; there is no development stand-in, because an unsigned MSI is not something to hand out by
 * accident (`docs/release.md` publishes the signed MSI here).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installerDistManifestSchema, installerFileName, type InstallerArch, type InstallerBuild } from '@indiansassist/shared';
import type { Config } from '../config.js';

export type ServedInstaller = InstallerBuild & { path: string; file: string };

export class InstallerDist {
  private builds: ServedInstaller[] = [];
  /** Why the manifest is empty (logged once per load). */
  lastError: string | null = null;

  constructor(private readonly config: Pick<Config, 'fleet'>) {}

  /** (Re)reads the manifest; never throws (a bad manifest serves nothing). */
  load(): void {
    const distDir = this.config.fleet.msiDistDir;
    this.lastError = null;
    this.builds = [];
    const manifestPath = join(distDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      this.lastError = 'no manifest.json in AGENT_MSI_DIST_DIR';
      return;
    }
    try {
      const m = installerDistManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
      const out: ServedInstaller[] = [];
      for (const b of m.builds) {
        const file = b.file ?? installerFileName(b.arch, b.version);
        const path = resolve(distDir, file);
        // A manifest never reaches outside its own directory, and never names a file that is not there.
        if (dirname(path) !== resolve(distDir) || !existsSync(path)) continue;
        const { file: _f, ...build } = b;
        void _f;
        out.push({ ...build, size: statSync(path).size, path, file });
      }
      this.builds = out;
    } catch (err) {
      this.lastError = `manifest.json is invalid: ${(err as Error).message.slice(0, 200)}`;
    }
  }

  /** The wire manifest (`GET /download/installer`). */
  manifest(): { v: 1; builds: InstallerBuild[] } {
    return { v: 1, builds: this.builds.map(({ path: _p, file: _f, ...b }) => (void _p, void _f, b)) };
  }

  find(arch: InstallerArch): ServedInstaller | null {
    return this.builds.find((b) => b.arch === arch) ?? null;
  }

  /** Whether this node can serve any installer at all (the console offers the download only then). */
  get available(): boolean {
    return this.builds.length > 0;
  }
}
