/**
 * Recording deletion (docs/specs/phase-b-contracts.md section 11.3, Y26): the object (and any upload parts) is
 * removed from storage, the row is marked `deleted_at` / `deleted_by` and stays (the chain references it), and
 * `recording.deleted { recordingId, cause, bytes }` is appended. Used by `DELETE /recordings/:id` (manual) and by
 * the retention sweep (actor system).
 */
import { markRecordingDeleted, type OrgRow, type RecordingRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { writeAudit, type Actor } from '../lib/audit.js';
import { deleteParts } from './recording-service.js';

/** True when this call deleted it; false when it was already deleted (a concurrent delete won). */
export async function deleteRecording(
  ctx: AppContext,
  org: OrgRow,
  rec: RecordingRow,
  cause: 'manual' | 'retention',
  actor: Actor,
  deletedBy: string | null,
): Promise<boolean> {
  // Storage first: a failure leaves the row undeleted for a retry instead of a row whose object nobody removes.
  await deleteParts(ctx, rec);
  await ctx.storage.delete(rec.storageKey);
  return ctx.db.transaction(async (tx) => {
    const row = await markRecordingDeleted(tx, rec.id, deletedBy);
    if (!row) return false;
    await writeAudit(ctx, tx, org, {
      sessionId: rec.sessionId,
      actor,
      action: 'recording.deleted',
      data: { recordingId: rec.id, cause, bytes: rec.bytes },
    });
    return true;
  });
}
