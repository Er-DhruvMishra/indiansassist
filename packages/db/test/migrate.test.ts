import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTOR_TYPES,
  CHECKPOINT_KINDS,
  CONSENT_STATES,
  ELEVATION_LEVELS,
  PLAYBOOK_INTERPRETERS,
  STORED_CONSENT_LEVELS,
  MIRROR_SCOPES,
  RECORDING_MODES,
  RECORDING_SOURCES,
  DEVICE_STATUSES,
  FILE_DIRECTIONS,
  INTEGRATION_TYPES,
  PACKAGE_TIERS,
  PARTICIPANT_ROLES,
  RECORDING_STATUSES,
  REGIONS,
  SESSION_END_REASONS,
  SESSION_PATHS,
  SESSION_STATES,
  TOKEN_STATUSES,
  TOKEN_TYPES,
  USER_ROLES,
  USER_STATUSES,
} from '@indiansassist/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  createOrgWithAdmin,
  driverOf,
  getOrg,
  migrate,
  MIGRATIONS_FOLDER,
  queryRows,
  pgliteClientOf,
  resolveDbTarget,
  type Db,
} from '../src/index.js';
import { freshDb } from './helpers.js';

const TABLES = [
  'audit_checkpoint',
  'audit_entry',
  'auth_session',
  'device',
  'elevation_handover',
  'integration',
  'login_attempt',
  'org',
  'playbook',
  'playbook_run',
  'recording',
  'session',
  'session_file',
  'session_host',
  'session_participant',
  'technician_seat',
  'token',
  'user',
];

const ENUMS: Record<string, readonly string[]> = {
  region: REGIONS,
  package_tier: PACKAGE_TIERS,
  user_role: USER_ROLES,
  user_status: USER_STATUSES,
  token_type: TOKEN_TYPES,
  token_status: TOKEN_STATUSES,
  session_state: SESSION_STATES,
  consent_state: CONSENT_STATES,
  session_path: SESSION_PATHS,
  session_end_reason: SESSION_END_REASONS,
  participant_role: PARTICIPANT_ROLES,
  actor_type: ACTOR_TYPES,
  recording_status: RECORDING_STATUSES,
  file_direction: FILE_DIRECTIONS,
  checkpoint_kind: CHECKPOINT_KINDS,
  integration_type: INTEGRATION_TYPES,
  device_status: DEVICE_STATUSES,
  consent_level: STORED_CONSENT_LEVELS,
  elevation_level: ELEVATION_LEVELS,
  playbook_interpreter: PLAYBOOK_INTERPRETERS,
  mirror_scope: MIRROR_SCOPES,
  recording_mode: RECORDING_MODES,
  recording_source: RECORDING_SOURCES,
};

describe('migrations', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('apply from scratch and create every table', async () => {
    const rows = await queryRows<{ table_name: string }>(
      db,
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(TABLES);
  });

  it('create pgEnums whose values equal the shared enums', async () => {
    const rows = await queryRows<{ name: string; label: string }>(
      db,
      sql`
      select t.typname as name, e.enumlabel as label
      from pg_type t join pg_enum e on e.enumtypid = t.oid
      order by t.typname, e.enumsortorder`,
    );
    const got: Record<string, string[]> = {};
    for (const r of rows) (got[r.name] ??= []).push(r.label);
    expect(got).toEqual(Object.fromEntries(Object.entries(ENUMS).map(([k, v]) => [k, [...v]])));
  });

  it('install the append-only and region triggers', async () => {
    const rows = await queryRows<{ tgname: string }>(
      db,
      sql`select tgname from pg_trigger where not tgisinternal order by tgname`,
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      'audit_checkpoint_immutable',
      'audit_checkpoint_no_truncate',
      'audit_entry_immutable',
      'audit_entry_no_truncate',
      'org_region_immutable',
    ]);
  });

  it('are idempotent (a second migrate is a no-op)', async () => {
    await migrate(db);
    const rows = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(rows[0]!.n).toBe(7);
  });

  it('commit a journal with the init, append_only, open-session index, Phase B, A.2 recorder, Phase C and playbook-pins migrations', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    expect(journal.entries.map((e) => e.tag)).toEqual([
      '0000_init',
      '0001_append_only',
      '0002_session_token_open_unique',
      '0003_phase_b',
      '0004_recorder',
      '0005_phase_c',
      '0006_playbook_pins',
    ]);
  });

  it('enforce the slug format check and case-insensitive unique email', async () => {
    const { org } = await createOrgWithAdmin(db, { adminEmail: 'Dup@Example.test' });
    expect(org.slug).toMatch(/^[a-z0-9-]{3,40}$/);
    await expect(
      db.execute(
        sql`insert into org (name, slug, data_region, audit_pepper) values ('x', 'Bad Slug', 'in-mum', ${'a'.repeat(64)})`,
      ),
    ).rejects.toThrow();
    await expect(createOrgWithAdmin(db, { adminEmail: 'dup@example.TEST' })).rejects.toThrow();
  });
});

describe('createDb', () => {
  it('resolves URLs to drivers', () => {
    expect(resolveDbTarget({ databaseUrl: '' })).toEqual({ kind: 'pglite', dataDir: null });
    expect(resolveDbTarget({ databaseUrl: '', pgliteDir: './data/pglite' })).toEqual({
      kind: 'pglite',
      dataDir: './data/pglite',
    });
    expect(resolveDbTarget({ databaseUrl: 'memory://' })).toEqual({ kind: 'pglite', dataDir: null });
    expect(resolveDbTarget({ url: 'pglite://' })).toEqual({ kind: 'pglite', dataDir: null });
    expect(resolveDbTarget({ url: 'pglite://memory' })).toEqual({ kind: 'pglite', dataDir: null });
    expect(resolveDbTarget({ url: 'pglite://./tmp/db' })).toEqual({ kind: 'pglite', dataDir: './tmp/db' });
    expect(resolveDbTarget({ url: 'postgres://u:p@h:5432/d' })).toEqual({
      kind: 'pg',
      connectionString: 'postgres://u:p@h:5432/d',
    });
    expect(resolveDbTarget({})).toEqual({ kind: 'pglite', dataDir: null });
    expect(() => resolveDbTarget({ url: 'mysql://x' })).toThrow(/unsupported/);
  });

  it('creates a pg Pool backed db without connecting', async () => {
    const db = await createDb({ databaseUrl: 'postgres://nobody:none@127.0.0.1:1/none' });
    expect(driverOf(db)).toBe('pg');
    expect(pgliteClientOf(db)).toBeNull();
    await closeDb(db);
  });

  it('persists PGlite data to a directory across reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-db-test-'));
    try {
      const db1 = await createDb({ url: `pglite://${dir}` });
      expect(driverOf(db1)).toBe('pglite');
      await migrate(db1);
      const { org } = await createOrgWithAdmin(db1);
      await closeDb(db1);

      const db2 = await createDb({ databaseUrl: '', pgliteDir: dir });
      await migrate(db2);
      expect((await getOrg(db2, org.id))?.slug).toBe(org.slug);
      await closeDb(db2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
