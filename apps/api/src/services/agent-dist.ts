/**
 * Agent builds served by this node (docs/specs/phase-c-contracts.md sections 2.2, 2.6): `AGENT_DIST_DIR/manifest.json`
 * and the files it names, read at boot and on SIGHUP. A node without the directory serves `builds: []` and answers
 * `503 download_unavailable` on prepare. Outside production a placeholder file (`AGENT_DEV_STUB`, created on demand)
 * stands in for every Windows build so the join page and `smoke:p3` work on a dev machine; it is never signed and
 * never served in production.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  agentDistFileName,
  agentDistManifestSchema,
  type AgentArch,
  type AgentBuild,
  type AgentPlatform,
} from '@indiansassist/shared';
import type { Config } from '../config.js';

export type ServedBuild = AgentBuild & { path: string; file: string };

const DEV_STUB_TEXT =
  'IndiansAssist development placeholder. This is NOT the support client: no agent build is installed on this server ' +
  '(set AGENT_DIST_DIR to a directory with manifest.json).\r\n';

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export class AgentDist {
  private builds: ServedBuild[] = [];
  /** Why the manifest is empty (logged once per load). */
  lastError: string | null = null;

  constructor(private readonly config: Pick<Config, 'agent'>) {}

  /** (Re)reads the manifest; never throws (a bad manifest serves nothing). */
  load(): void {
    const { distDir, devStub, minVersion } = this.config.agent;
    this.lastError = null;
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
          out.push({ ...build, size: statSync(path).size, path, file });
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

  /** The wire manifest (`GET /download/manifest`). */
  manifest(): { v: 1; builds: AgentBuild[] } {
    return { v: 1, builds: this.builds.map(({ path: _p, file: _f, ...b }) => (void _p, void _f, b)) };
  }

  find(platform: AgentPlatform, arch: AgentArch): ServedBuild | null {
    return this.builds.find((b) => b.platform === platform && b.arch === arch) ?? null;
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
