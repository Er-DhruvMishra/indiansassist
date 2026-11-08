/**
 * Agent builds served by this node (docs/specs/phase-c-contracts.md sections 2.2, 2.6): `AGENT_DIST_DIR/manifest.json`
 * and the files it names, read at boot and on SIGHUP. A node without the directory serves `builds: []` and answers
 * `503 download_unavailable` on prepare. Outside production a placeholder file (`AGENT_DEV_STUB`, created on demand)
 * stands in for every Windows build so the join page and `smoke:p3` work on a dev machine; it is never signed and
 * never served in production. A Linux build (Phase E section 7.6) is the raw ELF; its archive body (the second gzip
 * member of `services/linux-archive.ts`) is compressed here, once per load, and cached on the served build. Phase F
 * section 9.5: the Wayland portal companion (`IndiansAssist-linux-portal-x64-<v>`) beside it adds members 3 and 4.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  agentDistFileName,
  agentDistManifestSchema,
  agentPortalDistFileName,
  extensionDistFileName,
  extensionDistManifestSchema,
  type AgentArch,
  type AgentBuild,
  type AgentPlatform,
} from '@indiansassist/shared';
import type { Config } from '../config.js';
import { linuxArchiveBody, type LinuxArchiveBody } from './linux-archive.js';
import { loadMacZip } from './macos-archive.js'; // apple-owned (import)

/** `archive` is set for a Linux build only: the cached compressed ELF body of its per-download `.tar.gz`. */
export type ServedBuild = AgentBuild & { path: string; file: string; archive?: LinuxArchiveBody };

/** A packaged extension zip from `AGENT_DIST_DIR/extension/manifest.json` (the public downloads page). */
export type ServedExtension = { version: string; size: number; sha256: string; minOs: string; path: string; file: string };

const DEV_STUB_TEXT =
  'IndiansAssist development placeholder. This is NOT the support client: no agent build is installed on this server ' +
  '(set AGENT_DIST_DIR to a directory with manifest.json).\r\n';

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export class AgentDist {
  private builds: ServedBuild[] = [];
  private extensions: ServedExtension[] = [];
  /** Why the manifest is empty (logged once per load). */
  lastError: string | null = null;
  /** Why the extension manifest was not read (never stops the boot or the agent builds). */
  extensionError: string | null = null;

  constructor(private readonly config: Pick<Config, 'agent'>) {}

  /** The extension zips of `<distDir>/extension/`; `[]` when the directory or manifest is absent. Never throws. */
  private loadExtensions(distDir: string): void {
    this.extensions = [];
    this.extensionError = null;
    const dir = join(distDir, 'extension');
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) return;
    try {
      const m = extensionDistManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
      for (const b of m.builds) {
        const file = b.file ?? extensionDistFileName(b.version);
        const path = resolve(dir, file);
        // A manifest never reaches outside its own directory, and never names a file that is not there.
        if (dirname(path) !== resolve(dir) || !existsSync(path)) continue;
        this.extensions.push({ version: b.version, size: statSync(path).size, sha256: b.sha256, minOs: b.minOs, path, file });
      }
    } catch (err) {
      this.extensions = [];
      this.extensionError = `extension/manifest.json is invalid: ${(err as Error).message.slice(0, 200)}`;
    }
  }

  /** (Re)reads the manifest; never throws (a bad manifest serves nothing). */
  load(): void {
    const { distDir, devStub, minVersion } = this.config.agent;
    this.lastError = null;
    this.loadExtensions(distDir);
    const manifestPath = join(distDir, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
        const m = agentDistManifestSchema.parse(raw);
        const out: ServedBuild[] = [];
        for (const b of m.builds) {
          const file = b.file ?? agentDistFileName(b.platform, b.arch, b.version);
          const path = resolve(distDir, file);
          if (dirname(path) !== resolve(distDir) || !existsSync(path)) continue;
          const { file: _f, ...build } = b;
          void _f;
          // apple-owned: begin
          // Phase F section 17.2: the macOS build (the cached members of the signed IndiansAssist.app); the apple
          // stream fills this block, and the coordinator alone edits around it. `services/macos-archive.ts` cuts the
          // bundle's stored members from the dist zip here and caches them (`routes/download.ts` adds the signed
          // sidecar per grant); a zip it cannot serve leaves the build out, so it is "not served" from boot on.
          if (build.platform === 'macos') {
            const served: ServedBuild = { ...build, size: statSync(path).size, path, file };
            try {
              loadMacZip(served);
            } catch (err) {
              this.lastError = `${file} is not served: ${(err as Error).message.slice(0, 200)}`;
              continue;
            }
            out.push(served);
            continue;
          }
          // apple-owned: end
          if (build.platform === 'linux') {
            const elf = readFileSync(path);
            // Phase F section 9.5: the portal companion beside it (`agentPortalDistFileName`), when present, rides in
            // the same archive as `.ia-portal`; its sha256 and size are read from the file. A manifest row whose
            // companion does not match the file serves the archive without it.
            const portal = this.loadCompanion(distDir, build.version, build.companion);
            const { companion: _c, ...rest } = build;
            void _c;
            out.push({
              ...rest,
              ...(portal ? { companion: portal.info } : {}),
              size: elf.length,
              path,
              file,
              archive: linuxArchiveBody(elf, portal?.bytes),
            });
          } else out.push({ ...build, size: statSync(path).size, path, file });
        }
        this.builds = out;
        return;
      } catch (err) {
        this.lastError = `manifest.json is invalid: ${(err as Error).message.slice(0, 200)}`;
        this.builds = [];
        return;
      }
    }
    if (!devStub) {
      this.builds = [];
      this.lastError = 'no manifest.json in AGENT_DIST_DIR';
      return;
    }
    if (!existsSync(devStub)) {
      mkdirSync(dirname(devStub), { recursive: true });
      writeFileSync(devStub, DEV_STUB_TEXT);
    }
    const size = statSync(devStub).size;
    const sha256 = sha256File(devStub);
    const file = basename(devStub);
    this.builds = (['x64', 'arm64'] as const).map((arch) => ({
      platform: 'windows' as const,
      arch,
      version: minVersion,
      size,
      sha256,
      signed: false,
      minOs: '10.0.17763',
      path: devStub,
      file,
    }));
  }

  /** Phase F section 9.5: the portal companion of a Linux build, if its file exists (and matches the row, when given). */
  private loadCompanion(
    distDir: string,
    version: string,
    row: { sha256: string; size: number } | undefined,
  ): { bytes: Buffer; info: { sha256: string; size: number } } | null {
    const path = resolve(distDir, agentPortalDistFileName(version));
    if (!existsSync(path)) {
      if (row) this.lastError = `${agentPortalDistFileName(version)} is missing; the Linux download is served without it`;
      return null;
    }
    const bytes = readFileSync(path);
    const info = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    if (row && (row.sha256 !== info.sha256 || row.size !== info.size)) {
      this.lastError = `${agentPortalDistFileName(version)} does not match manifest.json; the Linux download is served without it`;
      return null;
    }
    return { bytes, info };
  }

  /** The wire manifest (`GET /download/manifest`). */
  manifest(): { v: 1; builds: AgentBuild[] } {
    return { v: 1, builds: this.builds.map(({ path: _p, file: _f, archive: _a, ...b }) => (void _p, void _f, void _a, b)) };
  }

  find(platform: AgentPlatform, arch: AgentArch): ServedBuild | null {
    return this.builds.find((b) => b.platform === platform && b.arch === arch) ?? null;
  }

  /** Every served build (the public list). The array object changes on each load, which is how a cache can tell. */
  served(): readonly ServedBuild[] {
    return this.builds;
  }

  /** The packaged extension zips (the public list). */
  servedExtensions(): readonly ServedExtension[] {
    return this.extensions;
  }

  /** `PublicToken.agent` (section 2.7 J6). */
  publicInfo(): { windows: { x64: boolean; arm64: boolean }; android: { apk: boolean; appUrl: string | null }; minVersion: string } {
    return {
      windows: { x64: this.find('windows', 'x64') !== null, arm64: this.find('windows', 'arm64') !== null },
      android: { apk: this.find('android', 'universal') !== null, appUrl: this.config.agent.androidAppUrl },
      minVersion: this.config.agent.minVersion,
    };
  }
}
