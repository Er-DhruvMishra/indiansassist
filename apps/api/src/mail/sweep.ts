/**
 * Phase F stream mail, rule 4.3h: deletes `password_reset` rows 24 h after `expires_at` or `used_at`. Run by the
 * sweeper lease holder after the A-E passes; a no-op until the mail stream fills it.
 */
import type { AppContext } from '../context.js';

export async function sweepMailTokens(ctx: AppContext, now: Date = new Date()): Promise<void> {
  void ctx;
  void now;
}
