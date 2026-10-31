#!/usr/bin/env node
// Live Android e2e (`pnpm android:e2e`, contracts section 15.3): the Android host on an emulator against a real api,
// with the real web console in Playwright as the Assist. Skips (exit 0) unless IA_EMULATOR=1.
//
// What it does, in order:
//   1. starts the api (PORT 4300, METRICS_PORT 9480, a fresh PGlite under ./data/e2e-android/run-*, rate limits off,
//      SIGNUP_PLAN_TIER=p3_portable, log ./data/android-api.log) and Vite on 5273 (VITE_API_URL -> the api);
//   2. uses the attached emulator / device (boots Pixel7_API35 headless when none is attached, and kills it after);
//      builds the debug and androidTest APKs with IA_DEV_API=http://localhost:4300, installs them, grants
//      POST_NOTIFICATIONS / RECORD_AUDIO / CAMERA and SYSTEM_ALERT_WINDOW, pre-enables the Accessibility service, and
//      maps the api into the device with `adb reverse tcp:4300 tcp:4300`;
//   3. signs up a p3 org, mints a one_time p3 token, opens an observing Assist ws and the console in Chromium;
//   4. runs AssistE2ETest (am instrument) and drives the Assist half against its logcat progress lines;
//   5. verifies the session audit chain, prints PASS / FAIL per assertion and stops everything it started.
//
// Env: IA_EMULATOR=1 (required), IA_AVD (Pixel7_API35), IA_API_PORT (4300), IA_METRICS_PORT (9480), IA_WEB_PORT
// (5273), IA_SKIP_BUILD=1, IA_KEEP_EMULATOR=1, IA_HEADED=1, ANDROID_HOME / ANDROID_SDK_ROOT.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistDriver, TECH_NAME, sleep } from './assist-driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = resolve(here, '..');
const repo = resolve(androidDir, '../..');
const win = process.platform === 'win32';
const env = process.env;

if (env.IA_EMULATOR !== '1') {
  console.log('SKIP  android:e2e: set IA_EMULATOR=1 to run it (needs the Android SDK and an emulator or device; see apps/android/README.md)');
  process.exit(0);
}

const API_PORT = Number(env.IA_API_PORT || 4300);
const METRICS_PORT = Number(env.IA_METRICS_PORT || 9480);
const WEB_PORT = Number(env.IA_WEB_PORT || 5273);
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const AVD = env.IA_AVD || 'Pixel7_API35';
const PKG = 'com.indiansassist.desk';
const TEST_PKG = `${PKG}.test`;
const SIGNAL_DIR = '/data/local/tmp/ia-e2e';
const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (win ? join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : join(env.HOME ?? '', 'Android', 'Sdk'));
const ADB = join(sdk, 'platform-tools', win ? 'adb.exe' : 'adb');
const EMULATOR = join(sdk, 'emulator', win ? 'emulator.exe' : 'emulator');
const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const outDir = join(repo, 'data', 'e2e-android');
const runDir = join(outDir, `run-${runId}`);
mkdirSync(runDir, { recursive: true });

const t0 = Date.now();
const results = [];
const children = [];
let bootedEmulator = false;
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);

/** `known`: passes the run but is printed as KNOWN (a defect outside apps/android, proven by evidence). */
function record(name, ok, detail = '', known = false) {
  results.push({ name, ok, detail, known });
  log(`${known ? 'KNOWN' : ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}

async function assert(name, fn) {
  try {
    const d = await fn();
    return record(name, true, typeof d === 'string' ? d : '');
  } catch (e) {
    record(name, false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// ---------- processes ----------

function adb(args, opts = {}) {
  const r = spawnSync(ADB, args, { encoding: 'utf8', timeout: opts.timeout ?? 120_000 });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`adb ${args.join(' ')} -> ${r.status}: ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout ?? '').trim();
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Starts a long-running child with output to `logFile`; on Windows through cmd.exe so pnpm resolves. */
function startChild(name, command, extraEnv, logFile) {
  const out = createWriteStream(logFile, { flags: 'w' });
  const child = win
    ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: repo, env: { ...env, ...extraEnv }, windowsHide: true })
    : spawn('sh', ['-c', command], { cwd: repo, env: { ...env, ...extraEnv }, detached: true });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push({ name, child });
  return child;
}

function killTree(pid) {
  if (!pid) return;
  if (win) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
}

function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(port, '0.0.0.0', () => s.close(() => res(true)));
  });
}

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`${url} did not come up within ${ms} ms`);
}

// ---------- logcat progress from AssistE2ETest ----------

class LogWatch {
  constructor() {
    this.lines = [];
    this.steps = new Map();
    this.waiters = [];
    this.failed = null;
    this.out = createWriteStream(join(runDir, 'logcat-ia.txt'));
  }

  start() {
    adb(['logcat', '-c'], { allowFail: true });
    this.proc = spawn(ADB, ['logcat', '-v', 'time', 'IA_E2E:I', 'IA.ctl:I', 'IA.a11y:I', 'IA:E', 'AndroidRuntime:E', 'TestRunner:I', '*:S']);
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        this.onLine(line);
      }
    });
  }

  onLine(line) {
    this.lines.push(line);
    this.out.write(line + '\n');
    const step = /IA_E2E\s*\(\s*\d+\):\s+step=(\S+)(.*)$/.exec(line);
    if (step) {
      const kv = {};
      for (const m of step[2].matchAll(/(\w+)=(\S*)/g)) kv[m[1]] = m[2].replace(/_/g, ' ');
      this.steps.set(step[1], kv);
      log(`device: ${step[1]}${step[2]}`);
    }
    const fail = /IA_E2E\s*\(\s*\d+\):\s+fail=(\S+)\s?(.*)$/.exec(line);
    if (fail) {
      this.failed = `${fail[1]}: ${fail[2]}`;
      log(`device FAILED: ${this.failed}`);
    }
    for (const w of [...this.waiters]) w.check();
  }

  /** Resolves with the step's key/values; rejects on a device failure, instrumentation exit or timeout. */
  step(name, ms) {
    return new Promise((res, rej) => {
      const w = {
        check: () => {
          if (this.steps.has(name)) return done(() => res(this.steps.get(name)));
          if (this.failed) return done(() => rej(new Error(`device test failed: ${this.failed}`)));
          if (instrumentDone) return done(() => rej(new Error(`instrumentation ended before step ${name}`)));
        },
      };
      const timer = setTimeout(() => done(() => rej(new Error(`timed out after ${ms} ms waiting for device step ${name}`))), ms);
      const done = (f) => {
        clearTimeout(timer);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        f();
      };
      this.waiters.push(w);
      w.check();
    });
  }

  /** Races `p` against a device failure or the end of the instrumentation, so the driver never waits for nothing. */
  guard(p) {
    let timer;
    const dead = new Promise((_, rej) => {
      const tick = () => {
        if (this.failed) return rej(new Error(`device test failed: ${this.failed}`));
        if (instrumentDone) return rej(new Error('instrumentation ended'));
        timer = setTimeout(tick, 250);
      };
      tick();
    });
    return Promise.race([p, dead]).finally(() => clearTimeout(timer));
  }

  /** Lines matching `re` seen so far. */
  grep(re) {
    return this.lines.filter((l) => re.test(l));
  }

  async waitGrep(re, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.grep(re);
      if (hit.length) return hit;
      await sleep(200);
    }
    return [];
  }

  stop() {
    this.proc?.kill();
    this.out.end();
  }
}

let instrumentDone = false;
let instrumentOutput = '';

// ---------- main ----------

async function main() {
  log(`android:e2e run ${runId} (api ${API}, web ${WEB}, artifacts ${runDir})`);
  if (!existsSync(ADB)) throw new Error(`adb not found at ${ADB} (set ANDROID_HOME)`);
  for (const p of [API_PORT, METRICS_PORT, WEB_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is busy; set IA_API_PORT / IA_METRICS_PORT / IA_WEB_PORT`);

  // 1. api + web
  const regionOrigins = `in-mum=${WEB},eu-fra=${WEB},us-east=${WEB}`;
  const apiLog = join(repo, 'data', 'android-api.log');
  startChild('api', 'pnpm --filter @indiansassist/api exec tsx src/server.ts', {
    PORT: String(API_PORT),
    METRICS_PORT: String(METRICS_PORT),
    API_ORIGIN: API,
    WEB_ORIGIN: WEB,
    REGION_ORIGINS: regionOrigins,
    PGLITE_DIR: join(runDir, 'pglite'),
    STORAGE_FS_DIR: join(runDir, 'storage'),
    RATE_LIMIT_DISABLED: 'true',
    SIGNUP_PLAN_TIER: 'p3_portable',
    LOG_LEVEL: 'info',
  }, apiLog);
  startChild('web', `pnpm --filter @indiansassist/web exec vite --port ${WEB_PORT} --strictPort`, { VITE_API_URL: API, VITE_REGION_ORIGINS: regionOrigins }, join(runDir, 'web.log'));

  // 2. device (in parallel with the servers coming up)
  let devices = adb(['devices']).split('\n').slice(1).filter((l) => /\tdevice$/.test(l));
  if (devices.length === 0) {
    log(`no device attached: booting ${AVD} headless`);
    const emu = spawn(EMULATOR, ['-avd', AVD, '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect', '-no-snapshot-save', '-no-boot-anim'], { detached: !win, stdio: 'ignore', windowsHide: true });
    emu.unref();
    bootedEmulator = true;
    adb(['wait-for-device'], { timeout: 180_000 });
    const end = Date.now() + 240_000;
    while (adb(['shell', 'getprop', 'sys.boot_completed'], { allowFail: true }) !== '1') {
      if (Date.now() > end) throw new Error('emulator did not finish booting in 240 s');
      await sleep(2000);
    }
    devices = adb(['devices']).split('\n').slice(1).filter((l) => /\tdevice$/.test(l));
  }
  log(`device ${devices[0].split('\t')[0]}, API ${adb(['shell', 'getprop', 'ro.build.version.sdk'])}`);

  if (env.IA_SKIP_BUILD !== '1') {
    log('building the debug and androidTest APKs (IA_DEV_API=' + API + ')');
    const gradle = win
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', join(androidDir, 'gradlew.bat'), 'assembleDebug', 'assembleDebugAndroidTest', '-q'], { cwd: androidDir, env: { ...env, IA_DEV_API: API }, stdio: 'inherit' })
      : spawnSync('./gradlew', ['assembleDebug', 'assembleDebugAndroidTest', '-q'], { cwd: androidDir, env: { ...env, IA_DEV_API: API }, stdio: 'inherit' });
    if (gradle.status !== 0) throw new Error('gradle build failed');
  }
  const apk = join(androidDir, 'build', 'outputs', 'apk', 'debug', 'indiansassist-desk-debug.apk');
  const testApk = join(androidDir, 'build', 'outputs', 'apk', 'androidTest', 'debug', 'indiansassist-desk-debug-androidTest.apk');
  adb(['install', '-r', '-g', apk], { timeout: 300_000 });
  adb(['install', '-r', '-g', testApk], { timeout: 120_000 });
  adb(['shell', 'pm', 'clear', PKG]);
  for (const p of ['android.permission.POST_NOTIFICATIONS', 'android.permission.RECORD_AUDIO', 'android.permission.CAMERA']) adb(['shell', 'pm', 'grant', PKG, p]);
  adb(['shell', 'appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', 'allow']);
  adb(['shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', `${PKG}/${PKG}.service.DeskAccessibilityService`]);
  adb(['shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1']);
  adb(['reverse', `tcp:${API_PORT}`, `tcp:${API_PORT}`]);
  adb(['shell', `rm -rf ${SIGNAL_DIR}; mkdir -p ${SIGNAL_DIR}; chmod 777 ${SIGNAL_DIR}`]);
  adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFail: true });
  adb(['shell', 'wm', 'dismiss-keyguard'], { allowFail: true });
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'], { allowFail: true });
  log('APKs installed; notifications / microphone / camera granted, overlay allowed, Accessibility service enabled, api reversed');

  await waitHttp(`${API}/api/v1/health`, 120_000);
  await waitHttp(WEB, 120_000);
  log('api and web are up');

  // 3. Assist side
  const driver = new AssistDriver({ apiUrl: API, webOrigin: WEB, headless: env.IA_HEADED !== '1', log });
  try {
    await runFlow(driver);
  } finally {
    await driver.screenshot(join(runDir, 'console-final.png'));
    await driver.close();
  }
}

async function runFlow(driver) {
  const st = await driver.signup();
  const tok = await driver.mintToken();
  log(`org ${st.org.slug ?? st.org.id} (${st.orgDisplay}), token ${tok.token.id}`);
  await driver.openObserver();
  await driver.openConsole();
  log('console open in Chromium, signaling online');

  const chatIn = `Hello from the Assist ${randomBytes(2).toString('hex')}`;
  const chatOut = `Hello from the Android Desk ${randomBytes(2).toString('hex')}`;
  const fileName = `ia-e2e-${runId}.txt`;
  const fileBytes = Buffer.concat([Buffer.from(`IndiansAssist android e2e ${runId}\n`), randomBytes(40_000)]);
  const fileMd5 = createHash('md5').update(fileBytes).digest('hex');

  const watch = new LogWatch();
  watch.start();
  const instArgs = {
    IA_EMULATOR: '1',
    IA_TOKEN: tok.compact,
    IA_TECH: TECH_NAME,
    IA_ORG: st.orgDisplay,
    IA_CHAT_IN: chatIn,
    IA_CHAT_OUT: chatOut,
    IA_FILE_NAME: fileName,
    IA_SIGNAL_DIR: SIGNAL_DIR,
  };
  const cmd = ['am', 'instrument', '-w', '-r', ...Object.entries(instArgs).flatMap(([k, v]) => ['-e', k, shQuote(v)]), '-e', 'class', `${PKG}.AssistE2ETest`, `${TEST_PKG}/androidx.test.runner.AndroidJUnitRunner`].join(' ');
  const testStart = Date.now();
  const inst = spawn(ADB, ['shell', cmd]);
  inst.stdout.on('data', (d) => (instrumentOutput += d.toString('utf8')));
  inst.stderr.on('data', (d) => (instrumentOutput += d.toString('utf8')));
  const instDone = new Promise((res) =>
    inst.on('close', (code) => {
      instrumentDone = true;
      for (const w of [...watch.waiters]) w.check();
      res(code);
    }),
  );
  log('AssistE2ETest started on the device');

  let sessionId = null;
  try {
    // Knock: seen by the plain ws observer (native Android Desk) and accepted in the console.
    await assert('knock from the native Android Desk reaches the Assist (ws observer)', async () => {
      const k = await watch.guard(driver.observer.next((m) => m.t === 'assist.knock', 120_000, 'assist.knock'));
      if (!/^IndiansAssist-Android\//.test(k.userAgent ?? '')) throw new Error(`knock userAgent '${k.userAgent}'`);
      return `UA ${k.userAgent}`;
    });
    const acc = await watch.guard(driver.acceptKnock());
    sessionId = acc.sessionId;
    await assert('Assist accepts the knock in the console (navigates to the P3 console)', async () => `session ${sessionId}`);
    await assert('observer sees knock.closed by accepted', async () => {
      const c = await driver.observer.next((m) => m.t === 'knock.closed' && m.sessionId === sessionId, 15_000, 'knock.closed');
      if (c.by !== 'accepted') throw new Error(`knock.closed by ${c.by}`);
    });

    await assert('consent screen shows the technician and the org', async () => {
      const s = await watch.step('consent_screen', 60_000);
      const want = `${TECH_NAME} (${st.orgDisplay}) wants to see this phone`;
      if (s.title !== want) throw new Error(`title '${s.title}', expected '${want}'`);
      return s.title;
    });
    await assert('MediaProjection system dialog accepted through UiAutomator', async () => {
      const s = await watch.step('projection_accepted', 60_000);
      return `spinner ${s.spinner}, button '${s.button}'`;
    });
    await assert('session active at level control with captured frames', async () => {
      const s = await watch.step('active', 90_000);
      if (s.level !== 'control') throw new Error(`level ${s.level}`);
      return `frames ${s.frames}`;
    });
    await assert('foreground sharing notification posted (in-app check + dumpsys)', async () => {
      const s = await watch.step('notification', 30_000);
      const dump = adb(['shell', 'dumpsys', 'notification', '--noredact'], { allowFail: true });
      const rec = dump.split('NotificationRecord(').find((r) => r.includes(`pkg=${PKG}`) && r.includes('id=1 '));
      if (!rec) throw new Error('dumpsys notification has no id=1 record for the app');
      if (!rec.includes('Sharing your screen with')) throw new Error('the id=1 record does not carry the sharing title');
      return `${s.title} (ongoing, foreground service)`;
    });
    await assert('console decodes the remote video (videoWidth > 0)', async () => {
      const v = await watch.guard(driver.waitVideo(60_000));
      return `${v.width}x${v.height}`;
    });
    const deviceSas = await watch.step('sas', 90_000);
    await assert('security code matches between the console and the app screen', async () => {
      const c = await driver.consoleSas(30_000);
      if (c !== deviceSas.sas) throw new Error(`console ${c} != app ${deviceSas.sas}`);
      await driver.confirmSas(deviceSas.sas);
      return `${c.slice(0, 3)} ${c.slice(3)} (confirmed in the console's SasConfirmDialog)`;
    });
    await driver.enableControl();
    await watch.step('home', 30_000);

    await assert('os.pointer tap at control: ctl.res ok and dispatchGesture completed', async () => {
      await sleep(500);
      await driver.tap(0.5, 0.45);
      const up = await watch.waitGrep(/IA\.ctl.*op=os\.pointer kind=up .*ok=/, 20_000);
      const bad = watch.grep(/IA\.ctl.*op=os\.pointer.*ok=false/);
      if (bad.length) throw new Error(`refused: ${bad[0]}`);
      const down = watch.grep(/IA\.ctl.*op=os\.pointer kind=down .*ok=true/);
      if (!down.length || !up.some((l) => /ok=true/.test(l))) throw new Error(`no ctl.res ok for pointer down + up: ${watch.grep(/IA\.ctl/).slice(-3).join(' / ')}`);
      const begin = watch.grep(/IA\.a11y.*dispatchGesture kind=stroke\.begin accepted=true result=OK/);
      const end = watch.grep(/IA\.a11y.*dispatchGesture kind=stroke\.end accepted=true result=OK/);
      if (!begin.length || !end.length) throw new Error(`gesture not completed: ${watch.grep(/IA\.a11y/).slice(-3).join(' / ')}`);
      return 'ctl.res ok for down and up; dispatchGesture stroke.begin + stroke.end completed (result OK)';
    });

    await assert('chat Assist -> Android', async () => {
      await driver.sendChat(chatIn);
      await watch.step('chat_in', 60_000);
    });
    await assert('chat Android -> Assist', async () => {
      await watch.step('chat_out', 60_000);
      await watch.guard(driver.waitChat(chatOut, 30_000));
    });

    await assert('file Assist -> Android lands in Download/IndiansAssist with the same bytes', async () => {
      const sha = await driver.sendFile(fileName, fileBytes);
      const saved = await watch.step('file_saved', 120_000);
      await driver.waitFileDone(fileName, 60_000);
      const path = `/sdcard/${saved.path.replace(/\/?$/, '/')}${saved.name}`;
      const ls = adb(['shell', 'ls', '-l', shQuote(path)]);
      const md5 = adb(['shell', 'md5sum', shQuote(path)]).split(/\s+/)[0];
      if (md5 !== fileMd5) throw new Error(`md5 on device ${md5} != sent ${fileMd5}`);
      if (!ls.includes(String(fileBytes.length))) throw new Error(`size mismatch: ${ls}`);
      return `${path}, ${fileBytes.length} bytes, md5 ${md5}, sha256 ${sha.slice(0, 12)}...`;
    });

    // Stop from the app.
    adb(['shell', `touch ${SIGNAL_DIR}/stop`]);
    await assert('Stop from the app ends the session (device, console, REST)', async () => {
      const e = await watch.step('ended', 60_000);
      const text = await driver.waitEnded(30_000);
      const s = await driver.session(sessionId);
      const row = s.session ?? s;
      if (row.state !== 'ended') throw new Error(`REST state ${row.state}`);
      if (row.endReason !== e.reason) throw new Error(`device endReason ${e.reason} != REST ${row.endReason}`);
      st.tail = e.tail || null;
      st.endReason = row.endReason;
      return `device ended + sharing notification gone; console '${text.trim()}'; REST state ended, endReason ${row.endReason}`;
    });

    const code = await Promise.race([instDone, sleep(30_000).then(() => 'timeout')]);
    await assert('instrumentation AssistE2ETest passed', async () => {
      if (code === 'timeout') throw new Error('am instrument did not exit');
      if (!/OK \(1 test\)/.test(instrumentOutput)) throw new Error(`am instrument output:\n${instrumentOutput.slice(-1500)}`);
      return `${((Date.now() - testStart) / 1000).toFixed(1)} s on the device`;
    });

    await assert('audit entries present and the session chain verifies', async () => {
      const required = ['session.knock', 'session.accepted', 'session.consent_granted', 'session.started', 'session.ended'];
      const { items, integrity, verify } = await driver.verifyAudit(sessionId, required, st.tail);
      writeFileSync(join(runDir, 'audit.json'), JSON.stringify(items, null, 2));
      if (integrity?.ok !== true) throw new Error(`server integrity ${JSON.stringify(integrity)}`);
      if (!verify.ok) throw new Error(verify.problems.join('; '));
      const by = (a) => items.filter((e) => e.action === a);
      const problems = [];
      const consent = by('session.consent_granted')[0]?.data;
      if (consent?.level !== 'control' || consent?.monitors !== 1) problems.push(`consent_granted ${JSON.stringify(consent)}`);
      if (!by('sec.verified').some((e) => e.data?.sas === deviceSas.sas && e.data?.gen === 0)) problems.push('no sec.verified for the confirmed code');
      if (by('a11y.state').filter((e) => e.actor?.type === 'desk' && e.data?.enabled === true).length < 2) problems.push('a11y.state { enabled: true } not chained at both session start and end');
      if (!by('control.input').some((e) => e.actor?.type === 'desk' && e.data?.mode === 'os' && e.data?.monitorId === 1 && e.data?.count >= 1)) problems.push('no desk control.input (mode os, monitorId 1)');
      if (!by('control.input').some((e) => e.actor?.type === 'user' && e.data?.mode === 'os')) problems.push('no console control.input');
      if (!by('file.received').some((e) => e.actor?.type === 'desk')) problems.push('no desk file.received');
      if (problems.length) throw new Error(problems.join('; '));
      st.audit = items;
      const actions = [...new Set(items.map((e) => e.action))];
      return `${verify.checked} entries, ${verify.segments} segment(s): ${actions.join(', ')}`;
    });

    // The Desk's Stop ends the session as desk_stopped. Hard rule 2 (A section 7.4) makes the Desk close every
    // data channel and the peer connection as it sends stop.sharing / consent.revoked and its WS session.end; the
    // console's SecureHub (apps/web/src/lib/secureHub.ts) now treats that teardown as an orderly end rather than
    // sec.fail 'channel' (fixed in secureHub.ts and the agent controllers, commit 70ad1c0), so the Desk's
    // session.end wins and the end reason is desk_stopped. A console-written sec.failed { reason: 'channel' } for
    // an orderly Stop would be a regression of that fix and fails this assertion.
    const items = st.audit ?? [];
    const spuriousSecFail = items.find((x) => x.action === 'sec.failed' && x.actor?.type === 'user' && x.data?.reason === 'channel');
    if (st.endReason === 'desk_stopped' && !spuriousSecFail)
      record('Stop ends the session as desk_stopped', true, 'endReason desk_stopped (console treated the Desk teardown as an orderly end)');
    else if (spuriousSecFail)
      record('Stop ends the session as desk_stopped', false, `regression: console wrote sec.failed { reason: 'channel' } at seq ${spuriousSecFail.seq} for an orderly Stop; endReason ${st.endReason}`);
    else record('Stop ends the session as desk_stopped', false, `endReason ${st.endReason}`);
  } finally {
    if (!instrumentDone) {
      await Promise.race([instDone, sleep(5_000)]);
      if (!instrumentDone) inst.kill();
    }
    writeFileSync(join(runDir, 'instrument.txt'), instrumentOutput);
    watch.stop();
    writeFileSync(join(runDir, 'logcat-full.txt'), adb(['logcat', '-d', '-v', 'time'], { allowFail: true, timeout: 60_000 }));
  }
}

async function cleanup() {
  for (const { name, child } of children.reverse()) {
    killTree(child.pid);
    log(`stopped ${name} (pid ${child.pid})`);
  }
  if (existsSync(ADB)) {
    adb(['reverse', '--remove', `tcp:${API_PORT}`], { allowFail: true });
    adb(['shell', `rm -rf ${SIGNAL_DIR}`], { allowFail: true });
    if (bootedEmulator && env.IA_KEEP_EMULATOR !== '1') {
      adb(['emu', 'kill'], { allowFail: true });
      log('emulator stopped (adb emu kill)');
    }
  }
  if (env.IA_KEEP_DATA !== '1') rmSync(join(runDir, 'pglite'), { recursive: true, force: true });
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  log(`ERROR ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await cleanup();
}
const bad = results.filter((r) => !r.ok);
const known = results.filter((r) => r.known).length;
console.log(`\nandroid:e2e ${results.length - bad.length}/${results.length} assertions passed${known ? ` (${known} KNOWN external defect)` : ''} in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${failed || bad.length ? 'FAIL' : 'PASS'} (artifacts ${runDir})`);
process.exit(failed || bad.length ? 1 : 0);
