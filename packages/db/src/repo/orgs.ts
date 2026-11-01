/** org repository. `data_region` is set once at creation and is immutable (rule R1), enforced here and by trigger. */
import { randomBytes } from 'node:crypto';
import { isRegion, type PackageTier, type RecordingMode, type Region } from '@indiansassist/shared';
import { eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { NotFoundError, RegionImmutableError } from '../errors.js';
import { org, type OrgBranding, type OrgRow } from '../schema/index.js';

export type CreateOrgInput = {
  name: string;
  slug: string;
  dataRegion: Region;
  planTier?: PackageTier;
  branding?: OrgBranding;
  /** 64 hex chars; generated from 32 CSPRNG bytes when omitted (section 4.2). */
  auditPepper?: string;
};

/** Every mutable org column. `dataRegion` is deliberately absent; passing it anyway throws. */
export type OrgPatch = {
  name?: string;
  branding?: OrgBranding;
  planTier?: PackageTier;
  ssoConfig?: Record<string, unknown> | null;
  /** Phase C section 1.3 step 7 (agent policy). */
  requireSasConfirm?: boolean;
  /** Phase B 11.1 (stored as given; read through mergePolicy). */
  extensionPolicy?: Record<string, unknown>;
  recordingRetentionDays?: number | null;
  /** Phase A.2 section 3. */
  recordingMode?: RecordingMode;
  /** Phase D sections 6.1, 7.1, rule 8.2d. */
  wakerMeshEnabled?: boolean;
  fleetScopingEnabled?: boolean;
  unattendedPolicy?: Record<string, unknown>;
};

export function generateAuditPepper(): string {
  return randomBytes(32).toString('hex');
}

export async function createOrg(exec: Executor, input: CreateOrgInput): Promise<OrgRow> {
  if (!isRegion(input.dataRegion)) throw new Error(`unknown region: ${String(input.dataRegion)}`);
  const pepper = input.auditPepper ?? generateAuditPepper();
  if (!/^[0-9a-f]{64}$/.test(pepper)) throw new Error('auditPepper must be 64 lower-case hex chars');
  const [row] = await exec
    .insert(org)
    .values({
      name: input.name,
      slug: input.slug,
      dataRegion: input.dataRegion,
      planTier: input.planTier ?? 'p1_browser',
      branding: input.branding ?? {},
      auditPepper: pepper,
    })
    .returning();
  return row!;
}

export async function getOrg(exec: Executor, id: string): Promise<OrgRow | null> {
  const [row] = await exec.select().from(org).where(eq(org.id, id)).limit(1);
  return row ?? null;
}

export async function getOrgOrThrow(exec: Executor, id: string): Promise<OrgRow> {
  const row = await getOrg(exec, id);
  if (!row) throw new NotFoundError('org', id);
  return row;
}

export async function getOrgBySlug(exec: Executor, slug: string): Promise<OrgRow | null> {
  const [row] = await exec.select().from(org).where(eq(org.slug, slug)).limit(1);
  return row ?? null;
}

export async function isSlugTaken(exec: Executor, slug: string): Promise<boolean> {
  return (await getOrgBySlug(exec, slug)) !== null;
}

const PATCHABLE = new Set<string>([
  'name',
  'branding',
  'planTier',
  'ssoConfig',
  'extensionPolicy',
  'recordingRetentionDays',
  'recordingMode',
  'requireSasConfirm',
  'wakerMeshEnabled',
  'fleetScopingEnabled',
  'unattendedPolicy',
]);

/**
 * Updates mutable org columns. Throws RegionImmutableError when the patch carries `dataRegion` (or its column
 * name `data_region`), whatever its value, before touching the database; throws on any other unknown key.
 */
export async function updateOrg(exec: Executor, id: string, patch: OrgPatch): Promise<OrgRow> {
  const keys = Object.keys(patch);
  if (keys.includes('dataRegion') || keys.includes('data_region')) throw new RegionImmutableError();
  for (const k of keys) if (!PATCHABLE.has(k)) throw new Error(`org column ${k} is not patchable`);
  if (keys.length === 0) return getOrgOrThrow(exec, id);
  const [row] = await exec.update(org).set(patch).where(eq(org.id, id)).returning();
  if (!row) throw new NotFoundError('org', id);
  return row;
}

export async function updateOrgBranding(exec: Executor, id: string, branding: OrgBranding): Promise<OrgRow> {
  return updateOrg(exec, id, { branding });
}
