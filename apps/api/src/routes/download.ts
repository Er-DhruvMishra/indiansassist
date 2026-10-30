/**
 * Agent download (docs/specs/phase-c-contracts.md section 2.2, W3): the bearer never travels in a URL, so
 * `GET /download?t=` is a two-step grant. `prepare` runs the token lookup (same failures and budgets as
 * `public-lookup`), mints a desk code for the filename (section 2.3) and a 120 s grant; `GET /download/:grant` streams
 * the build to the same IP at most 3 times (`HEAD` free), honours `Range`, refuses another region, and chains
 * `download.served` once per grant.
 */
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  agentFileName,
  downloadPrepareSchema,
  isRegionServed,
  LIMITS,
  sha256Hex,
  type AgentArch,
  type AgentPlatform,
  type DownloadPrepareReply,
  type Region,
} from '@indiansassist/shared';
import { getOrg } from '@indiansassist/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { systemActor, writeAudit } from '../lib/audit.js';
import { mintDeskCode } from '../lib/desk-codes.js';
import { iso } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { limits } from '../plugins/security.js';
import { verifyTokenInput } from '../services/token-verify.js';

type Grant = {
  tokenId: string;
  orgId: string;
  region: Region;
  deskCode: string;
  platform: AgentPlatform;
  arch: AgentArch;
  version: string;
  sha256: string;
  ip: string;
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
      ip: req.ip,
    };
    await ctx.presence.setKey(grantKey(sha256Hex(grant)), JSON.stringify(g), LIMITS.downloadGrantTtlSec);
    const filename = build.platform === 'android' ? build.file : agentFileName(tok.region, deskCode);
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
    if (!build || build.sha256 !== g.sha256) fail('link_expired', 'this build is no longer served');
    let uses = 0;
    if (!head) {
      uses = await ctx.presence.incr(`${grantKey(hash)}:uses`, LIMITS.downloadGrantTtlSec);
      if (uses > LIMITS.downloadGrantMaxUses) fail('link_expired', 'this download link was used up; start the download again');
    }
    const range = parseRange(req.headers['range'], build.size);
    if (range === 'bad') {
      reply.header('Content-Range', `bytes */${build.size}`);
      return reply.status(416).send();
    }
    const filename = build.platform === 'android' ? build.file : agentFileName(g.region, g.deskCode);
    reply
      .header('Content-Type', build.platform === 'android' ? 'application/vnd.android.package-archive' : 'application/vnd.microsoft.portable-executable')
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
          data: { tokenId: g.tokenId, platform: g.platform, arch: g.arch, version: g.version, sha256: g.sha256 },
        });
    }
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
}
