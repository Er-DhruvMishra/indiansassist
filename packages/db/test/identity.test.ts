import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countLoginFailuresSince,
  countOrgAdmins,
  countSeats,
  createAuthSession,
  createOrg,
  createOrgUser,
  createOrgWithAdmin,
  deleteAuthSession,
  deleteLoginAttemptsBefore,
  deleteSeatByUser,
  findAuthSession,
  findUserByEmail,
  findValidAuthSession,
  getOrg,
  getSeatByUser,
  listUsersByOrg,
  recordLoginAttempt,
  RegionImmutableError,
  revokeAuthSession,
  revokeUserAuthSessions,
  touchAuthSession,
  updateOrg,
  updateSeat,
  updateUser,
  type Db,
  type SeededOrg,
} from '../src/index.js';
import { closeDb, freshDb, rejectionText } from './helpers.js';

describe('orgs and region immutability', () => {
  let db: Db;
  let s: SeededOrg;
  beforeAll(async () => {
    db = await freshDb();
    s = await createOrgWithAdmin(db, { region: 'eu-fra' });
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('creates an org with region, default plan tier and a generated pepper', async () => {
    expect(s.org).toMatchObject({ dataRegion: 'eu-fra', planTier: 'p1_browser', branding: {} });
    expect(s.org.auditPepper).toMatch(/^[0-9a-f]{64}$/);
    expect((await getOrg(db, s.org.id))?.slug).toBe(s.org.slug);
    await expect(createOrg(db, { name: 'x', slug: 'xyz-1', dataRegion: 'mars' as never })).rejects.toThrow(
      /unknown region/,
    );
  });

  it('throws in the repository on any data_region update, before SQL runs', async () => {
    await expect(updateOrg(db, s.org.id, { dataRegion: 'in-mum' } as never)).rejects.toBeInstanceOf(
      RegionImmutableError,
    );
    await expect(updateOrg(db, s.org.id, { dataRegion: 'eu-fra' } as never)).rejects.toBeInstanceOf(
      RegionImmutableError,
    );
    await expect(updateOrg(db, s.org.id, { data_region: 'us-east' } as never)).rejects.toBeInstanceOf(
      RegionImmutableError,
    );
    await expect(updateOrg(db, s.org.id, { slug: 'new-slug' } as never)).rejects.toThrow(/not patchable/);
    expect((await getOrg(db, s.org.id))?.dataRegion).toBe('eu-fra');
  });

  it('blocks raw SQL region changes with the org_region_immutable trigger', async () => {
    expect(await rejectionText(db.execute(sql`update org set data_region = 'in-mum' where id = ${s.org.id}`))).toMatch(
      /data_region is immutable/,
    );
    // a same-value write and other columns pass the trigger
    await db.execute(sql`update org set data_region = 'eu-fra', name = 'Renamed' where id = ${s.org.id}`);
    expect((await getOrg(db, s.org.id))?.name).toBe('Renamed');
  });

  it('patches mutable columns and bumps updated_at', async () => {
    const before = (await getOrg(db, s.org.id))!;
    const after = await updateOrg(db, s.org.id, { branding: { displayName: 'Acme', accentColor: '#0f766e' } });
    expect(after.branding).toEqual({ displayName: 'Acme', accentColor: '#0f766e' });
    expect(after.dataRegion).toBe('eu-fra');
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });
});

describe('users, seats and auth sessions', () => {
  let db: Db;
  let s: SeededOrg;
  beforeAll(async () => {
    db = await freshDb();
    s = await createOrgWithAdmin(db, { adminEmail: 'Priya@Acme.test' });
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('finds users by email case-insensitively', async () => {
    expect((await findUserByEmail(db, 'priya@acme.TEST'))?.id).toBe(s.user.id);
    expect(await findUserByEmail(db, 'nobody@acme.test')).toBeNull();
  });

  it('lists an org with seats, created_at asc, in pages', async () => {
    const auditor = await createOrgUser(db, s.org, { role: 'auditor' });
    const techs = [];
    for (let i = 0; i < 3; i++)
      techs.push(await createOrgUser(db, s.org, { role: 'technician', seatTier: 'p2_extension' }));
    expect(auditor.seat).toBeNull();
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listUsersByOrg(db, s.org.id, { limit: 2, cursor });
      ids.push(...page.items.map((u) => u.id));
      if (page.items[0]?.id === s.user.id) expect(page.items[0].seat?.tier).toBe('p1_browser');
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual([s.user.id, auditor.user.id, ...techs.map((t) => t.user.id)]);
    const other = await createOrgWithAdmin(db);
    expect((await listUsersByOrg(db, other.org.id)).items.map((u) => u.id)).toEqual([other.user.id]);
  });

  it('updates users and seats and counts admins', async () => {
    const { user } = await createOrgUser(db, s.org, { role: 'technician' });
    expect(await countOrgAdmins(db, s.org.id)).toBe(1);
    await updateUser(db, user.id, { role: 'org_admin' });
    expect(await countOrgAdmins(db, s.org.id)).toBe(2);
    expect((await updateSeat(db, user.id, { tier: 'p3_portable', active: false })).tier).toBe('p3_portable');
    expect(await countSeats(db, s.org.id, { activeOnly: true })).toBeLessThan(await countSeats(db, s.org.id));
    expect(await deleteSeatByUser(db, user.id)).toBe(true);
    expect(await getSeatByUser(db, user.id)).toBeNull();
  });

  it('creates, finds, touches, revokes and deletes auth sessions', async () => {
    const a = await createAuthSession(db, {
      userId: s.user.id,
      tokenHash: '1'.repeat(64),
      region: s.org.dataRegion,
      ip: '127.0.0.1',
    });
    expect(a.expiresAt.getTime() - a.createdAt.getTime()).toBeGreaterThan(6 * 24 * 3600 * 1000);
    expect((await findAuthSession(db, '1'.repeat(64)))?.id).toBe(a.id);
    expect((await findValidAuthSession(db, '1'.repeat(64)))?.user.id).toBe(s.user.id);
    expect(await touchAuthSession(db, a.id)).toBe(false);
    expect(await touchAuthSession(db, a.id, 0)).toBe(true);

    const b = await createAuthSession(db, { userId: s.user.id, tokenHash: '2'.repeat(64), region: s.org.dataRegion });
    const c = await createAuthSession(db, { userId: s.user.id, tokenHash: '3'.repeat(64), region: s.org.dataRegion });
    expect(await revokeUserAuthSessions(db, s.user.id, c.id)).toBe(2);
    expect(await findValidAuthSession(db, '1'.repeat(64))).toBeNull();
    expect(await findValidAuthSession(db, '3'.repeat(64))).not.toBeNull();
    expect(await revokeAuthSession(db, b.id)).toBe(false);
    expect(await revokeAuthSession(db, c.id)).toBe(true);
    expect(await deleteAuthSession(db, c.id)).toBe(true);
    expect(await findAuthSession(db, '3'.repeat(64))).toBeNull();

    const expired = await createAuthSession(db, {
      userId: s.user.id,
      tokenHash: '4'.repeat(64),
      region: s.org.dataRegion,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(expired).toBeTruthy();
    expect(await findValidAuthSession(db, '4'.repeat(64))).toBeNull();
  });

  it('records login attempts for lockout and sweeps old ones', async () => {
    const h = 'e'.repeat(64);
    for (let i = 0; i < 3; i++) await recordLoginAttempt(db, { emailHash: h, success: false });
    await recordLoginAttempt(db, { emailHash: h, success: true });
    await recordLoginAttempt(db, { emailHash: h, success: false, at: new Date(Date.now() - 2 * 86400_000) });
    expect(await countLoginFailuresSince(db, h, new Date(Date.now() - 15 * 60_000))).toBe(3);
    expect(await deleteLoginAttemptsBefore(db, new Date(Date.now() - 86400_000))).toBe(1);
  });
});
