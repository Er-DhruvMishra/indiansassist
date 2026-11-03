/**
 * Phase F section 3.1d/e (docs/specs/phase-f-contracts.md section 15.2): the fleet data key rotates through
 * `FLEET_DATA_KEYS_PREVIOUS`. A MAC sealed under a previous key opens, and `decryptMac` re-seals it under the current
 * key with a compare-and-set on the old `mac_enc` (rewriting `mac_hash`, which is keyed by the fleet key); a lost
 * race is not an error; the eager `resealAllDeviceMacs` (`pnpm secrets:reseal`) re-seals the rest and counts values
 * that do not open.
 */
import { randomBytes } from 'node:crypto';
import { closeDb, createOrgWithAdmin, device as deviceTable, getDevice, insertDevice, type Db, type SeededOrg } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import {
  decryptMac,
  encryptMac,
  macKeys,
  macNeedsReseal,
  macPatch,
  openMac,
  resealAllDeviceMacs,
  resealDeviceMac,
  settleMacReseals,
} from '../src/fleet/common.js';
import { makeDb } from './helpers.js';

const hex = () => randomBytes(32).toString('hex');
const F1 = hex();
const F2 = hex();
const F3 = hex();
const MAC = '00:11:22:33:44:55';

const warnings: unknown[] = [];
function ctxOf(env: Record<string, string>, db: Db): AppContext {
  const config = loadConfig({ NODE_ENV: 'test', ...env }, { persistSecrets: false });
  const log = { warn: (o: unknown) => warnings.push(o), info: () => {}, error: () => {}, debug: () => {} };
  return { config, db, log } as unknown as AppContext;
}

let db: Db;
let seeded: SeededOrg;
let oldCtx: AppContext;
let newCtx: AppContext;

async function deviceWithMac(ctx: AppContext, mac: string | null = MAC) {
  const d = await insertDevice(db, { orgId: seeded.org.id, name: `pc-${randomBytes(3).toString('hex')}`, region: seeded.org.dataRegion });
  if (mac === null) return d;
  const sealed = encryptMac(ctx, d.id, mac);
  await db.update(deviceTable).set(sealed).where(eq(deviceTable.id, d.id));
  return (await getDevice(db, d.id))!;
}

beforeAll(async () => {
  db = await makeDb();
  seeded = await createOrgWithAdmin(db);
  oldCtx = ctxOf({ FLEET_DATA_KEY: `f1:${F1}` }, db);
  newCtx = ctxOf({ FLEET_DATA_KEY: `f2:${F2}`, FLEET_DATA_KEYS_PREVIOUS: `f1:${F1}` }, db);
});
afterAll(async () => {
  await closeDb(db);
});

describe('macKeys (section 3.1d)', () => {
  it('returns the current key and every previous key', () => {
    const keys = macKeys(ctxOf({ FLEET_DATA_KEY: `f3:${F3}`, FLEET_DATA_KEYS_PREVIOUS: `f1:${F1},f2:${F2}` }, db));
    expect([...keys.keys()].sort()).toEqual(['f1', 'f2', 'f3']);
    expect(Buffer.from(keys.get('f3')!).toString('hex')).toBe(F3);
    expect([...macKeys(oldCtx).keys()]).toEqual(['f1']);
  });

  it('opens a MAC under a previous key, and refuses one under an unknown key', async () => {
    const d = await deviceWithMac(oldCtx);
    expect(d.macEnc!.startsWith('f1.')).toBe(true);
    expect(openMac(newCtx, d.id, d.macEnc!)).toBe(MAC);
    expect(openMac(ctxOf({ FLEET_DATA_KEY: `f2:${F2}` }, db), d.id, d.macEnc!)).toBeNull();
    // Bound to its row: the same value does not open for another device id.
    expect(openMac(newCtx, seeded.org.id, d.macEnc!)).toBeNull();
    expect(macNeedsReseal(newCtx, d.macEnc!)).toBe(true);
    expect(macNeedsReseal(oldCtx, d.macEnc!)).toBe(false);
  });
});

describe('decryptMac lazy re-seal (section 3.1d)', () => {
  it('re-seals a MAC opened under a previous key, rewriting mac_enc and mac_hash with compare-and-set', async () => {
    const d = await deviceWithMac(oldCtx);
    expect(decryptMac(newCtx, d.id, d.macEnc!)).toBe(MAC);
    await settleMacReseals();
    const after = (await getDevice(db, d.id))!;
    expect(after.macEnc!.startsWith('f2.')).toBe(true);
    expect(after.macEnc).not.toBe(d.macEnc);
    expect(after.macHash).toBe(encryptMac(newCtx, d.id, MAC).macHash);
    expect(after.macHash).not.toBe(d.macHash);
    expect(decryptMac(newCtx, d.id, after.macEnc!)).toBe(MAC);
    // A value already under the current key is not written again.
    await settleMacReseals();
    expect((await getDevice(db, d.id))!.macEnc).toBe(after.macEnc);
  });

  it('leaves a value another request replaced alone (a lost race is not an error)', async () => {
    const d = await deviceWithMac(oldCtx);
    const replaced = encryptMac(newCtx, d.id, '66:77:88:99:aa:bb');
    await db.update(deviceTable).set(replaced).where(eq(deviceTable.id, d.id));
    expect(await resealDeviceMac(newCtx, db, d.id, d.macEnc!, MAC)).toBe(false);
    warnings.length = 0;
    expect(decryptMac(newCtx, d.id, d.macEnc!)).toBe(MAC);
    await settleMacReseals();
    expect(warnings).toEqual([]);
    expect((await getDevice(db, d.id))!.macEnc).toBe(replaced.macEnc);
  });

  it('returns null and writes nothing for a value that does not open', async () => {
    const d = await deviceWithMac(ctxOf({ FLEET_DATA_KEY: `f9:${hex()}` }, db));
    expect(decryptMac(newCtx, d.id, d.macEnc!)).toBeNull();
    await settleMacReseals();
    expect((await getDevice(db, d.id))!.macEnc).toBe(d.macEnc);
  });

  it('macPatch treats a MAC under a previous key as unchanged', async () => {
    const d = await deviceWithMac(oldCtx);
    expect(macPatch(newCtx, d, MAC)).toBeNull();
    await settleMacReseals();
    expect((await getDevice(db, d.id))!.macEnc!.startsWith('f2.')).toBe(true);
  });
});

describe('resealAllDeviceMacs (section 3.1e, pnpm secrets:reseal)', () => {
  it('re-seals every MAC not under the current key and counts values that do not open', async () => {
    const db2 = await makeDb();
    try {
      const s = await createOrgWithAdmin(db2);
      const o = ctxOf({ FLEET_DATA_KEY: `f1:${F1}` }, db2);
      const n = ctxOf({ FLEET_DATA_KEY: `f2:${F2}`, FLEET_DATA_KEYS_PREVIOUS: `f1:${F1}` }, db2);
      const seal = async (ctx: AppContext | null) => {
        const d = await insertDevice(db2, { orgId: s.org.id, name: `pc-${randomBytes(3).toString('hex')}`, region: s.org.dataRegion });
        if (ctx) await db2.update(deviceTable).set(encryptMac(ctx, d.id, MAC)).where(eq(deviceTable.id, d.id));
        return d.id;
      };
      const old = [await seal(o), await seal(o)];
      const current = await seal(n);
      await seal(null);
      const broken = await seal(ctxOf({ FLEET_DATA_KEY: `f9:${hex()}` }, db2));

      const report = await resealAllDeviceMacs(n, db2);
      expect(report).toEqual({ column: 'device.mac_enc', scanned: 4, resealed: 2, lostRace: 0, failed: 1 });
      for (const id of [...old, current]) {
        const row = (await getDevice(db2, id))!;
        expect(row.macEnc!.startsWith('f2.')).toBe(true);
        expect(openMac(n, id, row.macEnc!)).toBe(MAC);
        expect(row.macHash).toBe(encryptMac(n, id, MAC).macHash);
      }
      expect((await getDevice(db2, broken))!.macEnc!.startsWith('f9.')).toBe(true);
      // A second run has nothing left to do; the old key can now be removed.
      expect(await resealAllDeviceMacs(n, db2)).toMatchObject({ resealed: 0, failed: 1 });
    } finally {
      await closeDb(db2);
    }
  });
});
