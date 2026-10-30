/**
 * Seeds the section 8.6 starter catalogue into an org (signup of an org whose plan includes P3). Each insert is
 * chained as `playbook.created` (actor system) so the catalogue has a record from its first row.
 */
import { tierWithin, type PackageTier } from '@indiansassist/shared';
import { insertPlaybook, type Executor, type OrgRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { systemActor, writeAudit } from '../lib/audit.js';
import { STARTER_PLAYBOOKS } from '../playbooks/starter.js';

export function planHasPlaybooks(planTier: PackageTier): boolean {
  return !tierWithin(planTier, 'p2_extension');
}

export async function seedStarterPlaybooks(ctx: Pick<AppContext, 'metrics'>, tx: Executor, org: OrgRow, createdBy: string | null): Promise<number> {
  for (const s of STARTER_PLAYBOOKS) {
    const r = await insertPlaybook(tx, {
      orgId: org.id,
      name: s.name,
      description: s.description,
      interpreter: s.interpreter,
      body: s.body,
      requiresElevation: s.requiresElevation,
      timeoutSec: s.timeoutSec,
      createdBy,
    });
    await writeAudit(ctx, tx, org, {
      actor: systemActor,
      action: 'playbook.created',
      data: { playbookId: r.id, bodyHash: r.bodySha256, interpreter: r.interpreter, requiresElevation: r.requiresElevation },
    });
  }
  return STARTER_PLAYBOOKS.length;
}
