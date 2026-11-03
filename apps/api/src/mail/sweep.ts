/**
 * Phase F stream mail, rule 4.3h: deletes `password_reset` rows 24 h after `expires_at` or `used_at`. Run by the
 * sweeper lease holder after the A-E passes.
 */
import { deleteStalePasswordResets } from '@indiansassist/db';
import type { AppContext } from '../context.js';

export const MAIL_TOKEN_KEEP_MS = 24 * 60 * 60 * 1000;

export async function sweepMailTokens(ctx: AppContext, now: Date = new Date()): Promise<void> {
  const n = await deleteStalePasswordResets(ctx.db, new Date(now.getTime() - MAIL_TOKEN_KEEP_MS));
  if (n > 0) ctx.log.info({ deleted: n }, 'stale password-reset tokens deleted');
}
