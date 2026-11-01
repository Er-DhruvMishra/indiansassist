#!/usr/bin/env node
// IndiansAssist Phase D fleet load test (docs/specs/phase-d-contracts.md section 13.5, `smoke:p4:load`).
//
// N simulated installed services (default 2,000, the contract's design target for one api node) enroll, hello on
// /signal/device, heartbeat for M minutes (default 10), survive a forced node restart (SIGKILL, not a graceful stop)
// and must all be back online within the reconnect budget (default 120 s) with no device left in a tamper state and
// no `tamper.suspected` in the chain: the 900 s grace of rule 10.2 is far longer than one backoff cycle, so a node
// loss must never mark a device suspected. The reconnect uses the Phase C section 3.1 backoff (1, 2, 4, 8 ... max
// 30 s) with the +-30 % jitter and the 0..30 s initial delay section 13.5 adds, so the storm is spread the way the
// service spreads it. The new section 13.5 metrics are read off the node's own /metrics endpoint as evidence.
//
// This is a NIGHTLY check, not a per-commit gate: it is not run by `pnpm test`, `typecheck` or `lint`, and at full
// size it takes about 15 minutes and holds 2,000 sockets open.
//
//   pnpm --filter @indiansassist/shared build      # the script verifies with the built shared package
//   pnpm smoke:p4:load                             # 2,000 devices, 10 minutes, on port 4200
//   LOAD_DEVICES=25 LOAD_MINUTES=0.5 LOAD_HEARTBEAT_SEC=5 LOAD_INITIAL_DELAY_SEC=3 pnpm smoke:p4:load   # smoke-sized
//
// Unlike the other smokes this script OWNS its api node: it starts one on LOAD_PORT with its own PGlite directory,
// SIGKILLs it and starts it again, so nothing else may be running on that port and no existing node is touched.
//
// Env (all optional):
//   LOAD_DEVICES=2000          devices to enroll and hold
//   LOAD_MINUTES=10            heartbeat phase, fractional minutes allowed
//   LOAD_HEARTBEAT_SEC=30      heartbeat period per device (+- 5 s jitter, section 13.5)
//   LOAD_RECONNECT_SEC=120     budget for every device to be back online after the restart
//   LOAD_INITIAL_DELAY_SEC=30  the random delay before the first reconnect attempt
//   LOAD_CONCURRENCY=50        parallel enrollments / first connections
//   LOAD_PORT=4200             the api port this script starts (4000 and 4100 are left alone)
//   LOAD_METRICS_PORT          defaults to LOAD_PORT + 1
//   LOAD_DATA_DIR              defaults to <repo>/data/load-p4 (wiped at the start, kept across the restart)
//   LOAD_RATE_LIMITS=1         start the node with the per-IP limits ON. Off by default: every simulated device
//                              shares 127.0.0.1, so the per-IP enroll (60/min) and upgrade (600/min) limits would
//                              throttle the harness, not the fleet. With them on, the DEVICE_HELLO_RATE 4429 path is
//                              exercised and the client backs off, but the 2-minute budget is not reachable from one IP.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { ApiClient } from './smoke/http.mjs';
import { Runner, check, eq } from './smoke/runner.mjs';
import { loadShared } from './smoke/shared.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_UA = 'IndiansAssist-Service/0.4.0 (Windows 10.0.26100; x64)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** +- `pct` jitter around `ms` (section 13.5 asks for +-30 % on the reconnect backoff). */
const jitter = (ms, pct) => Math.round(ms * (1 + (Math.random() * 2 - 1) * pct));
const num = (v, dflt) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
const pct = (xs, p) => (xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]);

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let n = it.next(); !n.done; n = it.next()) await fn(n.value);
  });
  await Promise.all(workers);
}

// ---------- one simulated installed service ----------

/**
 * A device holds its own Ed25519 identity key and X25519 sealing key (both "generated on the device", section 3.3)
 * and nothing else: no media, no worker. Only the frames the load path needs are implemented.
 */
class LoadDevice {
  constructor(shared, index, lanSegment) {
    this.s = shared;
    this.name = `LOAD-PC-${String(index).padStart(5, '0')}`;
    this.seed = new Uint8Array(randomBytes(32));
    this.kexSecret = new Uint8Array(randomBytes(32));
    this.publicKey = shared.devicePublicKeyOf(this.seed);
    this.kexPublicKey = shared.kexPublicKeyOf(this.kexSecret);
    this.keyId = shared.kidOf(shared.base64urlDecode(this.publicKey));
    this.hw = randomBytes(32).toString('hex');
    this.lanSegment = lanSegment;
    this.deviceId = null;
    this.ws = null;
    this.closeCode = null;
    this.heartbeats = 0;
    this.helloMs = null;
    this.timer = null;
  }

  capabilities() {
    return {
      monitors: 1,
      elevation: 'admin',
      features: ['screen', 'input', 'chat', 'service_input'],
      encoders: ['vp8'],
      hwEncoder: false,
      interpreters: ['powershell'],
      serviceVersion: '0.4.0',
    };
  }

  enrollBody(enrollConfig, tokenId) {
    const sign = (input) => this.s.signDeviceInput(input, this.seed);
    return {
      enrollConfig,
      devicePublicKey: this.publicKey,
      deviceKexPublicKey: this.kexPublicKey,
      deviceKeyProof: sign(this.s.deviceSigInput.enroll({ tokenId, devicePublicKey: this.publicKey, deviceKexPublicKey: this.kexPublicKey })),
      machine: {
        name: this.name,
        platform: 'windows',
        osVersion: '10.0.26100',
        arch: 'x64',
        serviceVersion: '0.4.0',
        hwFingerprint: this.hw,
        wakeMac: null,
        amt: null,
        capabilities: this.capabilities(),
        interactive: { state: 'locked', idleSec: null, at: Date.now() },
      },
    };
  }

  /** Opens an Origin-less /signal/device socket and answers the challenge; resolves on `device.hello.ok`. */
  connect(url, timeoutMs = 30_000) {
    return new Promise((resolve_, reject) => {
      const ws = new WebSocket(url, { headers: { 'User-Agent': SERVICE_UA }, handshakeTimeout: timeoutMs });
      this.ws = ws;
      this.closeCode = null;
      let done = false;
      const fail = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = setTimeout(() => fail(new Error(`${this.name}: no device.hello.ok within ${timeoutMs} ms`)), timeoutMs);
      ws.on('unexpected-response', (_req, res) => fail(new Error(`${this.name}: upgrade rejected with HTTP ${res.statusCode}`)));
      ws.on('error', (err) => fail(err));
      ws.on('close', (code) => {
        this.closeCode = code;
        fail(new Error(`${this.name}: socket closed (${code}) before hello.ok`));
      });
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        if (msg.t === 'ping') return this.#send({ t: 'pong' });
        if (msg.t === 'device.challenge') return this.#hello(msg.serverChallenge);
        if (msg.t === 'device.hello.ok') {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.helloMs = Date.now();
          // From here a close is an event, not a broken promise.
          ws.removeAllListeners('error');
          ws.on('error', () => undefined);
          resolve_(msg);
          return;
        }
        if (msg.t === 'error') fail(new Error(`${this.name}: ${msg.code} ${msg.message ?? ''}`));
      });
    });
  }

  #hello(serverChallenge) {
    const nonce = this.s.base64urlEncode(new Uint8Array(randomBytes(16)));
    this.#send({
      t: 'device.hello',
      deviceId: this.deviceId,
      keyId: this.keyId,
      nonce,
      sig: this.s.signDeviceInput(this.s.deviceSigInput.hello({ deviceId: this.deviceId, serverChallenge, nonce }), this.seed),
      client: {
        serviceVersion: '0.4.0',
        agentVersion: '0.4.0',
        osVersion: '10.0.26100',
        arch: 'x64',
        capabilities: this.capabilities(),
        lanSegment: this.lanSegment,
        wakeMac: null,
        amt: null,
        interactive: { state: 'locked', idleSec: null, at: Date.now() },
      },
    });
  }

  #send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Section 13.5: one heartbeat every `periodMs` +- 5 s until `stopAt`. */
  startHeartbeat(periodMs, stopAt) {
    const tick = () => {
      if (Date.now() >= stopAt) return;
      this.#send({ t: 'device.heartbeat' });
      this.heartbeats += 1;
      this.timer = setTimeout(tick, Math.max(1000, periodMs + (Math.random() * 10_000 - 5000)));
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, Math.max(1000, periodMs + (Math.random() * 10_000 - 5000)));
    this.timer.unref?.();
  }

  stopHeartbeat() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  close() {
    this.stopHeartbeat();
    try {
      this.ws?.terminate();
    } catch {
      /* already gone */
    }
  }
}

// ---------- the api node this script owns ----------

class ApiNode {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
  }

  async start() {
    const env = {
      ...process.env,
      PORT: String(this.cfg.port),
      HOST: '127.0.0.1',
      API_ORIGIN: `http://localhost:${this.cfg.port}`,
      WEB_ORIGIN: `http://localhost:${this.cfg.port}`,
      METRICS_PORT: String(this.cfg.metricsPort),
      DATABASE_URL: '',
      PGLITE_DIR: resolve(this.cfg.dataDir, 'pglite'),
      STORAGE_FS_DIR: resolve(this.cfg.dataDir, 'storage'),
      SIGNUP_PLAN_TIER: 'p4_installed',
      DEVICE_HELLO_RATE: String(this.cfg.helloRate),
      RATE_LIMIT_DISABLED: this.cfg.rateLimits ? '' : '1',
      LOG_LEVEL: 'warn',
      NODE_ENV: 'development',
    };
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: resolve(REPO_ROOT, 'apps/api'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', () => undefined);
    const stderr = [];
    child.stderr.on('data', (b) => {
      stderr.push(b.toString('utf8'));
      if (stderr.length > 40) stderr.shift();
    });
    const exited = new Promise((_, reject) =>
      child.once('exit', (code) => reject(new Error(`the api node exited with ${code}: ${stderr.join('').slice(-2000)}`))),
    );
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.cfg.port}/api/v1/health`);
        if (res.ok) return child.pid;
      } catch {
        /* not listening yet */
      }
      await Promise.race([sleep(500), exited]);
    }
    throw new Error(`the api node did not answer /api/v1/health on :${this.cfg.port}`);
  }

  /** A forced stop, as section 13.5 asks: no graceful shutdown, no presence cleanup. */
  async kill() {
    const child = this.child;
    if (!child) return;
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await Promise.race([gone, sleep(20_000)]);
    this.child = null;
  }

  async metrics() {
    const res = await fetch(`http://127.0.0.1:${this.cfg.metricsPort}/metrics`);
    if (!res.ok) throw new Error(`/metrics answered ${res.status}`);
    return res.text();
  }
}

/** One sample of `name` carrying exactly `labels` from a Prometheus text body, or null. */
export function metricSample(body, name, labels = {}) {
  const want = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .sort()
    .join(',');
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = (m[2] ?? '')
      .split(',')
      .filter((x) => x !== '')
      .sort()
      .join(',');
    if (got === want) return Number(m[3]);
  }
  return null;
}

// ---------- the flow ----------

export async function runLoadP4(opts = {}) {
  const cfg = {
    devices: opts.devices ?? 2000,
    minutes: opts.minutes ?? 10,
    heartbeatSec: opts.heartbeatSec ?? 30,
    reconnectSec: opts.reconnectSec ?? 120,
    initialDelaySec: opts.initialDelaySec ?? 30,
    concurrency: opts.concurrency ?? 50,
    port: opts.port ?? 4200,
    metricsPort: opts.metricsPort ?? (opts.port ?? 4200) + 1,
    dataDir: opts.dataDir ?? resolve(REPO_ROOT, 'data', 'load-p4'),
    helloRate: opts.helloRate ?? 500,
    rateLimits: opts.rateLimits ?? false,
  };
  const run = new Runner({ log: opts.log });
  const apiUrl = `http://localhost:${cfg.port}`;
  const node = new ApiNode(cfg);
  const api = new ApiClient(apiUrl, { origin: apiUrl });
  const devices = [];
  const state = {};
  let shared = null;

  try {
    await run.step('load: the built @indiansassist/shared package carries the Phase D exports', async () => {
      shared = await loadShared();
      if (typeof shared.deviceSigInput?.hello !== 'function' || typeof shared.devicePublicKeyOf !== 'function')
        throw new Error('packages/shared/dist predates Phase D; rebuild it');
      return `${cfg.devices} devices, ${cfg.minutes} min heartbeat, ${cfg.reconnectSec} s reconnect budget`;
    });

    await run.step(`load: start a dedicated api node on :${cfg.port} with an empty PGlite directory`, async () => {
      rmSync(cfg.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      mkdirSync(cfg.dataDir, { recursive: true });
      const pid = await node.start();
      const h = await api.expect('GET', '/api/v1/health');
      state.region = h.servedRegions.length > 0 ? h.servedRegions[0] : h.region;
      return `pid ${pid}, region ${state.region}, per-IP limits ${cfg.rateLimits ? 'on' : 'off'}, DEVICE_HELLO_RATE ${cfg.helloRate}`;
    });

    await run.step('load: a p4_installed org, an allow-policy group and one enrollment token with capacity for the fleet', async () => {
      const sx = randomBytes(4).toString('hex');
      const r = await api.expect(
        'POST',
        '/api/v1/auth/signup',
        { orgName: `Load P4 ${sx}`, region: state.region, name: `Load P4 ${sx}`, email: `load-p4-${sx}@example.com`, password: `Load-${randomBytes(12).toString('base64url')}` },
        [201],
      );
      check(r.org.planTier === 'p4_installed', `org.planTier ${r.org.planTier}`);
      state.org = r.org;
      await api.expect('PATCH', `/api/v1/users/${r.user.id}/role`, { role: 'org_admin', tier: 'p4_installed' });
      const g = await api.expect('POST', '/api/v1/orgs/current/device-groups', { name: 'Load fleet', defaultPolicy: { mode: 'allow', recordingRequired: false } }, [201]);
      const t = await api.expect('POST', '/api/v1/tokens', { tier: 'p4_installed', typ: 'enrollment', maxDevices: cfg.devices, label: 'smoke-p4-load' }, [201]);
      eq(t.token.maxDevices, cfg.devices, 'token.maxDevices');
      const cfgReply = await api.expect('GET', `/api/v1/devices/enroll-config?tokenId=${t.token.id}&groupId=${g.id}`);
      state.enrollConfig = cfgReply.iaconfig;
      state.tokenId = t.token.id;
      const verified = await shared.verifyEnrollConfig(state.enrollConfig, (await api.expect('GET', '/.well-known/indiansassist.json')).keys.map((k) => ({ kid: k.kid, pub: k.pub })));
      check(verified, 'the enroll.iaconfig verifies against the region keys');
      state.deviceSignalUrl = verified.signalUrl;
      return `org ${r.org.slug}, token ${t.token.id}, signal ${verified.signalUrl}`;
    });

    await run.step(`load: enroll ${cfg.devices} devices, each minting its own identity and sealing key`, async () => {
      const segment = { subnetHash: shared.sha256Hex(`ia-seg-v1/${state.org.id}/10.20.30.0/24/load`), gatewayMacHash: shared.sha256Hex(`ia-gw-v1/${state.org.id}/load`) };
      for (let i = 0; i < cfg.devices; i += 1) devices.push(new LoadDevice(shared, i, segment));
      const t0 = Date.now();
      let refused = 0;
      await pool(devices, cfg.concurrency, async (d) => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const r = await api.request('POST', '/api/v1/devices/enroll', d.enrollBody(state.enrollConfig, state.tokenId));
          if (r.status === 201) {
            d.deviceId = r.json.deviceId;
            return;
          }
          if (r.status !== 429 && r.json?.error?.code !== 'rate_limited') throw new Error(`${d.name}: enroll -> ${r.status} ${r.json?.error?.code ?? ''}`);
          refused += 1;
          await sleep(jitter(Math.min(30_000, 1000 * 2 ** attempt), 0.3));
        }
        throw new Error(`${d.name}: still rate limited after 8 enrollment attempts`);
      });
      const ms = Date.now() - t0;
      check(
        devices.every((d) => d.deviceId),
        'every device has a deviceId',
      );
      const tok = await api.expect('GET', `/api/v1/tokens/${state.tokenId}`);
      eq(tok.devicesEnrolled, cfg.devices, 'token.devicesEnrolled');
      return `${cfg.devices} enrolled in ${(ms / 1000).toFixed(1)} s (${(cfg.devices / (ms / 1000)).toFixed(0)}/s), ${refused} rate-limited retries`;
    });

    await run.step(`load: all ${cfg.devices} hello on /signal/device and are counted connected`, async () => {
      const t0 = Date.now();
      let backoffs = 0;
      await pool(devices, cfg.concurrency, async (d) => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            await d.connect(state.deviceSignalUrl);
            return;
          } catch (err) {
            // 4429 / HTTP 429 is the node asking for backoff (section 13.5); anything else is a real failure.
            const retryable = d.closeCode === 4429 || /HTTP 429/.test(String(err.message));
            if (!retryable) throw err;
            backoffs += 1;
            await sleep(jitter(Math.min(30_000, 1000 * 2 ** attempt), 0.3));
          }
        }
        throw new Error(`${d.name}: never got past the hello rate limit`);
      });
      const ms = Date.now() - t0;
      const body = await node.metrics();
      eq(metricSample(body, 'ia_devices_connected'), cfg.devices, 'ia_devices_connected');
      eq(metricSample(body, 'ia_device_hello_total', { result: 'ok' }), cfg.devices, 'ia_device_hello_total{result="ok"}');
      eq(metricSample(body, 'ia_device_hello_total', { result: 'unauthenticated' }), 0, 'no hello was refused');
      return `${cfg.devices} helloed in ${(ms / 1000).toFixed(1)} s (${(cfg.devices / (ms / 1000)).toFixed(0)}/s), ${backoffs} backoffs`;
    });

    await run.step(`load: heartbeat every ${cfg.heartbeatSec} s +- 5 s for ${cfg.minutes} minutes with no socket lost`, async () => {
      const durationMs = Math.round(cfg.minutes * 60_000);
      const stopAt = Date.now() + durationMs;
      for (const d of devices) d.startHeartbeat(cfg.heartbeatSec * 1000, stopAt);
      await sleep(durationMs);
      for (const d of devices) d.stopHeartbeat();
      await sleep(1000); // let the last heartbeats be handled before reading the registry
      const dropped = devices.filter((d) => d.closeCode !== null);
      eq(dropped.length, 0, `sockets closed during the heartbeat phase (${dropped.slice(0, 3).map((d) => `${d.name}:${d.closeCode}`).join(', ')})`);
      const sent = devices.reduce((n, d) => n + d.heartbeats, 0);
      check(sent > 0, 'at least one heartbeat was sent');
      const body = await node.metrics();
      eq(metricSample(body, 'ia_devices_connected'), cfg.devices, 'ia_devices_connected after the heartbeat phase');
      eq(metricSample(body, 'ia_device_heartbeat_lag_seconds_count'), sent, 'the node observed every heartbeat');
      const within45 = metricSample(body, 'ia_device_heartbeat_lag_seconds_bucket', { le: '45' });
      eq(within45, sent, 'every heartbeat lag was under 45 s');
      const sum = metricSample(body, 'ia_device_heartbeat_lag_seconds_sum');
      return `${sent} heartbeats, mean lag ${(sum / sent).toFixed(1)} s, ${cfg.devices} still connected`;
    });

    await run.step('load: a forced node restart (SIGKILL) closes every socket', async () => {
      const t0 = Date.now();
      await node.kill();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && devices.some((d) => d.closeCode === null)) await sleep(200);
      const live = devices.filter((d) => d.closeCode === null);
      eq(live.length, 0, `sockets still open after the node died (${live.length})`);
      for (const d of devices) d.stopHeartbeat();
      state.deadAt = Date.now();
      return `every socket saw the node go in ${((state.deadAt - t0) / 1000).toFixed(1)} s`;
    });

    await run.step(`load: every device is back online within ${cfg.reconnectSec} s of the node returning`, async () => {
      const backAt = [];
      // The budget runs from the moment the node serves again (restarting a node is the operator's time, not the
      // fleet's); until then the devices are already backing off, so the storm is as early as it is in production.
      const budget = { backAt: null, deadline: Date.now() + cfg.reconnectSec * 1000 };
      const startNode = node.start().then((pid) => {
        state.restartMs = Date.now() - state.deadAt;
        budget.backAt = Date.now();
        budget.deadline = budget.backAt + cfg.reconnectSec * 1000;
        return pid;
      });
      // The services do not wait for the node: they are already backing off (0..initialDelay, then 1, 2, 4, 8 ... 30 s).
      // Every device backs off at the same time, as a real fleet does: no pool here, that is the storm.
      const reconnect = Promise.all(
        devices.map(async (d) => {
          await sleep(Math.random() * cfg.initialDelaySec * 1000);
          for (let attempt = 0; Date.now() < budget.deadline; attempt += 1) {
            try {
              await d.connect(state.deviceSignalUrl, Math.max(5000, budget.deadline - Date.now()));
              backAt.push(Date.now() - (budget.backAt ?? Date.now()));
              return;
            } catch (err) {
              d.lastError = err instanceof Error ? err.message : String(err);
              await sleep(Math.min(jitter(Math.min(30_000, 1000 * 2 ** attempt), 0.3), Math.max(250, budget.deadline - Date.now())));
            }
          }
          throw new Error(`${d.name}: not back online within ${cfg.reconnectSec} s of the node returning (last error: ${d.lastError ?? 'none'})`);
        }),
      );
      await startNode;
      await reconnect;
      const body = await node.metrics();
      eq(metricSample(body, 'ia_devices_connected'), cfg.devices, 'ia_devices_connected after the restart');
      check(metricSample(body, 'ia_device_hello_total', { result: 'ok' }) >= cfg.devices, 'the new node verified a hello for every device');
      state.reconnectMs = backAt;
      return `node back in ${(state.restartMs / 1000).toFixed(1)} s, all ${cfg.devices} back in ${(Math.max(...backAt) / 1000).toFixed(1)} s (p50 ${(pct(backAt, 0.5) / 1000).toFixed(1)} s, p95 ${(pct(backAt, 0.95) / 1000).toFixed(1)} s)`;
    });

    await run.step('load: the node loss left no device in a tamper state and chained no tamper.suspected (rule 10.2)', async () => {
      let cursor = null;
      let seen = 0;
      const bad = [];
      do {
        const page = await api.expect('GET', `/api/v1/devices?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        for (const d of page.items) {
          seen += 1;
          if (d.tamperState !== 'ok') bad.push(`${d.name}:${d.tamperState}`);
          if (!d.online) bad.push(`${d.name}:offline`);
        }
        cursor = page.nextCursor;
      } while (cursor);
      eq(seen, cfg.devices, 'devices in the fleet list');
      eq(bad.length, 0, `devices in a tamper state or offline (${bad.slice(0, 5).join(', ')})`);
      const chain = await api.expect('GET', '/api/v1/audit?action=tamper.suspected&limit=5');
      eq(chain.items.length, 0, 'tamper.suspected entries');
      const body = await node.metrics();
      for (const cause of ['suspected', 'stopped']) eq(metricSample(body, 'ia_tamper_alerts_total', { cause }), 0, `ia_tamper_alerts_total{cause="${cause}"}`);
      return `${seen} devices online, tamperState ok, no tamper.suspected`;
    });
  } finally {
    for (const d of devices) d.close();
    await node.kill().catch(() => undefined);
  }

  run.log(`\nsmoke p4 load: ${run.summary()} -> ${run.ok ? 'PASS' : 'FAIL'}`);
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e = process.env;
  const port = num(e.LOAD_PORT, 4200);
  runLoadP4({
    devices: Math.round(num(e.LOAD_DEVICES, 2000)),
    minutes: num(e.LOAD_MINUTES, 10),
    heartbeatSec: num(e.LOAD_HEARTBEAT_SEC, 30),
    reconnectSec: num(e.LOAD_RECONNECT_SEC, 120),
    initialDelaySec: num(e.LOAD_INITIAL_DELAY_SEC, 30),
    concurrency: Math.round(num(e.LOAD_CONCURRENCY, 50)),
    port,
    metricsPort: num(e.LOAD_METRICS_PORT, port + 1),
    dataDir: e.LOAD_DATA_DIR ? resolve(e.LOAD_DATA_DIR) : undefined,
    helloRate: num(e.DEVICE_HELLO_RATE, 500),
    rateLimits: e.LOAD_RATE_LIMITS === '1',
  })
    .then((run) => process.exit(run.ok ? 0 : 1))
    .catch((err) => {
      console.error(`FAIL  smoke p4 load crashed: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    });
}
