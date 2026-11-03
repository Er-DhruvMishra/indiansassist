// `pnpm secrets:reseal` (scripts/reseal-org-secrets.mjs) covers the device MACs (docs/specs/phase-f-contracts.md
// sections 3.1e, 15.2): a PGlite directory seeded through the built packages with MACs under a previous fleet key,
// one under the current key and one under an unknown key; the script re-seals the old ones, prints one line per
// column, and exits 1 while a value fails to open. Needs `pnpm -r build`.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../reseal-org-secrets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (p) => pathToFileURL(resolve(root, p)).href;
const built = ['apps/api/dist/fleet/common.js', 'packages/db/dist/index.js'].every((p) => existsSync(resolve(root, p)));

const hex = () => randomBytes(32).toString('hex');
const F1 = hex();
const F2 = hex();
const MAC = '00:11:22:33:44:55';
const fleet = (id, key) => ({ config: { fleet: { dataKey: Buffer.from(key, 'hex'), dataKeyId: id, previousKeys: [] } } });

let dir;
let db;
let common;
let ids;

function envFor(extra = {}) {
  return {
    NODE_ENV: 'test',
    PGLITE_DIR: dir,
    DATABASE_URL: '',
    SESSION_COOKIE_SECRET: randomBytes(32).toString('base64url'),
    ORG_SECRETS_KEY: `o1:${hex()}`,
    ORG_SECRETS_FP_KEY: hex(),
    FLEET_DATA_KEY: `f2:${F2}`,
    FLEET_DATA_KEYS_PREVIOUS: `f1:${F1}`,
    ...extra,
  };
}

async function openDb() {
  const { createDb } = await import(dist('packages/db/dist/index.js'));
  return createDb({ pgliteDir: dir });
}

describe.skipIf(!built)('pnpm secrets:reseal: device MACs (section 3.1e)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ia-reseal-'));
    common = await import(dist('apps/api/dist/fleet/common.js'));
    const dbm = await import(dist('packages/db/dist/index.js'));
    db = await openDb();
    await dbm.migrate(db);
    const s = await dbm.createOrgWithAdmin(db);
    const seal = async (ctx) => {
      const d = await dbm.insertDevice(db, { orgId: s.org.id, name: `pc-${randomBytes(3).toString('hex')}`, region: s.org.dataRegion });
      await dbm.updateDevice(db, d.id, common.encryptMac(ctx, d.id, MAC));
      return d.id;
    };
    ids = {
      old: [await seal(fleet('f1', F1)), await seal(fleet('f1', F1))],
      current: await seal(fleet('f2', F2)),
      broken: await seal(fleet('f9', hex())),
    };
    await dbm.closeDb(db);
  }, 60_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('re-seals every MAC under a previous key, prints the column and exits 1 while one fails', async () => {
    const lines = [];
    expect(await main(envFor(), (l) => lines.push(l))).toBe(1);
    const mac = lines.find((l) => l.startsWith('device.mac_enc'));
    expect(mac).toMatch(/scanned 4, re-sealed 2, changed meanwhile 0, failed 1/);
    expect(lines).toContain('current fleet key: f2');
    // The org-secret columns are still reported first.
    expect(lines[0]).toMatch(/^org\.sso_secret_enc/);

    const dbm = await import(dist('packages/db/dist/index.js'));
    db = await openDb();
    try {
      const cur = fleet('f2', F2);
      for (const id of [...ids.old, ids.current]) {
        const row = await dbm.getDevice(db, id);
        expect(row.macEnc.startsWith('f2.')).toBe(true);
        expect(common.openMac(cur, id, row.macEnc)).toBe(MAC);
        expect(row.macHash).toBe(common.encryptMac(cur, id, MAC).macHash);
      }
      expect((await dbm.getDevice(db, ids.broken)).macEnc.startsWith('f9.')).toBe(true);
      // Remove the broken value: the next run has nothing to do and exits 0.
      await dbm.updateDevice(db, ids.broken, { macEnc: null, macHash: null });
    } finally {
      await dbm.closeDb(db);
    }
    const again = [];
    expect(await main(envFor(), (l) => again.push(l))).toBe(0);
    expect(again.find((l) => l.startsWith('device.mac_enc'))).toMatch(/scanned 3, re-sealed 0, changed meanwhile 0, failed 0/);
  }, 60_000);
});
