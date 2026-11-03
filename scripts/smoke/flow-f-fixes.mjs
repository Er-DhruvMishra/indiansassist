// Phase F smoke flow, stream fixes (docs/specs/phase-f-contracts.md sections 3.1, 15.2): compose-free checks of the
// fleet key rotation. The flow runs its own api (it needs a rotated FLEET_DATA_KEY, which the runner's api does not
// have): a PGlite directory under ./data/e2e-fixes is seeded through the built packages with an org and a device
// whose wake MAC is sealed under the old key `f1`; the api then boots with FLEET_DATA_KEY=f2 and
// FLEET_DATA_KEYS_PREVIOUS=f1 on the fixes smoke port (4136, SMOKE_FIXES_API_PORT); a wake request reads the MAC,
// which opens under the previous key and is re-sealed under the current one (compare-and-set); after the api stops,
// the row holds an `f2` value that opens to the same MAC. Needs `pnpm -r build`. Nothing here talks to the runner's
// api, and the seeded data uses synthetic addresses only.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiClient } from './http.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (p) => pathToFileURL(resolve(ROOT, p)).href;
const NEEDS = ['apps/api/dist/server.js', 'apps/api/dist/fleet/common.js', 'apps/api/dist/adapters/auth-provider.js', 'packages/db/dist/index.js'];
const MAC = '00:11:22:33:44:55';
const PASSWORD = 'correct horse battery staple fixes';

const fleetCtx = (keyId, hex, previous = []) => ({
  config: { fleet: { dataKey: Buffer.from(hex, 'hex'), dataKeyId: keyId, previousKeys: previous.map(([id, h]) => ({ keyId: id, key: Buffer.from(h, 'hex') })) } },
});

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Starts the api on `port` with `env`; resolves once /api/v1/health answers. */
async function startApi(port, env, timeoutMs = 240_000) {
  const child = spawn(process.execPath, [resolve(ROOT, 'apps/api/dist/server.js')], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the api exited (${child.exitCode}): ${stderr.trim().slice(-600)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (r.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`the api did not answer /api/v1/health on ${port} within ${timeoutMs} ms: ${stderr.trim().slice(-600)}`);
}

async function stopApi(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 10_000);
  });
}

export async function flowSteps(run, ctx) {
  const port = Number(process.env.SMOKE_FIXES_API_PORT || 4136);
  if ([4000, 4100, 4105].includes(port)) throw new Error(`port ${port} is reserved; use the fixes smoke port 4136`);
  const st = (ctx.state.fixes = {});
  const F1 = randomBytes(32).toString('hex');
  const F2 = randomBytes(32).toString('hex');

  await run.step('fixes: the built packages are present', () => {
    for (const p of NEEDS) check(existsSync(resolve(ROOT, p)), `${p} is missing; run pnpm -r build first`);
    st.dir = resolve(ROOT, 'data', 'e2e-fixes', `smoke-${process.pid}-${randomBytes(3).toString('hex')}`);
    mkdirSync(st.dir, { recursive: true });
    return st.dir;
  });

  try {
    await run.step('fixes: seed an org and a device whose MAC is sealed under the old fleet key f1', async () => {
      const db = await import(dist('packages/db/dist/index.js'));
      const common = await import(dist('apps/api/dist/fleet/common.js'));
      const { hashPassword } = await import(dist('apps/api/dist/adapters/auth-provider.js'));
      const conn = await db.createDb({ pgliteDir: join(st.dir, 'pglite') });
      try {
        await db.migrate(conn);
        st.email = `fixes-smoke-${randomBytes(4).toString('hex')}@e2e.example.com`;
        const seeded = await db.createOrgWithAdmin(conn, {
          adminEmail: st.email,
          passwordHash: await hashPassword(PASSWORD),
          planTier: 'p4_installed',
          seatTier: 'p4_installed',
        });
        const d = await db.insertDevice(conn, { orgId: seeded.org.id, name: 'fixes-smoke-pc', region: seeded.org.dataRegion });
        await db.updateDevice(conn, d.id, common.encryptMac(fleetCtx('f1', F1), d.id, MAC));
        st.deviceId = d.id;
        const row = await db.getDevice(conn, d.id);
        check(row.macEnc.startsWith('f1.'), 'the seeded MAC is under f1');
        st.oldEnc = row.macEnc;
      } finally {
        await db.closeDb(conn);
      }
      return `device ${st.deviceId}`;
    });

    await run.step('fixes: the api boots with FLEET_DATA_KEY=f2 and FLEET_DATA_KEYS_PREVIOUS=f1', async () => {
      const apiUrl = `http://127.0.0.1:${port}`;
      st.child = await startApi(port, {
        NODE_ENV: 'development',
        PORT: String(port),
        API_ORIGIN: `http://localhost:${port}`,
        WEB_ORIGIN: 'http://localhost:5295',
        METRICS_PORT: '0',
        PGLITE_DIR: join(st.dir, 'pglite'),
        STORAGE_FS_DIR: join(st.dir, 'storage'),
        DATABASE_URL: '',
        RATE_LIMIT_DISABLED: '1',
        LOG_LEVEL: 'warn',
        FLEET_DATA_KEY: `f2:${F2}`,
        FLEET_DATA_KEYS_PREVIOUS: `f1:${F1}`,
      });
      st.api = new ApiClient(apiUrl, { fetchImpl: ctx.fetchImpl });
      return apiUrl;
    });

    await run.step('fixes: a wake request reads the MAC through the previous key', async () => {
      await st.api.expect('POST', '/api/v1/auth/login', { email: st.email, password: PASSWORD }, [200]);
      const w = await st.api.expect('POST', `/api/v1/devices/${st.deviceId}/wake`, { method: 'wol', reason: 'fixes smoke' }, [202]);
      check(typeof w.wakeId === 'string', 'a wake id');
      // The lazy re-seal runs right after the read; give it a moment before stopping the api.
      await new Promise((r) => setTimeout(r, 1500));
      return `wake ${w.wakeId} (${w.via ? `via ${w.via}` : 'no waker online, as expected'})`;
    });
  } finally {
    await stopApi(st.child);
  }

  await run.step('fixes: the device MAC was re-sealed on read under f2 (mac_enc and mac_hash)', async () => {
    check(st.deviceId, 'no seeded device');
    const db = await import(dist('packages/db/dist/index.js'));
    const common = await import(dist('apps/api/dist/fleet/common.js'));
    const conn = await db.createDb({ pgliteDir: join(st.dir, 'pglite') });
    try {
      const row = await db.getDevice(conn, st.deviceId);
      check(row.macEnc !== st.oldEnc, 'mac_enc changed');
      check(row.macEnc.startsWith('f2.'), `mac_enc is under f2 (got key id ${row.macEnc.split('.')[0]})`);
      const cur = fleetCtx('f2', F2);
      check(common.openMac(cur, st.deviceId, row.macEnc) === MAC, 'the re-sealed MAC opens to the same value under f2');
      check(row.macHash === common.encryptMac(cur, st.deviceId, MAC).macHash, 'mac_hash is keyed by the current fleet key');
      return 'f1 -> f2';
    } finally {
      await db.closeDb(conn);
    }
  });

  // The smoke data directory goes whatever happened (it is always under ./data/e2e-fixes).
  if (st.dir && st.dir.startsWith(resolve(ROOT, 'data', 'e2e-fixes'))) rmSync(st.dir, { recursive: true, force: true });
}
