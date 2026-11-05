/**
 * The playbook manifest of a connected device (docs/specs/phase-d-contracts.md rule 9.3, section 3.4). A device
 * learns its org's catalogue in `device.hello.ok.playbooks` and verifies every queued `playbook_run` body against it,
 * so a playbook created or changed after the device connected would be refused there (`not_allowed`) until the next
 * reconnect. Whenever an org's catalogue changes (create, update, enable or disable, delete), this pushes
 * `device.playbooks { playbooks }` (S->D) to the org's connected devices: the same entries, built the same way and
 * filtered by each device's interpreters exactly as the hello's are, so the pin model is unchanged. Bursts coalesce
 * into one push per org per `MANIFEST_PUSH_COALESCE_MS`, and the push always carries the catalogue as it stands when
 * it fires.
 */
import { LIMITS } from '@indiansassist/shared';
import { listEnrolledDevices, listManifestPlaybooks, type DeviceRow, type Executor } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { buildManifest } from '../signal/agent-manifest.js';

/** One push per org within this window, however many catalogue changes it holds. */
export const MANIFEST_PUSH_COALESCE_MS = 500;

/** The interpreters a device reported in its last `device.hello` (`capabilities.interpreters`). */
export function interpretersOfDevice(d: Pick<DeviceRow, 'capabilities'>): string[] {
  const i = (d.capabilities as { interpreters?: unknown } | null)?.interpreters;
  return Array.isArray(i) ? i.filter((x): x is string => typeof x === 'string') : [];
}

/** The manifest entries a device with these interpreters receives (the `device.hello.ok.playbooks` value). */
export async function devicePlaybooks(db: Executor, orgId: string, interpreters: readonly string[]): Promise<Record<string, unknown>[]> {
  const rows = await listManifestPlaybooks(db, orgId, interpreters, LIMITS.playbookCatalogueMax + 1);
  return buildManifest(rows).msg.playbooks;
}

/** Pushes `device.playbooks` to every connected device of an org; returns how many sockets it reached. */
export async function pushPlaybooksNow(ctx: AppContext, orgId: string): Promise<number> {
  const devices = await listEnrolledDevices(ctx.db, orgId);
  // Devices with the same interpreters share one manifest, so the catalogue is read once per distinct set.
  const byKey = new Map<string, Promise<Record<string, unknown>[]>>();
  let reached = 0;
  for (const d of devices) {
    const interpreters = [...interpretersOfDevice(d)].sort();
    const key = interpreters.join(',');
    let manifest = byKey.get(key);
    if (!manifest) {
      manifest = devicePlaybooks(ctx.db, orgId, interpreters);
      byKey.set(key, manifest);
    }
    try {
      if (await ctx.hub.devices.push(d.id, { t: 'device.playbooks', playbooks: await manifest })) reached++;
    } catch (err) {
      ctx.log.warn({ err, deviceId: d.id }, 'device.playbooks push failed');
    }
  }
  return reached;
}

/** The per-org coalescing timer. Owned by the device hub, so it stops with the node. */
export class ManifestPush {
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<Promise<unknown>>();
  delayMs = MANIFEST_PUSH_COALESCE_MS;

  constructor(private readonly ctx: AppContext) {}

  /** The org's catalogue changed: push within `delayMs`, once for the whole burst. */
  schedule(orgId: string): void {
    if (this.pending.has(orgId)) return;
    const timer = setTimeout(() => {
      // Cleared before the catalogue is read, so a change landing during the push schedules the next one.
      this.pending.delete(orgId);
      const run = pushPlaybooksNow(this.ctx, orgId)
        .catch((err: unknown) => this.ctx.log.warn({ err, orgId }, 'playbook manifest push failed'))
        .finally(() => this.running.delete(run));
      this.running.add(run);
    }, this.delayMs);
    timer.unref?.();
    this.pending.set(orgId, timer);
  }

  async close(): Promise<void> {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    await Promise.allSettled([...this.running]);
  }
}
