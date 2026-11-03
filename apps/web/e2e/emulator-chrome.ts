/**
 * The shared Android-emulator Chrome harness (docs/specs/phase-f-contracts.md sections 1.5, 15.9), used by the
 * `*-emulator.spec.ts` specs under `emulator.config.ts` (`camera-emulator.spec.ts`, `mobile-emulator.spec.ts`).
 *
 * It boots `Pixel7_API35` headless (or reuses an attached emulator or device), as `apps/android/tools/android-e2e.mjs`
 * does; checks that Chrome is installed (`pm path com.android.chrome`; absent = "not met"); maps the suite's api and
 * web ports into the device with `adb reverse`, so the phone's origin is a secure `http://localhost:<port>`; grants
 * the camera permission to Chrome only (`pm grant com.android.chrome android.permission.CAMERA`); and connects
 * Playwright's `_android` to Chrome. One runner at a time: the lock `data/.emulator.lock` serialises runs across
 * streams; a second runner waits up to 30 minutes, then reports "not run: emulator busy". Everything it set up (the
 * reverse mappings, the lock, an emulator it booted itself) is removed in `finally` by `withEmulatorChrome`.
 *
 * It runs only with `IA_EMULATOR=1`. It installs nothing and changes nothing on the host but the lock file; on the
 * device it changes only the two reverse mappings and Chrome's camera grant. `IA_KEEP_EMULATOR=1` keeps an emulator
 * it booted running afterwards. ANDROID_HOME / ANDROID_SDK_ROOT locate the SDK.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _android, type AndroidDevice, type BrowserContext } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const env = process.env;
const win = process.platform === 'win32';

export const EMULATOR_AVD = 'Pixel7_API35';
export const CHROME_PKG = 'com.android.chrome';
export const EMULATOR_LOCK = resolve(repoRoot, 'data', '.emulator.lock');
/** Section 1.5: a second runner waits up to 30 minutes for the lock. */
export const LOCK_WAIT_MS = 30 * 60_000;
const LOCK_POLL_MS = 5_000;
/** No runner holds the lock longer than a spec's 45-minute timeout, so an older lock is stale even when Windows has
 * reused its owner's pid for another process. */
const LOCK_MAX_AGE_MS = 50 * 60_000;
const BOOT_TIMEOUT_MS = 240_000;
const TAKEN_PORTS = [4000, 4100, 4105];

export type EmulatorChrome = {
  device: AndroidDevice;
  /** Chrome's persistent context on the device. */
  context: BrowserContext;
  serial: string;
};

/** Why the harness did not run: the spec skips with this text (never a silent pass). */
export type NotRun = { notRun: string };

export function emulatorEnabled(): boolean {
  return env.IA_EMULATOR === '1';
}

function sdkPaths(): { adb: string; emulator: string } {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (win ? join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : join(env.HOME ?? '', 'Android', 'Sdk'));
  return {
    adb: join(sdk, 'platform-tools', win ? 'adb.exe' : 'adb'),
    emulator: join(sdk, 'emulator', win ? 'emulator.exe' : 'emulator'),
  };
}

function adb(args: string[], opts: { allowFail?: boolean; timeout?: number } = {}): string {
  const r = spawnSync(sdkPaths().adb, args, { encoding: 'utf8', timeout: opts.timeout ?? 120_000 });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`adb ${args.join(' ')} -> ${r.status}: ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Takes `data/.emulator.lock` (exclusive create). A lock whose owner process is gone, or that is older than
 * LOCK_MAX_AGE_MS, is stale and is taken over.
 * Returns false when the lock is still held after `waitMs`.
 */
export async function acquireEmulatorLock(waitMs = LOCK_WAIT_MS, lockPath = EMULATOR_LOCK): Promise<boolean> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let owner: number | null = null;
    let takenAt = NaN;
    try {
      const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; at?: unknown };
      owner = Number(held.pid) || null;
      takenAt = typeof held.at === 'string' ? Date.parse(held.at) : NaN;
    } catch {
      // being written, or unreadable: owner stays null, so the lock is treated as held and we wait
    }
    if (owner !== null && (!pidAlive(owner) || Date.now() - takenAt > LOCK_MAX_AGE_MS)) {
      rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= end) return false;
    await sleep(Math.min(LOCK_POLL_MS, Math.max(0, end - Date.now())));
  }
}

/** Removes the lock only when this process holds it. */
export function releaseEmulatorLock(lockPath = EMULATOR_LOCK): void {
  try {
    const owner = Number((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }).pid);
    if (owner === process.pid) rmSync(lockPath, { force: true });
  } catch {
    /* absent or unreadable: nothing of ours to remove */
  }
}

function attachedDevices(): string[] {
  return adb(['devices'])
    .split('\n')
    .slice(1)
    .filter((l) => /\tdevice\s*$/.test(l))
    .map((l) => l.split('\t')[0]!);
}

/** Boots the AVD headless when nothing is attached; true when this call booted it. */
async function ensureDevice(): Promise<boolean> {
  if (attachedDevices().length > 0) return false;
  const { emulator } = sdkPaths();
  if (!existsSync(emulator)) throw new Error(`emulator not found at ${emulator} (set ANDROID_HOME)`);
  const child = spawn(emulator, ['-avd', EMULATOR_AVD, '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect', '-no-snapshot-save', '-no-boot-anim'], {
    detached: !win,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  adb(['wait-for-device'], { timeout: 180_000 });
  const end = Date.now() + BOOT_TIMEOUT_MS;
  while (adb(['shell', 'getprop', 'sys.boot_completed'], { allowFail: true }) !== '1') {
    if (Date.now() > end) throw new Error(`${EMULATOR_AVD} did not finish booting in ${BOOT_TIMEOUT_MS / 1000} s`);
    await sleep(2000);
  }
  return true;
}

/**
 * Runs `fn` with Chrome on the emulator for a suite whose api and web listen on `apiPort` / `webPort` (the stream's
 * emulator ports of section 1.5). Returns `{ notRun }` instead of running when `IA_EMULATOR` is not 1, the SDK or
 * Chrome is missing ("not met"), or another runner holds the lock for 30 minutes ("emulator busy").
 */
export async function withEmulatorChrome<T>(ports: { apiPort: number; webPort: number }, fn: (chrome: EmulatorChrome) => Promise<T>): Promise<T | NotRun> {
  if (!emulatorEnabled()) return { notRun: 'not run: set IA_EMULATOR=1 (needs the Android SDK and the Pixel7_API35 emulator)' };
  for (const p of [ports.apiPort, ports.webPort]) {
    if (TAKEN_PORTS.includes(p)) throw new Error(`emulator harness: port ${p} is never used by a Phase F suite (4000, 4100, 4105 are taken)`);
  }
  if (!existsSync(sdkPaths().adb)) return { notRun: `not met: adb not found at ${sdkPaths().adb} (set ANDROID_HOME)` };
  if (!(await acquireEmulatorLock())) return { notRun: 'not run: emulator busy' };

  let booted = false;
  let device: AndroidDevice | null = null;
  let context: BrowserContext | null = null;
  const reversed: number[] = [];
  try {
    booted = await ensureDevice();
    if (!adb(['shell', 'pm', 'path', CHROME_PKG], { allowFail: true }).startsWith('package:')) {
      return { notRun: `not met: Chrome (${CHROME_PKG}) is not installed on the emulator` };
    }
    for (const p of [ports.apiPort, ports.webPort]) {
      adb(['reverse', `tcp:${p}`, `tcp:${p}`]);
      reversed.push(p);
    }
    // The camera permission for Chrome only (the page still asks; the spec answers the site prompt).
    adb(['shell', 'pm', 'grant', CHROME_PKG, 'android.permission.CAMERA']);
    adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { allowFail: true });
    adb(['shell', 'wm', 'dismiss-keyguard'], { allowFail: true });
    const devices = await _android.devices();
    device = devices[0] ?? null;
    if (!device) return { notRun: 'not met: Playwright found no Android device' };
    context = await device.launchBrowser({ pkg: CHROME_PKG });
    return await fn({ device, context, serial: device.serial() });
  } finally {
    await context?.close().catch(() => undefined);
    await device?.close().catch(() => undefined);
    for (const p of reversed) adb(['reverse', '--remove', `tcp:${p}`], { allowFail: true });
    if (booted && env.IA_KEEP_EMULATOR !== '1') adb(['emu', 'kill'], { allowFail: true });
    releaseEmulatorLock();
  }
}

export function isNotRun(x: unknown): x is NotRun {
  return typeof x === 'object' && x !== null && 'notRun' in x && typeof (x as NotRun).notRun === 'string';
}
