/**
 * The public, login-free downloads (`/downloads`): the list and the generic files of the builds this node already
 * serves. Unrelated to the token grant (`POST /download/prepare`, `GET /download/:grant`) and the admin installer
 * routes, which are unchanged: a generic file carries no code, and the token and enrollment checks happen when one is
 * used. The file name resolves only through the known-file map (`services/public-downloads.ts`), so an unknown name,
 * a path or a traversal attempt is simply not found.
 */
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PublicDownloads as PublicDownloadsReply } from '@indiansassist/shared';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { limits } from '../plugins/security.js';
import { sliceParts } from '../services/linux-archive.js';
import { PUBLIC_CONTENT_TYPES, PublicDownloads } from '../services/public-downloads.js';
import { parseRange } from './download.js';

export async function publicDownloadRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const downloads = new PublicDownloads(ctx.config, ctx.agentDist, ctx.installerDist);

  app.get('/api/v1/downloads', { config: limits.publicDownloadsList }, async (_req, reply): Promise<PublicDownloadsReply> => {
    reply.header('Cache-Control', 'public, max-age=60');
    return downloads.list();
  });

  const serve = async (req: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply, head: boolean) => {
    const f = downloads.find(req.params.file);
    if (!f || (f.path !== undefined && !existsSync(f.path))) fail('not_found', 'this file is not published on this server');
    const range = parseRange(req.headers['range'], f.size);
    if (range === 'bad') {
      reply.header('Content-Range', `bytes */${f.size}`);
      return reply.status(416).send();
    }
    reply
      .header('Content-Type', PUBLIC_CONTENT_TYPES[f.format])
      .header('Content-Disposition', `attachment; filename="${f.filename}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=300')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Accept-Ranges', 'bytes')
      .header('ETag', `"${f.sha256}"`);
    const start = range?.start ?? 0;
    const end = range?.end ?? f.size - 1;
    reply.header('Content-Length', String(f.size === 0 ? 0 : end - start + 1));
    if (range) reply.header('Content-Range', `bytes ${start}-${end}/${f.size}`);
    reply.status(range ? 206 : 200);
    if (head || f.size === 0) return reply.send();
    if (f.parts) return reply.send(Readable.from(sliceParts(f.parts, start, end)));
    return reply.send(createReadStream(f.path, { start, end }));
  };

  // HEAD first: Fastify's automatic HEAD sibling of a GET route would otherwise answer it (as routes/download.ts).
  app.head<{ Params: { file: string } }>('/api/v1/downloads/:file', { config: limits.publicDownloadsFile }, (req, reply) => serve(req, reply, true));
  app.get<{ Params: { file: string } }>('/api/v1/downloads/:file', { config: limits.publicDownloadsFile }, (req, reply) => serve(req, reply, false));
}
