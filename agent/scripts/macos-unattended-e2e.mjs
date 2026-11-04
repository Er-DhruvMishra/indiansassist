#!/usr/bin/env node
// Phase F §17.3 (stream apple): the macOS unattended path end to end, on a Mac, with nothing installed.
//
//   node agent/scripts/macos-unattended-e2e.mjs [--skip-build]
//
// 1. starts the api (PGlite under a temporary root, 127.0.0.1:<E2E_MAC_SVC_PORT, default 4181>);
// 2. builds the dev daemon (ia-service, features macos-service,dev) and the dev worker (ia-desktop, features
//    ia-agent/media,macos,gui,dev) into agent/target/debug, trusting that api's region keys (IA_TOKEN_PUBKEYS);
// 3. signs up a p4_installed org, makes a device group whose policy is `allow` without local approval, an enrollment
//    token and the region-signed enroll.iaconfig;
// 4. starts `ia-service --console --data-dir <root> --enroll <file>`: the daemon enrolls itself (a file keychain
//    under the root, never the System keychain), opens <root>/run/worker.sock and the /signal/device socket;
// 5. starts `ia-desktop --socket <root>/run/worker.sock --dev-daemon --synthetic-capture --no-self-delete` (the
//    LaunchAgent stand-in, as this user): it checks the daemon, is admitted, and waits;
// 6. checks the device row says `platform: macos`, online, and an `active` interactive state;
// 7. asks for an unattended session, and checks the daemon handed it to the waiting worker (`auto_grant`), the worker
//    read the blob, and the session reached the server from the worker;
// 8. runs a read-only zsh playbook (sw_vers, uname -a) as a device action: done, exit 0, ranAs admin, the output
//    seen on the device and never on the server (rule 9.7);
// 9. kills the daemon outright and starts it again: watchdog_restarted is chained once; a clean stop removes the
//    run marker;
// 10. stops everything it started (only its own pids) and removes the root.
//
// Isolation (A1-A3): no launchd job, no System keychain, no TCC prompt (synthetic capture), nothing under /var/run or
// /Library, IA_ICE_LOOPBACK=1 so the firewall is never asked. No personal data is used: the org and the account are
// synthetic.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient } from '../../scripts/smoke/http.mjs';

if (process.platform !== 'darwin') {
  console.error('macos-unattended-e2e runs on macOS only');
  process.exit(1);
}
const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(agentDir, '..');
const target = resolve(agentDir, 'target');
const port = process.env.E2E_MAC_SVC_PORT || '4181';
const API = `http://127.0.0.1:${port}`;
const WEB = 'http://127.0.0.1:5341';
// The socket path must fit in 104 bytes: a short root under /tmp.
const root = `/tmp/iamu-${process.pid}`;
const children = [];
const logs = { api: '', daemon: '', worker: '' };

function log(step, msg) {
  console.log(`[macos-e2e] ${step}: ${msg}`);
}

function fail(msg) {
  throw new Error(msg);
}

function cargo() {
  return spawnSync('which', ['cargo']).status === 0 ? 'cargo' : `${process.env.HOME}/.cargo/bin/cargo`;
}

function build(pubkeys) {
  const common = ['build', '--manifest-path', resolve(agentDir, 'Cargo.toml'), '--locked'];
  // The daemon trusts only the region keys compiled into it (`IA_TOKEN_PUBKEYS`): this api's.
  const env = { ...process.env, CARGO_TARGET_DIR: target, IA_TOKEN_PUBKEYS: pubkeys };
  for (const args of [
    ['-p', 'ia-service', '--features', 'macos-service,dev'],
    ['-p', 'ia-desktop', '--no-default-features', '--features', 'ia-agent/media,ia-agent/macos,ia-agent/gui,dev'],
  ]) {
    const r = spawnSync(cargo(), [...common, ...args], { stdio: 'inherit', env });
    if (r.status !== 0) fail(`the build failed: ${args.join(' ')}`);
  }
}

function start(name, cmd, args, env, cwd = repoRoot) {
  // Each child leads its own process group, so stopping it also stops what it started (pnpm -> the api).
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const keep = (b) => {
    logs[name] += b.toString();
    if (logs[name].length > 2_000_000) logs[name] = logs[name].slice(-1_000_000);
  };
  p.stdout.on('data', keep);
  p.stderr.on('data', keep);
  children.push(p);
  return p;
}

async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

function stopAll() {
  for (const p of children.reverse()) {
    if (p.exitCode === null) {
      try {
        process.kill(-p.pid, 'SIGTERM');
      } catch {
        p.kill('SIGTERM');
      }
    }
  }
}

async function main() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(`${root}/api`, { recursive: true });

  start('api', 'pnpm', ['--filter', '@indiansassist/api', 'dev'], {
    PORT: port,
    API_ORIGIN: API,
    METRICS_PORT: '0',
    PGLITE_DIR: `${root}/api/pglite`,
    STORAGE_FS_DIR: `${root}/api/storage`,
    RATE_LIMIT_DISABLED: '1',
    SIGNUP_PLAN_TIER: 'p4_installed',
    LOG_LEVEL: 'warn',
    WEB_ORIGIN: WEB,
    REGION_ORIGINS: `in-mum=${WEB},eu-fra=${WEB},us-east=${WEB}`,
  });
  await until('the api', async () => (await fetch(`${API}/api/v1/health`)).ok, 120_000);
  log('api', API);
  const wk = await (await fetch(`${API}/.well-known/indiansassist.json`)).json();
  const pubkeys = wk.keys.map((k) => k.pub).join(',');
  if (!process.argv.includes('--skip-build')) build(pubkeys);

  const api = new ApiClient(API, { origin: WEB });
  const h = await api.expect('GET', '/api/v1/health');
  const region = h.servedRegions?.length ? h.servedRegions[0] : h.region;
  const sx = randomBytes(4).toString('hex');
  const su = await api.expect(
    'POST',
    '/api/v1/auth/signup',
    { orgName: `Mac E2E ${sx}`, region, name: `Mac E2E ${sx}`, email: `mac-e2e-${sx}@example.com`, password: `Mac-${randomBytes(12).toString('base64url')}` },
    [201],
  );
  await api.expect('PATCH', `/api/v1/users/${su.user.id}/role`, { role: 'org_admin', tier: 'p4_installed' });
  const g = await api.expect(
    'POST',
    '/api/v1/orgs/current/device-groups',
    { name: 'Mac unattended', defaultPolicy: { mode: 'allow', recordingRequired: false, requireLocalApprovalWhenPresent: false, maxUnattendedMinutes: 30 } },
    [201],
  );
  const t = await api.expect('POST', '/api/v1/tokens', { tier: 'p4_installed', typ: 'enrollment', maxDevices: 1, label: 'mac e2e' }, [201]);
  const cfg = await api.expect('GET', `/api/v1/devices/enroll-config?tokenId=${t.token.id}&groupId=${g.id}`);
  // The catalogue entry exists before the device connects: its manifest arrives in device.hello.ok.
  const pb = await api.expect(
    'POST',
    '/api/v1/orgs/current/playbooks',
    { name: `Mac read-only ${sx}`, interpreter: process.env.E2E_MAC_PB_SHELL || 'zsh', body: 'sw_vers\nuname -a\n' },
    [201],
  );
  const enrollFile = `${root}/enroll.iaconfig`;
  writeFileSync(enrollFile, cfg.iaconfig, { mode: 0o600 });
  log('org', `group ${g.id}, token ${t.token.id}`);

  const bin = resolve(target, 'debug');
  const daemon = start('daemon', `${bin}/ia-service`, ['--console', '--data-dir', root, '--enroll', enrollFile], { RUST_LOG: 'info' });
  await until('the daemon to enroll', async () => /device socket open/.test(logs.daemon), 60_000).catch((e) => {
    fail(`${e.message}\n--- daemon ---\n${logs.daemon.slice(-4000)}`);
  });
  log('daemon', `pid ${daemon.pid}, enrolled, socket ${root}/run/worker.sock`);

  const worker = start(
    'worker',
    `${bin}/ia-desktop`,
    ['--socket', `${root}/run/worker.sock`, '--dev-daemon', '--synthetic-capture', '--no-self-delete'],
    { RUST_LOG: 'info', IA_ICE_LOOPBACK: '1' },
  );
  await until('the worker to be admitted', async () => /a worker is connected and waiting/.test(logs.daemon), 30_000).catch((e) => {
    fail(`${e.message}\n--- daemon ---\n${logs.daemon.slice(-3000)}\n--- worker ---\n${logs.worker.slice(-3000)}`);
  });
  log('worker', `pid ${worker.pid}, admitted`);

  const devices = await api.expect('GET', '/api/v1/devices');
  const list = devices.devices ?? devices.items ?? devices;
  const row = list.find((d) => d.platform === 'macos') ?? fail(`no macos device in ${JSON.stringify(devices).slice(0, 400)}`);
  const deviceId = row.id;
  const dev = await until('the device to be online and active', async () => {
    const d = await api.expect('GET', `/api/v1/devices/${deviceId}`);
    const state = d.interactive?.state ?? d.interactiveState;
    return d.online !== false && state === 'active' ? d : null;
  }, 45_000);
  log('device', `${deviceId} platform ${dev.platform}, ${dev.osVersion}, interactive ${dev.interactive?.state ?? dev.interactiveState}`);

  const open = await api.expect('POST', `/api/v1/devices/${deviceId}/sessions`, { unattended: true, reason: 'mac e2e' }, [201, 202]);
  const sessionId = open.sessionId ?? open.id;
  log('session', `requested ${sessionId}`);
  await until('the daemon to hand the session to the worker', async () => /the session was handed to the console user's worker/.test(logs.daemon), 30_000);
  await until('the worker to read its blob', async () => /the worker read its launch blob/.test(logs.worker), 15_000);
  if (!/AutoGrant/i.test(logs.worker.match(/the worker read its launch blob.*/)?.[0] ?? '')) fail('the blob was not auto_grant');
  const live = await until('the session to reach the server from the worker', async () => {
    const s = await api.expect('GET', `/api/v1/sessions/${sessionId}`);
    return ['waiting_tech', 'active', 'connected', 'pending_tech'].includes(s.state ?? s.status) ? s : null;
  }, 45_000).catch((e) => {
    fail(`${e.message}\n--- worker ---\n${logs.worker.slice(-4000)}`);
  });
  log('session', `${sessionId} state ${live.state ?? live.status}`);

  // A read-only zsh playbook as a device action: run as root by the daemon (ranAs admin), exit 0. Rule 9.7 keeps the
  // output off the server; the dev daemon logs it, so the check reads it there.
  const actionsPath = `/api/v1/devices/${deviceId}/actions`;
  const q = await api.expect('POST', actionsPath, { kind: 'playbook_run', payload: { playbookId: pb.id, args: {}, requiresElevation: false } }, [202]);
  const done = await until('the playbook run to finish', async () => {
    const row = (await api.expect('GET', actionsPath)).items.find((a) => a.id === q.actionId);
    return row && ['done', 'failed'].includes(row.state) ? row : null;
  }, 60_000).catch((e) => fail(`${e.message}\n--- daemon ---\n${logs.daemon.slice(-3000)}`));
  if (done.state !== 'done') fail(`the playbook run ${done.state}: ${JSON.stringify(done.result)}`);
  if (done.result?.ranAs !== 'admin') fail(`ranAs ${done.result?.ranAs}`);
  if (done.result?.exit !== 0) fail(`exit ${done.result?.exit}`);
  if (JSON.stringify(done.result).includes('ProductName')) fail('the output reached the server (rule 9.7)');
  await until('the output on the device', async () => /dev: the action's output.*ProductName.*Darwin/s.test(logs.daemon), 10_000);
  log('playbook', `${q.actionId} done, exit 0, ranAs admin, output seen on the device only`);

  // The restart signal: a daemon killed outright and started again in this boot reports watchdog_restarted once.
  daemon.kill('SIGKILL');
  await until('the daemon to die', async () => daemon.exitCode !== null || daemon.signalCode !== null, 10_000);
  if (!existsSync(`${root}/state/run.marker`)) fail('no run marker was left by the killed daemon');
  logs.daemon = '';
  const again = start('daemon', `${bin}/ia-service`, ['--console', '--data-dir', root], { RUST_LOG: 'info' });
  await until('the restarted daemon to connect', async () => /device socket open/.test(logs.daemon), 60_000);
  const tamper = await until('watchdog_restarted on the server', async () => {
    const chain = await api.expect('GET', '/api/v1/audit?action=tamper.alert&limit=20');
    return chain.items.find((e) => JSON.stringify(e.data ?? {}).includes('watchdog_restarted')) ?? null;
  }, 30_000).catch((e) => fail(`${e.message}\n--- daemon ---\n${logs.daemon.slice(-3000)}`));
  log('restart', `watchdog_restarted chained (${tamper.id ?? 'audit row'})`);

  // A clean stop removes the marker, so the next start is not a restart.
  again.kill('SIGTERM');
  await until('the daemon to stop', async () => again.exitCode !== null, 15_000);
  if (again.exitCode !== 0) fail(`the daemon exited ${again.exitCode}`);
  if (existsSync(`${root}/state/run.marker`)) fail('a clean stop left the run marker');
  log('stop', `daemon exited 0 and removed its marker; the worker ${worker.exitCode === null ? 'is ending' : `exited ${worker.exitCode}`}`);
  console.log('[macos-e2e] PASS');
}

main()
  .catch((e) => {
    console.error(`[macos-e2e] FAIL: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    stopAll();
    setTimeout(() => {
      rmSync(root, { recursive: true, force: true });
      process.exit(process.exitCode ?? 0);
    }, 1500);
  });
