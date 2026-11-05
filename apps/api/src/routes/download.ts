/**
 * Agent download (docs/specs/phase-c-contracts.md section 2.2, W3): the bearer never travels in a URL, so
 * `GET /download?t=` is a two-step grant. `prepare` runs the token lookup (same failures and budgets as
 * `public-lookup`), mints a desk code for the filename (section 2.3) and a 120 s grant; `GET /download/:grant` streams
 * the build to the same IP at most 3 times (`HEAD` free), honours `Range`, refuses another region, and chains
 * `download.served` once per grant. Linux (Phase E section 7.6) serves the per-download `.tar.gz` of
 * `services/linux-archive.ts`, whose bytes are a pure function of the grant, under the same rules; Phase F section 9.5:
 * with the Wayland portal companion as `.ia-portal` beside the X11 binary when the build has one.
 */
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  agentFileName,
  downloadPrepareSchema,
  INSTALLER_ARCHES,
  installerDownloadQuerySchema,
  installerPlatformForFormat,
  isRegionServed,
  LIMITS,
  sha256Hex,
  type AgentArch,
  type AgentPlatform,
  type DownloadPrepareReply,
  type InstallerArch,
  type InstallerFormat,
  type InstallerManifest,
  type Region,
} from '@indiansassist/shared';
import { findTokenByTid, getOrg } from '@indiansassist/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { systemActor, userActor, writeAudit } from '../lib/audit.js';
import { mintDeskCode } from '../lib/desk-codes.js';
import { iso } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { limits } from '../plugins/security.js';
import { verifyTokenInput } from '../services/token-verify.js';
import { requireFleetRole } from '../fleet/scope.js';
import { authenticate } from '../plugins/auth.js';
import { effectiveStatus } from '../lib/mappers.js';
import type { ServedBuild } from '../services/agent-dist.js';
import { LINUX_ARCHIVE_CONTENT_TYPE, linuxArchiveName, linuxArchiveParts, partsLength, sliceParts } from '../services/linux-archive.js';

type Grant = {
  tokenId: string;
  orgId: string;
  region: Region;
  deskCode: string;
  platform: AgentPlatform;
  arch: AgentArch;
  version: string;
  sha256: string;
  /** Phase F section 9.5: the portal companion's sha256 when the Linux archive carries it (a grant serves the bytes it was
   * prepared for). Absent on grants minted before the companion existed. */
  companion?: string | null;
  ip: string;
};

/** Phase F section 8.11: each installer format's media type (the MSI as in Phase D). */
export const INSTALLER_CONTENT_TYPES: Record<InstallerFormat, string> = {
  msi: 'application/x-msi',
  deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-rpm',
  pkg: 'application/octet-stream',
};

const grantKey = (hash: string) => `ia:dl:${hash}`;
const GRANT_RE = /^[A-Za-z0-9_-]{43}$/;

async function loadGrant(ctx: AppContext, raw: string): Promise<{ hash: string; g: Grant } | null> {
  if (!GRANT_RE.test(raw)) return null;
  const hash = sha256Hex(raw);
  const v = await ctx.presence.getKey(grantKey(hash));
  if (!v) return null;
  try {
    return { hash, g: JSON.parse(v) as Grant };
  } catch {
    return null;
  }
}

/** The served name (C section 2.3; Phase E section 7.6): the APK's dist name, the per-download `.exe` or `.tar.gz`. */
function servedFileName(build: ServedBuild, region: Region, deskCode: string): string {
  if (build.platform === 'android') return build.file;
  if (build.platform === 'linux') return linuxArchiveName(region, deskCode);
  // apple-owned: begin
  // Phase F section 17.2: the macOS served name, the per-download stored zip `IndiansAssist-<region>-<dddd>-<dddd>-<dddd>.zip`.
  if (build.platform === 'macos') return agentFileName(region, deskCode).replace(/\.exe$/, '.zip');
  // apple-owned: end
  return agentFileName(region, deskCode);
}

const CONTENT_TYPES: Record<AgentPlatform, string> = {
  windows: 'application/vnd.microsoft.portable-executable',
  android: 'application/vnd.android.package-archive',
  linux: LINUX_ARCHIVE_CONTENT_TYPE,
  // Phase F section 17.2: the per-download stored zip of the macOS bundle (served once the apple stream ships it).
  macos: 'application/zip',
};

/** Parses a single `bytes=a-b` range; null = whole file, 'bad' = unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'bad';
  return { start, end };
}

export async function downloadRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/download/manifest', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return ctx.agentDist.manifest();
  });

  app.post('/api/v1/download/prepare', { config: limits.publicLookup }, async (req, reply) => {
    const lim = await ctx.limiter.hit(`download-prepare:${req.ip}`, 5, 60_000);
    if (!lim.allowed) {
      ctx.metrics.rateLimited.inc();
      fail('rate_limited', 'too many download requests', { retryAfterSec: lim.retryAfterSec });
    }
    const body = parseOr400(downloadPrepareSchema, req.body);
    const v = await verifyTokenInput(ctx, body.code, { ip: req.ip });
    if (!v.ok) {
      if (v.code === 'rate_limited') ctx.metrics.rateLimited.inc();
      if (v.code === 'token_gone' && v.details?.['status'] === 'used') fail('token_used', 'this code was already used');
      fail(v.code, v.message, v.details);
    }
    const tok = v.token;
    if (tok.tier !== 'p3_portable') fail('invalid_token_type', 'this code is not for the IndiansAssist support client');
    if (tok.typ === 'one_time' && tok.status === 'used') fail('token_used', 'this code was already used');
    const build = ctx.agentDist.find(body.platform, body.arch);
    if (!build) fail('download_unavailable', 'the support client is not available on this server');
    const deskCode = await mintDeskCode(ctx, tok);
    const grant = randomBytes(32).toString('base64url');
    const g: Grant = {
      tokenId: tok.id,
      orgId: tok.orgId,
      region: tok.region,
      deskCode,
      platform: build.platform,
      arch: build.arch,
      version: build.version,
      sha256: build.sha256,
      companion: build.companion?.sha256 ?? null,
      ip: req.ip,
    };
    await ctx.presence.setKey(grantKey(sha256Hex(grant)), JSON.stringify(g), LIMITS.downloadGrantTtlSec);
    const filename = servedFileName(build, tok.region, deskCode);
    const out: DownloadPrepareReply = {
      url: `${ctx.config.apiOrigin}/api/v1/download/${grant}`,
      expiresAt: iso(new Date(Date.now() + LIMITS.downloadGrantTtlSec * 1000)),
      filename,
      deskCode,
      version: build.version,
      sha256: build.sha256,
      signed: build.signed,
    };
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send(out);
  });

  const serve = async (req: FastifyRequest<{ Params: { grant: string } }>, reply: FastifyReply, head: boolean) => {
    const loaded = await loadGrant(ctx, req.params.grant);
    if (!loaded) fail('link_expired', 'this download link has expired; start the download again');
    const { hash, g } = loaded;
    if (g.ip !== req.ip || !isRegionServed(g.region, ctx.config.servedRegions))
      fail('link_expired', 'this download link has expired; start the download again');
    const build = ctx.agentDist.find(g.platform, g.arch);
    if (!build || build.sha256 !== g.sha256 || (build.companion?.sha256 ?? null) !== (g.companion ?? null))
      fail('link_expired', 'this build is no longer served');
    let uses = 0;
    if (!head) {
      uses = await ctx.presence.incr(`${grantKey(hash)}:uses`, LIMITS.downloadGrantTtlSec);
      if (uses > LIMITS.downloadGrantMaxUses) fail('link_expired', 'this download link was used up; start the download again');
    }
    // Linux: the archive of this grant (member 1 per request, member 2 cached at load); its length is the size served.
    let parts: Buffer[] | null = null;
    if (build.platform === 'linux') {
      if (!build.archive) fail('link_expired', 'this build is no longer served');
      parts = linuxArchiveParts(g.region, g.deskCode, build.archive);
    }
    // apple-owned: begin
    // Phase F section 17.2: the macOS zip of this grant: the bundle's stored members (cut from the dist zip when the
    // build was loaded) and the signed sidecar `IndiansAssist.iaconfig` carrying this grant's desk code. Ed25519 is
    // deterministic, so the bytes are a pure function of the grant (Range and HEAD hold).
    if (build.platform === 'macos') {
      const { macZipBodyFor, macZipParts } = await import('../services/macos-archive.js');
      const { signIaconfig } = await import('@indiansassist/shared');
      const body = macZipBodyFor(build);
      if (!body) fail('link_expired', 'this build is no longer served');
      const sidecar = await signIaconfig(
        { v: 1, apiOrigin: ctx.config.apiOrigin, region: g.region, code: g.deskCode, kid: ctx.keys.kid },
        ctx.keys.seedHex,
      );
      parts = macZipParts(body, sidecar);
    }
    // apple-owned: end
    const size = parts ? partsLength(parts) : build.size;
    const range = parseRange(req.headers['range'], size);
    if (range === 'bad') {
      reply.header('Content-Range', `bytes */${size}`);
      return reply.status(416).send();
    }
    const filename = servedFileName(build, g.region, g.deskCode);
    reply
      .header('Content-Type', CONTENT_TYPES[build.platform])
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Accept-Ranges', 'bytes');
    if (!head && uses === 1) {
      const org = await getOrg(ctx.db, g.orgId);
      if (org)
        await writeAudit(ctx, ctx.db, org, {
          sessionId: null,
          actor: systemActor,
          action: 'download.served',
          data: {
            tokenId: g.tokenId,
            platform: g.platform,
            arch: g.arch,
            version: g.version,
            sha256: g.sha256,
            // Phase F section 9.5: the Linux archive carried the portal companion.
            ...(g.platform === 'linux' ? { companion: Boolean(g.companion) } : {}),
          },
        });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    reply.header('Content-Length', String(size === 0 ? 0 : end - start + 1));
    if (range) reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.status(range ? 206 : 200);
    if (head || size === 0) return reply.send();
    if (parts) return reply.send(Readable.from(sliceParts(parts, start, end)));
    return reply.send(createReadStream(build.path, { start, end }));
  };

  // ---------- the branded installer (Phase D sections 12.1, 12.2, 13.4) ----------

  app.get('/api/v1/download/installer', async (req, reply): Promise<InstallerManifest> => {
    const p = await authenticate(ctx, req);
    requireFleetRole(p, 'admin');
    reply.header('Cache-Control', 'no-store');
    return ctx.installerDist.manifest();
  });

  const serveInstaller = async (req: FastifyRequest<{ Params: { arch: string } }>, reply: FastifyReply, head: boolean) => {
    const p = await authenticate(ctx, req);
    requireFleetRole(p, 'admin');
    const arch = (INSTALLER_ARCHES as readonly string[]).includes(req.params.arch) ? (req.params.arch as InstallerArch) : null;
    if (!arch) fail('not_found', 'unknown installer arch');
    const q = parseOr400(installerDownloadQuerySchema, req.query);
    // The download is audited against the enrollment token whose config the rollout will carry (section 12.1).
    const tok = await findTokenByTid(ctx.db, q.tokenId);
    if (!tok || tok.orgId !== p.org.id) fail('not_found', 'token not found');
    if (tok.typ !== 'enrollment' || tok.tier !== 'p4_installed') fail('invalid_token_type', 'the installer is served for a p4_installed enrollment token');
    const status = effectiveStatus(tok);
    if (status !== 'active') fail('token_gone', `token is ${status}`, { status });
    const format: InstallerFormat = q.format ?? 'msi';
    const platform = installerPlatformForFormat(format);
    const build = ctx.installerDist.find(arch, format, platform);
    if (!build) fail('download_unavailable', `no ${format} installer for this architecture is available on this server`);
    const range = parseRange(req.headers['range'], build.size);
    if (range === 'bad') {
      reply.header('Content-Range', `bytes */${build.size}`);
      return reply.status(416).send();
    }
    reply
      .header('Content-Type', INSTALLER_CONTENT_TYPES[format])
      .header('Content-Disposition', `attachment; filename="${build.file}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Accept-Ranges', 'bytes');
    // As the Phase C route: HEAD is free, and a served download chains one entry (the whole file, or its first range).
    if (!head && (range === null || range.start === 0))
      await writeAudit(ctx, ctx.db, p.org, {
        sessionId: null,
        actor: userActor(p.user),
        action: 'download.served',
        // Section 8.11: the entry names the platform and the package format (`msi` included).
        data: { tokenId: tok.id, platform, arch: build.arch, version: build.version, sha256: build.sha256, format },
      });
    const start = range?.start ?? 0;
    const end = range?.end ?? build.size - 1;
    reply.header('Content-Length', String(build.size === 0 ? 0 : end - start + 1));
    if (range) reply.header('Content-Range', `bytes ${start}-${end}/${build.size}`);
    reply.status(range ? 206 : 200);
    if (head || build.size === 0) return reply.send();
    return reply.send(createReadStream(build.path, { start, end }));
  };

  // HEAD first: Fastify's automatic HEAD sibling of a GET route would otherwise count as a use.
  app.head<{ Params: { grant: string } }>('/api/v1/download/:grant', (req, reply) => serve(req, reply, true));
  app.get<{ Params: { grant: string } }>('/api/v1/download/:grant', (req, reply) => serve(req, reply, false));
  app.head<{ Params: { arch: string } }>('/api/v1/download/installer/:arch', (req, reply) => serveInstaller(req, reply, true));
  app.get<{ Params: { arch: string } }>('/api/v1/download/installer/:arch', (req, reply) => serveInstaller(req, reply, false));
}
