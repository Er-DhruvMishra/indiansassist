/**
 * Boot cleanup (contracts section 7.6 N3) and the 10 s sweeper (N4): deadline timeouts, sessions left on revoked
 * tokens, sessions owned by lost nodes, login_attempt retention, expired / abandoned uploads, recording retention
 * (Phase B Y26) and hourly periodic checkpoints (section 5.6 C2). Every node starts a sweeper, but a pass runs only on the holder of the `sweeper`
 * presence lease (one node of the cluster at a time; the memory driver always holds it).
 */
import {
  deleteLoginAttemptsBefore,
  getOrg,
  getOrgChainTail,
  getAuditEntryBySeq,
  listExpiredUploads,
  listOpenSessionsByNode,
  listOpenSessionsOnRevokedTokens,
  listRecordingsPastRetention,
  listSessionsPastDeadline,
  NON_ENDED_STATES,
  org as orgTable,
  session as sessionTable,
} from '@indiansassist/db';
import { and, inArray, ne } from 'drizzle-orm';
import type { AppContext } from './context.js';
import { systemActor } from './lib/audit.js';
import { writeCheckpoint } from './services/audit-service.js';
import { deleteRecording } from './services/recording-delete.js';
import { deleteParts, failRecording } from './services/recording-service.js';
import { endSessionQuietly } from './services/session-end.js';

const HOUR_MS = 60 * 60_000;
/** Lease TTL: three missed passes before another node takes over. */
const LEASE_TTL_SEC = 30;

/** N3: a restarted node closes only its own non-ended rows. */
export async function bootCleanup(ctx: AppContext): Promise<number> {
  const rows = await listOpenSessionsByNode(ctx.db, ctx.config.nodeId);
  for (const s of rows) await endSessionQuietly(ctx, s.id, { reason: 'error', actor: systemActor });
  return rows.length;
}

export class Sweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPeriodic = Date.now();

  constructor(private readonly ctx: AppContext) {}

  start(intervalMs = 10_000): void {
    this.timer = setInterval(() => void this.runOnce().catch((err: unknown) => this.ctx.log.error({ err }, 'sweeper failed')), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(opts: { forcePeriodic?: boolean } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.ctx.presence.tryLease('sweeper', this.ctx.config.nodeId, LEASE_TTL_SEC))) return;
      await this.deadlines();
      await this.revokedTokens();
      await this.lostNodes();
      await deleteLoginAttemptsBefore(this.ctx.db, new Date(Date.now() - 24 * HOUR_MS));
      await this.expiredUploads();
      await this.retention();
      if (opts.forcePeriodic || Date.now() - this.lastPeriodic >= HOUR_MS) {
        this.lastPeriodic = Date.now();
        await this.periodicCheckpoints();
      }
    } finally {
      this.running = false;
    }
  }

  private async deadlines(): Promise<void> {
    for (const s of await listSessionsPastDeadline(this.ctx.db)) {
      await endSessionQuietly(this.ctx, s.id, { reason: 'timeout', actor: systemActor, from: [s.state] });
    }
  }

  /** Backstop for the revocation cascade (sections 6.7, 7.4; SEC-09): sessions left live on a revoked token. */
  private async revokedTokens(): Promise<void> {
    for (const s of await listOpenSessionsOnRevokedTokens(this.ctx.db))
      await endSessionQuietly(this.ctx, s.id, { reason: 'token_revoked', actor: systemActor });
  }

  /**
   * N4 lost-node sweep. Only meaningful with a presence driver that sees other nodes; with the single-node
   * `memory` driver every foreign node looks lost, so the sweep is skipped (a second replica on the same database
   * would otherwise end the first one's live sessions, prd-F2). config.ts documents single-replica for `memory`.
   * When this node's own heartbeat key is missing the presence store lost its state (flush, failover): every node
   * would look lost, so the pass is skipped and the heartbeat rewritten.
   */
  private async lostNodes(): Promise<void> {
    if (!this.ctx.presence.multiNode) return;
    const own = this.ctx.config.nodeId;
    if (!(await this.ctx.presence.isNodeAlive(own))) {
      await this.ctx.presence.heartbeatNode(own, 90);
      this.ctx.log.warn({ nodeId: own }, 'own presence heartbeat was missing; lost-node sweep skipped');
      return;
    }
    const rows = await this.ctx.db
      .select({ id: sessionTable.id, nodeId: sessionTable.nodeId })
      .from(sessionTable)
      .where(and(ne(sessionTable.nodeId, this.ctx.config.nodeId), inArray(sessionTable.state, [...NON_ENDED_STATES])));
    const alive = new Map<string, boolean>();
    for (const r of rows) {
      if (!alive.has(r.nodeId)) alive.set(r.nodeId, await this.ctx.presence.isNodeAlive(r.nodeId));
      if (!alive.get(r.nodeId)) await endSessionQuietly(this.ctx, r.id, { reason: 'error', actor: systemActor });
    }
  }

  /**
   * Expired chunked uploads (24 h) and abandoned single uploads (1 h, a crash mid-stream) are failed and their
   * objects deleted (SEC-08): storage first, so a failure leaves the row `uploading` for the next pass instead of
   * a `failed` row whose parts nobody deletes. One bad row does not stop the others.
   */
  private async expiredUploads(): Promise<void> {
    for (const rec of await listExpiredUploads(this.ctx.db)) {
      try {
        const o = await getOrg(this.ctx.db, rec.orgId);
        if (!o) continue;
        await deleteParts(this.ctx, rec);
        await this.ctx.storage.delete(rec.storageKey);
        await failRecording(this.ctx, o, rec, 'upload_expired');
      } catch (err) {
        this.ctx.log.error({ err, recordingId: rec.id }, 'expired upload cleanup failed; retried next pass');
      }
    }
  }

  /**
   * Phase B Y26: recordings older than their org's `recording_retention_days` are deleted (object removed, row
   * kept, `recording.deleted { cause: 'retention' }` by the system). One bad row does not stop the others.
   */
  async retention(): Promise<number> {
    let n = 0;
    for (const rec of await listRecordingsPastRetention(this.ctx.db)) {
      try {
        const o = await getOrg(this.ctx.db, rec.orgId);
        if (o && (await deleteRecording(this.ctx, o, rec, 'retention', systemActor, null))) n++;
      } catch (err) {
        this.ctx.log.error({ err, recordingId: rec.id }, 'retention delete failed; retried next pass');
      }
    }
    return n;
  }

  /** Every org whose tail entry is not itself an `audit.anchored` entry gets a `periodic` checkpoint. */
  async periodicCheckpoints(): Promise<number> {
    let n = 0;
    for (const o of await this.ctx.db.select().from(orgTable)) {
      const tail = await getOrgChainTail(this.ctx.db, o.id);
      if (!tail) continue;
      const last = await getAuditEntryBySeq(this.ctx.db, o.id, tail.seq);
      if (last?.action === 'audit.anchored') continue;
      if (await writeCheckpoint(this.ctx, this.ctx.db, o, 'periodic')) n++;
    }
    return n;
  }
}
