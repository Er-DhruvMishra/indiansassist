/**
 * The public downloads list and its files: built from what `AgentDist` and `InstallerDist` already loaded, so no
 * binary is stored twice. A file name resolves only through the map built here (never onto a path), and the map is
 * rebuilt when a reload swapped either dist's array (`served()` returns a new array each load).
 *
 * The Linux portable build is the one file that is not served raw: the X11 ELF only works with its portal companion
 * beside it as `.ia-portal` (mode 0755, the name it looks for), so the download is the cached `.tar.gz` of
 * `services/linux-archive.ts` with a generic inner name. Its sha256 is computed here, once per load, and the archive
 * itself is never marked signed: the detached signatures cover the two ELFs, not the archive.
 */
import { createHash } from 'node:crypto';
import {
  agentDistFileName,
  installerFormatOf,
  installerPlatformOf,
  publicLinuxArchiveName,
  type PublicDownloadFile,
  type PublicDownloadFormat,
  type PublicDownloads as PublicDownloadsReply,
} from '@indiansassist/shared';
import type { Config } from '../config.js';
import type { AgentDist, ServedBuild, ServedExtension } from './agent-dist.js';
import type { InstallerDist, ServedInstaller } from './installer-dist.js';
import { LINUX_ARCHIVE_CONTENT_TYPE, linuxArchiveHead, partsLength } from './linux-archive.js';

export const PUBLIC_CONTENT_TYPES: Record<PublicDownloadFormat, string> = {
  zip: 'application/zip',
  exe: 'application/vnd.microsoft.portable-executable',
  'tar.gz': LINUX_ARCHIVE_CONTENT_TYPE,
  'app.zip': 'application/zip',
  apk: 'application/vnd.android.package-archive',
  msi: 'application/x-msi',
  deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-rpm',
  pkg: 'application/octet-stream',
};

/** A file the public route can serve: on disk (`path`), or the in-memory members of the Linux archive (`parts`). */
export type PublicFile = Omit<PublicDownloadFile, 'url'> & ({ path: string; parts?: never } | { path?: never; parts: Buffer[] });

function formatOf(b: ServedBuild): PublicDownloadFormat {
  if (b.platform === 'windows') return 'exe';
  if (b.platform === 'android') return 'apk';
  if (b.platform === 'macos') return 'app.zip';
  return 'tar.gz';
}

function fromBuild(b: ServedBuild): PublicFile {
  const common = { tier: 'p3_portable' as const, platform: b.platform, arch: b.arch, format: formatOf(b), version: b.version, minOs: b.minOs };
  if (b.platform === 'linux' && b.archive) {
    const inner = agentDistFileName('linux', 'x64', b.version);
    const parts = [linuxArchiveHead(inner, b.archive.elfSize), b.archive.member];
    if (b.archive.companion) parts.push(b.archive.companion.head, b.archive.companion.member);
    const hash = createHash('sha256');
    for (const p of parts) hash.update(p);
    return { ...common, filename: publicLinuxArchiveName(b.version), size: partsLength(parts), sha256: hash.digest('hex'), signed: false, parts };
  }
  return { ...common, filename: b.file, size: b.size, sha256: b.sha256, signed: b.signed, path: b.path };
}

function fromInstaller(b: ServedInstaller): PublicFile {
  return {
    tier: 'p4_installed',
    platform: installerPlatformOf(b),
    arch: b.arch,
    format: installerFormatOf(b),
    version: b.version,
    minOs: b.minOs,
    filename: b.file,
    size: b.size,
    sha256: b.sha256,
    signed: b.signed ?? false,
    path: b.path,
  };
}

function fromExtension(b: ServedExtension): PublicFile {
  return {
    tier: 'p2_extension',
    platform: 'browser',
    arch: 'universal',
    format: 'zip',
    version: b.version,
    minOs: b.minOs,
    filename: b.file,
    size: b.size,
    sha256: b.sha256,
    signed: false,
    path: b.path,
  };
}

export class PublicDownloads {
  private seen: { agents: readonly ServedBuild[]; installers: readonly ServedInstaller[]; extensions: readonly ServedExtension[] } | null = null;
  private index = new Map<string, PublicFile>();

  constructor(
    private readonly config: Pick<Config, 'agent' | 'apiOrigin'>,
    private readonly agentDist: AgentDist,
    private readonly installerDist: InstallerDist,
  ) {}

  private files(): Map<string, PublicFile> {
    const agents = this.agentDist.served();
    const installers = this.installerDist.served();
    const extensions = this.agentDist.servedExtensions();
    if (!this.seen || this.seen.agents !== agents || this.seen.installers !== installers || this.seen.extensions !== extensions) {
      const next = new Map<string, PublicFile>();
      const add = (f: PublicFile) => {
        // The first of a name wins, as in the dists; a name is the only way in.
        if (!next.has(f.filename)) next.set(f.filename, f);
      };
      // Never the development placeholder: it is not a build (`AGENT_DEV_STUB`).
      for (const b of agents) if (b.path !== this.config.agent.devStub) add(fromBuild(b));
      for (const b of installers) add(fromInstaller(b));
      for (const b of extensions) add(fromExtension(b));
      this.index = next;
      this.seen = { agents, installers, extensions };
    }
    return this.index;
  }

  /** The file served under exactly this name, or null. Never interprets `name` as a path. */
  find(name: string): PublicFile | null {
    return this.files().get(name) ?? null;
  }

  /** The wire list (`GET /api/v1/downloads`). */
  list(): PublicDownloadsReply {
    const origin = this.config.apiOrigin;
    const files: PublicDownloadFile[] = [...this.files().values()].map(({ path: _path, parts: _parts, ...f }) => {
      void _path;
      void _parts;
      return { ...f, url: `${origin}/api/v1/downloads/${encodeURIComponent(f.filename)}` };
    });
    return { v: 1, files };
  }
}
