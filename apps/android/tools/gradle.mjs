#!/usr/bin/env node
/**
 * Runs the Android Gradle wrapper from the repo root on any OS (`pnpm android:build`, `pnpm android:test`):
 * `gradlew.bat` on Windows, `./gradlew` elsewhere, with cwd apps/android. Arguments are passed through.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const args = process.argv.slice(2);
const r = win
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', resolve(cwd, 'gradlew.bat'), ...args], { cwd, stdio: 'inherit' })
  : spawnSync('./gradlew', args, { cwd, stdio: 'inherit' });
process.exit(r.status ?? 1);
